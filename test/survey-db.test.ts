import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { FeatureCandidate, GpsSample, Observation, Photo, Survey } from '../src/types';

/**
 * IndexedDB schema tests (issue #7) using fake-indexeddb:
 *  - fresh database created directly at v2
 *  - v1 database with a legacy full-Survey row upgrades to v2 without
 *    aborting the versionchange transaction
 *  - child stores survive and loadSurvey() reconstructs the full survey
 *  - list/load/delete flows work after migration
 */

let surveyDb: typeof import('../src/db/survey-db').surveyDb;

const DB_NAME = 'osm-photo-mapper';

/** Open (and if needed create/upgrade) a database using a given idb instance. */
function openDb(
  idb: IDBFactory,
  version: number,
  onUpgrade: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, version);
    req.onupgradeneeded = () => onUpgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** v1 store layout (as shipped in the original MVP). */
function createV1Stores(db: IDBDatabase): void {
  db.createObjectStore('surveys', { keyPath: 'id' });
  const gps = db.createObjectStore('gps_samples', { keyPath: 'id' });
  gps.createIndex('by_survey', 'surveyId', { unique: false });
  const photos = db.createObjectStore('photos', { keyPath: 'id' });
  photos.createIndex('by_survey', 'surveyId', { unique: false });
  const obs = db.createObjectStore('observations', { keyPath: 'id' });
  obs.createIndex('by_photo', 'photoId', { unique: false });
  obs.createIndex('by_survey', 'surveyId', { unique: false });
  const cands = db.createObjectStore('candidates', { keyPath: 'id' });
  cands.createIndex('by_survey', 'surveyId', { unique: false });
}

