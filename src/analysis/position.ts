import type { BBox, GpsSample, Photo } from '../types';

/**
 * Position estimation helpers.
 *
 * The estimator returns a candidate position plus supporting evidence, not an
 * assertion that the coordinate is correct. Each observation casts a bearing
 * "ray" from the capture location; the estimate is the ray intersection
 * (least-squares) when multiple observations of the same object are available,
 * or the best single-ray projection otherwise.
 */

const EARTH_RADIUS = 6371000; // meters

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Destination point given a start, an initial bearing (deg from north) and a
 * distance (m). Standard "destination point" formulae.
 */
export function bearingToLatLon(
  latDeg: number,
  lonDeg: number,
  bearingDeg: number,
  distanceM: number
): { lat: number; lon: number } {
  const delta = distanceM / EARTH_RADIUS;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(latDeg);
  const lambda1 = toRad(lonDeg);

  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );

  return { lat: (phi2 * 180) / Math.PI, lon: (lambda2 * 180) / Math.PI };
}

/** Assumed GPS accuracy (m) when a fix reports none — a conservative
 * middle value, so unknown accuracy is never treated as perfect. */
const ASSUMED_ACCURACY_M = 10;

/**
 * Refine the capture heading using where the object sits in the image.
 *
 * An object near the right/left edge should not be projected along the optical
 * centerline. We assume a nominal horizontal field of view (default ~62deg,
 * typical of a phone camera) and map the bbox center's horizontal offset to a
 * bearing offset.
 */
export function imageBearing(
  headingDeg: number,
  bbox: BBox,
  horizontalFovDeg = 62
): number {
  const centerU = bbox.x + bbox.w / 2; // 0..1 across image width
  const offset = (centerU - 0.5) * horizontalFovDeg;
  return normalizeBearing(headingDeg + offset);
}

export function normalizeBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** A single cast ray from a capture position toward an observed object. */
export interface ObservationRay {
  lat: number;
  lon: number;
  bearingDeg: number;
  distanceM: number;
  /** Reported GPS accuracy (m) at capture; absent when unknown. */
  gpsAccuracy?: number;
  /** Whether the bearing is grounded in real orientation data. */
  hasHeading: boolean;
}

/** A candidate position estimate with evidence. */
export interface PositionEstimate {
  lat: number;
  lon: number;
  /** 0..1 confidence in the position. */
  positionConfidence: number;
  warnings: string[];
}

/**
 * Estimate an object's position from one or more observation rays.
 *
 * With a single ray we project along it (weak, distance-dependent). With
 * multiple rays we intersect them: for each ray we sample candidate points
 * along it and minimize the summed angular deviation, which is more robust
 * than naive pairwise intersection when headings are noisy.
 */
export function estimatePosition(rays: ObservationRay[]): PositionEstimate {
  const warnings: string[] = [];

  if (rays.length === 0) {
    throw new Error('estimatePosition requires at least one ray');
  }

  const hasAnyHeading = rays.some((r) => r.hasHeading);
  if (!hasAnyHeading) {
    warnings.push('No orientation data: position is based on GPS only, not camera direction.');
  }

  if (rays.length === 1) {
    const r = rays[0];
    const d = r.distanceM;
    const { lat, lon } = bearingToLatLon(r.lat, r.lon, r.bearingDeg, d);
    // Unknown accuracy is penalized as 10 m: conservative, never assumed
    // perfect (issue #10 — EXIF GPS carries no accuracy report).
    const acc = r.gpsAccuracy ?? ASSUMED_ACCURACY_M;
    // Confidence drops with GPS accuracy and with an unknown distance.
    let confidence = clamp01(1 - acc / 100);
    if (!r.hasHeading) confidence *= 0.4;
    if (d <= 0) {
      confidence *= 0.3;
      warnings.push('No distance estimate: position approximated by capture location.');
    }
    if (d <= 0) {
      // Fall back to capture location.
      return { lat: r.lat, lon: r.lon, positionConfidence: confidence * 0.5, warnings };
    }
    return { lat, lon, positionConfidence: confidence, warnings };
  }

  // Multi-ray: coarse-to-fine search minimizing summed angular deviation.
  const centroid = rays.reduce(
    (acc, r) => ({ lat: acc.lat + r.lat / rays.length, lon: acc.lon + r.lon / rays.length }),
    { lat: 0, lon: 0 }
  );

  let best = { lat: centroid.lat, lon: centroid.lon, error: Number.POSITIVE_INFINITY };
  let lo = 1;
  let hi = 200; // meters of search radius around centroid

  for (let pass = 0; pass < 5; pass++) {
    const span = hi - lo;
    const steps = pass === 0 ? 12 : 16;
    for (let i = 0; i <= steps; i++) {
      const radius = lo + (span * i) / steps;
      for (let a = 0; a < 360; a += 30) {
        const cand = bearingToLatLon(centroid.lat, centroid.lon, a, radius);
        const err = totalAngularError(cand.lat, cand.lon, rays);
        if (err < best.error) best = { lat: cand.lat, lon: cand.lon, error: err };
      }
    }
    // Tighten bounds around the best.
    const bd = distanceMeters(centroid.lat, centroid.lon, best.lat, best.lon);
    const margin = Math.max(10, bd * 0.5);
    lo = Math.max(1, bd - margin);
    hi = bd + margin;
  }

  // Angular error (degrees) -> confidence. Small error = high confidence.
  const confidence = clamp01(1 - best.error / 90);
  const accs = rays.map((r) => r.gpsAccuracy).filter((a): a is number => a != null);
  if (accs.length === 0) {
    warnings.push('GPS accuracy unknown for all rays; position quality unverified.');
  } else {
    const meanAcc = accs.reduce((s, a) => s + a, 0) / accs.length;
    if (meanAcc > 20) warnings.push(`GPS accuracy is coarse (mean ~${Math.round(meanAcc)} m).`);
  }
  if (best.error > 30) warnings.push('Observation rays disagree; position is low confidence.');

  return { lat: best.lat, lon: best.lon, positionConfidence: confidence, warnings };
}

