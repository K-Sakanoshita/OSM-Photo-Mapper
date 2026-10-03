import type {
  FeatureCandidate,
  GpsSample,
  Observation,
  Photo,
  Survey,
  SurveyMeta
} from '../types';

/**
 * Local persistence via IndexedDB.
 *
 * Stores are normalized per the data model:
 *   surveys        -> SurveyMeta (id, name, createdAt, recording flag ONLY)
 *   gps_samples    -> GpsSample
 *   photos         -> Photo
 *   observations   -> Observation
 *   candidates     -> FeatureCandidate
 *
 * The surveys store never holds child data (photo image payloads, GPS
 * arrays, ...). The full `Survey` view is reconstructed on read from the
 * child stores so records stay independently updatable (e.g. dragging a pin
 * updates just the candidate row).
 */

const DB_NAME = 'osm-photo-mapper';
const DB_VERSION = 2;

/** Reduce a (possibly legacy, fully-populated) survey row to metadata. */
function metaOnly(row: Survey): SurveyMeta {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    recording: row.recording === true
  };
}

const STORES = {
  surveys: 'surveys',
  gps: 'gps_samples',
  photos: 'photos',
  observations: 'observations',
  candidates: 'candidates'
} as const;

type StoreName = (typeof STORES)[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev: IDBVersionChangeEvent) => {
      // ev.target is the IDBOpenDBRequest; the database is req.result.
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.surveys)) {
        db.createObjectStore(STORES.surveys, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.gps)) {
        const s = db.createObjectStore(STORES.gps, { keyPath: 'id' });
        s.createIndex('by_survey', 'surveyId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.photos)) {
        const s = db.createObjectStore(STORES.photos, { keyPath: 'id' });
        s.createIndex('by_survey', 'surveyId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.observations)) {
        const s = db.createObjectStore(STORES.observations, { keyPath: 'id' });
        s.createIndex('by_photo', 'photoId', { unique: false });
        s.createIndex('by_survey', 'surveyId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.candidates)) {
        const s = db.createObjectStore(STORES.candidates, { keyPath: 'id' });
        s.createIndex('by_survey', 'surveyId', { unique: false });
      }

      // v1 -> v2: legacy survey rows stored the full Survey (photos include
      // image data URLs), duplicating large payloads and risking stale child
      // arrays in the metadata row. Strip them down to metadata-only rows.
      //
      // IMPORTANT: the upgrade already runs inside the versionchange
      // transaction. Opening a *separate* transaction here (db.transaction)
      // aborts the versionchange and fails the whole open with
      // "Version change transaction was aborted". Use req.transaction.
      if ((ev.oldVersion ?? 0) > 0 && (ev.oldVersion ?? 0) < 2) {
        const upgradeTx = req.transaction!;
        const surveys = upgradeTx.objectStore(STORES.surveys);
        const cursorReq = surveys.openCursor();
        cursorReq.onsuccess = (e: Event) => {
          const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cur) return;
          const row = cur.value as Survey;
          const photos = row.photos ?? [];
          const gps = row.gpsSamples ?? [];
          const cands = row.candidates ?? [];
          if (photos.length || gps.length || cands.length) {
            // Defensive upsert: v1 already wrote child records to their own
            // stores, but guarantee anything embedded-only is preserved.
            for (const p of photos) upgradeTx.objectStore(STORES.photos).put(p);
            for (const g of gps) upgradeTx.objectStore(STORES.gps).put(g);
            for (const c of cands) upgradeTx.objectStore(STORES.candidates).put(c);
          }
          cur.update(metaOnly(row));
          // Advance the cursor so every legacy survey row is migrated, not
          // just the first one (issue #7).
          cur.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  names: StoreName[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => IDBRequest<T> | void
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(names, mode);
        const req = fn(t);
        if (!req) {
          t.oncomplete = () => resolve(undefined as T);
          t.onerror = () => reject(t.error);
          return;
        }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

function getByIndex<T>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
  return openDB().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const t = db.transaction(store, 'readonly');
        const req = t.objectStore(store).index(index).getAll(value);
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
      })
  );
}

function getAll<T>(store: StoreName): Promise<T[]> {
  return openDB().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
      })
  );
}

/**
 * Issue #4: a linked object is identified by type + ID, but rows linked
 * before `linkedOsmType` existed only carry the ID. Resolve the type from
 * the stored osmMatches (falling back to 'node' — the only type the legacy
 * exporter could modify).
 */
function backfillLinkedOsmType(candidates: FeatureCandidate[]): FeatureCandidate[] {
  return candidates.map((c) => {
    if (c.linkedOsmId == null || c.linkedOsmType != null) return c;
    const type = c.osmMatches.find((m) => m.osmId === c.linkedOsmId)?.osmType ?? 'node';
    return { ...c, linkedOsmType: type };
  });
}

