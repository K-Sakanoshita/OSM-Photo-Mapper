import { describe, expect, it } from 'vitest';
import type { GpsSample } from '../src/types';
import {
  TRACK_FRESHNESS_MS,
  FIX_FRESHNESS_MS,
  GPS_STALE_MS,
  trackCameraPosition,
  captureFixCameraPosition,
  exifCameraPosition,
  resolveCameraPosition,
  requestOneShotFix,
  withTimeout,
  classifyGps,
  formatGpsStatus,
  describeCameraPosition,
  type OneShotFix
} from '../src/capture/camera-position';

function makeSample(id: string, ts: number, lat: number, lon: number, movementHeading?: number): GpsSample {
  return { id, lat, lon, accuracy: 5, timestamp: ts, movementHeading };
}

const A = makeSample('a', 1000, 48.8, 2.3, 90);
const B = makeSample('b', 2000, 48.801, 2.301, 110);

function makeFix(ts: number, accuracy?: number): OneShotFix {
  return { lat: 48.85, lon: 2.35, accuracy, timestamp: ts };
}

/* ------------------------------------------------------------------ */
/* trackCameraPosition                                                 */
/* ------------------------------------------------------------------ */

describe('trackCameraPosition', () => {
  it('interpolates inside the recorded span (inSpan, interpolated)', () => {
    const cp = trackCameraPosition([A, B], 1500)!;
    expect(cp.source).toBe('track');
    expect(cp.inSpan).toBe(true);
    expect(cp.interpolated).toBe(true);
    expect(cp.ageMs).toBe(0);
    expect(cp.lat).toBeCloseTo(48.8005, 6);
    expect(cp.lon).toBeCloseTo(2.3005, 6);
    expect(cp.accuracy).toBe(5);
    expect(cp.movementHeading).toBeDefined();
  });

  it('returns the exact sample at the span edges without interpolation', () => {
    const atFirst = trackCameraPosition([A, B], 1000)!;
    expect(atFirst.inSpan).toBe(true);
    expect(atFirst.interpolated).toBe(false);
    expect(atFirst.lat).toBe(48.8);
    const atLast = trackCameraPosition([A, B], 2000)!;
    expect(atLast.inSpan).toBe(true);
    expect(atLast.lat).toBeCloseTo(48.801, 6);
  });

  it('accepts a just-outside-span capture when the endpoint is still fresh', () => {
    const cp = trackCameraPosition([A, B], 2000 + 10_000)!; // 10 s after the last sample
    expect(cp.inSpan).toBe(false);
    expect(cp.interpolated).toBe(false);
    expect(cp.ageMs).toBe(10_000);
    expect(cp.lat).toBeCloseTo(48.801, 6); // nearest (stale) endpoint
  });

  it('rejects a stale endpoint once the capture is older than the freshness threshold', () => {
    expect(trackCameraPosition([A, B], 2000 + TRACK_FRESHNESS_MS + 1)).toBeUndefined();
    expect(trackCameraPosition([A, B], 1000 - TRACK_FRESHNESS_MS - 1)).toBeUndefined();
  });

  it('accepts a capture just before the span when the first sample is fresh', () => {
    const cp = trackCameraPosition([A, B], 1000 - 5_000)!;
    expect(cp.inSpan).toBe(false);
    expect(cp.ageMs).toBe(5_000);
    expect(cp.lat).toBe(48.8);
  });

  it('handles a single-sample track (no interpolation possible)', () => {
    const cp = trackCameraPosition([A], 1000 + 5_000)!;
    expect(cp.inSpan).toBe(false);
    expect(cp.interpolated).toBe(false);
    expect(cp.ageMs).toBe(5_000);
  });

  it('returns undefined for an empty track', () => {
    expect(trackCameraPosition([], 1500)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* captureFixCameraPosition / exifCameraPosition                       */
/* ------------------------------------------------------------------ */

describe('captureFixCameraPosition', () => {
  it('accepts a fresh fix with bounded staleness', () => {
    const cp = captureFixCameraPosition(makeFix(10_000, 8), 10_050)!;
    expect(cp.source).toBe('capture-fix');
    expect(cp.lat).toBe(48.85);
    expect(cp.accuracy).toBe(8);
    expect(cp.ageMs).toBe(50);
    expect(cp.fixTimestamp).toBe(10_000);
    expect(cp.timestamp).toBe(10_050);
  });

  it('rejects a fix older than the freshness threshold', () => {
    expect(captureFixCameraPosition(makeFix(0), FIX_FRESHNESS_MS + 2_000)).toBeUndefined();
  });

  it('carries no accuracy when the fix does not report one', () => {
    const cp = captureFixCameraPosition(makeFix(10_000), 10_000)!;
    expect(cp.accuracy).toBeUndefined();
  });
});

describe('exifCameraPosition', () => {
  it('produces a zero-age exif-sourced position without accuracy', () => {
    const cp = exifCameraPosition({ lat: 35.6, lon: 139.7 }, 42);
    expect(cp.source).toBe('exif');
    expect(cp.lat).toBe(35.6);
    expect(cp.ageMs).toBe(0);
    expect(cp.accuracy).toBeUndefined();
    expect(cp.fixTimestamp).toBe(42);
  });
});

/* ------------------------------------------------------------------ */
/* resolveCameraPosition (precedence)                                  */
/* ------------------------------------------------------------------ */

describe('resolveCameraPosition', () => {
  it('prefers a track that genuinely covers the capture moment', () => {
    const cp = resolveCameraPosition({
      track: [A, B],
      captureTimestamp: 1500,
      captureFix: makeFix(1500, 3) // fix is fresher, but the track is in-span
    })!;
    expect(cp.source).toBe('track');
  });

  it('prefers a capture-time fix over a stale track endpoint', () => {
    const cp = resolveCameraPosition({
      track: [A, B], // capture 10 s after the span: endpoint is 10 s old
      captureTimestamp: 12_000,
      captureFix: makeFix(11_000) // fix is only 1 s old
    })!;
    expect(cp.source).toBe('capture-fix');
  });

  it('keeps the stale track endpoint when the fix is not fresher (tie)', () => {
    const cp = resolveCameraPosition({
      track: [A, B],
      captureTimestamp: 12_000, // endpoint age 10 s
      captureFix: makeFix(2_000) // fix age 10 s — no fresher than the endpoint
    })!;
    expect(cp.source).toBe('track');
    expect(cp.inSpan).toBe(false);
  });

  it('prefers the fresher source when the track endpoint and fix both qualify', () => {
    const cp = resolveCameraPosition({
      track: [A, B],
      captureTimestamp: 12_000, // endpoint age 10 s
      captureFix: makeFix(5_000) // fix age 7 s -> fresher than the endpoint
    })!;
    expect(cp.source).toBe('capture-fix');
  });

  it('uses the stale track endpoint when there is no fix at all', () => {
    const cp = resolveCameraPosition({
      track: [A, B],
      captureTimestamp: 12_000,
      exifGps: { lat: 35.6, lon: 139.7 }
    })!;
    expect(cp.source).toBe('track');
    expect(cp.inSpan).toBe(false);
    expect(cp.ageMs).toBe(10_000);
  });

  it('falls back to a fresh capture fix when the track does not cover the capture', () => {
    const cp = resolveCameraPosition({
      track: [A, B], // span 1000..2000; capture 60 s later -> rejected
      captureTimestamp: 20_000,
      captureFix: makeFix(19_000, 4) // 1 s old
    })!;
    expect(cp.source).toBe('capture-fix');
  });

  it('falls back to EXIF GPS when track and fix are both unusable', () => {
    const cp = resolveCameraPosition({
      track: [A, B],
      captureTimestamp: 90_000, // track endpoint 88 s old -> rejected
      captureFix: makeFix(0), // fix 90 s old -> rejected
      exifGps: { lat: 35.6, lon: 139.7 }
    })!;
    expect(cp.source).toBe('exif');
    expect(cp.lat).toBe(35.6);
  });

  it('returns undefined when no source is usable', () => {
    expect(
      resolveCameraPosition({
        track: [A, B],
        captureTimestamp: 90_000,
        captureFix: makeFix(0),
        exifGps: null
      })
    ).toBeUndefined();
  });

  it('works with an empty track and no fix (EXIF only)', () => {
    const cp = resolveCameraPosition({
      track: [],
      captureTimestamp: 42,
      exifGps: { lat: 1, lon: 2 }
    })!;
    expect(cp.source).toBe('exif');
  });
});

/* ------------------------------------------------------------------ */
/* GPS readiness status                                                */
/* ------------------------------------------------------------------ */

describe('classifyGps', () => {
  const now = 100_000;
  it('is unavailable without a fix', () => {
    expect(classifyGps(null, now)).toBe('unavailable');
    expect(classifyGps(undefined, now)).toBe('unavailable');
  });
  it('is ready for a fresh, accurate fix', () => {
    expect(classifyGps(makeFix(now - 5_000, 5), now)).toBe('ready');
  });
  it('is stale once the fix exceeds the staleness threshold', () => {
    expect(classifyGps(makeFix(now - GPS_STALE_MS - 1, 5), now)).toBe('stale');
  });
  it('is coarse for a coarse fix (even when fresh)', () => {
    expect(classifyGps(makeFix(now - 5_000, 25), now)).toBe('coarse');
  });
  it('treats an unknown accuracy as coarse (never assumed precise)', () => {
    expect(classifyGps(makeFix(now - 5_000), now)).toBe('coarse');
  });
});

describe('formatGpsStatus', () => {
  const now = 100_000;
  it('warns explicitly when GPS is unavailable', () => {
    const s = formatGpsStatus(null, now, 0, 'live');
    expect(s).toContain('GPS unavailable');
    expect(s).toContain('manual positioning');
    expect(s).toContain('track: 0 samples');
  });
  it('reports coordinates, accuracy, age and source when ready', () => {
    const s = formatGpsStatus(makeFix(now - 3_000, 5), now, 12, 'track');
    expect(s).toContain('GPS ready');
    expect(s).toContain('48.85000');
    expect(s).toContain('±5 m');
    expect(s).toContain('3 s');
    expect(s).toContain('track');
    expect(s).toContain('track 12');
  });
  it('says "accuracy n/a" when the fix has no accuracy report', () => {
    const s = formatGpsStatus(makeFix(now - 1000), now, 0, 'live');
    expect(s).toContain('accuracy n/a');
  });
});

describe('describeCameraPosition', () => {
  it('summarizes a fresh track position with accuracy and interpolation', () => {
    const s = describeCameraPosition({
      lat: 0, lon: 0, accuracy: 5, timestamp: 0, fixTimestamp: 0,
      ageMs: 12_000, source: 'track', interpolated: true
    });
    expect(s).toBe('track ±5 m (12 s old) interpolated');
  });
  it('omits unknown accuracy and sub-second age', () => {
    const s = describeCameraPosition({
      lat: 0, lon: 0, timestamp: 0, fixTimestamp: 0,
      ageMs: 400, source: 'capture-fix'
    });
    expect(s).toBe('capture-fix');
  });
  it('labels exif provenance', () => {
    const s = describeCameraPosition(exifCameraPosition({ lat: 1, lon: 2 }, 0));
    expect(s).toBe('exif');
  });
});

/* ------------------------------------------------------------------ */
/* withTimeout / requestOneShotFix                                     */
/* ------------------------------------------------------------------ */

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 50, 0)).resolves.toBe(7);
  });
  it('resolves with the fallback when the promise is too slow', async () => {
    const never = new Promise<number>(() => {});
    await expect(withTimeout(never, 10, -1)).resolves.toBe(-1);
  });
  it('resolves with the fallback when the promise rejects', async () => {
    await expect(withTimeout(Promise.reject(new Error('nope')), 50, 3)).resolves.toBe(3);
  });
});

describe('requestOneShotFix', () => {
  it('resolves to null (never rejects) when geolocation is unavailable', async () => {
    // jsdom has no geolocation implementation.
    await expect(requestOneShotFix(30)).resolves.toBeNull();
  });
});
