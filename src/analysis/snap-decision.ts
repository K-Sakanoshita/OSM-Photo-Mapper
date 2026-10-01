/**
 * Conditional OSM snap decision (issue #8).
 *
 * Snap to an OSM object only when ALL of the following hold:
 *   1. the object matches the candidate's feature class exactly
 *      (tagScore === 1 — every defining tag/value agrees);
 *   2. the object's specific tags do not contradict the candidate's
 *      observed/reviewed identifying tags (same class ≠ same object:
 *      tourism=information + information=guidepost is NOT an
 *      information=board candidate's object; playground=slide ≠ swing);
 *   3. the object is within a CONSERVATIVE snap radius:
 *      dMax = min(uncertainty, AUTO_SNAP_MAX_DISTANCE_M). Low confidence
 *      (large uncertainty) never widens the search — until issue #3
 *      produces an evidence-based uncertainty model, the radius is hard
 *      capped at 3 m;
 *   4. no plausible competing same-object candidate exists within
 *      COMPETITOR_RANGE_FACTOR × dMax. Competitors are objects that also
 *      match the class AND agree on the candidate's identifying tags —
 *      an object whose subtype contradicts the candidate is a different
 *      object and does not create ambiguity.
 *
 * Otherwise the candidate stays at its estimated (or bounded
 * aerial-refined) position. Snap failures are silent for the caller:
 * return null and keep the previous position.
 */
import { distanceMeters } from './position';
import { scoreTagsForClass } from '../osm/overpass';
import { commonValuesFor, suggestedTagsFor } from '../analysis/feature-classes';
import type { OsmMatch, OsmType, PositionEvidence } from '../types';

export interface SnapInput {
  lat: number;
  lon: number;
  featureType: string;
  /** Position uncertainty in meters (placeholder formula until #3). */
  uncertaintyM: number;
  /** Nearby OSM objects from the Overpass lookup (all types). */
  matches: OsmMatch[];
  /** The candidate's reviewed tag set (required + observed/confirmed
   *  detail tags). Used to check specific identifying evidence. */
  candidateTags: Record<string, string>;
}

export interface SnapDecision {
  /** OSM object to snap to (type + ID — never assume node). */
  osm: { osmId: number; osmType: OsmType; lat: number; lon: number; tags: Record<string, string> };
  /** 0..1 — higher when the object is closer relative to the radius. */
  confidence: number;
  snappedPosition: { lat: number; lon: number };
  evidence: PositionEvidence;
}

/** Hard cap on the auto-snap radius (meters). Low confidence must NOT
 *  translate into a wider search for an object to snap to. */
export const AUTO_SNAP_MAX_DISTANCE_M = 3;
/** Competing same-object candidates are searched within this multiple of
 *  the snap radius. */
export const COMPETITOR_RANGE_FACTOR = 2;

/**
 * Specific-identity conflicts between the candidate's identifying tags
 * (observed/reviewed tags + the class's concrete inferred values) and an
 * OSM object's tags. Returns human-readable reasons (empty = compatible).
 *
 * Rules:
 *  - every tag the candidate actually has must not be contradicted by a
 *    different value for the same key on the OSM object;
 *  - for class-inferred detail values (suggestedTags, e.g.
 *    information=board for an information board), an OSM object carrying
 *    the same key with a DIFFERENT value (information=guidepost)
 *    contradicts the candidate; a missing key is not a conflict (the tag
 *    is optional);
 *  - for keys whose value cannot be known from the class alone
 *    (commonValues, e.g. playground=<type>), the candidate must have an
 *    observed/reviewed value for the key to be a valid snap target at
 *    all — otherwise the object's value is unverified.
 */
export function identifyingTagConflicts(
  candidateTags: Record<string, string>,
  featureType: string,
  osmTags: Record<string, string>
): string[] {
  const conflicts: string[] = [];

  // 1. Observed/reviewed tags: the object must not disagree on any key.
  for (const [k, v] of Object.entries(candidateTags)) {
    const actual = osmTags[k];
    if (actual != null && actual !== v) {
      conflicts.push(`${k}: candidate '${v}' vs OSM '${actual}'`);
    }
  }

  // 2. Class-inferred detail values (candidate's own value takes precedence).
  const suggested = suggestedTagsFor(featureType);
  for (const [k, v] of Object.entries(suggested)) {
    if (k in candidateTags) continue;
    const actual = osmTags[k];
    if (actual != null && actual !== v) {
      conflicts.push(`${k}: class expects '${v}' but OSM has '${actual}'`);
    }
  }

  // 3. Values that cannot be inferred from the class: the candidate must
  //    have confirmed one from the photo before auto-snap is legitimate.
  for (const k of Object.keys(commonValuesFor(featureType))) {
    const mine = candidateTags[k];
    if (mine == null) {
      conflicts.push(`${k}: no confirmed value in candidate (cannot verify OSM value)`);
    } else {
      const actual = osmTags[k];
      if (actual != null && actual !== mine) {
        conflicts.push(`${k}: candidate '${mine}' vs OSM '${actual}'`);
      }
    }
  }

  return conflicts;
}

export function decideSnap(input: SnapInput): SnapDecision | null {
  const scored = input.matches
    .map((m) => ({
      m,
      d: distanceMeters(input.lat, input.lon, m.lat, m.lon),
      tagScore: scoreTagsForClass(m.tags, input.featureType),
      conflicts: identifyingTagConflicts(input.candidateTags, input.featureType, m.tags)
    }))
    .filter((t) => t.tagScore > 0);

  if (scored.length === 0) return null;

  // Conservative radius: the uncertainty may NARROW the search but never
  // widen it beyond the hard cap.
  const dMax = Math.max(1, Math.min(input.uncertaintyM, AUTO_SNAP_MAX_DISTANCE_M));

  // Primary targets: exact class match, identifying tags agree, within radius.
  const primary = scored.filter((t) => t.tagScore === 1 && t.conflicts.length === 0 && t.d <= dMax);
  if (primary.length === 0) return null;

  // Ambiguity: another plausible SAME-OBJECT candidate near the primary.
  // An object whose specific tags contradict the candidate is a different
  // object (e.g. a guidepost next to the board) and does not block.
  const range = dMax * COMPETITOR_RANGE_FACTOR;
  for (const p of primary) {
    // (osmType is intentionally NOT required: a same-class way whose
    // centroid lies nearby is still a plausible same-object competitor.)
    const competitor = scored.find(
      (t) => t.m.osmId !== p.m.osmId && t.d <= range && t.tagScore >= 0.5 && t.conflicts.length === 0
    );
    if (competitor) return null;
  }

  // Best target: nearest (all primaries already agree on class + identity).
  const best = [...primary].sort((a, b) => a.d - b.d)[0];

  const confidence = Math.max(0, Math.min(1, 0.5 + 0.5 * (1 - best.d / dMax)));
  const nId = Object.keys(input.candidateTags).length;

  return {
    osm: {
      osmId: best.m.osmId,
      osmType: best.m.osmType,
      lat: best.m.lat,
      lon: best.m.lon,
      tags: { ...best.m.tags }
    },
    confidence,
    snappedPosition: { lat: best.m.lat, lon: best.m.lon },
    evidence: {
      source: 'osm-object',
      label: 'Snapped to OSM object',
      detail: `Exact class match with ${nId} identifying tag(s) agreeing, distance ${best.d.toFixed(1)} m (radius ${dMax.toFixed(0)} m), no same-object competitor within ${range.toFixed(0)} m`
    }
  };
}
