import { describe, expect, it } from 'vitest';
import {
  distanceMeters,
  estimatePosition,
  rayFromPhoto,
  trackPositionAt
} from '../src/analysis/position';
import type { ObservationRay } from '../src/analysis/position';
import type { GpsSample, Photo } from '../src/types';

type Sample = GpsSample;

function sample(id: string, lat: number, lon: number, timestamp: number, heading?: number): Sample {
  return { id, lat, lon, accuracy: 5, timestamp, heading };
}

describe('trackPositionAt (issue #6: time-based GPS association)', () => {
  const a = sample('a', 48.8, 2.3, 1000);
  const b = sample('b', 48.801, 2.301, 2000);

  it('returns undefined for an empty track', () => {
    expect(trackPositionAt([], 1500)).toBeUndefined();
  });

  it('returns the only sample for a single-sample track', () => {
    expect(trackPositionAt([a], 999999)).toEqual(a);
  });

  it('interpolates linearly between the bracketing samples', () => {
    const p = trackPositionAt([a, b], 1500)!;
    expect(p.lat).toBeCloseTo(48.8005, 9);
    expect(p.lon).toBeCloseTo(2.3005, 9);
    expect(p.timestamp).toBe(1500);
    expect(p.id).not.toBe(a.id);
  });

  it('snaps to the nearest sample outside the track span', () => {
    expect(trackPositionAt([a, b], 500)?.id).toBe(a.id);
    expect(trackPositionAt([a, b], 5000)?.id).toBe(b.id);
  });

  it('returns the closest sample when at coincides with one', () => {
    expect(trackPositionAt([a, b], 1000)?.id).toBe(a.id);
    expect(trackPositionAt([a, b], 2000)?.id).toBe(b.id);
  });

  it('interpolates heading around the 0/360 wrap (shortest arc)', () => {
    const n1 = sample('n1', 48.8, 2.3, 1000, 350);
    const n2 = sample('n2', 48.801, 2.301, 2000, 10);
    const p = trackPositionAt([n1, n2], 1500)!;
    expect(p.heading).toBeCloseTo(0, 5); // 350 -> 10 midpoint is 0/360, not 180
  });

  it('interpolates heading directly when no wrap is needed', () => {
    const n1 = sample('n1', 48.8, 2.3, 1000, 90);
    const n2 = sample('n2', 48.801, 2.301, 2000, 180);
    const p = trackPositionAt([n1, n2], 1500)!;
    expect(p.heading).toBeCloseTo(135, 5);
  });

  it('uses the available heading when one sample lacks it', () => {
    const n1 = sample('n1', 48.8, 2.3, 1000);
    const n2 = sample('n2', 48.801, 2.301, 2000, 120);
    const p = trackPositionAt([n1, n2], 1500)!;
    expect(p.heading).toBe(120);
  });

  it('carries the worst accuracy of the bracketing samples', () => {
    const a2 = { ...a, accuracy: 3 };
    const b2 = { ...b, accuracy: 12 };
    expect(trackPositionAt([a2, b2], 1500)?.accuracy).toBe(12);
  });
});

describe('trackPositionAt multi-sample bracketing (issue #6 remaining blocker)', () => {
  // A 1.0s, B 2.0s, C 3.0s — the issue's example scenario.
  const A = sample('A', 48.8, 2.3, 1000, 0);
  const B = sample('B', 48.801, 2.301, 2000, 10);
  const C = sample('C', 48.802, 2.302, 3000, 20);
  const track = [A, B, C];

  it('interpolates between A-B for a capture between A and B', () => {
    const p = trackPositionAt(track, 1400)!;
    expect(p.lat).toBeCloseTo(48.8004, 9);
    expect(p.lon).toBeCloseTo(2.3004, 9);
    expect(p.timestamp).toBe(1400);
  });

  it('interpolates between B-C, not A-B, for a capture between B and C', () => {
    // B is the NEAREST sample to 2.4s, but the true bracketing interval is B-C.
    const p = trackPositionAt(track, 2400)!;
    expect(p.lat).toBeCloseTo(48.8014, 9);
    expect(p.lon).toBeCloseTo(2.3014, 9);
    expect(p.heading).toBeCloseTo(14, 5);
  });

  it('returns the original sample on an exact hit', () => {
    expect(trackPositionAt(track, 2000)).toBe(B);
  });

  it('returns the first sample for captures before the track', () => {
    expect(trackPositionAt(track, 500)).toBe(A);
  });

  it('returns the last sample for captures after the track', () => {
    expect(trackPositionAt(track, 3500)).toBe(C);
  });

  it('handles uneven sample spacing', () => {
    const X = sample('X', 48.8, 2.3, 0, 0);
    const Y = sample('Y', 48.81, 2.31, 10000, 10);
    const Z = sample('Z', 48.8105, 2.3105, 10500, 20);
    const p = trackPositionAt([X, Y, Z], 9900)!;
    // 99% of the way from X to Y (a nearest-sample-first approach would pick
    // Y as nearest and risk the wrong interval).
    expect(p.lat).toBeCloseTo(48.8099, 6);
    expect(p.heading).toBeCloseTo(9.9, 5);
  });
});

