import { describe, expect, it } from 'vitest';
import { canGroupCandidates, mergeCandidateGroup } from '../src/analysis/candidate-group';
import { estimatePosition, bearingToLatLon, distanceMeters, type ObservationRay } from '../src/analysis/position';
import type { FeatureCandidate, Observation, Photo, Survey } from '../src/types';
const obs = (id: string, photoId = id): Observation => ({ id, photoId, surveyId: 's', featureType: 'unknown', bbox: { x: .2, y: .2, w: .3, h: .3 }, tagSuggestions: {}, tagConfidence: .9, distanceEstimate: 10 });
const candidate = (id: string): FeatureCandidate => ({ id, surveyId: 's', analyzer: 'openai', featureType: 'unknown', observationIds: [id], tags: {}, positionConfidence: .2, tagConfidence: .9, osmMatches: [], warnings: [], status: 'new' });
const ray = (x: number, y: number, targetX = 10, targetY = 10): ObservationRay => ({ lat: y / 111194.9266, lon: x / 111194.9266, hasHeading: false, bearingDeg: 0, distanceM: Math.hypot(x - targetX, y - targetY), gpsAccuracy: .2, distanceUncertaintyM: .3 });
const survey = (): Survey => ({ id: 's', name: 'Test', createdAt: 0, recording: false, gpsSamples: [], photos: ['a', 'b', 'c'].map((id, i): Photo => ({ id, surveyId: 's', timestamp: 1, timestampSource: 'exif', gps: { id, lat: 0, lon: i * .0001, timestamp: 1, accuracy: 2 } })), candidates: [] });

describe('reviewed identity groups', () => {
  it('allows unknown objects across photos without camera headings', () => {
    const observations = [obs('a'), obs('b')];
    const merged = mergeCandidateGroup(survey(), candidate('a'), candidate('b'), observations);
    expect(merged.observationIds).toEqual(['a', 'b']);
    expect(merged.mergeSources?.map((c) => c.id)).toEqual(['a', 'b']);
    expect(merged.positionQuality).toBe('distance-only');
    expect(merged.positionSolution?.evidence[0].source).toBe('distance-estimate');
    expect(merged.osmMatches).toEqual([]);
  });
  it('blocks same-photo objects, including a transitive group', () => {
    const observations = [obs('a', 'p1'), obs('b', 'p2'), obs('c', 'p1')];
    const merged = mergeCandidateGroup(survey(), candidate('a'), candidate('b'), observations);
    expect(canGroupCandidates([merged, candidate('c')], observations)).toBe(false);
    expect(() => mergeCandidateGroup(survey(), merged, candidate('c'), observations)).toThrow();
  });
  it('keeps all originals through successive merges and does not mutate inputs', () => {
    const observations = ['a', 'b', 'c'].map((id) => obs(id));
    const a = candidate('a'), b = candidate('b');
    a.tags = { material: 'stone' }; b.tags = { material: 'metal', colour: 'grey' };
    const merged = mergeCandidateGroup(survey(), mergeCandidateGroup(survey(), a, b, observations), candidate('c'), observations);
    expect(merged.mergeSources?.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(merged.tags).toEqual({ material: 'stone', colour: 'grey' });
    expect(a.observationIds).toEqual(['a']);
  });
  it('rejects missing evidence and different linked OSM identities', () => {
    const a = candidate('a'), b = candidate('b');
    expect(canGroupCandidates([a, b], [obs('a')])).toBe(false);
    a.linkedOsmId = 1; b.linkedOsmId = 2;
    expect(canGroupCandidates([a, b], [obs('a'), obs('b')])).toBe(false);
  });
});

describe('distance-only provisional placement', () => {
  it('locates a point using three non-collinear cameras without headings', () => {
    const result = estimatePosition([ray(0, 0), ray(20, 0), ray(0, 20)]);
    expect(result.positionQuality).toBe('distance-only');
    expect(distanceMeters(result.lat, result.lon, 10 / 111194.9266, 10 / 111194.9266)).toBeLessThan(.2);
    expect(result.positionConfidence).toBeLessThanOrEqual(.3);
  });
  it('includes both mirror solutions in the uncertainty from two cameras', () => {
    const result = estimatePosition([ray(0, 0), ray(20, 0)]);
    const mirror = bearingToLatLon(0, 10 / 111194.9266, result.lat > 0 ? 180 : 0, 10);
    expect(distanceMeters(result.lat, result.lon, mirror.lat, mirror.lon)).toBeLessThanOrEqual(result.uncertaintyMeters + .2);
    expect(result.warnings.some((w) => w.includes('mirrored'))).toBe(true);
  });
  it('does not claim localization from repeated camera locations', () => {
    const result = estimatePosition([ray(0, 0), ray(0, 0)]);
    expect(result.positionQuality).toBe('no-orientation');
    expect(result.uncertaintyMeters).toBeGreaterThan(14);
  });
  it('flags distances that cannot agree', () => {
    const a = ray(0, 0), b = ray(100, 0);
    a.distanceM = b.distanceM = 2;
    expect(estimatePosition([a, b]).positionQuality).toBe('contradictory');
  });
});
