/**
 * Device orientation -> geographic heading (issue #3, blocker 1).
 *
 * A raw `DeviceOrientationEvent.alpha` is NOT a guaranteed clockwise
 * bearing from geographic north: it is a rotation around the DEVICE z
 * axis, and its meaning depends on the platform (absolute vs relative),
 * the screen orientation (portrait/landscape) and the device tilt. This
 * module normalizes the available signals into a geographic bearing with
 * an explicit QUALITY marker, so downstream evidence (rays, confidence)
 * can weight it appropriately instead of assuming it is a compass.
 *
 * Signal preference (most reliable first):
 *  1. `webkitCompassHeading` (iOS) — platform-computed compass bearing,
 *     already screen-orientation corrected. Quality: 'compass' (magnetic
 *     north; local declination is not corrected).
 *  2. ABSOLUTE alpha — a world-frame yaw. For the common flat-portrait
 *     case the bearing is `360 - alpha`; with screen rotation we add the
 *     screen orientation angle. When the device is far from flat we keep
 *     the value but downgrade quality to 'approximate' (tilt makes the
 *     alpha->bearing mapping less trustworthy).
 *  3. RELATIVE alpha — rotation since an arbitrary reference, NOT
 *     geographic. It is never converted to a bearing (heading =
 *     undefined, quality 'relative').
 *
 * The quality marker feeds the position estimator's bearing-uncertainty
 * weighting (see `headingUncertaintyDeg`).
 *
 * Issue #3 (camera vs movement bearing): this module is the ONLY source
 * of the CAMERA bearing. The GPS track's heading is the MOVEMENT bearing
 * (direction of travel) and is a separate, contextual evidence — it is
 * never normalized here and never used as a camera heading.
 */

import type { CameraHeading, CameraHeadingSource } from '../types';

/** Quality of a geographic heading reading. */
export type HeadingQuality =
  | 'compass' // platform compass (magnetic north)
  | 'absolute-alpha' // absolute alpha, device near flat portrait
  | 'approximate' // absolute alpha under significant tilt/screen rotation
  | 'relative' // relative alpha only — NOT a geographic bearing
  | 'none'; // no usable orientation data

/** A normalized heading reading with provenance-quality evidence. */
export interface HeadingReading {
  /** Geographic bearing, degrees clockwise from north; undefined when
   *  the orientation data is not geographic (relative/none). */
  heading?: number;
  quality: HeadingQuality;
  /** Short human-readable description for evidence display. */
  detail: string;
  /** Epoch ms when the reading was taken. The live tracker always sets
   *  it; without it, freshness relative to the shutter cannot be verified
   *  and the reading is NOT usable as camera bearing (issue #3). */
  timestamp?: number;
}

/** The fields of a DeviceOrientationEvent this module needs. */
export interface OrientationLike {
  alpha?: number | null;
  beta?: number | null;
  gamma?: number | null;
  absolute?: boolean | null;
  webkitCompassHeading?: number | null;
  webkitCompass?: number | null;
}

/** 1-sigma bearing uncertainty (degrees) by heading quality, used to
 *  weight orientation evidence in the position estimator (issue #3).
 *  Covers ONLY the quality markers that yield a geographic bearing:
 *  'track' is gone — the GPS-track (movement) heading is distinct
 *  evidence and never masquerades as a camera heading. */
export const HEADING_UNCERTAINTY_DEG: Record<CameraHeadingSource, number> = {
  compass: 5,
  'absolute-alpha': 5,
  approximate: 20,
  // EXIF GPSImgDirection: the camera's own compass at shutter time — as
  // good as the device compass, but the north reference (true/magnetic/
  // grid) may differ from the device's convention.
  'exif-direction': 5,
};

export const DEFAULT_HEADING_UNCERTAINTY_DEG = 10;

/**
 * Normalize a (synthetic or live) orientation sample into a geographic
 * heading with quality. Pure function — unit-testable without a device.
 */
