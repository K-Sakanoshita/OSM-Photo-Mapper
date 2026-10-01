import { describe, expect, it } from 'vitest';
import {
  FEATURE_CLASSES,
  applyMappingToTags,
  commonValuesFor,
  defaultTagsFor,
  definingKeysFor,
  findChosenMapping,
  getFeatureClass,
  geometryPreferenceFor,
  mappingsFor,
  mergeTags,
  suggestedTagsFor
} from '../src/analysis/feature-classes';
import type { Observation } from '../src/types';

describe('feature class presets (issue #5)', () => {
  it('AED uses the OSM-conventional emergency=defibrillator, not amenity=', () => {
    expect(defaultTagsFor('aed')).toEqual({ emergency: 'defibrillator' });
    const cls = getFeatureClass('aed');
    expect(cls?.requiredTags['amenity']).toBeUndefined();
  });

  it('waste basket defaults to amenity=waste_basket (not amenity=recycling/bin)', () => {
    expect(defaultTagsFor('waste_basket')).toEqual({ amenity: 'waste_basket' });
    const tags = defaultTagsFor('waste_basket');
    expect(tags.amenity).not.toBe('recycling');
    expect(tags.amenity).not.toBe('bin');
  });

  it('bicycle parking: amenity=... is required, bicycle_parking=<type> is only suggested', () => {
    expect(defaultTagsFor('bicycle_parking')).toEqual({ amenity: 'bicycle_parking' });
    expect(suggestedTagsFor('bicycle_parking')).toEqual({ bicycle_parking: 'frame' });
    // The subtype tag must NOT be applied by default.
    expect('bicycle_parking' in defaultTagsFor('bicycle_parking')).toBe(false);
  });

  it('playground equipment carries NO default/guessed type tag (type must come from analysis/review)', () => {
    expect(defaultTagsFor('playground')).toEqual({});
    // No value may be guessed as a suggestion either — the type is unknown.
    expect(suggestedTagsFor('playground')).toEqual({});
    const cls = getFeatureClass('playground');
    expect(Object.keys(cls?.requiredTags ?? {})).toHaveLength(0);
    // ...but the known-allowed values are offered as a review-time picker.
    const common = commonValuesFor('playground');
    expect(common.playground).toEqual(
      expect.arrayContaining(['slide', 'swing', 'roundabout', 'sandbox', 'other'])
    );
    expect(common.playground).toContain('slide');
  });

  it('definingKeysFor covers required + suggested + common-value keys', () => {
    expect(definingKeysFor('playground')).toEqual(['playground']);
    expect(definingKeysFor('bicycle_parking')).toEqual(
      expect.arrayContaining(['amenity', 'bicycle_parking'])
    );
    expect(definingKeysFor('bench')).toEqual(['amenity']);
    expect(definingKeysFor('nope')).toEqual([]);
  });

  it('vending machine defaults to amenity=vending_machine', () => {
    expect(defaultTagsFor('vending_machine')).toEqual({ amenity: 'vending_machine' });
  });

  it('unknown feature types yield no tags', () => {
    expect(defaultTagsFor('nope')).toEqual({});
    expect(suggestedTagsFor('nope')).toEqual({});
  });

  it('required keys never overlap with suggested or common-value keys within a class', () => {
    for (const cls of FEATURE_CLASSES) {
      for (const k of Object.keys(cls.requiredTags)) {
        expect(k in cls.suggestedTags, `${cls.id}: key ${k} in required+suggested`).toBe(false);
        expect(
          k in (cls.commonValues ?? {}),
          `${cls.id}: key ${k} in required+commonValues`
        ).toBe(false);
      }
    }
  });

  it('defaultTagsFor returns a copy (callers may mutate)', () => {
    const a = defaultTagsFor('bench');
    a.amenity = 'hacked';
    expect(defaultTagsFor('bench')).toEqual({ amenity: 'bench' });
  });
});

describe('mergeTags', () => {
  const obs = (id: string, tagSuggestions: Record<string, string>, tagConfidence: number, featureType = 'bench'): Observation => ({
    id,
    photoId: `photo-${id}`,
    surveyId: 's1',
    featureType,
    bbox: { x: 0, y: 0, w: 1, h: 1 },
    tagSuggestions,
    tagConfidence
  });

  it('merges suggestions across observations of the same object', () => {
    expect(mergeTags([obs('a', { amenity: 'bench' }, 0.5), obs('b', { name: 'Park bench' }, 0.9)])).toEqual({
      amenity: 'bench',
      name: 'Park bench'
    });
  });

  it('keeps a non-empty value over a later empty one', () => {
    // playground has no required defaults, so the result is exactly the suggestion.
    expect(mergeTags([
      obs('a', { playground: 'slide' }, 0.5, 'playground'),
      obs('b', { playground: '' }, 0.9, 'playground')
    ])).toEqual({ playground: 'slide' });
  });

  it('fills in required class defaults for keys never suggested', () => {
    expect(mergeTags([obs('a', { name: 'Park bench' }, 0.9)])).toEqual({
      amenity: 'bench',
      name: 'Park bench'
    });
  });
});

