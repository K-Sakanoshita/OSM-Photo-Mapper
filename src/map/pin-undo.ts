import type { FeatureCandidate } from '../types';

export interface PinUndo {
  candidateId: string;
  label: string;
  before?: Partial<FeatureCandidate>;
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

export function restorePinUndo(entry: PinUndo, current: FeatureCandidate): FeatureCandidate | undefined {
  return entry.before ? { ...current, ...structuredClone(entry.before) } : undefined;
}
