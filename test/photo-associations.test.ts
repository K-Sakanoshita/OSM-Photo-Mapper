import { expect, it } from 'vitest';
import { photosForPin, photoAssignment } from '../src/photos/associations';
import type { FeatureCandidate, Observation, Photo } from '../src/types';
const photos = [{ id: 'a' }, { id: 'b' }] as Photo[];
const observations = [{ id: 'a1', photoId: 'a' }, { id: 'a2', photoId: 'a' }, { id: 'b1', photoId: 'b' }] as Observation[];
const pin = { id: 'p', observationIds: ['a1', 'b1'] } as FeatureCandidate;
it('groups two photos beneath one object pin and keeps detection boxes separate', () => {
  const result = photosForPin(pin, observations, photos);
  expect(result.map((entry) => entry.photo.id)).toEqual(['a', 'b']);
  expect(result.map((entry) => entry.observations.map((obs) => obs.id))).toEqual([['a1'], ['b1']]);
});
it('allows one photo to be associated with multiple different objects', () => {
  const other = { id: 'q', observationIds: ['a2'] } as FeatureCandidate;
  expect(photoAssignment(photos[0], observations, [pin, other]).pins.map((item) => item.id)).toEqual(['p', 'q']);
});
it('shows one photo once even with multiple detections and ignores missing photos', () => {
  const combined = { observationIds: ['a1', 'a2', 'missing'] } as FeatureCandidate;
  expect(photosForPin(combined, observations, photos)).toHaveLength(1);
  expect(photosForPin(combined, observations, photos)[0].observations).toHaveLength(2);
});
it('distinguishes removed pins, failed/empty analysis and photos awaiting analysis', () => {
  expect(photoAssignment(photos[0], observations, []).state).toBe('unassigned');
  expect(photoAssignment({ id: 'none' } as Photo, observations, []).state).toBe('pending');
  expect(photoAssignment({ id: 'none', analysisStatus: { status: 'ok', photoId: 'none' } } as Photo, observations, []).state).toBe('empty');
  expect(photoAssignment({ id: 'none', analysisStatus: { status: 'error', photoId: 'none' } } as Photo, observations, []).state).toBe('failed');
});
