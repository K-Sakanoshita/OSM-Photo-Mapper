import type { FeatureCandidate } from '../types';

export interface PinUndo {
  candidateId: string;
  group?: { before: FeatureCandidate[]; afterIds: string[] };
  label: string;
  before?: Partial<FeatureCandidate>;
  deleted?: FeatureCandidate;
  index?: number;
}

export function pinUndoBefore(candidate: FeatureCandidate, merge = false): PinUndo {
  return {
    candidateId: candidate.id,
    label: merge ? 'Undo merge' : 'Undo pin move',
    before: structuredClone({
      lat: candidate.lat, lon: candidate.lon,
      positionConfidence: candidate.positionConfidence, warnings: candidate.warnings,
      ...(merge ? { status: candidate.status, linkedOsmId: candidate.linkedOsmId,
        linkedOsmType: candidate.linkedOsmType, tags: candidate.tags, osmMatches: candidate.osmMatches } : {})
    })
  };
}

export function restorePinUndo(entry: PinUndo, current?: FeatureCandidate): FeatureCandidate | undefined {
  if (entry.deleted) return structuredClone(entry.deleted);
  return entry.before && current ? { ...current, ...structuredClone(entry.before) } : undefined;
}