function putAll<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, rows: T[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    for (const r of rows) t.objectStore(store).put(r);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

function getAllRows<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

/** A legacy v1 survey row: full Survey with embedded child arrays. */
function makeLegacySurvey(
  n = 1,
  name = 'Legacy walk'
): { survey: Survey; gps: GpsSample[]; photos: Photo[]; cands: FeatureCandidate[] } {
  const id = `s${n}`;
  const gps: GpsSample[] = [
    { id: `g${n}a`, surveyId: id, lat: 48.8, lon: 2.3, accuracy: 5, timestamp: 1000 },
    { id: `g${n}b`, surveyId: id, lat: 48.801, lon: 2.301, accuracy: 4, timestamp: 2000 }
  ];
  const photos: Photo[] = [
    {
      id: `p${n}`,
      surveyId: id,
      timestamp: 1500,
      timestampSource: 'exif',
      image: `data:image/jpeg;base64,VERYLARGE${n}`,
      gps: gps[0],
      // Issue #10: provenance-tagged camera position must survive the
      // IndexedDB round trip.
      cameraPosition: {
        lat: 48.8,
        lon: 2.3,
        accuracy: 5,
        timestamp: 1500,
        fixTimestamp: 1000,
        ageMs: 500,
        source: 'track',
        interpolated: true
      },
      movementHeading: 90
    }
  ];
  const cands: FeatureCandidate[] = [
    {
      id: `c${n}`,
      surveyId: id,
      featureType: 'bench',
      lat: 48.8005,
      lon: 2.3005,
      positionConfidence: 0.6,
      tagConfidence: 0.7,
      tags: { amenity: 'bench' },
      observationIds: [`o${n}`],
      osmMatches: [],
      warnings: [],
      status: 'new'
    }
  ];
  const survey: Survey = {
    id,
    name,
    createdAt: 9000 + n,
    recording: false,
    gpsSamples: gps,
    photos,
    candidates: cands
  };
  return { survey, gps, photos, cands };
}

/** Replace the global indexedDB with a fresh in-memory instance and re-import the module. */
async function freshModule(idb: IDBFactory) {
  vi.resetModules();
  const g = globalThis as { indexedDB: IDBFactory; IDBKeyRange?: unknown };
  g.indexedDB = idb;
  g.IDBKeyRange = IDBKeyRange;
  surveyDb = (await import('../src/db/survey-db')).surveyDb;
}

beforeEach(async () => {
  await freshModule(new IDBFactory());
});

/** A linked candidate as stored before `linkedOsmType` existed. */
function legacyLinkedCandidate(surveyId: string, id: string, osmId: number, matches: FeatureCandidate['osmMatches']): FeatureCandidate {
  return {
    id,
    surveyId,
    featureType: 'bench',
    lat: 48.8005,
    lon: 2.3005,
    positionConfidence: 0.5,
    tagConfidence: 0.5,
    tags: { amenity: 'bench' },
    observationIds: [],
    osmMatches: matches,
    warnings: [],
    status: 'existing',
    linkedOsmId: osmId
  };
}

describe('linkedOsmType backfill (issue #4)', () => {
  it('resolves linkedOsmType from osmMatches for legacy linked candidates', async () => {
    await surveyDb.createSurvey({
      id: 's1', name: 'Backfill', createdAt: 1, recording: false,
      gpsSamples: [], photos: [], candidates: []
    });
    const cand = legacyLinkedCandidate('s1', 'cand-legacy', 4242, [
      { osmType: 'way', osmId: 4242, distanceM: 3.1, tags: { highway: 'footway' }, name: 'Path' },
      { osmType: 'node', osmId: 777, distanceM: 5.0, tags: { amenity: 'bench' } }
    ]);
    await surveyDb.updateCandidate(cand);

    const loaded = (await surveyDb.loadSurvey('s1'))!.candidates.find((c) => c.id === 'cand-legacy');
    expect(loaded).toBeDefined();
    expect(loaded!.linkedOsmId).toBe(4242);
    expect(loaded!.linkedOsmType).toBe('way');
  });

  it('falls back to node when the linked ID is not in osmMatches', async () => {
    await surveyDb.createSurvey({
      id: 's1', name: 'Backfill 2', createdAt: 1, recording: false,
      gpsSamples: [], photos: [], candidates: []
    });
    await surveyDb.updateCandidate(legacyLinkedCandidate('s1', 'cand-legacy2', 4242, []));

    const loaded = (await surveyDb.loadSurvey('s1'))!.candidates.find((c) => c.id === 'cand-legacy2');
    expect(loaded!.linkedOsmType).toBe('node');
  });

  it('leaves explicit linkedOsmType values untouched', async () => {
    await surveyDb.createSurvey({
      id: 's1', name: 'Backfill 3', createdAt: 1, recording: false,
      gpsSamples: [], photos: [], candidates: []
    });
    const cand = legacyLinkedCandidate('s1', 'cand-legacy3', 4242, [
      { osmType: 'way', osmId: 4242, distanceM: 3.1, tags: {} }
    ]);
    cand.linkedOsmType = 'node'; // explicitly set (e.g. by the new UI)
    await surveyDb.updateCandidate(cand);

    const loaded = (await surveyDb.loadSurvey('s1'))!.candidates.find((c) => c.id === 'cand-legacy3');
    expect(loaded!.linkedOsmType).toBe('node');
  });
});

describe('fresh v2 database', () => {
  it('creates metadata-only survey rows on a fresh install', async () => {
    await surveyDb.createSurvey({
      id: 's9',
      name: 'Fresh',
      createdAt: 1,
      recording: false,
      gpsSamples: [],
      photos: [],
      candidates: []
    });
    const metas = await surveyDb.listSurveys();
    expect(metas).toEqual([{ id: 's9', name: 'Fresh', createdAt: 1, recording: false }]);
    const loaded = await surveyDb.loadSurvey('s9');
    expect(loaded?.gpsSamples).toEqual([]);
    expect(loaded?.photos).toEqual([]);
    expect(loaded?.candidates).toEqual([]);
  });
});

describe('v1 -> v2 migration', () => {
  it('upgrades a legacy full-Survey row to metadata-only without aborting', async () => {
    const idb = new IDBFactory();
    // Build a v1 database whose surveys store holds a full legacy Survey row
    // (child stores intentionally left empty: worst case for preservation).
    const db1 = await openDb(idb, 1, createV1Stores);
    const { survey } = makeLegacySurvey(1);
    await putAll(db1, 'surveys', 'readwrite', [survey]);
    db1.close();

    await freshModule(idb);

    // Opening at v2 triggers the upgrade; this must resolve (not abort).
    const metas = await surveyDb.listSurveys();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toEqual({ id: 's1', name: 'Legacy walk', createdAt: 9001, recording: false });

    // Raw surveys row is metadata-only now (no embedded child arrays).
    const db2 = await openDb(idb, 2, () => {});
    const rawRow = (await getAllRows<Record<string, unknown>>(db2, 'surveys'))[0];
    expect('photos' in rawRow).toBe(false);
    expect('gpsSamples' in rawRow).toBe(false);
    expect('candidates' in rawRow).toBe(false);
    db2.close();
  });

  it('preserves embedded child records and reconstructs the survey', async () => {
    const idb = new IDBFactory();
    const db1 = await openDb(idb, 1, createV1Stores);
    const { survey } = makeLegacySurvey(1);
    await putAll(db1, 'surveys', 'readwrite', [survey]);
    db1.close();

    await freshModule(idb);
    const loaded = await surveyDb.loadSurvey('s1');

    expect(loaded?.id).toBe('s1');
    expect(loaded?.gpsSamples).toHaveLength(2);
    expect(loaded?.gpsSamples?.[0]).toMatchObject({ id: 'g1a', lat: 48.8, timestamp: 1000 });
    expect(loaded?.photos).toHaveLength(1);
    expect(loaded?.photos?.[0]).toMatchObject({ id: 'p1', timestamp: 1500, timestampSource: 'exif' });
    expect(loaded?.photos?.[0].image).toBe('data:image/jpeg;base64,VERYLARGE1');
    // Issue #10: camera-position provenance survives the round trip.
    expect(loaded?.photos?.[0].cameraPosition).toMatchObject({
      source: 'track',
      lat: 48.8,
      lon: 2.3,
      accuracy: 5,
      ageMs: 500,
      interpolated: true
    });
    expect(loaded?.candidates).toHaveLength(1);
    expect(loaded?.candidates?.[0]).toMatchObject({ id: 'c1', featureType: 'bench', observationIds: ['o1'] });
    // gpsSamples are returned in timestamp order
    expect(loaded?.gpsSamples?.map((g) => g.id)).toEqual(['g1a', 'g1b']);
  });

  it('migrates every legacy survey row, not only the first (issue #7)', async () => {
    const idb = new IDBFactory();
    // v1 database with THREE legacy full-Survey rows.
    const db1 = await openDb(idb, 1, createV1Stores);
    const legacy = [1, 2, 3].map((n) => makeLegacySurvey(n, `Legacy walk ${n}`));
    await putAll(db1, 'surveys', 'readwrite', legacy.map((l) => l.survey));
    db1.close();

    await freshModule(idb);

    // All three surveys survive the migration and are listed.
    const metas = await surveyDb.listSurveys();
    expect(metas.map((m) => m.id).sort()).toEqual(['s1', 's2', 's3']);
    expect(metas.every((m) => !('photos' in m) && !('gpsSamples' in m) && !('candidates' in m))).toBe(true);

    // Every raw row in the surveys store is metadata-only.
    const db2 = await openDb(idb, 2, () => {});
    const rawRows = await getAllRows<Record<string, unknown>>(db2, 'surveys');
    expect(rawRows).toHaveLength(3);
    for (const row of rawRows) {
      expect('photos' in row).toBe(false);
      expect('gpsSamples' in row).toBe(false);
      expect('candidates' in row).toBe(false);
    }
    db2.close();

    // Every survey remains loadable with its child records intact.
    for (let n = 1; n <= 3; n++) {
      const loaded = await surveyDb.loadSurvey(`s${n}`);
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe(`Legacy walk ${n}`);
      expect(loaded?.gpsSamples).toHaveLength(2);
      expect(loaded?.photos).toHaveLength(1);
      expect(loaded?.photos?.[0].image).toBe(`data:image/jpeg;base64,VERYLARGE${n}`);
      expect(loaded?.candidates).toHaveLength(1);
      expect(loaded?.candidates?.[0].id).toBe(`c${n}`);
    }
  });

  it('keeps list/load/delete flows working after migration', async () => {
    const idb = new IDBFactory();
    const db1 = await openDb(idb, 1, createV1Stores);
    const { survey } = makeLegacySurvey(1);
    await putAll(db1, 'surveys', 'readwrite', [survey]);
    db1.close();

    await freshModule(idb);

    expect((await surveyDb.listSurveys()).map((m) => m.id)).toEqual(['s1']);
    expect((await surveyDb.loadSurvey('s1'))?.photos).toHaveLength(1);

    await surveyDb.deleteSurvey('s1');
    expect(await surveyDb.listSurveys()).toEqual([]);
    expect(await surveyDb.loadSurvey('s1')).toBeUndefined();
  });
});

describe('analysis provenance persistence (issue #15)', () => {
  it('retains observations when replacing an existing analysis', async () => {
    const { survey, cands } = makeLegacySurvey();
    await surveyDb.createSurvey(survey);
    const makeObservation = (id: string): Observation => ({
      id, photoId: 'p1', surveyId: 's1', featureType: 'bench',
      bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, tagSuggestions: {}, tagConfidence: 0
    });
    await surveyDb.saveAnalysis('s1', [makeObservation('old')], cands);
    await surveyDb.saveAnalysis('s1', [makeObservation('new')], [{ ...cands[0], id: 'new-candidate' }]);
    expect((await surveyDb.listObservations('s1')).map((o) => o.id)).toEqual(['new']);
    expect((await surveyDb.loadSurvey('s1'))?.candidates.map((c) => c.id)).toEqual(['new-candidate']);
  });

  it('retains provider and model on observations and candidates after reload', async () => {
    const { survey, cands } = makeLegacySurvey();
    await surveyDb.createSurvey(survey);
    const observation: Observation = {
      id: 'o1', photoId: 'p1', surveyId: 's1', featureType: 'bench',
      bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      tagSuggestions: { amenity: 'bench' }, tagConfidence: 0.8,
      analyzer: 'openai', analyzerModel: 'gpt-4o-mini'
    };
    await surveyDb.saveAnalysis('s1', [observation], [{ ...cands[0], analyzer: 'openai', analyzerModel: 'gpt-4o-mini' }]);
    expect((await surveyDb.listObservations('s1'))[0]).toMatchObject({ analyzer: 'openai', analyzerModel: 'gpt-4o-mini' });
    expect((await surveyDb.loadSurvey('s1'))?.candidates[0]).toMatchObject({ analyzer: 'openai', analyzerModel: 'gpt-4o-mini' });
  });
});
