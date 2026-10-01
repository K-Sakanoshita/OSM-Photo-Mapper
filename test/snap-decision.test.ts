import { describe, expect, it } from 'vitest';
import {
  AUTO_SNAP_MAX_DISTANCE_M,
  decideSnap,
  identifyingTagConflicts,
  type SnapInput
} from '../src/analysis/snap-decision';
import { scoreTagsForClass } from '../src/osm/overpass';
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

function input(overrides: Partial<SnapInput> & { featureType: string }): SnapInput {
  return {
    lat: LAT,
    lon: LON,
    uncertaintyM: 5,
    matches: [],
    candidateTags: {},
    ...overrides
  };
}

const BENCH = { amenity: 'bench' };
const VENDING = { amenity: 'vending_machine', drink: 'water' };

describe('decideSnap', () => {
  it('snaps to a strong, unique same-class object within the radius', () => {
    const res = decideSnap(
      input({ featureType: 'bench', uncertaintyM: 5, candidateTags: { ...BENCH }, matches: [match(101, 2, 0, BENCH)] })
    );
    expect(res).not.toBeNull();
    expect(res!.osm.osmId).toBe(101);
    expect(res!.snappedPosition.lat).toBeCloseTo(res!.osm.lat, 9);
    // dMax = min(5, 3) = 3; confidence = 0.5 + 0.5*(1 - d/3) with d ~ 2 m
    // -> ~0.67. (haversine vs degree-approx placement differs by < 0.1%.)
    expect(res!.confidence).toBeGreaterThan(0.65);
    expect(res!.confidence).toBeLessThan(0.69);
    expect(res!.evidence.source).toBe('osm-object');
  });

  it('low confidence never widens the snap radius (hard cap)', () => {
    // Uncertainty 33 m (worst case) must NOT allow snapping to an object
    // 8 m away: dMax = min(33, 3) = 3.
    const res = decideSnap(
      input({ featureType: 'bench', uncertaintyM: 33, candidateTags: { ...BENCH }, matches: [match(101, 8, 0, BENCH)] })
    );
    expect(res).toBeNull();
    expect(AUTO_SNAP_MAX_DISTANCE_M).toBe(3);
  });

  it('does not snap when two same-class objects compete', () => {
    const res = decideSnap(
      input({
        featureType: 'bench',
        uncertaintyM: 5,
        candidateTags: { ...BENCH },
        matches: [match(101, 2, 0, BENCH), match(102, -4, 1, BENCH)]
      })
    );
    // 102 is ~4.1 m away, within 2*dMax = 6 m, same class, tags agree ->
    // ambiguity -> no snap.
    expect(res).toBeNull();
  });

  it('does not snap when the match is outside the radius', () => {
    const res = decideSnap(
      input({ featureType: 'bench', uncertaintyM: 5, candidateTags: { ...BENCH }, matches: [match(101, 20, 0, BENCH)] })
    );
    expect(res).toBeNull();
  });

  it('does not snap to a different feature class (cross-class match)', () => {
    // A vending machine 2 m away is NOT the bench candidate: scored against
    // the candidate's own class it gets tagScore 0.
    const res = decideSnap(
      input({ featureType: 'bench', uncertaintyM: 5, candidateTags: { ...BENCH }, matches: [match(201, 2, 0, VENDING)] })
    );
    expect(res).toBeNull();
  });

  it('snaps when a plausible competitor is far outside the competition range', () => {
    const res = decideSnap(
      input({
        featureType: 'bench',
        uncertaintyM: 5,
        candidateTags: { ...BENCH },
        matches: [match(101, 2, 0, BENCH), match(102, 60, 0, BENCH)]
      })
    );
    expect(res).not.toBeNull();
    expect(res!.osm.osmId).toBe(101);
  });
});

