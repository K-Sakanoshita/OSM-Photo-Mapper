import { describe, expect, it } from 'vitest';
import {
  areaBBox,
  annotateCandidate,
  buildQueryForArea,
  buildTagClauses,
  scoreTagsForClass,
  toOsmMatch,
  type LatLon,
  type OverpassElement
} from '../src/osm/overpass';
import type { OsmMatch } from '../src/types';
import { distanceMeters } from '../src/analysis/position';

describe('buildTagClauses (issue #5)', () => {
  const clauses = buildTagClauses();

  it('emits an exact-match clause for single-value keys', () => {
    // Keys used by only one value get "="; amenity is shared by many classes.
    expect(clauses).toContain('["emergency"="defibrillator"]');
    expect(clauses).toContain('["tourism"="information"]');
  });

  it('emits an anchored alternation regex for multi-value keys', () => {
    const amenity = clauses.find((c) => c.startsWith('["amenity"~'));
    expect(amenity).toBeDefined();
    expect(amenity).toContain('~"^('); // anchored alternation
    expect(amenity).toMatch(/\)\$"\]$/); // anchored at end
    for (const v of ['bench', 'toilets', 'waste_basket', 'vending_machine', 'drinking_water', 'bicycle_parking']) {
      expect(amenity).toContain(v);
    }
  });

  it('emits a key-presence clause for classes with no required tags (playground)', () => {
    expect(clauses).toContain('["playground"~".+"]');
  });

  it('emits one clause per distinct tag key', () => {
    const keys = new Set(clauses.map((c) => c.match(/^["\[]("?)([a-z_]+)\1[="~]/)?.[2]));
    expect(keys).toEqual(new Set(['amenity', 'emergency', 'tourism', 'playground']));
  });
});

describe('buildQueryForArea (issue #5)', () => {
  it('queries node and way selectors for all clauses inside the bbox', () => {
    const q = buildQueryForArea(48.80, 2.20, 48.82, 2.24);
    expect(q).toContain('[out:json][timeout:25]');
    expect(q).toContain('48.800000,2.200000,48.820000,2.240000');
    // `out body center` so nodes carry lat/lon and ways carry a centroid —
    // every returned element must yield usable coordinates (issue #5).
    expect(q).toContain('out body center;');
    expect(q).not.toContain('out tags');
    // one node + one way selector per clause
    expect(q.match(/node\(/g)?.length).toBe(buildTagClauses().length);
    expect(q.match(/way\(/g)?.length).toBe(buildTagClauses().length);
  });
});

describe('toOsmMatch (issue #5: node lat/lon vs way center)', () => {
  it('maps a node element using its own lat/lon', () => {
    const el: OverpassElement = {
      type: 'node',
      id: 55,
      lat: 48.8123,
      lon: 2.3321,
      tags: { amenity: 'bench' }
    };
    expect(toOsmMatch(el)).toEqual({
      osmType: 'node',
      osmId: 55,
      lat: 48.8123,
      lon: 2.3321,
      tags: { amenity: 'bench' },
      matchScore: 0
    });
  });

  it('maps a way element using its centroid (out body center)', () => {
    const el: OverpassElement = {
      type: 'way',
      id: 77,
      center: { lat: 48.85, lon: 2.35 },
      tags: { playground: 'slide' }
    };
    const m = toOsmMatch(el);
    expect(m?.osmType).toBe('way');
    expect(m?.osmId).toBe(77);
    expect(m?.lat).toBe(48.85);
    expect(m?.lon).toBe(2.35);
    expect(m?.tags).toEqual({ playground: 'slide' });
  });

  it('drops elements without usable coordinates', () => {
    expect(toOsmMatch({ type: 'way', id: 88, tags: { amenity: 'bench' } })).toBeNull();
    expect(toOsmMatch({ type: 'node', id: 99, tags: {} })).toBeNull();
  });

  it('defaults missing tags to an empty object', () => {
    expect(toOsmMatch({ type: 'node', id: 1, lat: 10, lon: 20 })?.tags).toEqual({});
  });
});

describe('areaBBox', () => {
  it('pads a single point symmetrically (meters -> degrees)', () => {
    const box = areaBBox([{ lat: 48.8, lon: 2.3 }], 100)!;
    const dLat = 100 / 111320;
    expect(box.minLat).toBeCloseTo(48.8 - dLat, 9);
    expect(box.maxLat).toBeCloseTo(48.8 + dLat, 9);
    const dLon = 100 / (111320 * Math.cos((48.8 * Math.PI) / 180));
    expect(box.minLon).toBeCloseTo(2.3 - dLon, 9);
    expect(box.maxLon).toBeCloseTo(2.3 + dLon, 9);
  });

  it('covers all points', () => {
    const pts: LatLon[] = [
      { lat: 48.8, lon: 2.2 },
      { lat: 48.9, lon: 2.4 }
    ];
    const box = areaBBox(pts, 0)!;
    expect(box.minLat).toBe(48.8);
    expect(box.maxLat).toBe(48.9);
    expect(box.minLon).toBe(2.2);
    expect(box.maxLon).toBe(2.4);
  });

  it('returns null for no points', () => {
    expect(areaBBox([], 100)).toBeNull();
  });
});

describe('scoreTagsForClass (issue #5: score against ONE class)', () => {
  it('scores 1.0 for an exact match of all required tags', () => {
    expect(scoreTagsForClass({ emergency: 'defibrillator' }, 'aed')).toBe(1);
    expect(scoreTagsForClass({ amenity: 'bench', name: 'x' }, 'bench')).toBe(1);
  });

  it('scores 0 for cross-class objects', () => {
    expect(scoreTagsForClass({ amenity: 'bench' }, 'vending_machine')).toBe(0);
    expect(scoreTagsForClass({ amenity: 'vending_machine' }, 'bench')).toBe(0);
  });

  it('ignores extra non-required tags (score is over required tags only)', () => {
    expect(scoreTagsForClass({ amenity: 'bench', bench: 'wooden', name: 'x' }, 'bench')).toBe(1);
  });

  it('scores 0 when a required key is missing', () => {
    expect(scoreTagsForClass({ tourism: 'guide_post' }, 'information_board')).toBe(0);
  });

  it('falls back to key presence for classes without required tags', () => {
    expect(scoreTagsForClass({ playground: 'slide' }, 'playground')).toBe(1);
    expect(scoreTagsForClass({ playground: 'swing' }, 'playground')).toBe(1);
    expect(scoreTagsForClass({ leisure: 'playground' }, 'playground')).toBe(0);
    expect(scoreTagsForClass({ amenity: 'bench' }, 'playground')).toBe(0);
  });

  it('scores 0 for unknown feature types', () => {
    expect(scoreTagsForClass({ amenity: 'bench' }, 'unknown_type')).toBe(0);
  });
});

function match(osmId: number, tags: Record<string, string>, lat: number, lon: number): OsmMatch {
  return { osmType: 'node', osmId, lat, lon, tags, matchScore: 0 };
}

describe('annotateCandidate (issue #5: per-candidate, class-aware ranking)', () => {
  // ~111,320 m per degree of latitude.
  const mToDegLat = (m: number) => m / 111320;

  it('ranks a true class match above a closer cross-class object', () => {
    const cand = { featureType: 'bench', lat: 48.8, lon: 2.3 };
    const bench = match(1, { amenity: 'bench' }, 48.8 + mToDegLat(22), 2.3);
    const vending = match(2, { amenity: 'vending_machine' }, 48.8 + mToDegLat(11), 2.3);
    const out = annotateCandidate(cand, [vending, bench], 120);
    expect(out[0].osmId).toBe(1); // bench wins despite being farther
    expect(out[0].matchScore).toBeGreaterThan(out[1].matchScore);
    // expected blend: 0.6*tag + 0.4*proximity (distance via haversine)
    const dBench = distanceMeters(cand.lat!, cand.lon!, bench.lat, bench.lon);
    const dVending = distanceMeters(cand.lat!, cand.lon!, vending.lat, vending.lon);
    expect(out[0].matchScore).toBeCloseTo(0.6 * 1 + 0.4 * (1 - dBench / 120), 9);
    expect(out[1].matchScore).toBeCloseTo(0.6 * 0 + 0.4 * (1 - dVending / 120), 9);
  });

  it('drops objects outside the radius', () => {
    const cand = { featureType: 'bench', lat: 48.8, lon: 2.3 };
    const far = match(3, { amenity: 'bench' }, 48.8 + mToDegLat(500), 2.3);
    expect(annotateCandidate(cand, [far], 120)).toEqual([]);
  });

  it('returns [] when the candidate has no position', () => {
    const cand = { featureType: 'bench', lat: undefined, lon: undefined };
    expect(annotateCandidate(cand, [match(1, { amenity: 'bench' }, 48.8, 2.3)], 120)).toEqual([]);
  });

  it('keeps at most 5 matches, best first', () => {
    const cand = { featureType: 'bench', lat: 48.8, lon: 2.3 };
    const many = Array.from({ length: 8 }, (_, i) =>
      match(10 + i, { amenity: 'bench' }, 48.8 + mToDegLat(5 + i * 10), 2.3)
    );
    const out = annotateCandidate(cand, many, 120);
    expect(out).toHaveLength(5);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].matchScore).toBeGreaterThanOrEqual(out[i].matchScore);
    }
  });
});
