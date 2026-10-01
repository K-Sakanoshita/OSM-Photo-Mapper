import { describe, expect, it } from 'vitest';
import { trackPositionAt } from '../src/analysis/position';
import type { GpsSample } from '../src/types';

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
