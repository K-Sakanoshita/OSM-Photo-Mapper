import type { FeatureCandidate, Observation, Photo } from '../types';

/** A photo may support several objects; a pin may contain several photos. */
export function photosForPin(candidate: FeatureCandidate, observations: Observation[], photos: Photo[]) {
  const ids = new Set(candidate.observationIds);
  return photos.map((photo) => ({ photo, observations: observations.filter((obs) => ids.has(obs.id) && obs.photoId === photo.id) }))
    .filter((entry) => entry.observations.length > 0);
}

export function photoAssignment(photo: Photo, observations: Observation[], candidates: FeatureCandidate[]) {
  const detections = observations.filter((obs) => obs.photoId === photo.id);
  const ids = new Set(detections.map((obs) => obs.id));
  const pins = candidates.filter((candidate) => candidate.observationIds.some((id) => ids.has(id)));
  if (pins.length) return { state: 'assigned' as const, pins };
  if (detections.length) return { state: 'unassigned' as const, pins };
  if (photo.analysisStatus?.status === 'error') return { state: 'failed' as const, pins };
  if (photo.analysisStatus?.status === 'ok') return { state: 'empty' as const, pins };
  return { state: 'pending' as const, pins };
}
