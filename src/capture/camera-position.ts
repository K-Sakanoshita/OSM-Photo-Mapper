/**
 * Camera-position resolution for photos (issue #10).
 *
 * A photo's geolocation is the CAMERA position at capture time — evidence
 * for locating the photographed object, never the object's own
 * coordinates. Continuous Record mode is optional, so the position must be
 * resolvable independently of it:
 *
 *   1. 'track'        — the recorded track, but ONLY when the capture
 *                       timestamp is genuinely covered (bracketed by fresh
 *                       samples). A stale endpoint outside the recorded
 *                       span is rejected, or used only when no fresher
 *                       capture-time fix exists.
 *   2. 'capture-fix'  — a one-shot getCurrentPosition() started in the
 *                       same user gesture as the camera/file input.
 *   3. 'exif'         — EXIF GPS coordinates (lowest precedence).
 *
 * The resolved position carries provenance (source, accuracy, ageMs) so
 * the reviewer can judge its quality.
 */

import type { CameraPosition, GpsSample } from '../types';
import { trackPositionAt } from '../analysis/position';

/** Max age (ms) of a track endpoint relative to the capture time before the
 *  track is rejected as the camera position. Matches the tracker's
 *  maximumAge (1.5 s) with margin for picker round-trips. */
export const TRACK_FRESHNESS_MS = 15_000;

/** Max age (ms) of a one-shot capture fix relative to the capture time.
 *  The fix is requested in the same gesture as the file input, so a few
 *  seconds of drift (camera shutter lag, gallery selection) is normal. */
export const FIX_FRESHNESS_MS = 60_000;

/** A one-shot position fix obtained at photo-capture gesture time. */
export interface OneShotFix {
  lat: number;
  lon: number;
  /** Reported horizontal accuracy (m); absent when the provider
   *  did not report one. */
  accuracy?: number;
  /** Epoch ms when the fix was obtained. */
  timestamp: number;
}

/** GPS coordinates parsed from a photo's EXIF data. */
export interface ExifGps {
  lat: number;
  lon: number;
}

export interface TrackCameraPosition extends CameraPosition {
  /** True when the capture time lies inside the recorded track span
   *  (genuine bracketing coverage, as opposed to an endpoint fallback). */
  inSpan: boolean;
  /** Direction of travel (course over ground) from the track at the
   *  capture time (when available). MOVEMENT bearing — contextual
   *  evidence only, never a camera bearing (issue #3). */
  movementHeading?: number;
}

/**
 * Camera position from the recorded track at the capture timestamp.
 *
 * Returns undefined when the capture time falls outside the recorded span
 * by more than `maxAgeMs` — `trackPositionAt` would otherwise silently
 * attach the nearest (stale) endpoint, which must NOT become a photo's
 * camera position.
 */
export function trackCameraPosition(
  samples: GpsSample[],
  captureTimestamp: number,
  maxAgeMs: number = TRACK_FRESHNESS_MS
): TrackCameraPosition | undefined {
  if (samples.length === 0) return undefined;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first.timestamp - captureTimestamp > maxAgeMs) return undefined; // before span, stale
  if (captureTimestamp - last.timestamp > maxAgeMs) return undefined; // after span, stale

  const pos = trackPositionAt(samples, captureTimestamp)!;
  const interpolated = captureTimestamp > first.timestamp && captureTimestamp < last.timestamp;
  const ageMs = Math.abs(captureTimestamp - pos.timestamp);
  return {
    lat: pos.lat,
    lon: pos.lon,
    accuracy: pos.accuracy,
    timestamp: captureTimestamp,
    fixTimestamp: pos.timestamp,
    ageMs,
    source: 'track',
    interpolated,
    inSpan: captureTimestamp >= first.timestamp && captureTimestamp <= last.timestamp,
    movementHeading: pos.movementHeading
  };
}

/** Camera position from a one-shot fix taken at capture-gesture time. */
export function captureFixCameraPosition(
  fix: OneShotFix,
  captureTimestamp: number,
  maxAgeMs: number = FIX_FRESHNESS_MS
): CameraPosition | undefined {
  const ageMs = Math.abs(captureTimestamp - fix.timestamp);
  if (ageMs > maxAgeMs) return undefined; // fix too stale relative to capture
  return {
    lat: fix.lat,
    lon: fix.lon,
    accuracy: fix.accuracy,
    timestamp: captureTimestamp,
    fixTimestamp: fix.timestamp,
    ageMs,
    source: 'capture-fix'
  };
}

/** Camera position from EXIF GPS (lowest-precedence fallback). */
export function exifCameraPosition(gps: ExifGps, captureTimestamp: number): CameraPosition {
  return {
    lat: gps.lat,
    lon: gps.lon,
    timestamp: captureTimestamp,
    fixTimestamp: captureTimestamp,
    ageMs: 0,
    source: 'exif'
  };
}

