import type { FeatureCandidate, Observation, Survey } from '../types';
import { estimatePosition, rayFromPhoto } from './position';

/** Resolve the complete group, so transitive merges cannot hide same-photo conflicts. */
export function groupEvidence(candidates: FeatureCandidate[], observations: Observation[]): Observation[] {
  const ids = candidates.flatMap((c) => c.observationIds);
  const byId = new Map(observations.map((o) => [o.id, o]));
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) throw new Error('Source observations are missing or overlapping');
  return ids.map((id) => byId.get(id)!);
}

export function canGroupCandidates(candidates: FeatureCandidate[], observations: Observation[]): boolean {
  try {
    if (candidates.length < 2 || new Set(candidates.map((c) => c.surveyId)).size !== 1 || candidates.some((c) => !c.observationIds.length)) return false;
    const evidence = groupEvidence(candidates, observations);
    if (evidence.some((o) => o.surveyId !== candidates[0].surveyId)) return false;
    if (new Set(evidence.map((o) => o.photoId)).size !== evidence.length) return false;
    const links = new Set(candidates.filter((c) => c.linkedOsmId != null).map((c) => `${c.linkedOsmType ?? 'node'}/${c.linkedOsmId}`));
    return links.size <= 1;
  } catch { return false; }
}

export function mergeCandidateGroup(survey: Survey, target: FeatureCandidate, source: FeatureCandidate, observations: Observation[]): FeatureCandidate {
  if (!canGroupCandidates([target, source], observations)) throw new Error('These candidates cannot be merged');
  const evidence = groupEvidence([target, source], observations);
  const merged = structuredClone(target);
  merged.observationIds = evidence.map((o) => o.id);
  merged.mergeSources = [target, source].flatMap((c) => structuredClone(c.mergeSources ?? [c]));
  merged.tags = { ...source.tags, ...target.tags }; // explicitly documented target precedence
  merged.name = target.name ?? source.name;
  merged.featureType = target.featureType === 'unknown' ? source.featureType : target.featureType;
  merged.analyzer = target.analyzer === source.analyzer ? target.analyzer : 'mixed';
  if (target.analyzerModel !== source.analyzerModel) delete merged.analyzerModel;
  merged.tagConfidence = Math.min(target.tagConfidence, source.tagConfidence);
  merged.warnings = [...new Set([...target.warnings, ...source.warnings])];
  const tagWarnings = [...new Set([...target.warnings, ...source.warnings].filter((w) => w.startsWith('Tag conflict:')))];
  for (const [key, value] of Object.entries(source.tags)) {
    if (target.tags[key] != null && target.tags[key] !== value) tagWarnings.push(`Tag conflict: ${key}=${value}; retained ${target.tags[key]}`);
  }
  const linked = [target, source].find((c) => c.linkedOsmId != null);
  if (linked) {
    Object.assign(merged, { lat: linked.lat, lon: linked.lon, status: linked.status, linkedOsmId: linked.linkedOsmId, linkedOsmType: linked.linkedOsmType, positionSolution: linked.positionSolution, positionConfidence: linked.positionConfidence, positionQuality: linked.positionQuality, positionUncertaintyMeters: linked.positionUncertaintyMeters });
    merged.osmMatches = linked.osmMatches;
  } else {
    const rays = evidence.flatMap((obs) => {
      const photo = survey.photos.find((p) => p.id === obs.photoId);
      const ray = photo ? rayFromPhoto(photo, obs) : null;
      return ray ? [ray] : [];
    });
    // Do not leave stale single-photo solutions or nearby matches on the new estimate.
    delete merged.positionSolution;
    merged.osmMatches = [];
    if (rays.length) {
      const estimate = estimatePosition(rays);
      Object.assign(merged, { lat: estimate.lat, lon: estimate.lon, positionConfidence: estimate.positionConfidence, positionQuality: estimate.positionQuality, positionUncertaintyMeters: estimate.uncertaintyMeters });
      merged.warnings = estimate.warnings;
      merged.positionSolution = { estimatedPosition: { lat: estimate.lat, lon: estimate.lon }, uncertaintyMeters: estimate.uncertaintyMeters, positionQuality: estimate.positionQuality, evidence: [{ source: rays.some((r) => r.hasHeading) ? 'ray-projection' : estimate.positionQuality === 'no-orientation' ? 'gps-track' : 'distance-estimate', label: 'Position estimated from grouped photos' }] };
    } else {
      delete merged.lat; delete merged.lon;
      merged.positionConfidence = 0;
      delete merged.positionQuality; delete merged.positionUncertaintyMeters;
    }
  }
  merged.warnings.push(...tagWarnings);
  merged.warnings.push('Grouped by reviewer — verify the provisional position and tags.');
  return merged;
}
