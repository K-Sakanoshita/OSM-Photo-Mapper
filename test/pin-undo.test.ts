import { describe, expect, it } from 'vitest';
import type { FeatureCandidate } from '../src/types';
import { pinUndoBefore, restorePinUndo } from '../src/map/pin-undo';
import { mergeCandidateWithOsm } from '../src/osm/merge-candidate';

function candidate(): FeatureCandidate {
  return { id: 'c1', surveyId: 's1', analyzer: 'openai', featureType: 'playground',
    lat: 34, lon: 134, positionConfidence: 0.8, tagConfidence: 0.99,
    tags: { playground: 'swing' }, observationIds: [], osmMatches: [], warnings: [], status: 'new' };
}

describe('pin undo', () => {
  it('restores moves in reverse order while preserving later tag edits', () => {
    const c = candidate();
    const first = pinUndoBefore(c);
    c.lat = 35;
    c.positionConfidence = 0.3;
    c.warnings.push('Manually moved');
    const second = pinUndoBefore(c);
    c.lat = 36;
    c.tags.material = 'metal';
    const restoredSecond = restorePinUndo(second, c)!;
    expect(restoredSecond.lat).toBe(35);
    const restoredFirst = restorePinUndo(first, restoredSecond)!;
    expect(restoredFirst).toMatchObject({ lat: 34, lon: 134, positionConfidence: 0.8, warnings: [],
      tags: { playground: 'swing', material: 'metal' } });
  });
  it('undoes OSM merge including links, tags, position and discarded nearby matches', () => {
    const c = candidate();
    const match = { osmType: 'node' as const, osmId: 42, lat: 35, lon: 135,
      tags: { playground: 'basketswing', operator: 'City' }, matchScore: 0.98 };
    c.osmMatches = [match, { ...match, osmId: 43 }];
    const original = structuredClone(c);
    const undo = pinUndoBefore(c, true);
    mergeCandidateWithOsm(c, match);
    const restored = restorePinUndo(undo, c)!;
    expect(restored).toMatchObject(original);
    expect(restored.linkedOsmId).toBeUndefined();
    expect(restored.linkedOsmType).toBeUndefined();
    expect(restored.tags).toEqual(original.tags);
    expect(restored.osmMatches).toHaveLength(2);
  });
  it('removes a custom pin when undoing its addition', () => {
    expect(restorePinUndo({ candidateId: 'c1', label: 'Undo add pin' }, candidate())).toBeUndefined();
  });
});
