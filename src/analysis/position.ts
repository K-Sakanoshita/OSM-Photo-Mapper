import type {
  BBox,
  CameraHeadingSource,
  GpsSample,
  Observation,
  Photo,
  PositionQuality
} from '../types';
import { DEFAULT_HEADING_UNCERTAINTY_DEG } from '../capture/orientation';

/**
 * Position estimation helpers (issue #3).
 *
 * The estimator returns a candidate position plus supporting EVIDENCE, not an
 * assertion that the coordinate is correct. Each observation casts a bearing
 * "ray" from the camera position at capture; the estimate is the weighted
 * ray intersection when multiple observations of the same object are
 * available, or the best single-ray projection otherwise.
 *
 * Every output carries:
 *  - `uncertaintyMeters`: a 1-sigma horizontal uncertainty DERIVED FROM THE
 *    EVIDENCE (GPS accuracy, heading quality, distance uncertainty, camera
 *    position age, fit error) — never a function of confidence alone.
 *  - `positionQuality`: an explicit classification (triangulated / single-ray
 *    / weak-geometry / contradictory / no-orientation) so reviewers can tell
 *    a strong triangulation from an ill-conditioned one.
 *  - `warnings`: human-readable evidence flags (nearly parallel rays, short
 *    baseline, stale GPS, contradictory distances, ...).
 *
 * A position is only an evidence-backed PROPOSAL: snapping is a separate,
 * conservative decision (see snap-decision.ts).
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
    sin(phi1) * cos(delta) + cos(phi1) * sin(delta) * cos(theta)
  );
  const lambda2 =
    lambda1 +
    atan2(
      sin(theta) * sin(delta) * cos(phi1),
      cos(delta) - sin(phi1) * sin(phi2)
    );

  return { lat: (phi2 * 180) / Math.PI, lon: (lambda2 * 180) / Math.PI };
}

// Small math aliases keep the geodesic formulae readable.
const { sin, cos, tan, asin, atan2, sqrt, max, min } = Math;

/** Assumed GPS accuracy (m) when a fix reports none — a conservative
 * middle value, so unknown accuracy is never treated as perfect. */
const ASSUMED_ACCURACY_M = 10;

/** When a distance estimate has no uncertainty, assume ±50% of it
 * (conservative; distance-from-image is a weak signal). */
const DEFAULT_DISTANCE_UNCERTAINTY_FRAC = 0.5;
const MIN_DISTANCE_UNCERTAINTY_M = 2;

/** Typical walking speed (m/s): how far a person drifts per second of
 * camera-position staleness. */
const WALK_SPEED_MPS = 1.4;
/** Camera positions older than this relative to capture are flagged stale. */
export const STALE_CAMERA_MS = 30_000;

/** Crossing angles below this make ray triangulation ill-conditioned. */
export const PARALLEL_CROSSING_DEG = 20;
/** Baselines shorter than this give a weak triangulation. */
export const MIN_BASELINE_M = 10;
/** Mean angular fit error above this marks the observations contradictory. */
export const CONTRADICTORY_FIT_DEG = 30;

/** Nominal horizontal field of view of a phone camera (deg). */
export const NOMINAL_FOV_DEG = 62;

/**
 * Refine the capture heading using where the object sits in the image.
 *
 * An object near the right/left edge should not be projected along the
 * optical centerline. We assume a nominal horizontal field of view
 * (default ~62deg, typical of a phone camera) and map the bbox center's
 * horizontal offset to a bearing offset.
 */
export function imageBearing(
  headingDeg: number,
  bbox: BBox,
  horizontalFovDeg = NOMINAL_FOV_DEG
): number {
  const centerU = bbox.x + bbox.w / 2; // 0..1 across image width
  const offset = (centerU - 0.5) * horizontalFovDeg;
  return normalizeBearing(headingDeg + offset);
}

