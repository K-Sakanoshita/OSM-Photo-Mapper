import { describe, expect, it } from 'vitest';
import { iconForTags } from '../src/map/tag-icon';

describe('tag-based map icons', () => {
  it('uses the supplied mappings and fallback', () => {
    expect(iconForTags({ playground: 'swing' })).toBe('playground.png');
    expect(iconForTags({ playground: 'slide' })).toBe('slide.png');
    expect(iconForTags({ amenity: 'bench' })).toBe('bench.png');
    expect(iconForTags({})).toBe('marker-stroked.png');
  });
  it('applies subtags only within their matching parent', () => {
    expect(iconForTags({ man_made: 'ceremonial_gate', ceremonial_gate: 'torii' })).toBe('torii.png');
    expect(iconForTags({ ceremonial_gate: 'torii' })).toBe('marker-stroked.png');
    expect(iconForTags({ amenity: 'place_of_worship', religion: 'shinto' })).toBe('torii.png');
  });
});
