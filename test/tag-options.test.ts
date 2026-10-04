import { describe, expect, it } from 'vitest';
import { tagKeys, tagValues } from '../src/map/tag-options';

describe('configured tag choices', () => {
  it('includes catalog and icon tags, including subtype choices', () => {
    expect(tagKeys()).toContain('playground');
    expect(tagValues('playground')).toContain('swing');
    expect(tagValues('amenity')).toContain('bench');
    expect(tagValues('shop')).toContain('convenience');
  });
  it('excludes rendering wildcards and returns unique sorted choices', () => {
    expect(tagKeys()).not.toContain('*');
    for (const key of tagKeys()) {
      const values = tagValues(key);
      expect(values).not.toContain('*');
      expect(values).toEqual([...new Set(values)].sort());
    }
    expect(tagValues('custom:unknown')).toEqual([]);
  });
});