/* ------------------------------------------------------------------ */
/* estimatePosition (issue #3: evidence, uncertainty, quality classes) */
/* ------------------------------------------------------------------ */

describe('estimatePosition (issue #3)', () => {
  // Scenario geometry (approximate planar at ~48.8 deg N):
  //  A = origin (48.800000, 2.300000)
  //  P = true object: 100 m east + 100 m north of A
  //  B = second camera: 200 m due south of A
  //  A -> P: bearing 45deg, 141 m;  B -> P: bearing ~18.43deg, 316 m
  const A = { lat: 48.800000, lon: 2.300000 };
  const P = { lat: 48.800904, lon: 2.301364 };
  const B = { lat: 48.798189, lon: 2.300000 };

  function ray(lat: number, lon: number, bearingDeg: number, opts: Partial<ObservationRay> = {}): ObservationRay {
    return {
      lat,
      lon,
      bearingDeg,
      distanceM: 0,
      gpsAccuracy: 5,
      hasHeading: true,
      ...opts
    };
  }

  it('classifies no-orientation evidence as GPS-only', () => {
    const est = estimatePosition([
      { ...ray(A.lat, A.lon, 0), hasHeading: false },
      { ...ray(B.lat, B.lon, 0), hasHeading: false }
    ]);
    expect(est.positionQuality).toBe('no-orientation');
    // Accuracy-weighted centroid of A and B (equal accuracy -> midpoint).
    const mid = { lat: (A.lat + B.lat) / 2, lon: (A.lon + B.lon) / 2 };
    expect(distanceMeters(est.lat, est.lon, mid.lat, mid.lon)).toBeLessThan(10);
    expect(est.positionConfidence).toBeLessThanOrEqual(0.2);
    expect(est.warnings.some((w) => w.includes('No orientation'))).toBe(true);
  });

  it('classifies a single heading ray as single-ray projection', () => {
    const est = estimatePosition([ray(A.lat, A.lon, 45, { distanceM: 141.4 })]);
    expect(est.positionQuality).toBe('single-ray');
    expect(distanceMeters(est.lat, est.lon, P.lat, P.lon)).toBeLessThan(10);
    // Distance-dominated: with a 10deg default bearing uncertainty at 141 m
    // the lateral term alone is ~25 m.
    expect(est.uncertaintyMeters).toBeGreaterThan(20);
    expect(est.positionConfidence).toBeLessThanOrEqual(0.5);
  });

  it('classifies a good two-ray intersection as triangulated', () => {
    const est = estimatePosition([
      ray(A.lat, A.lon, 45, { distanceM: 141.4, bearingUncDeg: 5 }),
      ray(B.lat, B.lon, 18.43, { distanceM: 316.2, bearingUncDeg: 5 })
    ]);
    expect(est.positionQuality).toBe('triangulated');
    expect(distanceMeters(est.lat, est.lon, P.lat, P.lon)).toBeLessThan(25);
    expect(est.warnings).toHaveLength(0);
    expect(est.uncertaintyMeters).toBeGreaterThan(0);
    expect(est.uncertaintyMeters).toBeLessThan(100);
  });

  it('classifies nearly parallel rays as weak geometry (not contradictory)', () => {
    // Both rays due along the same 45deg direction, 200 m apart: the fit
    // error is inflated by the geometry, not by the observations.
    const est = estimatePosition([
      ray(A.lat, A.lon, 45, { distanceM: 141.4 }),
      ray(B.lat, B.lon, 45, { distanceM: 316.2 })
    ]);
    expect(est.positionQuality).toBe('weak-geometry');
    expect(est.warnings.some((w) => w.includes('nearly parallel'))).toBe(true);
    expect(est.positionConfidence).toBeLessThanOrEqual(0.4);
  });

  it('classifies a short baseline as weak geometry', () => {
    // Cameras only 5 m apart (B just south of A), bearings cross well.
    const est = estimatePosition([
      ray(A.lat, A.lon, 45),
      ray(A.lat - 0.000045, A.lon, 90) // ~5 m south
    ]);
    expect(est.positionQuality).toBe('weak-geometry');
    expect(est.warnings.some((w) => w.includes('baseline'))).toBe(true);
  });

  it('classifies strongly disagreeing rays as contradictory', () => {
    // A says 45deg, B says due east: no point satisfies both within the
    // search bounds; the geometry itself is fine (crossing 45deg, 200 m
    // baseline), so this is a contradiction in the observations.
    const est = estimatePosition([
      ray(A.lat, A.lon, 45),
      ray(B.lat, B.lon, 90)
    ]);
    expect(est.positionQuality).toBe('contradictory');
    expect(est.warnings.some((w) => w.includes('disagree'))).toBe(true);
    expect(est.positionConfidence).toBeLessThanOrEqual(0.2);
  });

  it('classifies a distance-evidence conflict as contradictory', () => {
    // Good bearing geometry (solution near P, ~141 m / ~316 m), but both
    // observations claim the object is 500 m away.
    const est = estimatePosition([
      ray(A.lat, A.lon, 45, { distanceM: 500, distanceUncertaintyM: 30, bearingUncDeg: 5 }),
      ray(B.lat, B.lon, 18.43, { distanceM: 500, distanceUncertaintyM: 30, bearingUncDeg: 5 })
    ]);
    expect(est.positionQuality).toBe('contradictory');
    expect(est.warnings.some((w) => w.includes('Distance evidence conflicts'))).toBe(true);
  });

  it('flags stale camera positions', () => {
    const est = estimatePosition([ray(A.lat, A.lon, 45, { distanceM: 141.4, cameraAgeMs: 60_000 })]);
    expect(est.warnings.some((w) => w.includes('stale'))).toBe(true);
  });

  it('weights precise bearings above imprecise ones in the fit', () => {
    // The precise ray (5deg uncertainty) points at P; the imprecise ray
    // (40deg uncertainty) is ~100deg off. Its fit weight (1/40 vs 1/5) is
    // small enough that the mean weighted deviation stays under the 30deg
    // contradiction threshold, so the triangulation is still reported.
    // An unweighted fit would see (0.2 + 100)/2 = 50deg and call this
    // contradictory — proving the uncertainty weighting is in effect.
    // (No distance evidence, so the search stays bounded and no distance
    // conflict can fire; the 45deg/118deg rays cross at 73deg.)
    const est = estimatePosition([
      ray(A.lat, A.lon, 45, { bearingUncDeg: 5 }),
      ray(B.lat, B.lon, 118.4, { bearingUncDeg: 40 })
    ]);
    expect(est.positionQuality).toBe('triangulated');
    expect(est.warnings).not.toContainEqual(expect.stringContaining('disagree'));
    expect(distanceMeters(est.lat, est.lon, P.lat, P.lon)).toBeLessThan(40);
  });
});