describe('issue #9: expanded class set, geometry policy, review-only mappings', () => {
  it('defines 22 classes, each with category, autoTag and geometryPreference', () => {
    expect(FEATURE_CLASSES).toHaveLength(22);
    for (const cls of FEATURE_CLASSES) {
      expect(cls.category, cls.id).toBeTruthy();
      expect(typeof cls.autoTag, cls.id).toBe('boolean');
      expect(['node', 'area', 'either', 'existing-only'], cls.id).toContain(cls.geometryPreference);
    }
  });

  it('covers the feature categories required by the issue', () => {
    for (const id of [
      'bench', 'waste_basket', 'street_lamp', 'drinking_water', 'information_board',
      'bollard', 'manhole', 'clock',
      'aed', 'fire_hydrant', 'fire_extinguisher', 'fire_hose',
      'torii', 'stone_lantern', 'komainu',
      'statue', 'playground', 'playground_area',
      'bicycle_parking', 'bicycle_repair_station', 'vending_machine', 'toilets'
    ]) {
      expect(getFeatureClass(id), `missing class ${id}`).toBeDefined();
    }
  });

  it('groups classes into hierarchical categories', () => {
    const cats = new Set(FEATURE_CLASSES.map((c) => c.category));
    for (const cat of [
      'street_furniture', 'emergency', 'religious', 'playground',
      'transport', 'business', 'amenities', 'artwork_memorial'
    ]) {
      expect(cats.has(cat), `missing category ${cat}`).toBe(true);
    }
  });

  it('review-only classes never have default tags', () => {
    const reviewOnly = FEATURE_CLASSES.filter((c) => !c.autoTag).map((c) => c.id);
    expect(reviewOnly.sort()).toEqual(['komainu', 'statue', 'stone_lantern']);
    for (const id of reviewOnly) {
      expect(defaultTagsFor(id), id).toEqual({});
    }
  });

  it('established conventions are autoTag; ambiguous ones are review-only', () => {
    for (const id of [
      'street_lamp', 'clock', 'torii', 'fire_hydrant', 'fire_extinguisher',
      'fire_hose', 'bollard', 'manhole'
    ]) {
      expect(getFeatureClass(id)!.autoTag, id).toBe(true);
    }
    for (const id of ['stone_lantern', 'komainu', 'statue']) {
      expect(getFeatureClass(id)!.autoTag, id).toBe(false);
    }
  });

  it('exposes candidate mappings for ambiguous classes', () => {
    expect(mappingsFor('stone_lantern')).toEqual([
      { label: 'historic=stone_lantern', tags: { historic: 'stone_lantern' } },
      { label: 'man_made=stone_lantern', tags: { man_made: 'stone_lantern' } }
    ]);
    expect(mappingsFor('statue')).toHaveLength(2);
    expect(mappingsFor('komainu')).toEqual([]);
    expect(mappingsFor('bench')).toEqual([]);
  });

  it('geometry preferences: point features are node/either; playground facility is area', () => {
    expect(geometryPreferenceFor('playground_area')).toBe('area');
    expect(geometryPreferenceFor('bench')).toBe('node');
    expect(geometryPreferenceFor('bollard')).toBe('either');
    expect(geometryPreferenceFor('bicycle_repair_station')).toBe('either');
    expect(geometryPreferenceFor('unknown_type')).toBe('node');
  });

  it('definingKeysFor includes mapping keys for review-only classes', () => {
    expect(definingKeysFor('stone_lantern')).toEqual(expect.arrayContaining(['historic', 'man_made']));
    expect(definingKeysFor('statue')).toEqual(
      expect.arrayContaining(['tourism', 'artwork_type', 'historic', 'memorial'])
    );
    expect(definingKeysFor('komainu')).toEqual([]);
  });

  describe('applyMappingToTags', () => {
    const mappings = mappingsFor('stone_lantern');
    const [historicM, manMadeM] = mappings;

    it('applies the chosen mapping to an empty tag set', () => {
      expect(applyMappingToTags({}, historicM, mappings)).toEqual({ historic: 'stone_lantern' });
    });

    it('removes the other mapping\'s key when switching (value still matches it)', () => {
      expect(applyMappingToTags({ historic: 'stone_lantern' }, manMadeM, mappings))
        .toEqual({ man_made: 'stone_lantern' });
    });

    it('never clobbers manually-set values', () => {
      expect(applyMappingToTags({ historic: 'custom' }, manMadeM, mappings))
        .toEqual({ historic: 'custom', man_made: 'stone_lantern' });
    });

    it('handles multi-key mappings (statue)', () => {
      const statueM = mappingsFor('statue');
      const [artwork, memorial] = statueM;
      expect(applyMappingToTags({}, artwork, statueM))
        .toEqual({ tourism: 'artwork', artwork_type: 'statue' });
      expect(applyMappingToTags({ tourism: 'artwork', artwork_type: 'statue' }, memorial, statueM))
        .toEqual({ historic: 'memorial', memorial: 'statue' });
    });
  });

  describe('findChosenMapping', () => {
    it('detects the mapping already reflected in the tags', () => {
      const sl = mappingsFor('stone_lantern');
      expect(findChosenMapping('stone_lantern', { historic: 'stone_lantern' })).toEqual(sl[0]);
      expect(findChosenMapping('stone_lantern', { man_made: 'stone_lantern' })).toEqual(sl[1]);
      const st = mappingsFor('statue');
      expect(findChosenMapping('statue', { tourism: 'artwork', artwork_type: 'statue', name: 'X' }))
        .toEqual(st[0]);
    });

    it('returns null when no mapping matches', () => {
      expect(findChosenMapping('stone_lantern', {})).toBeNull();
      expect(findChosenMapping('stone_lantern', { historic: 'other' })).toBeNull();
      expect(findChosenMapping('komainu', { historic: 'sculpture' })).toBeNull();
      expect(findChosenMapping('bench', { amenity: 'bench' })).toBeNull();
    });
  });
});
