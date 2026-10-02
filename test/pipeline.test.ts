import { describe, expect, it } from 'vitest';
import type { AnalysisContext, ImageObservationAnalyzer, VisualObservation } from '../src/analysis/analyzer';
import {
  MIN_ATTRIBUTE_CONFIDENCE,
  MIN_DETECTION_CONFIDENCE,
  SurveyAnalysisPipeline
} from '../src/analysis/pipeline';
import type { CameraHeading, Photo, Survey } from '../src/types';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function makePhoto(id: string, over: Partial<Photo> = {}): Photo {
  return {
    id,
    surveyId: 's1',
    timestamp: 2_000_000,
    timestampSource: 'exif',
    gps: { id: `gps-${id}`, lat: 48.8, lon: 2.3, accuracy: 5, timestamp: 2_000_000 },
    cameraPosition: {
      lat: 48.8,
      lon: 2.3,
      accuracy: 5,
      timestamp: 2_000_000,
      fixTimestamp: 2_000_000,
      ageMs: 0,
      source: 'track'
    },
    ...over
  };
}

function ch(bearing: number): CameraHeading {
  return { bearing, source: 'compass', uncertaintyDeg: 5, timestamp: 1_999_000, ageMs: 1_000 };
}

type VisReq = Pick<VisualObservation, 'featureType' | 'bbox' | 'detectionConfidence'>;

function vis(p: Partial<VisualObservation> & VisReq): VisualObservation {
  return { attributes: {}, ...p };
}

const BOX = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };

function makeSurvey(photos: Photo[]): Survey {
  return {
    id: 's1',
    name: 'Test survey',
    createdAt: 0,
    recording: false,
    gpsSamples: [],
    photos,
    candidates: []
  };
}

/**
 * Deterministic fake provider. The per-photo result is deliberately
 * UNTYPED (unknown): provider output is untrusted, and the tests feed it
 * malformed items on purpose. The pipeline must survive any shape.
 */
