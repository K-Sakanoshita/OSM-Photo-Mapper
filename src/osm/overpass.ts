import type { FeatureCandidate, OsmMatch } from '../types';
import { FEATURE_CLASSES, definingKeysFor, getFeatureClass } from '../analysis/feature-classes';
import { distanceMeters } from '../analysis/position';

/**
 * Nearby existing OSM data lookup via the Overpass API.
 *
 * Used for two purposes (per design): duplicate detection and position
 * evidence. It is best-effort and network-dependent: if the network is
 * unavailable (common in the field), it resolves to an empty list and the
 * pipeline continues.
 *
 * We never snap automatically solely because a nearby object has the same tag;
 * matches are surfaced as candidates for the reviewer to decide.
 *
 * Issue #5 fixes:
 *  - The query covers a bounding box spanning the actual survey area (all
 *    track samples, photo positions and candidate positions, plus padding),
 *    not just the last GPS point — long walks no longer miss objects
 *    photographed earlier.
 *  - Coordinates are always usable: the query uses `out body center`, so
 *    nodes carry lat/lon and ways/relations carry `center`.
 *  - Match scoring is feature-class-aware: each candidate is scored against
 *    ITS OWN class only, so a bench can no longer rank highly as a
 *    vending-machine match.
 */

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const DEFAULT_RADIUS_M = 120;
/** Padding around the survey area so objects just outside sampled points are found. */
const AREA_PADDING_M = 150;

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/** Escape a value for use inside an Overpass QL regex. */
function escRegex(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build tag filter clauses covering every MVP feature class.
 *
 * For each tag key used by any class we emit one node selector:
 *  - one value  -> exact match:      ["emergency"="defibrillator"]
 *  - many values-> anchored regex:   ["amenity"~"^(bench|toilets|...)$"]
 *  - no values  -> key presence:     ["playground"~".+"]  (e.g. playground
 *                                    equipment, whose type must not be guessed)
 *
 * Review-only classes (autoTag=false, issue #9) contribute the tag values
 * of their candidate mappings, so existing objects using ANY of the
 * plausible conventions (e.g. historic= vs man_made=stone_lantern) are
 * found and can be linked.
 *
 * Overpass set unions de-duplicate, so a node matching several clauses is
 * returned once.
 */
export function buildTagClauses(): string[] {
  const byKey = new Map<string, Set<string>>();
  const presenceKeys = new Set<string>();
  for (const cls of FEATURE_CLASSES) {
    for (const [k, v] of Object.entries(cls.requiredTags)) {
      const set = byKey.get(k) ?? new Set<string>();
      set.add(v);
      byKey.set(k, set);
    }
    // Review-only classes (issue #9): candidate mappings are plausible OSM
    // semantics — include their values in the search.
    if (!cls.autoTag) {
      for (const m of cls.mappings ?? []) {
        for (const [k, v] of Object.entries(m.tags)) {
          const set = byKey.get(k) ?? new Set<string>();
          set.add(v);
          byKey.set(k, set);
        }
      }
    }
    // Classes with no required tags (e.g. playground equipment) are still
    // searched by key presence of their defining keys (suggested +
    // common-value keys), so existing objects can be found and linked.
    if (Object.keys(cls.requiredTags).length === 0) {
      for (const k of definingKeysFor(cls.id)) presenceKeys.add(k);
    }
  }

  const clauses: string[] = [];
  for (const [key, values] of byKey) {
    if (values.size === 0) {
      clauses.push(`["${key}"~".+"]`);
    } else if (values.size === 1) {
      clauses.push(`["${key}"="${[...values][0]}"]`);
    } else {
      const alts = [...values].map(escRegex).join('|');
      clauses.push(`["${key}"~"^(${alts})$"]`);
    }
  }
  // Key-presence clauses for defining keys that carry no exact/alt values.
  for (const key of presenceKeys) {
    if (!byKey.has(key)) clauses.push(`["${key}"~".+"]`);
  }
  return clauses;
}

/** Build an Overpass QL query for all MVP-class objects inside a bbox. */
export function buildQueryForArea(
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number
): string {
  const box = `${minLat.toFixed(6)},${minLon.toFixed(6)},${maxLat.toFixed(6)},${maxLon.toFixed(6)}`;
  const clauses = buildTagClauses();
  // Query both nodes and ways (playgrounds are often ways; "out center" uses
  // the way centroid). Relations are out of scope for the MVP node features.
  const selectors = clauses.flatMap((c) => [`node(${box})${c};`, `way(${box})${c};`]).join('\n');
  // `out body center`: full element bodies (nodes incl. lat/lon, ways incl.
  // nodes) plus a centroid for ways/relations — so every returned element has
  // usable coordinates.
  return `[out:json][timeout:25];(${selectors});out body center;`;
}

/** Bounding box (degrees) around the given points with padding (meters). */
export function areaBBox(points: LatLon[], paddingM: number): {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
} | null {
  if (points.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  const midLat = (minLat + maxLat) / 2;
  const dLat = paddingM / 111320;
  const dLon = paddingM / (111320 * Math.cos((midLat * Math.PI) / 180));
  return {
    minLat: minLat - dLat,
    maxLat: maxLat + dLat,
    minLon: minLon - dLon,
    maxLon: maxLon + dLon
  };
}

/**
 * Score how well an OSM object's tags match ONE feature class (0..1).
 *
 * Scores against the candidate's own class only — never the best of all
 * classes — so cross-class objects (a bench vs. a vending-machine candidate)
 * score 0 instead of polluting the ranking.
 */
export function scoreTagsForClass(tags: Record<string, string>, featureType: string): number {
  const cls = getFeatureClass(featureType);
  if (!cls) return 0;

  const required = Object.entries(cls.requiredTags);
  if (required.length > 0) {
    const hits = required.filter(([k, v]) => tags[k] === v).length;
    return hits / required.length;
  }

  // No required tags (e.g. playground equipment, type must come from review):
  // match on key presence of the class's defining keys (suggested + common).
  const keys = definingKeysFor(featureType);
  if (keys.length === 0) return 0;
  const hits = keys.filter((k) => k in tags).length;
  return hits / keys.length;
}

/**
 * Fetch all MVP-class OSM objects in the area covered by the given points
 * (survey track + photo positions + candidate positions) plus padding.
 * Returns an empty array on any failure (offline, timeout, parse error).
 */
export async function fetchOsmInArea(points: LatLon[], paddingM = AREA_PADDING_M): Promise<OsmMatch[]> {
  const box = areaBBox(points, paddingM);
  if (!box) return [];
  try {
    const res = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(buildQueryForArea(box.minLat, box.minLon, box.maxLat, box.maxLon)),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { elements: OverpassElement[] };
    return json.elements
      .map((el) => toOsmMatch(el))
      .filter((m): m is OsmMatch => m !== null);
  } catch {
    return [];
  }
}

/**
 * Convert an Overpass element into an OsmMatch.
 * Exported for tests: nodes carry lat/lon directly; ways/relations use
 * `center` (the query requests `out body center`). Elements with neither are
 * dropped (null).
 */
export function toOsmMatch(el: OverpassElement): OsmMatch | null {
  // Nodes carry lat/lon directly; ways/relations use `center` (out ... center).
  const matchLat = el.lat ?? el.center?.lat;
  const matchLon = el.lon ?? el.center?.lon;
  if (matchLat == null || matchLon == null) return null;

  return {
    osmType: el.type,
    osmId: el.id,
    lat: matchLat,
    lon: matchLon,
    tags: el.tags ?? {},
    // Unsourced until annotateCandidate scores it against a concrete class.
    matchScore: 0
  };
}

/**
 * Attach nearby OSM matches to a candidate, scored against the candidate's
 * own feature class. Keeps matches within radiusM of the candidate position,
 * sorted by a blend of class tag score and proximity.
 */
export function annotateCandidate(
  candidate: Pick<FeatureCandidate, 'featureType' | 'lat' | 'lon'>,
  nearby: OsmMatch[],
  radiusM = DEFAULT_RADIUS_M
): OsmMatch[] {
  if (candidate.lat == null || candidate.lon == null || nearby.length === 0) return [];
  return nearby
    .map((m) => {
      const d = distanceMeters(candidate.lat!, candidate.lon!, m.lat, m.lon);
      if (d > radiusM) return null;
      const proximity = 1 - Math.min(1, d / radiusM);
      const tagScore = scoreTagsForClass(m.tags, candidate.featureType);
      return { ...m, matchScore: 0.6 * tagScore + 0.4 * proximity };
    })
    .filter((m): m is OsmMatch => m !== null)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);
}