export function normalizeHeading(
  e: OrientationLike,
  screenAngleDeg = 0
): HeadingReading {
  const compass = finite(e.webkitCompassHeading) ?? finite(e.webkitCompass);
  if (compass != null) {
    return {
      heading: normalizeBearingDeg(compass),
      quality: 'compass',
      detail: 'iOS compass (magnetic north; local declination uncorrected)',
    };
  }

  const alpha = finite(e.alpha);
  if (alpha == null || e.absolute !== true) {
    // Relative (or missing) alpha is not a geographic bearing.
    return {
      quality: 'relative',
      detail:
        alpha == null
          ? 'No orientation data'
          : 'Relative alpha only — not a geographic bearing',
    };
  }

  // Absolute alpha: world-frame yaw. bearing = 360 - alpha, adjusted for
  // screen rotation (landscape turns the screen-top axis).
  const heading = normalizeBearingDeg(360 - alpha + screenAngleDeg);

  const beta = finite(e.beta) ?? 0;
  const gamma = finite(e.gamma) ?? 0;
  const nearFlatPortrait =
    Math.abs(90 - beta) <= 20 && Math.abs(gamma) <= 20 && screenAngleDeg === 0;

  return nearFlatPortrait
    ? {
        heading,
        quality: 'absolute-alpha',
        detail: 'Absolute alpha, near-flat portrait (screen orientation applied)',
      }
    : {
        heading,
        quality: 'approximate',
        detail: 'Absolute alpha under tilt/landscape — treat as approximate',
      };
}

/**
 * Bearing uncertainty (degrees) for a heading of the given quality.
 * `undefined` when there is no usable geographic heading at all
 * (relative-only or none) — the estimator must then not cast a bearing
 * ray for that observation.
 */
export function headingUncertaintyDeg(
  quality: HeadingQuality | undefined
): number | undefined {
  if (quality == null || quality === 'relative' || quality === 'none')
    return undefined;
  if (quality in HEADING_UNCERTAINTY_DEG)
    return HEADING_UNCERTAINTY_DEG[quality as CameraHeadingSource];
  return DEFAULT_HEADING_UNCERTAINTY_DEG;
}

/**
 * Maximum age (ms) of an orientation reading, relative to the CAPTURE
 * timestamp, for it to be usable as the photo's camera bearing (issue
 * #3). A person can rotate the phone ~90° in a second; a reading from
 * several seconds before the shutter no longer describes the direction
 * the camera was pointing at capture time.
 */
export const ORIENT_FRESH_MS = 10_000;

/**
 * Associate a (possibly stale or post-return) orientation reading with a
 * capture, producing the photo's camera-bearing evidence — or an explicit
 * human-readable reason why the reading is NOT used (issue #3).
 *
 * The camera bearing comes ONLY from the device orientation. The movement
 * heading (direction of travel) is never an input here.
 *
 * Rejection rules (each yields a `headingNote`, never a bearing):
 *  - no reading, or no geographic heading (relative/none): no sensor data;
 *  - reading lacks a timestamp: freshness cannot be verified;
 *  - reading postdates the capture (post-return reading): the shutter
 *    already fired — the reading describes a different moment;
 *  - reading predates the camera launch (issue #13 phase 1, external
 *    camera only): while the OS camera was open the app was in the
 *    background, so a reading taken BEFORE the picker launched describes
 *    the pre-camera scene — rejected even if still fresh at capture;
 *  - reading older than ORIENT_FRESH_MS: stale.
 * When accepted, the result carries source, uncertainty, timestamp and
 * age so the estimator and the reviewer can see the full provenance.
 *
 * `pickerLaunchTs` is the moment the external camera/file picker was
 * launched. In-app camera captures (issue #13 phase 2) read the
 * orientation AT the shutter instant and pass no launch timestamp.
 */
