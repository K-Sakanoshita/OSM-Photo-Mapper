import { describe, expect, it } from 'vitest';
import { decideSnap } from '../src/analysis/snap-decision';
import type { OsmMatch } from '../src/types';

const LAT = 48.81;
const LON = 2.33;

function match(osmId: number, dEastM: number, dNorthM: number, tags: Record<string, string>): OsmMatch {
  return {
    osmType: 'node',
    osmId,
    lat: LAT + dNorthM / 111320,
    lon: LON + dEastM / (111320 * Math.cos((LAT * Math.PI) / 180)),
    tags,
    matchScore: 0
  };
}

const BENCH = { amenity: 'bench' };
const VENDING = { amenity: 'vending_machine', drink: 'water' };

describe('decideSnap', () => {
  it('snaps to a strong, unique same-class object within the uncertainty', () => {
    const res = decideSnap({
      lat: LAT,
      lon: LON,
      featureType: 'bench',
      uncertaintyM: 5,
      matches: [match(101, 3, 0, BENCH)]
    });
    expect(res).not.toBeNull();
    expect(res!.osm.osmId).toBe(101);
    expect(res!.snappedPosition.lat).toBeCloseTo(res!.osm.lat, 9);
    // dMax = max(5, 8) = 8; confidence = 0.5 + 0.5*(1 - d/8) with d ~ 3 m.
    // (haversine vs degree-approx placement differs by < 0.1%) -> tolerance 1e-2
    expect(res!.confidence).toBeGreaterThan(0.80);
    expect(res!.confidence).toBeLessThan(0.83);
    expect(res!.evidence.source).toBe('osm-object');
  });

  it('does not snap when two same-class objects compete', () => {
    const res = decideSnap({
      lat: LAT,
      lon: LON,
      featureType: 'bench',
      uncertaintyM: 5,
      matches: [match(101, 3, 0, BENCH), match(102, -4, 1, BENCH)]
    });
    expect(res).toBeNull();
  });

  it('does not snap when the match is outside the uncertainty bound', () => {
    const res = decideSnap({
      lat: LAT,
      lon: LON,
      featureType: 'bench',
      uncertaintyM: 5,
      matches: [match(101, 20, 0, BENCH)]
    });
    expect(res).toBeNull();
  });

  it('does not snap to a different feature class (cross-class match)', () => {
    // A vending machine 2 m away is NOT the bench candidate: scored against
    // the candidate's own class it gets tagScore 0.
    const res = decideSnap({
      lat: LAT,
      lon: LON,
      featureType: 'bench',
      uncertaintyM: 5,
      matches: [match(201, 2, 0, VENDING)]
    });
    expect(res).toBeNull();
  });

  it('snaps when a plausible competitor is far outside the competition range', () => {
    const res = decideSnap({
      lat: LAT,
      lon: LON,
      featureType: 'bench',
      uncertaintyM: 5,
      matches: [match(101, 3, 0, BENCH), match(102, 60, 0, BENCH)]
    });
    expect(res).not.toBeNull();
    expect(res!.osm.osmId).toBe(101);
  });

  it('uses the 8 m uncertainty floor', () => {
    // Uncertainty 2 m, object 5 m away: dMax = 8 -> snap allowed.
    const res = decideSnap({
      lat: LAT,
      lon: LON,
      featureType: 'bench',
      uncertaintyM: 2,
      matches: [match(101, 5, 0, BENCH)]
    });
    expect(res).not.toBeNull();
  });
});