class FakeAnalyzer implements ImageObservationAnalyzer {
  name = 'fake';
  photos: Photo[] = [];
  constructor(private readonly fn: (p: Photo) => unknown) {}
  async analyzePhoto(photo: Photo, _ctx: AnalysisContext): Promise<VisualObservation[]> {
    this.photos.push(photo);
    const out = await this.fn(photo);
    if (out instanceof Error) throw out;
    return out as VisualObservation[];
  }
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe('SurveyAnalysisPipeline (issue #2)', () => {
  it('creates one candidate per distinct object in a photo', async () => {
    const survey = makeSurvey([makePhoto('p1', { cameraHeading: ch(90) })]);
    // Two benches, same camera: one 5 m ahead, one 40 m ahead -> far
    // apart in projection (> 18 m cluster radius) -> two candidates.
    const analyzer = new FakeAnalyzer(() => [
      vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.9, distanceEstimate: 5 }),
      vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.9, distanceEstimate: 40 })
    ]);
    const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
    expect(res.observations).toHaveLength(2);
    expect(res.candidates).toHaveLength(2);
    expect(res.analyzerName).toBe('fake');
  });

  it('treats an empty observation array as a valid "no objects" answer', async () => {
    const survey = makeSurvey([makePhoto('p1', { cameraHeading: ch(90) })]);
    const analyzer = new FakeAnalyzer(() => []);
    const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
    expect(res.observations).toHaveLength(0);
    expect(res.candidates).toHaveLength(0);
    expect(res.photoStatuses).toEqual([{ photoId: 'p1', status: 'ok', observationCount: 0 }]);
  });

  it('drops malformed provider items and keeps the valid ones', async () => {
    const survey = makeSurvey([makePhoto('p1', { cameraHeading: ch(90) })]);
    // Raw UNTRUSTED array: one valid item, three unusable ones.
    const analyzer = new FakeAnalyzer(() => [
      vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.9 }),
      { featureType: 'bench' }, // no bbox
      'garbage', // not an object
      vis({ featureType: 'bench', bbox: { x: 5, y: 0, w: 0.1, h: 0.1 }, detectionConfidence: 0.9 }) // out of range
    ]);
    const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
    expect(res.observations).toHaveLength(1);
    expect(res.observations[0].featureType).toBe('bench');
    expect(res.observations[0].bbox).toEqual(BOX);
  });

  describe('OCR / attribute trust policy', () => {
    it('carries OCR text as evidence and NEVER turns it into name=*', async () => {
      const survey = makeSurvey([makePhoto('p1', { cameraHeading: ch(90) })]);
      const analyzer = new FakeAnalyzer(() => [
        vis({
          featureType: 'toilets',
          bbox: BOX,
          detectionConfidence: 0.9,
          ocrText: 'Café Lumière',
          ocrConfidence: 0.6,
          attributes: { name: 'Foo' } // 'name' is not a confirmable key for toilets
        })
      ]);
      const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
      const obs = res.observations[0];
      expect(obs.textSeen).toBe('Café Lumière');
      expect(obs.ocrConfidence).toBe(0.6);
      expect(obs.tagSuggestions['name']).toBeUndefined();
      expect(obs.detectedAttributes).toEqual({ name: 'Foo' });
      expect(res.candidates[0].tags['name']).toBeUndefined();
    });

    it('applies attributes as tags for confirmable keys above the confidence threshold', async () => {
      const survey = makeSurvey([makePhoto('p1', { cameraHeading: ch(90) })]);
      const analyzer = new FakeAnalyzer(() => [
        vis({ featureType: 'toilets', bbox: BOX, detectionConfidence: 0.8, attributes: { access: 'customers' } })
      ]);
      const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
      expect(res.candidates[0].tags).toEqual({ amenity: 'toilets', access: 'customers' });
      expect(res.observations[0].detectedAttributes).toBeUndefined();
    });

    it('keeps attributes unconfirmed below the detection confidence threshold', async () => {
      expect(MIN_ATTRIBUTE_CONFIDENCE).toBe(0.7);
      const survey = makeSurvey([makePhoto('p1', { cameraHeading: ch(90) })]);
      const analyzer = new FakeAnalyzer(() => [
        vis({ featureType: 'toilets', bbox: BOX, detectionConfidence: 0.5, attributes: { access: 'customers' } })
      ]);
      const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
      expect(res.candidates[0].tags).toEqual({ amenity: 'toilets' });
      expect(res.observations[0].detectedAttributes).toEqual({ access: 'customers' });
    });

    it('rejects commonValues values outside the declared list', async () => {
      const survey = makeSurvey([makePhoto('p1', { cameraHeading: ch(90) })]);
      const analyzer = new FakeAnalyzer(() => [
        vis({ featureType: 'toilets', bbox: BOX, detectionConfidence: 0.8, attributes: { access: 'sometimes' } })
      ]);
      const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
      expect(res.candidates[0].tags).toEqual({ amenity: 'toilets' });
      expect(res.observations[0].detectedAttributes).toEqual({ access: 'sometimes' });
    });

    it('never auto-applies attributes for review-only classes', async () => {
      const survey = makeSurvey([makePhoto('p1', { cameraHeading: ch(90) })]);
      // statue is autoTag=false (artwork vs memorial is ambiguous).
      const analyzer = new FakeAnalyzer(() => [
        vis({ featureType: 'statue', bbox: BOX, detectionConfidence: 0.9, attributes: { material: 'bronze' } })
      ]);
      const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
      expect(res.candidates[0].tags).toEqual({});
      expect(res.observations[0].detectedAttributes).toEqual({ material: 'bronze' });
    });
  });

  it('drops observations below the detection confidence threshold', async () => {
    expect(MIN_DETECTION_CONFIDENCE).toBe(0.4);
    const survey = makeSurvey([makePhoto('p1', { cameraHeading: ch(90) })]);
    const analyzer = new FakeAnalyzer(() => [
      vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.39 })
    ]);
    const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
    expect(res.observations).toHaveLength(0);
    expect(res.candidates).toHaveLength(0);
    expect(res.photoStatuses![0]).toEqual({ photoId: 'p1', status: 'ok', observationCount: 0 });
  });

  it('propagates distance estimate and uncertainty to the candidate', async () => {
    const survey = makeSurvey([makePhoto('p1', { cameraHeading: ch(90) })]);
    const analyzer = new FakeAnalyzer(() => [
      vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.8, distanceEstimate: 12, distanceUncertaintyM: 3 })
    ]);
    const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
    const obs = res.observations[0];
    expect(obs.distanceEstimate).toBe(12);
    expect(obs.distanceUncertaintyM).toBe(3);
    const cand = res.candidates[0];
    expect(cand.lat).not.toBeNull();
    expect(typeof cand.positionUncertaintyMeters).toBe('number');
  });

  describe('partial batch failure + retry', () => {
    it('records a per-photo error and continues the batch', async () => {
      const survey = makeSurvey([
        makePhoto('p1', { cameraHeading: ch(90) }),
        makePhoto('p2', { cameraHeading: ch(90) })
      ]);
      const analyzer = new FakeAnalyzer((p) =>
        p.id === 'p2' ? new Error('boom: API 500') : [vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.9 })]
      );
      const pipeline = new SurveyAnalysisPipeline(analyzer);
      const res = await pipeline.analyze(survey); // must not throw
      expect(res.photoStatuses).toEqual([
        { photoId: 'p1', status: 'ok', observationCount: 1 },
        { photoId: 'p2', status: 'error', error: 'boom: API 500' }
      ]);
      expect(res.observations).toHaveLength(1);
      expect(res.candidates).toHaveLength(1);
    });

    it('re-analyzes only the failed photos on retry (photoIds)', async () => {
      const survey = makeSurvey([
        makePhoto('p1', { cameraHeading: ch(90) }),
        makePhoto('p2', { cameraHeading: ch(90) })
      ]);
      let fail = true;
      const first = new FakeAnalyzer((p) =>
        fail && p.id === 'p2' ? new Error('boom') : [vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.9 })]
      );
      const res = await new SurveyAnalysisPipeline(first).analyze(survey);
      expect(res.photoStatuses![1].status).toBe('error');

      // Retry: a fresh provider run restricted to p2.
      fail = false;
      const retry = new FakeAnalyzer(() => [vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.85 })]);
      const retried = await new SurveyAnalysisPipeline(retry).analyzePhotos(survey, { photoIds: ['p2'] });
      expect(retry.photos.map((p) => p.id)).toEqual(['p2']);
      expect(retried.statuses).toEqual([{ photoId: 'p2', status: 'ok', observationCount: 1 }]);

      // Merge: drop p2's previous (none — it failed), append the new
      // observations, rebuild candidates from the merged set.
      const merged = [...res.observations.filter((o) => o.photoId !== 'p2'), ...retried.observations];
      const candidates = new SurveyAnalysisPipeline(retry).buildCandidates(survey, merged);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].observationIds).toHaveLength(2);
    });
  });

  describe('cross-photo grouping', () => {
    it('merges the same object seen from nearby cameras (proximity)', async () => {
      const p1 = makePhoto('p1', { cameraHeading: ch(90) });
      const p2 = makePhoto('p2', { cameraHeading: ch(90) });
      const survey = makeSurvey([p1, p2]);
      const obs = () => [vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.9, distanceEstimate: 10 })];
      const analyzer = new FakeAnalyzer(() => obs());
      const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
      // Same camera position, same bearing, same distance -> identical
      // projected point -> one cluster.
      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0].observationIds).toHaveLength(2);
    });

    it('keeps separate candidates for objects farther apart than the cluster radius', async () => {
      const p1 = makePhoto('p1', { cameraHeading: ch(0) });
      const p2 = makePhoto('p2', { cameraHeading: ch(180) }); // opposite direction
      const survey = makeSurvey([p1, p2]);
      const analyzer = new FakeAnalyzer((p) =>
        p.id === 'p1'
          ? [vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.9, distanceEstimate: 10 })]
          : [vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.9, distanceEstimate: 10 })]
      );
      const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
      // 10 m north vs 10 m south -> ~20 m apart > 18 m radius.
      expect(res.candidates).toHaveLength(2);
    });

    it('merges distant clusters that share identityEvidence', async () => {
      const p1 = makePhoto('p1', { cameraHeading: ch(0) });
      const p2 = makePhoto('p2', { cameraHeading: ch(180) });
      const survey = makeSurvey([p1, p2]);
      const analyzer = new FakeAnalyzer((p) =>
        p.id === 'p1'
          ? [vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.9, distanceEstimate: 10, identityEvidence: 'bench-A' })]
          : [vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.9, distanceEstimate: 10, identityEvidence: 'bench-A' })]
      );
      const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
      // Far apart in projection, but the provider says same object.
      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0].observationIds).toHaveLength(2);
    });
  });

  it('builds well-formed candidates (shape, tags, confidence, provenance)', async () => {
    const survey = makeSurvey([makePhoto('p1', { cameraHeading: ch(90) })]);
    const analyzer = new FakeAnalyzer(() => [
      vis({ featureType: 'bench', bbox: BOX, detectionConfidence: 0.85, distanceEstimate: 8 })
    ]);
    const res = await new SurveyAnalysisPipeline(analyzer).analyze(survey);
    const cand = res.candidates[0];
    expect(cand.id).toBe('cand-obs-p1-0');
    expect(cand.featureType).toBe('bench');
    expect(cand.tags).toEqual({ amenity: 'bench' });
    expect(cand.tagConfidence).toBe(0.85);
    expect(cand.observationIds).toEqual(['obs-p1-0']);
    expect(cand.status).toBe('new');
    expect(cand.lat).not.toBeNull();
    expect(cand.lon).not.toBeNull();
    expect(cand.positionConfidence).toBeGreaterThan(0);
    expect(cand.positionQuality).toBeDefined();
    expect(Array.isArray(cand.warnings)).toBe(true);
  });
});