export const surveyDb = {
  /** Create a new (empty) survey. Only metadata goes into the surveys store. */
  async createSurvey(survey: Survey): Promise<void> {
    await tx([STORES.surveys], 'readwrite', (t) =>
      t.objectStore(STORES.surveys).put(metaOnly(survey))
    );
  },

  /**
   * Persist survey metadata (name, recording flag, ...).
   * Child arrays are deliberately dropped: they live in their own stores and
   * re-storing them here would duplicate payloads and can go stale.
   */
  async saveSurveyMeta(survey: Survey): Promise<void> {
    await tx([STORES.surveys], 'readwrite', (t) =>
      t.objectStore(STORES.surveys).put(metaOnly(survey))
    );
  },

  /** Load a full survey with its child records assembled. */
  async loadSurvey(id: string): Promise<Survey | undefined> {
    const meta = await tx<SurveyMeta | undefined>([STORES.surveys], 'readonly', (t) =>
      t.objectStore(STORES.surveys).get(id)
    );
    if (!meta) return undefined;

    const [gps, photos, candidates] = await Promise.all([
      getByIndex<GpsSample>(STORES.gps, 'by_survey', id),
      getByIndex<Photo>(STORES.photos, 'by_survey', id),
      getByIndex<FeatureCandidate>(STORES.candidates, 'by_survey', id)
    ]);

    return {
      ...meta,
      gpsSamples: gps.sort((a, b) => a.timestamp - b.timestamp),
      photos: photos.sort((a, b) => a.timestamp - b.timestamp),
      candidates: backfillLinkedOsmType(candidates)
    };
  },

  /** Lightweight metadata rows for the survey list (no image payloads). */
  async listSurveys(): Promise<SurveyMeta[]> {
    const metas = await getAll<SurveyMeta>(STORES.surveys);
    return metas.sort((a, b) => b.createdAt - a.createdAt);
  },

  async addGpsSample(surveyId: string, sample: GpsSample): Promise<void> {
    await tx([STORES.gps], 'readwrite', (t) =>
      t.objectStore(STORES.gps).put({ ...sample, surveyId })
    );
  },

  async addPhoto(surveyId: string, photo: Photo): Promise<void> {
    await tx([STORES.photos], 'readwrite', (t) =>
      t.objectStore(STORES.photos).put({ ...photo, surveyId })
    );
  },

  /** List a survey's observations (needed to link candidates to source photos). */
  async listObservations(surveyId: string): Promise<Observation[]> {
    return getByIndex<Observation>(STORES.observations, 'by_survey', surveyId);
  },

  /** Save analysis output: replace observations + candidates for a survey. */
  async saveAnalysis(
    surveyId: string,
    observations: Observation[],
    candidates: FeatureCandidate[]
  ): Promise<void> {
    await openDB().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const t = db.transaction([STORES.observations, STORES.candidates], 'readwrite');
          // Delete only this survey's rows (other surveys' data is untouched).
          const clearBySurvey = (store: IDBObjectStore) => {
            const req = store.index('by_survey').openCursor(IDBKeyRange.only(surveyId));
            req.onsuccess = (e) => {
              const cur = (e.target as IDBRequest<IDBCursor | null>).result;
              if (cur) {
                cur.delete();
                cur.continue();
              }
            };
          };
          clearBySurvey(t.objectStore(STORES.observations));
          clearBySurvey(t.objectStore(STORES.candidates));
          for (const o of observations) t.objectStore(STORES.observations).put(o);
          for (const c of candidates) t.objectStore(STORES.candidates).put(c);
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        })
    );
  },

  /** Update a single candidate (e.g. dragged pin or edited tags). */
  async updateCandidate(candidate: FeatureCandidate): Promise<void> {
    await tx([STORES.candidates], 'readwrite', (t) =>
      t.objectStore(STORES.candidates).put(candidate)
    );
  },

  async deleteCandidate(id: string): Promise<void> {
    await tx([STORES.candidates], 'readwrite', (t) => t.objectStore(STORES.candidates).delete(id));
  },

  async deleteSurvey(id: string): Promise<void> {
    await openDB().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const t = db.transaction(
            [STORES.surveys, STORES.gps, STORES.photos, STORES.observations, STORES.candidates],
            'readwrite'
          );
          t.objectStore(STORES.surveys).delete(id);
          for (const store of [STORES.gps, STORES.photos, STORES.observations, STORES.candidates] as StoreName[]) {
            const idx = t.objectStore(store).index('by_survey');
            idx.openCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
              const cur = (e.target as IDBRequest<IDBCursor | null>).result;
              if (cur) {
                cur.delete();
                cur.continue();
              }
            };
          }
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        })
    );
  }
};
