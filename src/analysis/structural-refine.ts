/**
 * Bounded structural refinement of an estimated position (issue #8).
 *
 * Aerial imagery is SECONDARY evidence: the ground-survey estimate
 * (GPS + heading + distance + repeated observations) always stands first.
 * Imagery may only nudge the position a few meters, bounded by the
 * estimate's uncertainty, using structural cues that nationwide imagery can
 * actually resolve:
 *
 *  - structure-bound features (vending machines, AEDs, information boards,
 *    toilets) are typically attached to buildings -> prefer positions near
 *    high-gradient (building-edge) imagery;
 *  - open-ground features (benches, waste baskets, drinking water, bicycle
 *    parking, playgrounds) sit on open/paved ground -> prefer low-gradient
 *    open areas.
 *
 * The core (`refineByStructure`) is pure and testable in Node; the async
 * wrapper (`refinePosition`) stitches imagery in the browser and degrades
 * to null (no refinement) on any gap or error.
 */
import type { PositionEvidence } from '../types';
import type { TileProvider } from '../imagery/providers';
import { PixelGrid, stitchRegion } from '../imagery/region';
import { mPerPixelAt, zoomForResolution } from '../imagery/tiles';

/** Feature classes that are normally attached to building structure. */
export const STRUCTURE_BOUND_TYPES = new Set([
  'vending_machine',
  'aed',
  'information_board',
  'toilets',
  // Fire extinguishers are normally mounted on building walls (issue #9).
  'fire_extinguisher'
]);

export interface RefineResult {
  lat: number;
  lon: number;
  /** Correction distance, meters (always <= the bound). */
  deltaM: number;
  evidence: PositionEvidence;
  /** Imagery source that provided the evidence (set by refinePosition). */
  sourceId?: string;
  /** Attribution to display in review when imagery contributed. */
  attribution?: string;
}

/** Coarsest effective ground resolution acceptable as evidence for small
 *  POIs, in meters per pixel (issue #8).
 *
 *  Calibrated for Japanese latitudes (34–46°N): z18 ortho is 0.72–0.86
 *  m/px there, while z17 is 1.44–1.72 m/px. The 0.9 threshold accepts
 *  z18-class imagery everywhere in Japan and rejects z17 and coarser,
 *  which cannot reliably resolve small POIs (benches, signs, equipment). */
export const MAX_EVIDENCE_M_PER_PX = 0.9;

const EDGE_NORM = 64; // mean |grad| at which the edge score saturates
const MIN_IMPROVEMENT = 0.03;
/** A sample must beat the center by this factor (plus MIN_IMPROVEMENT).
 *  Kept modest: at z18-class resolution the scoring window is wide, so a
 *  center point near a boundary already scores fairly well and a large
 *  relative demand would make refinement dead. The absolute 0.03 floor
 *  still guards against noise-driven moves. */
const REL_IMPROVEMENT = 1.05;
const MAX_REFINE_M = 10; // hard cap: refinement is "a few meters"

interface SampleScore {
  lat: number;
  lon: number;
  distM: number;
  score: number;
}

/** Score one imagery point for a feature class preference. */
function scorePoint(grid: PixelGrid, px: number, py: number, radiusPx: number, structureBound: boolean): number {
  const s = grid.windowStats(px, py, radiusPx);
  if (s.n === 0) return -1;
  const edge = Math.min(1, s.grad / EDGE_NORM);
  if (structureBound) {
    // Near building edges / roof boundaries: strong local gradients.
    return edge;
  }
  // Open ground: smooth (low gradient) and reasonably bright (paved/clear).
  return (1 - edge) * 0.85 + (s.mean / 255) * 0.15;
}

/**
 * Pure bounded structural refinement. Expands the candidate position on a
 * small polar grid (center + 8 directions x 2 radii) and moves it to the
 * best-scoring point only when the improvement is meaningful. Never moves
 * more than `maxCorrectionM`.
 */
