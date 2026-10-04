import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEADING_UNCERTAINTY_DEG,
  associateCameraHeading,
  headingUncertaintyDeg,
  normalizeHeading,
  ORIENT_FRESH_MS,
  OrientationTracker,
  type HeadingReading,
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

  it('never assigns a camera-heading uncertainty to the movement heading (issue #3)', () => {
    // 'track' is no longer a heading quality: the GPS-track (movement)
    // heading is a distinct evidence and must not carry camera-heading
    // uncertainty weights.
    expect(HEADING_UNCERTAINTY_DEG['track']).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* associateCameraHeading (issue #3: freshness + provenance gate)      */
/* ------------------------------------------------------------------ */

describe('associateCameraHeading (issue #3: stale / post-return readings are rejected)', () => {
  const CAPTURE = 1_000_000;

  function reading(partial: Partial<HeadingReading> & { heading: number }): HeadingReading {
    return {
      quality: 'compass',
      detail: 'Compass heading',
      ...partial
    };
  }

  it('accepts a fresh reading and records full provenance', () => {
    const { cameraHeading } = associateCameraHeading(
      reading({ heading: 270, quality: 'compass', timestamp: CAPTURE - 2000 }),
      CAPTURE
    );
    expect(cameraHeading).toEqual({
      bearing: 270,
      source: 'compass',
      uncertaintyDeg: 5,
      timestamp: CAPTURE - 2000,
      ageMs: 2000,
      detail: 'Compass heading'
    });
  });

  it('accepts a reading taken at the exact capture time (age 0)', () => {
    const { cameraHeading, headingNote } = associateCameraHeading(
      reading({ heading: 90, quality: 'absolute-alpha', timestamp: CAPTURE }),
      CAPTURE
    );
    expect(headingNote).toBeUndefined();
    expect(cameraHeading?.source).toBe('absolute-alpha');
    expect(cameraHeading?.ageMs).toBe(0);
    expect(cameraHeading?.uncertaintyDeg).toBe(5);
  });

  it('rejects a STALE reading (older than the freshness window) with an explicit note', () => {
    const { cameraHeading, headingNote } = associateCameraHeading(
      reading({ heading: 270, timestamp: CAPTURE - (ORIENT_FRESH_MS + 1) }),
      CAPTURE
    );
    expect(cameraHeading).toBeUndefined();
    expect(headingNote).toContain('stale');
    expect(headingNote).toContain(`${Math.round((ORIENT_FRESH_MS + 1) / 1000)} s`);
  });

  it('accepts a reading exactly at the freshness boundary (age == window)', () => {
    const { cameraHeading, headingNote } = associateCameraHeading(
      reading({ heading: 270, timestamp: CAPTURE - ORIENT_FRESH_MS }),
      CAPTURE
    );
    expect(headingNote).toBeUndefined();
    expect(cameraHeading?.ageMs).toBe(ORIENT_FRESH_MS);
  });

  it('rejects a POST-RETURN reading (timestamp after the shutter) unconditionally', () => {
    // Even a 1 ms post-return reading must be rejected — the shutter
    // already fired; the reading describes a different moment.
    const { cameraHeading, headingNote } = associateCameraHeading(
      reading({ heading: 270, timestamp: CAPTURE + 1 }),
      CAPTURE
    );
    expect(cameraHeading).toBeUndefined();
    expect(headingNote).toContain('postdates');
  });

  it('rejects a reading WITHOUT a timestamp (freshness unverifiable)', () => {
    const { cameraHeading, headingNote } = associateCameraHeading(
      { heading: 270, quality: 'compass', detail: 'Compass heading' },
      CAPTURE
    );
    expect(cameraHeading).toBeUndefined();
    expect(headingNote).toContain('no timestamp');
  });

  it('rejects relative-only readings (no geographic heading)', () => {
    const { cameraHeading, headingNote } = associateCameraHeading(
      { heading: undefined, quality: 'relative', detail: 'Relative alpha; no screen orientation' },
      CAPTURE
    );
    expect(cameraHeading).toBeUndefined();
    expect(headingNote).toContain('No geographic heading');
  });

  it('rejects none-quality readings with the sensor detail', () => {
    const { cameraHeading, headingNote } = associateCameraHeading(
      { heading: undefined, quality: 'none', detail: 'Orientation permission denied' },
      CAPTURE
    );
    expect(cameraHeading).toBeUndefined();
    expect(headingNote).toContain('Orientation permission denied');
  });

  it('handles a missing reading (tracker never started)', () => {
    const { cameraHeading, headingNote } = associateCameraHeading(null, CAPTURE);
    expect(cameraHeading).toBeUndefined();
    expect(headingNote).toBe('No orientation reading');
  });

  it('maps an approximate-quality reading to the approximate source', () => {
    const { cameraHeading } = associateCameraHeading(
      reading({ heading: 10, quality: 'approximate', detail: 'Approximate from absolute alpha + tilt', timestamp: CAPTURE - 100 }),
      CAPTURE
    );
    expect(cameraHeading?.source).toBe('approximate');
    expect(cameraHeading?.uncertaintyDeg).toBe(20);
  });
});

/* ------------------------------------------------------------------ */
/* Pre-launch gate (issue #13 phase 1 / issue #3 remaining blocker)    */
/* ------------------------------------------------------------------ */

describe('associateCameraHeading pre-launch gate (issue #13 phase 1: external camera)', () => {
  const LAUNCH = 1_000_000;
  // Photo taken 6 s after the picker opened.
  const CAPTURE = LAUNCH + 6_000;

  function reading(partial: Partial<HeadingReading> & { heading: number }): HeadingReading {
    return { quality: 'compass', detail: 'Compass heading', ...partial };
  }

  it('rejects a PRE-LAUNCH reading even though it is still fresh at capture time', () => {
    // The reading was taken 4 s BEFORE the picker opened. Its age at
    // capture is exactly ORIENT_FRESH_MS (10 s), so the freshness gate
    // alone would let it through — the launch gate is what rejects it.
    // While the OS camera was open the app was in the background, so a
    // pre-launch reading describes the pre-camera scene, not the
    // composition at the shutter moment.
    const { cameraHeading, headingNote } = associateCameraHeading(
      reading({ heading: 270, timestamp: LAUNCH - 4_000 }),
      CAPTURE,
      LAUNCH
    );
    expect(cameraHeading).toBeUndefined();
    expect(headingNote).toContain('predates camera launch');
    expect(headingNote).toContain('4 s');
  });

  it('accepts a reading taken after launch (shutter-window evidence)', () => {
    const { cameraHeading, headingNote } = associateCameraHeading(
      reading({ heading: 90, timestamp: LAUNCH + 2_000 }),
      CAPTURE,
      LAUNCH
    );
    expect(headingNote).toBeUndefined();
    expect(cameraHeading?.bearing).toBe(90);
    expect(cameraHeading?.ageMs).toBe(4_000);
  });

  it('accepts a reading taken exactly at the launch moment', () => {
    const { cameraHeading, headingNote } = associateCameraHeading(
      reading({ heading: 90, timestamp: LAUNCH }),
      CAPTURE,
      LAUNCH
    );
    expect(headingNote).toBeUndefined();
    expect(cameraHeading?.ageMs).toBe(6_000);
  });

  it('keeps the previous behavior when no launch timestamp is passed (in-app capture)', () => {
    const { cameraHeading, headingNote } = associateCameraHeading(
      reading({ heading: 270, timestamp: CAPTURE - 4_000 }),
      CAPTURE
    );
    expect(headingNote).toBeUndefined();
    expect(cameraHeading?.bearing).toBe(270);
  });
});

/* ------------------------------------------------------------------ */
/* Sideways-photography acceptance (issue #3)                          */
/* ------------------------------------------------------------------ */

describe('sideways photography: movement heading must never become the camera bearing (issue #3)', () => {
  it('uses ONLY the orientation reading as camera bearing when the track says otherwise', () => {
    // Track (movement) says the user is walking north (heading 0);
    // the device orientation (camera) says the lens points east (90).
    // The camera bearing MUST be 90 — the movement heading is ignored.
    const { cameraHeading } = associateCameraHeading(
      { heading: 90, quality: 'compass', detail: 'Compass heading', timestamp: Date.now() - 1000 },
      Date.now()
    );
    expect(cameraHeading?.bearing).toBe(90);
  });

  it('produces NO camera bearing when only a movement heading exists (no orientation reading)', () => {
    // A walking user with no orientation sensor data: the GPS track has a
    // movement heading, but that must not masquerade as a camera bearing.
    // associateCameraHeading never sees the track — with no reading the
    // result is an explicit note, not a bearing.
    const { cameraHeading, headingNote } = associateCameraHeading(null, Date.now());
    expect(cameraHeading).toBeUndefined();
    expect(headingNote).toBe('No orientation reading');
  });
});


describe('OrientationTracker absolute events', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function setup() {
    const host = Object.assign(new EventTarget(), { ondeviceorientationabsolute: null });
    vi.stubGlobal('window', host);
    vi.stubGlobal('DeviceOrientationEvent', undefined);
    vi.stubGlobal('screen', { orientation: { angle: 0 } });
    const tracker = new OrientationTracker();
    tracker.start();
    const emit = (type: string, absolute: boolean, alpha: number) => {
      host.dispatchEvent(Object.assign(new Event(type), { absolute, alpha, beta: 90, gamma: 0 }));
    };
    return { tracker, emit };
  }

  it('records absolute heading and does not replace it with relative orientation', () => {
    const { tracker, emit } = setup();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    emit('deviceorientationabsolute', true, 90);
    expect(tracker.read().heading).toBe(270);
    clock.mockReturnValue(2000);
    emit('deviceorientation', false, 20);
    expect(tracker.read().heading).toBe(270);
    expect(tracker.read().timestamp).toBe(1000);
    expect(associateCameraHeading(tracker.read(), 1001).cameraHeading?.bearing).toBe(270);
    expect(associateCameraHeading(tracker.read(), 12000).cameraHeading).toBeUndefined();
    tracker.stop();
    emit('deviceorientationabsolute', true, 0);
    expect(tracker.read().heading).toBeUndefined();
    tracker.start();
    emit('deviceorientationabsolute', true, 180);
    expect(tracker.read().heading).toBe(180);
    tracker.stop();
  });

  it('keeps relative-only events without inventing a geographic heading', () => {
    const { tracker, emit } = setup();
    emit('deviceorientation', false, 90);
    expect(tracker.read().quality).toBe('relative');
    expect(associateCameraHeading(tracker.read(), Date.now()).cameraHeading).toBeUndefined();
    tracker.stop();
  });
});
