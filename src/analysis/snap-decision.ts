/**
 * Conditional OSM snapping (issue #8).
 *
 * Automatic snap/link to an existing OSM object is allowed only when the
 * same-object match is strong and essentially unique:
 *
 *   1. exact feature-class tag match (score 1.0 — every defining tag agrees)
 *   2. OSM object within the position uncertainty (floor 8 m)
 *   3. no similarly plausible competing POI nearby (tag score >= 0.5 within
 *      twice that distance)
 *
 * Anything less stays an unsnapped review candidate. The raw ground-survey
 * estimate is never discarded: it is preserved in the PositionSolution and
 * the reviewer can always fall back to it.
 */
import type { OsmMatch, PositionEvidence } from '../types';
import { distanceMeters } from './position';
import { scoreTagsForClass } from '../osm/overpass';

export interface SnapDecision {
  osm: OsmMatch;
  snappedPosition: { lat: number; lon: number };
  /** 0..1 confidence that the OSM object is the same real-world object. */
  confidence: number;
  evidence: PositionEvidence;
}

export interface SnapInput {
  lat: number;
  lon: number;
  featureType: string;
  /** Position uncertainty, meters. */
  uncertaintyM: number;
  matches: OsmMatch[];
}

const UNCERTAINTY_FLOOR_M = 8;
const COMPETITOR_TAG_SCORE = 0.5;
const COMPETITOR_RANGE_FACTOR = 2;

export function decideSnap(input: SnapInput): SnapDecision | null {
  const dMax = Math.max(input.uncertaintyM, UNCERTAINTY_FLOOR_M);

  const scored = input.matches.map((m) => ({
    m,
    tagScore: scoreTagsForClass(m.tags, input.featureType),
    d: distanceMeters(input.lat, input.lon, m.lat, m.lon)
  }));

  // Strong candidates: exact class match within the uncertainty bound.
  const primary = scored.filter((t) => t.tagScore === 1 && t.d <= dMax);
  if (primary.length !== 1) return null; // zero or ambiguous -> no snap
  const p = primary[0];

  // Essentially unique: no plausible same-class competitor nearby.
  const hasCompetitor = scored.some(
    (t) => t !== p && t.tagScore >= COMPETITOR_TAG_SCORE && t.d <= dMax * COMPETITOR_RANGE_FACTOR
  );
  if (hasCompetitor) return null;

  const confidence = Math.min(
    1,
    Math.max(0, 0.5 + 0.5 * (1 - p.d / dMax))
  );

  return {
    osm: p.m,
    snappedPosition: { lat: p.m.lat, lon: p.m.lon },
    confidence,
    evidence: {
      source: 'osm-object',
      label: `Snapped to ${p.m.osmType}/${p.m.osmId}`,
      detail: `tag match 100%, distance ${p.d.toFixed(1)} m (bound ${dMax.toFixed(0)} m)`
    }
  };
}