export interface CameraPositionInputs {
  /** Recorded GPS track (may be empty — Record mode is optional). */
  track: GpsSample[];
  /** The photo's capture time (epoch ms), from EXIF/file metadata. */
  captureTimestamp: number;
  /** One-shot fix obtained in the capture gesture (when available). */
  captureFix?: OneShotFix | null;
  /** GPS coordinates parsed from the photo's EXIF data (when present). */
  exifGps?: ExifGps | null;
  trackMaxAgeMs?: number;
  fixMaxAgeMs?: number;
}

/**
 * Resolve the camera position for a photo with full provenance.
 *
 * Precedence: fresh track (genuine bracketing) > capture-time fix >
 * stale track endpoint (only if no fresher fix) > EXIF GPS.
 * Returns undefined when no usable source exists — the caller must then
 * tell the user the photo needs manual positioning.
 */
export function resolveCameraPosition(inp: CameraPositionInputs): CameraPosition | undefined {
  const ts = inp.captureTimestamp;
  const track = trackCameraPosition(inp.track, ts, inp.trackMaxAgeMs ?? TRACK_FRESHNESS_MS);
  const fix = inp.captureFix
    ? captureFixCameraPosition(inp.captureFix, ts, inp.fixMaxAgeMs ?? FIX_FRESHNESS_MS)
    : undefined;

  // Track wins whenever the capture moment is genuinely covered by the
  // recorded span. Outside the span, a stale endpoint only wins when no
  // (fresher) capture-time fix is available.
  if (track && (track.inSpan || !fix || track.ageMs <= fix.ageMs)) return track;
  if (fix) return fix;
  if (inp.exifGps) return exifCameraPosition(inp.exifGps, ts);
  return undefined;
}

/**
 * Start a one-shot high-accuracy position request. MUST be called inside
 * the user gesture that also opens the camera/file input — never await it
 * before opening the input, or the transient user activation is lost and
 * the camera will not open.
 *
 * Resolves to null (never rejects) on denial, error, or timeout.
 */
export function requestOneShotFix(timeoutMs = 15_000): Promise<OneShotFix | null> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let done = false;
    // Plain setTimeout/clearTimeout (identical to window.* in the browser,
    // but keeps this module importable under Node-based test runners).
    const timer = setTimeout(() => finish(null), timeoutMs);
    const finish = (fix: OneShotFix | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(fix);
    };
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        finish({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp
        }),
      () => finish(null),
      { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs }
    );
  });
}

/** Await `p` for at most `ms`; resolve to `fallback` on timeout/failure. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

/* ------------------------------------------------------------------ */
/* GPS readiness status (field-screen UI, issue #10)                   */
/* ------------------------------------------------------------------ */

/** A fix older than this cannot tell the user where they are NOW. */
export const GPS_STALE_MS = 30_000;
/** Accuracy coarser than this is flagged (still usable, with a warning). */
export const GPS_COARSE_M = 20;

export type GpsReadiness = 'unavailable' | 'stale' | 'coarse' | 'ready';

/** Classify a current fix into a readiness state the user can act on.
 *  Unknown accuracy is treated as coarse (conservative, never assumed
 *  precise). */
export function classifyGps(fix: OneShotFix | null | undefined, now: number): GpsReadiness {
  if (!fix) return 'unavailable';
  if (now - fix.timestamp > GPS_STALE_MS) return 'stale';
  if (fix.accuracy == null || fix.accuracy > GPS_COARSE_M) return 'coarse';
  return 'ready';
}

/** One-line status for the field screen. */
export function formatGpsStatus(
  fix: OneShotFix | null | undefined,
  now: number,
  trackSampleCount: number,
  source: 'live' | 'track'
): string {
  if (!fix) {
    return `GPS unavailable — photos will need manual positioning (track: ${trackSampleCount} samples)`;
  }
  const age = Math.max(0, Math.round((now - fix.timestamp) / 1000));
  const state = classifyGps(fix, now);
  const label =
    state === 'ready' ? 'GPS ready' : state === 'coarse' ? 'GPS coarse' : 'GPS stale';
  const acc = fix.accuracy != null ? `±${Math.round(fix.accuracy)} m` : 'accuracy n/a';
  return `${label}: ${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)} · ${acc} · ${age} s · ${source} · track ${trackSampleCount}`;
}

/** Compact provenance string for a photo's camera position (toasts/review). */
export function describeCameraPosition(cp: CameraPosition): string {
  const acc = cp.accuracy != null ? ` ±${Math.round(cp.accuracy)} m` : '';
  const age = cp.ageMs >= 1000 ? ` (${Math.round(cp.ageMs / 1000)} s old)` : '';
  const interp = cp.interpolated ? ' interpolated' : '';
  return `${cp.source}${acc}${age}${interp}`;
}