export function normalizeBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** A single cast ray from a camera position toward an observed object,
 *  carrying the quality evidence of each input (issue #3). */
export interface ObservationRay {
  lat: number;
  lon: number;
  bearingDeg: number;
  distanceM: number;
  /** Reported GPS accuracy (m) at capture; absent when unknown. */
  gpsAccuracy?: number;
  /** Whether the bearing is grounded in a real camera heading (device
   *  orientation). The movement/travel heading NEVER sets this (issue #3). */
  hasHeading: boolean;
  /** Provenance of the camera heading: which orientation path produced
   *  it (issue #3). Absent when hasHeading is false. */
  headingSource?: CameraHeadingSource;
  /** Age of the camera-heading reading relative to the shutter (ms);
   *  absent when hasHeading is false (issue #3). */
  headingAgeMs?: number;
  /** 1-sigma bearing uncertainty in degrees (heading quality + bbox
   *  offset spread). Absent when hasHeading is false. */
  bearingUncDeg?: number;
  /** 1-sigma distance uncertainty in meters; absent when unknown. */
  distanceUncertaintyM?: number;
  /** How stale the camera position is relative to capture (ms). */
  cameraAgeMs?: number;
  /** Provenance of the camera position (track / capture-fix / exif). */
  cameraSource?: string;
}

/** A candidate position estimate with full evidence. */
export interface PositionEstimate {
  lat: number;
  lon: number;
  /** 0..1 confidence in the quality of the position EVIDENCE (not a
   *  probability that the coordinate is exact). */
  positionConfidence: number;
  /** 1-sigma horizontal uncertainty in meters, derived from the evidence. */
  uncertaintyMeters: number;
  /** Quality classification for the review UI (issue #3). */
  positionQuality: PositionQuality;
  warnings: string[];
}

/** Per-ray evidence values used by the estimator. */
interface RayEvidence {
  gpsAcc: number;
  /** 1-sigma bearing uncertainty (deg); undefined without a heading. */
  bearingUncDeg: number | undefined;
  /** 1-sigma distance uncertainty (m); undefined when no distance. */
  distanceUncM: number | undefined;
  /** Position drift (m) attributable to camera-position staleness. */
  ageDriftM: number;
}

function rayEvidence(r: ObservationRay): RayEvidence {
  const gpsAcc = r.gpsAccuracy ?? ASSUMED_ACCURACY_M;
  const bearingUncDeg = r.hasHeading
    ? r.bearingUncDeg ?? DEFAULT_HEADING_UNCERTAINTY_DEG
    : undefined;
  const distanceUncM =
    r.distanceM > 0
      ? r.distanceUncertaintyM ??
        max(MIN_DISTANCE_UNCERTAINTY_M, r.distanceM * DEFAULT_DISTANCE_UNCERTAINTY_FRAC)
      : undefined;
  const ageDriftM =
    r.cameraAgeMs != null ? (r.cameraAgeMs / 1000) * WALK_SPEED_MPS : 0;
  return { gpsAcc, bearingUncDeg, distanceUncM, ageDriftM };
}

/**
 * Estimate an object's position from one or more observation rays.
 *
 *  - No usable heading anywhere: the GPS positions themselves are the
 *    evidence -> weighted centroid, quality 'no-orientation'.
 *  - Exactly one usable ray: project along it (distance-dominated),
 *    quality 'single-ray'.
 *  - Two or more usable rays: weighted ray intersection. The fit is
 *    weighted by bearing quality (precise compass rays outweigh
 *    approximate ones), and distance evidence is checked for
 *    consistency. The geometry (crossing angle, baseline) is classified
 *    explicitly instead of being hidden inside a confidence number.
 */
export function estimatePosition(rays: ObservationRay[]): PositionEstimate {
  const warnings: string[] = [];

  if (rays.length === 0) {
    throw new Error('estimatePosition requires at least one ray');
  }

  const headingRays = rays.filter((r) => r.hasHeading);
  pushStaleWarnings(warnings, rays);

  if (headingRays.length === 0) {
    return estimateNoOrientation(rays, warnings);
  }

  if (headingRays.length === 1) {
    if (rays.length > 1) {
      warnings.push(
        `Only 1 of ${rays.length} observations has usable orientation; triangulation not possible.`
      );
    }
    return estimateSingleRay(headingRays[0], warnings);
  }

  return estimateMultiRay(headingRays, warnings);
}

function pushStaleWarnings(warnings: string[], rays: ObservationRay[]): void {
  for (const r of rays) {
    if (r.cameraAgeMs != null && r.cameraAgeMs > STALE_CAMERA_MS) {
      warnings.push(
        `Camera position is stale (${Math.round(r.cameraAgeMs / 1000)} s before capture) — the observer may have moved since the fix.`
      );
    }
  }
}

/* ---------------- no orientation: GPS positions only ---------------- */

function estimateNoOrientation(
  rays: ObservationRay[],
  warnings: string[]
): PositionEstimate {
  warnings.push(
    'No orientation data: position is based on GPS only, not camera direction.'
  );
  // Accuracy-weighted centroid (precise fixes outweigh coarse ones).
  let wx = 0;
  let wy = 0;
  let wsum = 0;
  let accSqSum = 0;
  let maxDrift = 0;
  for (const r of rays) {
    const e = rayEvidence(r);
    const w = 1 / (e.gpsAcc * e.gpsAcc);
    wx += w * r.lat;
    wy += w * r.lon;
    wsum += w;
    accSqSum += e.gpsAcc * e.gpsAcc;
    maxDrift = max(maxDrift, e.ageDriftM);
  }
  const lat = wx / wsum;
  const lon = wy / wsum;
  const meanAcc = sqrt(accSqSum / rays.length);
  const uncertaintyMeters = sqrt(meanAcc * meanAcc + maxDrift * maxDrift);
  const positionConfidence = min(clamp01(1 - uncertaintyMeters / 80), 0.2);
  return {
    lat,
    lon,
    positionConfidence,
    uncertaintyMeters,
    positionQuality: 'no-orientation',
    warnings,
  };
}

/* ---------------- single-ray projection ---------------- */

function estimateSingleRay(
  r: ObservationRay,
  warnings: string[]
): PositionEstimate {
  const e = rayEvidence(r);
  const d = r.distanceM;

  if (d <= 0) {
    warnings.push('No distance estimate: position approximated by capture location.');
    const uncertaintyMeters = sqrt(
      e.gpsAcc * e.gpsAcc + e.ageDriftM * e.ageDriftM
    );
    return {
      lat: r.lat,
      lon: r.lon,
      positionConfidence: min(clamp01(1 - uncertaintyMeters / 80), 0.25),
      uncertaintyMeters,
      positionQuality: 'single-ray',
      warnings,
    };
  }

  const { lat, lon } = bearingToLatLon(r.lat, r.lon, r.bearingDeg, d);
  // Bearing error maps to lateral error: d * tan(uncertainty angle).
  const lateral = d * tan(toRad(min(e.bearingUncDeg ?? DEFAULT_HEADING_UNCERTAINTY_DEG, 45)));
  const uncertaintyMeters = sqrt(
    e.gpsAcc * e.gpsAcc +
      e.ageDriftM * e.ageDriftM +
      lateral * lateral +
      (e.distanceUncM ?? 0) * (e.distanceUncM ?? 0)
  );
  return {
    lat,
    lon,
    // A single ray is inherently weaker than a triangulation: capped.
    positionConfidence: min(clamp01(1 - uncertaintyMeters / 60), 0.5),
    uncertaintyMeters,
    positionQuality: 'single-ray',
    warnings,
  };
}

/* ---------------- multi-ray weighted intersection ---------------- */

function estimateMultiRay(
  headingRays: ObservationRay[],
  warnings: string[]
): PositionEstimate {
  const centroid = headingRays.reduce(
    (acc, r) => ({ lat: acc.lat + r.lat / headingRays.length, lon: acc.lon + r.lon / headingRays.length }),
    { lat: 0, lon: 0 }
  );

  // Weights: precise bearings dominate the fit (issue #3 blocker 3:
  // weight GPS accuracy, heading uncertainty, distance uncertainty).
  const weights = headingRays.map(
    (r) => 1 / (rayEvidence(r).bearingUncDeg ?? DEFAULT_HEADING_UNCERTAINTY_DEG)
  );

  // Progressive search: a coarse full-circle grid, then refinement passes
  // that shrink BOTH windows (radius around the best radius, bearing around
  // the best bearing) with finer steps. The bearing window MUST track the
  // best bearing — with a fixed 30deg angular grid the optimizer can slide
  // outward along a grid line and settle on a false minimum that never
  // approaches the true intersection.
  let best = {
    lat: centroid.lat,
    lon: centroid.lon,
    error: Number.POSITIVE_INFINITY,
    r: 0,
    a: 0
  };
  // The search radius is BOUNDED. An unbounded range lets the optimizer
  // slide arbitrarily far along a ray to shrink the mean angular error —
  // contradictory rays (no forward intersection) then look "fit" because
  // their bearings converge asymptotically. Distance evidence anchors the
  // bound; without it we cap at a realistic phone-survey range.
  const anchors = headingRays
    .filter((r) => r.distanceM > 0)
    .map((r) => {
      const e = rayEvidence(r);
      const cDist = distanceMeters(centroid.lat, centroid.lon, r.lat, r.lon);
      return cDist + r.distanceM + (e.distanceUncM ?? 0) * 2 + 50;
    });
  const searchHi = Math.max(200, ...anchors);
  let rLo = 1;
  let rHi = searchHi;
  let aCenter = 0;
  let aHalf = 180; // full circle for the coarse pass

  for (let pass = 0; pass < 6; pass++) {
    const rSteps = pass === 0 ? 12 : 24;
    const aSteps = pass === 0 ? 12 : 24;
    for (let i = 0; i <= rSteps; i++) {
      const radius = rLo + ((rHi - rLo) * i) / rSteps;
      for (let j = 0; j <= aSteps; j++) {
        const a = normalizeBearing(aCenter - aHalf + (2 * aHalf * j) / aSteps);
        const cand = bearingToLatLon(centroid.lat, centroid.lon, a, radius);
        const err = weightedAngularError(cand.lat, cand.lon, headingRays, weights);
        if (err < best.error) {
          best = { lat: cand.lat, lon: cand.lon, error: err, r: radius, a };
        }
      }
    }
    rLo = max(1, best.r - max(10, best.r * 0.4));
    rHi = Math.min(searchHi, best.r + max(10, best.r * 0.4));
    aCenter = best.a;
    aHalf = max(2, aHalf / 2);
  }

  const fitErrDeg = best.error;

  // --- Geometry quality (issue #3 blocker 2) --------------------------
  const origins = headingRays.map((r) => ({ lat: r.lat, lon: r.lon }));
  const baselineM = maxPairwiseDistance(origins);
  const crossingDeg = minCrossingAngle(headingRays);

  // --- Distance consistency (distance evidence, issue #3 blocker 3) ---
  const distConflicts: string[] = [];
  let meanSolutionDist = 0;
  let distCount = 0;
  for (const r of headingRays) {
    const e = rayEvidence(r);
    const dSol = distanceMeters(r.lat, r.lon, best.lat, best.lon);
    if (r.distanceM > 0) {
      meanSolutionDist += dSol;
      distCount++;
      const allowed = (e.distanceUncM ?? 0) + 0.5 * r.distanceM;
      if (Math.abs(dSol - r.distanceM) > allowed) {
        distConflicts.push(
          `Distance evidence conflicts: observation says ~${Math.round(r.distanceM)} m, geometry implies ~${Math.round(dSol)} m.`
        );
      }
    }
  }
  if (distCount > 0) meanSolutionDist /= distCount;

  // --- Classification ---------------------------------------------------
  let positionQuality: PositionQuality;
  // Geometry is classified FIRST: with nearly parallel rays or a short
  // baseline the fit error is inflated by the geometry itself, so a large
  // fit error there is NOT evidence that the observations contradict each
  // other — the geometry is the problem (issue #3 acceptance criterion).
  if (crossingDeg < PARALLEL_CROSSING_DEG || baselineM < MIN_BASELINE_M) {
    positionQuality = 'weak-geometry';
    if (crossingDeg < PARALLEL_CROSSING_DEG) {
      warnings.push(
        `Rays are nearly parallel (min crossing angle ${crossingDeg.toFixed(0)}deg) — triangulation is ill-conditioned.`
      );
    }
    if (baselineM < MIN_BASELINE_M) {
      warnings.push(
        `Camera baseline is only ${baselineM.toFixed(0)} m — triangulation is weak; move and shoot again.`
      );
    }
    if (fitErrDeg > CONTRADICTORY_FIT_DEG) {
      warnings.push(
        `Observation rays also disagree (mean weighted angular deviation ${fitErrDeg.toFixed(0)}deg) — unreliable in this geometry.`
      );
    }
    warnings.push(...distConflicts);
  } else if (fitErrDeg > CONTRADICTORY_FIT_DEG || distConflicts.length > 0) {
    positionQuality = 'contradictory';
    if (fitErrDeg > CONTRADICTORY_FIT_DEG) {
      warnings.push(
        `Observation rays disagree (mean weighted angular deviation ${fitErrDeg.toFixed(0)}deg).`
      );
    }
    warnings.push(...distConflicts);
  } else {
    positionQuality = 'triangulated';
  }

  // --- Evidence-derived uncertainty (issue #3 blocker 3) ----------------
  const evidence = headingRays.map(rayEvidence);
  const meanAcc = evidence.reduce((s, e) => s + e.gpsAcc, 0) / evidence.length;
  const maxDrift = evidence.reduce((s, e) => max(s, e.ageDriftM), 0);
  // Angular fit error maps to lateral error at the mean solution distance
  // (tan is capped: beyond 60deg the geometry has stopped being evidence).
  const uAng = meanSolutionDist * tan(toRad(min(fitErrDeg, 60)));
  let uncertaintyMeters = sqrt(
    meanAcc * meanAcc + maxDrift * maxDrift + uAng * uAng
  );
  if (positionQuality === 'weak-geometry') {
    // Parallel rays: even a small angle error yields a large lateral error.
    uncertaintyMeters = max(
      uncertaintyMeters,
      meanSolutionDist * tan(toRad(30))
    );
  } else if (positionQuality === 'contradictory') {
    uncertaintyMeters = max(
      uncertaintyMeters,
      meanSolutionDist * tan(toRad(45))
    );
  }

  const accs = headingRays.map((r) => r.gpsAccuracy).filter((a): a is number => a != null);
  if (accs.length === 0) {
    warnings.push('GPS accuracy unknown for all rays; position quality unverified.');
  } else {
    const meanAccReported = accs.reduce((s, a) => s + a, 0) / accs.length;
    if (meanAccReported > 20)
      warnings.push(`GPS accuracy is coarse (mean ~${Math.round(meanAccReported)} m).`);
  }

  const base = clamp01(1 - uncertaintyMeters / 40);
  const positionConfidence =
    positionQuality === 'weak-geometry'
      ? min(base, 0.4)
      : positionQuality === 'contradictory'
        ? min(base, 0.2)
        : base;

  return {
    lat: best.lat,
    lon: best.lon,
    positionConfidence,
    uncertaintyMeters,
    positionQuality,
    warnings,
  };
}

/** Weighted mean angular deviation (degrees) from a candidate point to the
 *  ray origins; precise bearings (larger weight) dominate the fit. */
function weightedAngularError(
  lat: number,
  lon: number,
  rays: ObservationRay[],
  weights: number[]
): number {
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < rays.length; i++) {
    const r = rays[i];
    const actual = bearingBetween(r.lat, r.lon, lat, lon);
    let diff = Math.abs(actual - r.bearingDeg);
    if (diff > 180) diff = 360 - diff;
    sum += weights[i] * diff;
    wsum += weights[i];
  }
  return sum / (wsum || 1);
}