describe('identifying tags (same class ≠ same object)', () => {
  it('does not snap when the object subtype contradicts the candidate (slide vs swing)', () => {
    const res = decideSnap(
      input({
        featureType: 'playground',
        uncertaintyM: 5,
        candidateTags: { playground: 'slide' },
        matches: [match(301, 2, 0, { playground: 'swing' })]
      })
    );
    expect(res).toBeNull();
  });

  it('does not snap when the object contradicts a class-required detail (board vs guidepost)', () => {
    // Candidate is an information board (class requires tourism=information
    // + information=board, issue #9); the OSM object is an information point
    // of a different subtype (information=guidepost). The required-tag
    // mismatch keeps the class score below the exact-match threshold, and
    // the subtype conflict blocks it anyway, so no snap.
    const res = decideSnap(
      input({
        featureType: 'information_board',
        uncertaintyM: 5,
        candidateTags: { tourism: 'information', information: 'board' },
        matches: [match(302, 2, 0, { tourism: 'information', information: 'guidepost' })]
      })
    );
    expect(res).toBeNull();
    // The object is class-compatible but not an EXACT match (0.5 of the
    // required tags agree), which is insufficient for auto-snap.
    expect(
      scoreTagsForClass({ tourism: 'information', information: 'guidepost' }, 'information_board')
    ).toBeCloseTo(0.5);
  });

  it('snaps when the object agrees on the candidate identifying tags', () => {
    const res = decideSnap(
      input({
        featureType: 'information_board',
        uncertaintyM: 5,
        candidateTags: { tourism: 'information', information: 'board' },
        matches: [match(303, 2, 0, { tourism: 'information', information: 'board', name: 'Info' })]
      })
    );
    expect(res).not.toBeNull();
    expect(res!.osm.osmId).toBe(303);
  });

  it('does not snap when the candidate lacks the value-identifying tag', () => {
    // Playground identity depends on playground=<type>, which cannot be
    // inferred from the class. A generic candidate (no playground value)
    // has no specific evidence, so auto-snap is refused even though the
    // object is 2 m away and class-compatible.
    const res = decideSnap(
      input({
        featureType: 'playground',
        uncertaintyM: 5,
        candidateTags: {},
        matches: [match(304, 2, 0, { playground: 'slide' })]
      })
    );
    expect(res).toBeNull();
  });

  it('does not treat a subtype-contradicting object as a competing same-object candidate', () => {
    // Primary: the board (information=board) at 2 m. Competitor: a
    // guidepost (information=guidepost) at 4 m. The guidepost contradicts
    // the candidate's confirmed information=board value, so it is a
    // DIFFERENT object and must not create ambiguity and block the snap.
    const res = decideSnap(
      input({
        featureType: 'information_board',
        uncertaintyM: 5,
        candidateTags: { tourism: 'information', information: 'board' },
        matches: [
          match(305, 2, 0, { tourism: 'information', information: 'board' }),
          match(306, 4, 0, { tourism: 'information', information: 'guidepost' })
        ]
      })
    );
    expect(res).not.toBeNull();
    expect(res!.osm.osmId).toBe(305);
  });
});

describe('review-only classes are never auto-snapped (issue #9)', () => {
  it('statue: no snap even for a 2 m away object with identical tags', () => {
    const tags = { tourism: 'artwork', artwork_type: 'statue' };
    const res = decideSnap(
      input({
        featureType: 'statue',
        uncertaintyM: 2,
        candidateTags: { ...tags },
        matches: [match(401, 2, 0, tags)]
      })
    );
    expect(res).toBeNull();
  });

  it('stone_lantern (pure review-only, no built-in mapping): no snap', () => {
    // stone_lantern has no built-in mapping (issue #9): the review-only
    // guard blocks the snap, and even without it the class score would be
    // 0 (no defining keys), so the object is never a snap target.
    const tags = { man_made: 'stone_lantern' };
    const res = decideSnap(
      input({
        featureType: 'stone_lantern',
        uncertaintyM: 2,
        candidateTags: { ...tags },
        matches: [match(402, 1, 0, tags)]
      })
    );
    expect(res).toBeNull();
  });

  it('komainu (pure review-only, no mappings): no snap', () => {
    const res = decideSnap(
      input({
        featureType: 'komainu',
        uncertaintyM: 2,
        candidateTags: { historic: 'sculpture' },
        matches: [match(403, 1, 0, { historic: 'sculpture' })]
      })
    );
    expect(res).toBeNull();
  });
});
