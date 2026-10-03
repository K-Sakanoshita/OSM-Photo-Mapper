import { describe, expect, it } from 'vitest';
import { validateCandidateExport, AREA_BLOCK_REASON } from '../src/analysis/export-validation';
import { FEATURE_CLASSES, applyMappingToTags, mappingsFor } from '../src/analysis/feature-classes';
import type { FeatureCandidate } from '../src/types';

let n = 0;
function candidate(overrides: Partial<FeatureCandidate> = {}): FeatureCandidate {
  n += 1;
  return {
    id: `cand-${n}`,
    surveyId: 's1',
    analyzer: 'openai',
    featureType: 'bench',
    lat: 35.68,
    lon: 139.76,
    positionConfidence: 0.5,
    tagConfidence: 0.5,
    tags: { amenity: 'bench' },
    observationIds: [],
    osmMatches: [],
    warnings: [],
    status: 'new',
    ...overrides
  };
}

function classOf(id: string) {
  return FEATURE_CLASSES.find((c) => c.id === id)!;
}

describe('validateCandidateExport (issue #11)', () => {
  describe('required class tags', () => {
    it('new bench with required amenity=bench is exportable', () => {
      const v = validateCandidateExport(candidate());
      expect(v.exportable).toBe(true);
      expect(v.gate).toBeUndefined();
    });

    it('bench with the required tag removed is blocked (semantics gate)', () => {
      const v = validateCandidateExport(candidate({ tags: { name: 'Some Bench' } }));
      expect(v.exportable).toBe(false);
      expect(v.gate).toBe('semantics');
      expect(v.reason).toContain('amenity=bench');
    });

    it('bench whose required tag value was changed is blocked', () => {
      const v = validateCandidateExport(candidate({ tags: { amenity: 'seating' } }));
      expect(v.exportable).toBe(false);
      expect(v.gate).toBe('semantics');
    });

    it('multi-tag class (torii) requires ALL required tags', () => {
      const c = classOf('torii');
      expect(c.requiredTags).toEqual({ man_made: 'ceremonial_gate', ceremonial_gate: 'torii' });
      const v = validateCandidateExport(
        candidate({ featureType: 'torii', tags: { man_made: 'ceremonial_gate' } })
      );
      expect(v.exportable).toBe(false);
      expect(v.reason).toContain('ceremonial_gate=torii');
      const ok = validateCandidateExport(
        candidate({ featureType: 'torii', tags: { ...c.requiredTags } })
      );
      expect(ok.exportable).toBe(true);
    });
  });

  describe('defining review value (generic playground)', () => {
    it('generic playground with no playground=* is blocked', () => {
      const v = validateCandidateExport(candidate({ featureType: 'playground', tags: {} }));
      expect(v.exportable).toBe(false);
      expect(v.gate).toBe('semantics');
      expect(v.reason).toContain('playground=*');
    });

    it('playground after selecting playground=slide is exportable', () => {
      const v = validateCandidateExport(
        candidate({ featureType: 'playground', tags: { playground: 'slide' } })
      );
      expect(v.exportable).toBe(true);
    });

    it('playground with only name=Foo is still blocked', () => {
      const v = validateCandidateExport(
        candidate({ featureType: 'playground', tags: { name: 'Foo' } })
      );
      expect(v.exportable).toBe(false);
      expect(v.gate).toBe('semantics');
      expect(v.reason).toContain('playground=*');
    });

    it('classes with optional commonValues and required tags are unaffected (toilets)', () => {
      const v = validateCandidateExport(
        candidate({ featureType: 'toilets', tags: { amenity: 'toilets' } })
      );
      // access=*/fee=* are optional details, not defining values.
      expect(v.exportable).toBe(true);
    });
  });

  describe('review-only classes (autoTag=false)', () => {
    it('statue with no mapping and no tags is blocked', () => {
      const v = validateCandidateExport(candidate({ featureType: 'statue', tags: {} }));
      expect(v.exportable).toBe(false);
      expect(v.gate).toBe('semantics');
      expect(v.reason).toContain('mapping');
    });

    it('statue after choosing the artwork mapping is exportable', () => {
      const mappings = mappingsFor('statue');
      const artwork = mappings.find((m) => m.tags.tourism === 'artwork')!;
      const v = validateCandidateExport(
        candidate({ featureType: 'statue', tags: applyMappingToTags({}, artwork, mappings) })
      );
      expect(v.exportable).toBe(true);
    });

    it('statue after choosing the memorial mapping is exportable', () => {
      const mappings = mappingsFor('statue');
      const memorial = mappings.find((m) => m.tags.historic === 'memorial')!;
      const v = validateCandidateExport(
        candidate({ featureType: 'statue', tags: applyMappingToTags({}, memorial, mappings) })
      );
      expect(v.exportable).toBe(true);
    });

    it('statue with only name=Foo is still blocked', () => {
      const v = validateCandidateExport(
        candidate({ featureType: 'statue', tags: { name: 'Foo' } })
      );
      expect(v.exportable).toBe(false);
      expect(v.gate).toBe('semantics');
    });

    it('stone lantern with manually entered meaningful semantic tag is exportable', () => {
      const v = validateCandidateExport(
        candidate({ featureType: 'stone_lantern', tags: { historic: 'stone_lantern' } })
      );
      expect(v.exportable).toBe(true);
    });

    it('stone lantern with only name=Foo is still blocked', () => {
      const v = validateCandidateExport(
        candidate({ featureType: 'stone_lantern', tags: { name: 'Foo' } })
      );
      expect(v.exportable).toBe(false);
      expect(v.gate).toBe('semantics');
    });

    it('komainu with no tags is blocked', () => {
      const v = validateCandidateExport(candidate({ featureType: 'komainu', tags: {} }));
      expect(v.exportable).toBe(false);
      expect(v.gate).toBe('semantics');
    });
  });

  describe('unknown feature types', () => {
    it('unknown type with a meaningful tag is exportable', () => {
      const v = validateCandidateExport(
        candidate({ featureType: 'mystery', tags: { random: 'tag' } })
      );
      expect(v.exportable).toBe(true);
    });

    it('unknown type with empty tags is blocked', () => {
      const v = validateCandidateExport(candidate({ featureType: 'mystery', tags: {} }));
      expect(v.exportable).toBe(false);
      expect(v.gate).toBe('semantics');
    });
  });

  describe('gate separation', () => {
    it('geometry blocks take the geometry gate with the area reason', () => {
      const v = validateCandidateExport(
        candidate({ featureType: 'playground_area', tags: {} })
      );
      expect(v.exportable).toBe(false);
      expect(v.gate).toBe('geometry');
      expect(v.reason).toBe(AREA_BLOCK_REASON);
    });

    it('geometry and semantics reasons are distinguishable', () => {
      const geom = validateCandidateExport(
        candidate({ featureType: 'playground_area', tags: { leisure: 'playground' } })
      );
      const sem = validateCandidateExport(candidate({ featureType: 'playground', tags: {} }));
      expect(geom.gate).toBe('geometry');
      expect(sem.gate).toBe('semantics');
      expect(geom.reason).not.toBe(sem.reason);
    });
  });
});
