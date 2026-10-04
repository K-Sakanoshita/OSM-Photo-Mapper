import { describe, expect, it } from 'vitest';
import { FEATURE_CLASSES } from '../src/analysis/feature-classes';
import { POI_CATEGORIES, POI_ENTRIES, matchPoiKeyword } from '../src/analysis/poi-catalog';

describe('POI catalog', () => {
  it('keeps documented major categories and unique, mapped entries', () => {
    expect(POI_CATEGORIES.length).toBeGreaterThanOrEqual(8);
    expect(POI_ENTRIES.length).toBeGreaterThanOrEqual(70);
    expect(new Set(POI_CATEGORIES.map((category) => category.id)).size).toBe(POI_CATEGORIES.length);
    expect(new Set(POI_ENTRIES.map((entry) => entry.id)).size).toBe(POI_ENTRIES.length);
    for (const category of POI_CATEGORIES) {
      expect(category.wiki).toMatch(/^https:\/\/wiki\.openstreetmap\.org\//);
      expect(category.taginfo).toMatch(/^https:\/\/taginfo\.openstreetmap\.org\//);
      for (const entry of category.entries) {
        expect(FEATURE_CLASSES.some((cls) => cls.id === (entry.featureType ?? entry.id))).toBe(true);
      }
    }
  });

  it('matches a clear category and keyword but leaves ambiguous text unresolved', () => {
    expect(matchPoiKeyword('playground', 'swing')?.tags).toEqual({ playground: 'swing' });
    expect(matchPoiKeyword('playground', 'ブランコ')?.tags).toEqual({ playground: 'swing' });
    expect(matchPoiKeyword('shop', 'bakery')?.tags).toEqual({ shop: 'bakery' });
    expect(matchPoiKeyword('shop', 'storefront')).toBeUndefined();
    expect(matchPoiKeyword('playground', 'playground')).toBeUndefined();
  });
});