export function associateCameraHeading(
  reading: HeadingReading | null | undefined,
  captureTimestamp: number,
  pickerLaunchTs?: number
): { cameraHeading?: CameraHeading; headingNote?: string } {
  if (!reading || reading.heading == null) {
    return {
      headingNote: reading
        ? `No geographic heading (${reading.detail})`
        : 'No orientation reading'
    };
  }
  if (reading.timestamp == null) {
    return {
      headingNote:
        'Orientation reading has no timestamp — freshness unverifiable, not used'
    };
  }
  if (reading.timestamp > captureTimestamp) {
    return {
      headingNote: `Orientation reading postdates capture by ${Math.round(reading.timestamp - captureTimestamp)} ms — post-return reading rejected`
    };
  }
  if (pickerLaunchTs != null && reading.timestamp < pickerLaunchTs) {
    const before = Math.round((pickerLaunchTs - reading.timestamp) / 1000);
    return {
      headingNote: `Orientation reading predates camera launch (read ${before} s before the picker opened) — not shutter-time evidence (issue #13)`
    };
  }
  const ageMs = captureTimestamp - reading.timestamp;
  if (ageMs > ORIENT_FRESH_MS) {
    return {
      headingNote: `Orientation reading stale (${Math.round(ageMs / 1000)} s before capture) — not used as camera bearing`
    };
  }
  const source: CameraHeadingSource =
    reading.quality === 'compass' ||
    reading.quality === 'absolute-alpha' ||
    reading.quality === 'approximate'
      ? reading.quality
      : 'approximate'; // defensive: heading present with an unexpected quality
  return {
    cameraHeading: {
      bearing: reading.heading,
      source,
      uncertaintyDeg: headingUncertaintyDeg(source) ?? DEFAULT_HEADING_UNCERTAINTY_DEG,
      timestamp: reading.timestamp,
      ageMs,
      detail: reading.detail
    }
  };
}

function finite(v: number | null | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function normalizeBearingDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Live orientation tracker (browser).
 *
 * Subscribes to `deviceorientation` (with the iOS permission dance, which
 * must be triggered from a user gesture) and keeps the most recent
 * normalized reading. `read()` is a synchronous snapshot — call it at
 * capture time, inside the user-gesture window.
 */
export class OrientationTracker {
  private latest: HeadingReading = { quality: 'none', detail: 'Not started' };
  private listener: ((e: DeviceOrientationEvent) => void) | null = null;
  private started = false;

  /** Attach listeners. On iOS this requests the orientation permission —
   *  call from a user gesture (e.g. the "start survey" button). Idempotent. */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;

    const attach = () => {
      if (this.listener) return;
      this.listener = (e: DeviceOrientationEvent) => {
        const screenAngle =
          typeof screen !== 'undefined' && screen.orientation?.angle != null
            ? screen.orientation.angle
            : 0;
        // Issue #3: every reading is timestamped so the capture pipeline
        // can check freshness relative to the shutter.
        this.latest = {
          ...normalizeHeading(e as unknown as OrientationLike, screenAngle),
          timestamp: Date.now()
        };
      };
      window.addEventListener('deviceorientation', this.listener);
    };

    const DOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    } | undefined;
    if (typeof DOE?.requestPermission === 'function') {
      // iOS 13+: permission must be requested from a user gesture.
      void DOE.requestPermission().then(
        (res) => {
          if (res === 'granted') attach();
          else
            this.latest = {
              quality: 'none',
              detail: 'Orientation permission denied',
            };
        },
        () => {
          this.latest = { quality: 'none', detail: 'Orientation permission failed' };
        }
      );
    } else if (typeof window !== 'undefined' && 'ondeviceorientation' in window) {
      attach();
    } else {
      this.latest = { quality: 'none', detail: 'No orientation sensor exposed' };
    }
  }

  /** Synchronous snapshot of the most recent normalized reading. The
   *  timestamp reflects WHEN the reading was taken — callers must check
   *  freshness before using it as a capture-time camera bearing (see
   *  `associateCameraHeading`). */
  read(): HeadingReading {
    return this.latest;
  }

  stop(): void {
    if (this.listener && typeof window !== 'undefined') {
      window.removeEventListener('deviceorientation', this.listener);
    }
    this.listener = null;
    this.started = false;
  }
}