/** Largest pairwise great-circle distance between the ray origins (m). */
function maxPairwiseDistance(origins: { lat: number; lon: number }[]): number {
  let best = 0;
  for (let i = 0; i < origins.length; i++) {
    for (let j = i + 1; j < origins.length; j++) {
      best = max(best, distanceMeters(origins[i].lat, origins[i].lon, origins[j].lat, origins[j].lon));
    }
  }
  return best;
}

/** Smallest pairwise crossing angle between ray bearings (0..180 deg). */
function minCrossingAngle(rays: ObservationRay[]): number {
  let best = 180;
  for (let i = 0; i < rays.length; i++) {
    for (let j = i + 1; j < rays.length; j++) {
      let diff = Math.abs(rays[i].bearingDeg - rays[j].bearingDeg) % 360;
      if (diff > 180) diff = 360 - diff;
      best = min(best, diff);
    }
  }
  return best;
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
  const y = sin(dLon) * cos(phi2);
  const x = cos(phi1) * sin(phi2) - sin(phi1) * cos(phi2) * cos(dLon);
  return normalizeBearing((atan2(y, x) * 180) / Math.PI);
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
  const a = sin(dPhi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * asin(min(1, sqrt(a)));
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
 * snapping the photo to a seconds-old fix and interpolating across the
 * wrong interval (e.g. picking the *nearest* sample first and then pairing
 * it with its predecessor can select the A-B interval when the capture is
 * actually between B and C).
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
    // Direction of travel is interpolated on the shortest arc, like any
    // bearing — but it stays a MOVEMENT heading (issue #3), never a
    // camera heading.
    movementHeading:
      a.movementHeading != null && b.movementHeading != null
        ? interpolateHeading(a.movementHeading, b.movementHeading, t)
        : a.movementHeading ?? b.movementHeading
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
 *
 * The ray origin is the CAMERA position at capture (issue #10). The
 * bearing is the photo's CAMERA heading — the device-orientation reading
 * that passed the freshness gate (issue #3), with its full provenance
 * (source, uncertainty, age) carried on the ray. The MOVEMENT heading
 * (direction of travel, photo.movementHeading) is NEVER used as the ray
 * bearing: when no camera heading is available, the ray is bearing-less
 * and the estimator falls back to GPS-only evidence.
 *
 * The origin is `photo.cameraPosition` (issue #10, with the legacy
 * `photo.gps` alias as fallback), and the ray carries the quality evidence
 * of every input: camera-heading source/uncertainty/age (issue #3),
 * distance uncertainty and camera position age/provenance.
 */
export function rayFromPhoto(
  photo: Photo,
  obs: Pick<Observation, 'bbox' | 'distanceEstimate' | 'distanceUncertaintyM'>
): ObservationRay | null {
  const cam =
    photo.cameraPosition ??
    (photo.gps
      ? {
          lat: photo.gps.lat,
          lon: photo.gps.lon,
          accuracy: photo.gps.accuracy,
          timestamp: photo.timestamp,
          fixTimestamp: photo.timestamp,
          ageMs: 0,
          source: 'track' as const,
        }
      : undefined);
  if (!cam) return null;

  // Issue #3: only the camera heading (device orientation) casts the
  // bearing ray. photo.movementHeading is contextual and never used here.
  const ch = photo.cameraHeading;
  const hasHeading = ch != null;
  const bearingDeg = hasHeading ? imageBearing(ch!.bearing, obs.bbox) : 0;
  const bearingUncDeg =
    hasHeading && ch!.uncertaintyDeg != null
      ? // RSS of the heading quality uncertainty and the bbox-center
        // assumption (the object could be anywhere within the bbox width).
        sqrt(ch!.uncertaintyDeg ** 2 + ((obs.bbox.w / 2) * NOMINAL_FOV_DEG) ** 2)
      : undefined;

  return {
    lat: cam.lat,
    lon: cam.lon,
    bearingDeg,
    distanceM: obs.distanceEstimate ?? 0,
    gpsAccuracy: cam.accuracy,
    hasHeading,
    headingSource: ch?.source,
    headingAgeMs: ch?.ageMs,
    bearingUncDeg,
    distanceUncertaintyM: obs.distanceUncertaintyM,
    cameraAgeMs: cam.ageMs,
    cameraSource: cam.source,
  };
}