/** Sum of (absolute) angular deviations from the candidate point to each ray origin. */
function totalAngularError(lat: number, lon: number, rays: ObservationRay[]): number {
  let sum = 0;
  for (const r of rays) {
    if (!r.hasHeading) continue;
    const actual = bearingBetween(r.lat, r.lon, lat, lon);
    let diff = Math.abs(actual - r.bearingDeg);
    if (diff > 180) diff = 360 - diff;
    sum += diff;
  }
  const n = rays.filter((r) => r.hasHeading).length || 1;
  return sum / n;
}

/** Initial bearing (deg) from point A (lat/lon) to point B. */
export function bearingBetween(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return normalizeBearing((Math.atan2(y, x) * 180) / Math.PI);
}

/** Great-circle distance in meters between two points. */
export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Associate a timestamp with the GPS track.
 *
 * Finds the samples that truly bracket `at` (the last sample at or before
 * `at` and the first sample after it) via binary search, then linearly
 * interpolates between exactly that pair (bearing/rate interpolation over
 * short walking intervals is a good approximation). This avoids both
 * snapping the photo to a seconds-old fix and interpolating across the wrong
 * interval (e.g. picking the *nearest* sample first and then pairing it with
 * its predecessor can select the A-B interval when the capture is actually
 * between B and C).
 *
 * Out-of-range timestamps return the nearest endpoint sample unchanged; an
 * exact sample hit returns that sample unchanged.
 *
 * Note: this yields the CAMERA position at capture time. It is never used as
 * the target object's coordinate (that is the position estimator's job).
 */
export function trackPositionAt(
  samples: GpsSample[],
  at: number
): GpsSample | undefined {
  if (samples.length === 0) return undefined;

  // Samples are assumed sorted by timestamp (they are, per surveyDb.loadSurvey).
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (at <= first.timestamp) return first;
  if (at >= last.timestamp) return last;

  // Binary search: index of the FIRST sample with timestamp > at.
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].timestamp > at) hi = mid;
    else lo = mid + 1;
  }
  const a = samples[lo - 1]; // last sample at or before `at`
  const b = samples[lo]; // first sample after `at`

  const span = b.timestamp - a.timestamp;
  if (span <= 0) {
    // Duplicate timestamps: no interval to interpolate across.
    return Math.abs(a.timestamp - at) <= Math.abs(b.timestamp - at) ? a : b;
  }

  const t = (at - a.timestamp) / span; // in (0, 1]; t === 1 cannot occur (b is after `at`)
  if (t === 0) return a; // exact hit on sample a

  return {
    id: `gps-interp-${at}`,
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    accuracy: (() => {
      const accs = [a.accuracy, b.accuracy].filter((x): x is number => x != null);
      return accs.length > 0 ? Math.max(...accs) : undefined; // worst of the pair
    })(),
    timestamp: at,
    speed: a.speed != null && b.speed != null ? a.speed + (b.speed - a.speed) * t : undefined,
    heading:
      a.heading != null && b.heading != null
        ? interpolateHeading(a.heading, b.heading, t)
        : a.heading ?? b.heading
  };
}

/** Shortest-arc interpolation between two bearings, degrees. */
function interpolateHeading(fromDeg: number, toDeg: number, t: number): number {
  let delta = ((toDeg - fromDeg) % 360 + 360) % 360;
  if (delta > 180) delta -= 360;
  return normalizeBearing(fromDeg + delta * t);
}

/**
 * Build an observation ray from a photo + its detected object.
 * If the photo lacks heading, the ray has no usable bearing and is marked
 * hasHeading=false (still contributes its position as a centroid anchor).
 */
export function rayFromPhoto(
  photo: Photo,
  bbox: BBox,
  distanceM?: number
): ObservationRay | null {
  const gps = photo.gps;
  if (!gps) return null;
  const hasHeading = photo.heading != null;
  const bearingDeg = hasHeading ? imageBearing(photo.heading!, bbox) : 0;
  return {
    lat: gps.lat,
    lon: gps.lon,
    bearingDeg,
    distanceM: distanceM ?? 0,
    gpsAccuracy: gps.accuracy,
    hasHeading,
  };
}
