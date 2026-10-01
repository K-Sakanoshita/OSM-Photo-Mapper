import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { FeatureCandidate, GpsSample, Photo, Survey } from '../src/types';

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
function makeLegacySurvey(): { survey: Survey; gps: GpsSample[]; photos: Photo[]; cands: FeatureCandidate[] } {
  const gps: GpsSample[] = [
    { id: 'g1', surveyId: 's1', lat: 48.8, lon: 2.3, accuracy: 5, timestamp: 1000 },
    { id: 'g2', surveyId: 's1', lat: 48.801, lon: 2.301, accuracy: 4, timestamp: 2000 }
  ];
  const photos: Photo[] = [
    {
      id: 'p1',
      surveyId: 's1',
      timestamp: 1500,
      timestampSource: 'exif',
      image: 'data:image/jpeg;base64,VERYLARGE',
      gps: gps[0],
      heading: 90
    }
  ];
  const cands: FeatureCandidate[] = [
    {
      id: 'c1',
      surveyId: 's1',
      featureType: 'bench',
      lat: 48.8005,
      lon: 2.3005,
      positionConfidence: 0.6,
      tagConfidence: 0.7,
      tags: { amenity: 'bench' },
      observationIds: ['o1'],
      osmMatches: [],
      warnings: [],
      status: 'new'
    }
  ];
  const survey: Survey = {
    id: 's1',
    name: 'Legacy walk',
    createdAt: 9000,
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
    const { survey } = makeLegacySurvey();
    await putAll(db1, 'surveys', 'readwrite', [survey]);
    db1.close();

    await freshModule(idb);

    // Opening at v2 triggers the upgrade; this must resolve (not abort).
    const metas = await surveyDb.listSurveys();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toEqual({ id: 's1', name: 'Legacy walk', createdAt: 9000, recording: false });

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
    const { survey } = makeLegacySurvey();
    await putAll(db1, 'surveys', 'readwrite', [survey]);
    db1.close();

    await freshModule(idb);
    const loaded = await surveyDb.loadSurvey('s1');

    expect(loaded?.id).toBe('s1');
    expect(loaded?.gpsSamples).toHaveLength(2);
    expect(loaded?.gpsSamples?.[0]).toMatchObject({ id: 'g1', lat: 48.8, timestamp: 1000 });
    expect(loaded?.photos).toHaveLength(1);
    expect(loaded?.photos?.[0]).toMatchObject({ id: 'p1', timestamp: 1500, timestampSource: 'exif' });
    expect(loaded?.photos?.[0].image).toBe('data:image/jpeg;base64,VERYLARGE');
    expect(loaded?.candidates).toHaveLength(1);
    expect(loaded?.candidates?.[0]).toMatchObject({ id: 'c1', featureType: 'bench', observationIds: ['o1'] });
    // gpsSamples are returned in timestamp order
    expect(loaded?.gpsSamples?.map((g) => g.id)).toEqual(['g1', 'g2']);
  });

  it('keeps list/load/delete flows working after migration', async () => {
    const idb = new IDBFactory();
    const db1 = await openDb(idb, 1, createV1Stores);
    const { survey } = makeLegacySurvey();
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