/* ------------------------------------------------------------------ */
/* rayFromPhoto (issue #3: quality evidence travels with the ray)      */
/* ------------------------------------------------------------------ */

describe('rayFromPhoto (issue #3)', () => {
  function makePhoto(overrides: Partial<Photo> = {}): Photo {
    return {
      id: 'p1',
      surveyId: 's1',
      timestamp: 2_000_000,
      timestampSource: 'exif',
      cameraPosition: {
        lat: 48.8,
        lon: 2.3,
        accuracy: 5,
        timestamp: 2_000_000,
        fixTimestamp: 1_995_000,
        ageMs: 5_000,
        source: 'track'
      },
      ...overrides
    };
  }

  const obs = {
    bbox: { x: 0.5, y: 0.4, w: 0.2, h: 0.25 },
    distanceEstimate: 10,
    distanceUncertaintyM: 3
  };

  it('builds the ray from cameraPosition with full quality evidence', () => {
    const photo = makePhoto({ heading: 90, headingSource: 'compass' });
    const r = rayFromPhoto(photo, obs)!;
    expect(r.lat).toBe(48.8);
    expect(r.lon).toBe(2.3);
    // bbox center u=0.6 -> (0.6-0.5)*62 = 6.2deg offset from heading 90.
    expect(r.bearingDeg).toBeCloseTo(96.2, 5);
    expect(r.hasHeading).toBe(true);
    expect(r.distanceM).toBe(10);
    expect(r.distanceUncertaintyM).toBe(3);
    expect(r.gpsAccuracy).toBe(5);
    expect(r.cameraAgeMs).toBe(5000);
    expect(r.cameraSource).toBe('track');
    // RSS of the compass uncertainty (5deg) and the bbox-center spread
    // (0.1 * 62 = 6.2deg): sqrt(25 + 38.44).
    expect(r.bearingUncDeg).toBeCloseTo(Math.sqrt(25 + 6.2 ** 2), 5);
  });

  it('propagates the heading source quality into bearing uncertainty', () => {
    const compass = rayFromPhoto(makePhoto({ heading: 90, headingSource: 'compass' }), obs)!;
    const approx = rayFromPhoto(makePhoto({ heading: 90, headingSource: 'approximate' }), obs)!;
    expect(approx.bearingUncDeg).toBeGreaterThan(compass.bearingUncDeg!);
  });

  it('marks rays without a heading as bearing-less', () => {
    const r = rayFromPhoto(makePhoto(), obs)!;
    expect(r.hasHeading).toBe(false);
    expect(r.bearingDeg).toBe(0);
    expect(r.bearingUncDeg).toBeUndefined();
  });

  it('falls back to the legacy gps alias when cameraPosition is absent', () => {
    const photo = makePhoto({
      cameraPosition: undefined,
      gps: { id: 'g1', lat: 48.9, lon: 2.4, accuracy: 8, timestamp: 2_000_000 },
      heading: 90,
      headingSource: 'track'
    });
    const r = rayFromPhoto(photo, obs)!;
    expect(r.lat).toBe(48.9);
    expect(r.lon).toBe(2.4);
    expect(r.gpsAccuracy).toBe(8);
  });

  it('returns null when the photo has no position at all', () => {
    const photo = makePhoto({ cameraPosition: undefined, gps: undefined });
    expect(rayFromPhoto(photo, obs)).toBeNull();
  });
});
