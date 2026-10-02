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
 */

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

/** Bearing uncertainty (degrees) by heading quality, used to weight
 *  orientation evidence in the position estimator (issue #3 blocker 3).
 * 'track' = heading derived from the GPS track (movement or the
 * orientation fallback recorded in the tracker). Unknown sources use
 * the conservative DEFAULT. */
export const HEADING_UNCERTAINTY_DEG: Record<HeadingQuality | 'track', number> = {
  compass: 5,
  'absolute-alpha': 5,
  approximate: 20,
  track: 10,
  relative: 10,
  none: 10,
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
  quality: HeadingQuality | 'track' | undefined
): number | undefined {
  if (quality == null || quality === 'relative' || quality === 'none')
    return undefined;
  return HEADING_UNCERTAINTY_DEG[quality];
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
        this.latest = normalizeHeading(e as unknown as OrientationLike, screenAngle);
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

  /** Synchronous snapshot of the most recent normalized reading. */
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
