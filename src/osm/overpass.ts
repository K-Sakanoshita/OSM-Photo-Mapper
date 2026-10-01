import type { OsmMatch } from '../types';
import { FEATURE_CLASSES } from '../analysis/feature-classes';
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
 */

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const DEFAULT_RADIUS_M = 150;

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Build an Overpass QL query for nodes near a point matching any MVP class. */
function buildQuery(lat: number, lon: number, radiusM: number): string {
  // Match nodes carrying any of our base tag keys/values of interest.
  const clauses = FEATURE_CLASSES.map((c) => {
    const parts = Object.entries(c.baseTags)
      .map(([k, v]) => `["${k}"="${v}"]`)
      .join('');
    return `node(${parts})(${lat - radiusM / 111320},${lon - radiusM / (111320 * Math.cos((lat * Math.PI) / 180))},${lat + radiusM / 111320},${lon + radiusM / (111320 * Math.cos((lat * Math.PI) / 180))});`;
  });
  return `[out:json][timeout:25];(${clauses.join('\n')});out tags center;`;
}

/**
 * Fetch nearby OSM objects of the MVP classes around (lat, lon).
 * Returns an empty array on any failure (offline, timeout, parse error).
 */
export async function fetchNearbyOsm(
  lat: number,
  lon: number,
  radiusM = DEFAULT_RADIUS_M
): Promise<OsmMatch[]> {
  try {
    const res = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(buildQuery(lat, lon, radiusM)),
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

function toOsmMatch(el: OverpassElement): OsmMatch | null {
  const tags = el.tags ?? {};
  let matchScore = 0;
  // Score by how many base-tag keys of a known class this object carries.
  for (const c of FEATURE_CLASSES) {
    const base = c.baseTags;
    let hits = 0;
    let total = 0;
    for (const [k, v] of Object.entries(base)) {
      total++;
      if (tags[k] === v) hits++;
    }
    if (total > 0) matchScore = Math.max(matchScore, hits / total);
  }

  const matchLat = el.lat ?? el.center?.lat;
  const matchLon = el.lon ?? el.center?.lon;
  if (matchLat == null || matchLon == null) return null;

  return {
    osmType: el.type,
    osmId: el.id,
    lat: matchLat,
    lon: matchLon,
    tags,
    matchScore
  };
}

/**
 * Attach nearby OSM matches to a candidate. The anchor is the candidate's
 * estimated position (or its first observation photo). Keeps matches within
 * radiusM, sorted by a blend of tag matchScore and proximity.
 */
export function annotateCandidate(
  candidate: { lat?: number; lon?: number },
  nearby: OsmMatch[],
  radiusM = DEFAULT_RADIUS_M
): OsmMatch[] {
  if (candidate.lat == null || candidate.lon == null || nearby.length === 0) return [];
  return nearby
    .filter((m) => distanceMeters(candidate.lat!, candidate.lon!, m.lat, m.lon) <= radiusM)
    .map((m) => {
      const d = distanceMeters(candidate.lat!, candidate.lon!, m.lat, m.lon);
      const proximity = 1 - Math.min(1, d / radiusM);
      return { ...m, matchScore: 0.6 * m.matchScore + 0.4 * proximity };
    })
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);
}
