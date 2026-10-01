import { describe, expect, it } from 'vitest';
import {
  FEATURE_CLASSES,
  commonValuesFor,
  defaultTagsFor,
  definingKeysFor,
  getFeatureClass,
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
