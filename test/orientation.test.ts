import { describe, expect, it } from 'vitest';
import {
  HEADING_UNCERTAINTY_DEG,
  headingUncertaintyDeg,
  normalizeHeading,
  type OrientationLike
} from '../src/capture/orientation';

describe('normalizeHeading (issue #3 blocker 1: orientation -> geographic bearing + quality)', () => {
  it('prefers the platform compass heading (iOS)', () => {
    const r = normalizeHeading({ webkitCompassHeading: 270, alpha: 90, absolute: true });
    expect(r.heading).toBe(270);
    expect(r.quality).toBe('compass');
  });

  it('does not fabricate a compass heading from the boolean webkitCompass flag alone', () => {
    // webkitCompass: true without a numeric heading value must fall through
    // to alpha handling, not pretend a compass reading exists.
    const r = normalizeHeading({ webkitCompass: true as unknown as number, alpha: 90, absolute: true, beta: 90, gamma: 0 });
    expect(r.quality).toBe('absolute-alpha');
    expect(r.heading).toBe(270);
  });

  it('converts absolute alpha in the flat-portrait case (bearing = 360 - alpha)', () => {
    const r = normalizeHeading({ alpha: 90, absolute: true, beta: 90, gamma: 0 });
    expect(r.heading).toBe(270);
    expect(r.quality).toBe('absolute-alpha');
  });

  it('downgrades absolute alpha under significant tilt to approximate', () => {
    const r = normalizeHeading({ alpha: 90, absolute: true, beta: 45, gamma: 0 });
    expect(r.heading).toBe(270);
    expect(r.quality).toBe('approximate');
  });

  it('downgrades landscape screen rotation to approximate and applies the screen angle', () => {
    // alpha 90, screen rotated 90deg: bearing = 360 - 90 + 90 = 360 -> 0
    const r = normalizeHeading(
      { alpha: 90, absolute: true, beta: 90, gamma: 0 },
      90
    );
    expect(r.heading).toBe(0);
    expect(r.quality).toBe('approximate');
  });

  it('normalizes negative alpha into 0..360', () => {
    const r = normalizeHeading({ alpha: -90, absolute: true, beta: 90, gamma: 0 });
    expect(r.heading).toBe(90);
    expect(r.quality).toBe('absolute-alpha');
  });

  it('never converts relative alpha to a bearing', () => {
    const r = normalizeHeading({ alpha: 90, absolute: false, beta: 90, gamma: 0 });
    expect(r.heading).toBeUndefined();
    expect(r.quality).toBe('relative');
  });

  it('reports relative quality (no heading) when alpha is missing', () => {
    const r = normalizeHeading({} as OrientationLike);
    expect(r.heading).toBeUndefined();
    expect(r.quality).toBe('relative');
    expect(r.detail).toBe('No orientation data');
  });

  it('rejects non-finite sensor values', () => {
    const r = normalizeHeading({ alpha: Number.NaN, absolute: true } as OrientationLike);
    expect(r.heading).toBeUndefined();
    expect(r.quality).toBe('relative');
  });
});

describe('headingUncertaintyDeg (issue #3 blocker 3: quality-weighted bearing evidence)', () => {
  it('assigns tighter uncertainty to precise sources', () => {
    expect(headingUncertaintyDeg('compass')).toBe(HEADING_UNCERTAINTY_DEG.compass);
    expect(headingUncertaintyDeg('compass')).toBeLessThanOrEqual(5);
    expect(headingUncertaintyDeg('absolute-alpha')).toBeLessThanOrEqual(5);
  });

  it('penalizes approximate readings', () => {
    expect(headingUncertaintyDeg('approximate')).toBeGreaterThanOrEqual(15);
    expect(headingUncertaintyDeg('approximate')).toBeGreaterThan(HEADING_UNCERTAINTY_DEG.compass);
  });

  it('returns undefined when there is no usable geographic heading', () => {
    expect(headingUncertaintyDeg('relative')).toBeUndefined();
    expect(headingUncertaintyDeg('none')).toBeUndefined();
    expect(headingUncertaintyDeg(undefined)).toBeUndefined();
  });

  it('gives the GPS track a defined moderate uncertainty', () => {
    expect(headingUncertaintyDeg('track')).toBe(10);
  });
});