export function refineByStructure(
  grid: PixelGrid,
  latDeg: number,
  lonDeg: number,
  featureType: string,
  maxCorrectionM: number
): RefineResult | null {
  if (maxCorrectionM < 1) return null;
  const bound = Math.min(maxCorrectionM, MAX_REFINE_M);
  const structureBound = STRUCTURE_BOUND_TYPES.has(featureType);

  // Evidence-quality gate: coarse imagery is not evidence for small POIs
  // (issue #8). Also catches zoom fallbacks from the stitcher's budgets.
  if (grid.mPerPixel > MAX_EVIDENCE_M_PER_PX) return null;

  const center = grid.pixelOf(latDeg, lonDeg);
  if (!center) return null;

  const radiusPx = Math.max(2, Math.round(2 / grid.mPerPixel));
  const cosLat = Math.cos((latDeg * Math.PI) / 180);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.max(0.2, cosLat);

  const dirs: Array<[number, number]> = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1]
  ];
  const dists = [bound / 2, bound];

  const samples: SampleScore[] = [];
  const push = (dxEastM: number, dyNorthM: number) => {
    const lat = latDeg + dyNorthM / mPerDegLat;
    const lon = lonDeg + dxEastM / mPerDegLon;
    const p = grid.pixelOf(lat, lon);
    if (!p) return;
    const distM = Math.hypot(dxEastM, dyNorthM);
    const score = scorePoint(grid, p.px, p.py, radiusPx, structureBound);
    if (score < 0) return;
    samples.push({ lat, lon, distM, score });
  };

  push(0, 0);
  for (const d of dists) for (const [dx, dy] of dirs) push(dx * d, dy * d);
  if (samples.length < 2) return null;

  const centerScore = samples[0].score;
  let best = samples[0];
  for (const s of samples) {
    if (s.distM > 0 && s.score > best.score) best = s;
  }

  if (best.distM === 0) return null; // center already best
  if (best.score < centerScore * REL_IMPROVEMENT + MIN_IMPROVEMENT) return null; // not meaningful
  if (best.distM > bound) return null;

  const cue = structureBound ? 'building-edge' : 'open-ground';
  return {
    lat: best.lat,
    lon: best.lon,
    deltaM: best.distM,
    evidence: {
      source: 'aerial-structure',
      label: `Aerial structure cue (${cue})`,
      detail: `moved ${best.distM.toFixed(1)} m; score ${best.score.toFixed(2)} vs ${centerScore.toFixed(2)} at estimate`
    }
  };
}

/**
 * Browser path: stitch the small imagery region around the estimate, then
 * run the pure refinement. Returns null (caller keeps the raw estimate)
 * when there is no provider, no coverage, or any fetch/decode failure.
 */
export async function refinePosition(
  provider: TileProvider | null,
  featureType: string,
  latDeg: number,
  lonDeg: number,
  uncertaintyM: number,
  targetMetersPerPixel: number = 0.5
): Promise<RefineResult | null> {
  if (!provider) return null;

  // Cheap pre-check: if even the best zoom this provider offers is too
  // coarse for small-POI evidence, skip the tile fetches entirely.
  const bestZoom = Math.min(zoomForResolution(targetMetersPerPixel, latDeg), provider.source.maxZoom);
  if (mPerPixelAt(bestZoom, latDeg) > MAX_EVIDENCE_M_PER_PX) return null;

  const regionRadius = Math.min(Math.max(uncertaintyM, 5), 20);
  const grid = await stitchRegion(provider, latDeg, lonDeg, regionRadius, targetMetersPerPixel);
  if (!grid) return null;
  const res = refineByStructure(grid, latDeg, lonDeg, featureType, Math.min(uncertaintyM, MAX_REFINE_M));
  if (!res) return null;
  // Carry imagery provenance so review can show the source/attribution
  // whenever aerial data contributed to the position.
  return {
    ...res,
    sourceId: provider.source.id,
    attribution: provider.source.attribution
  };
}
