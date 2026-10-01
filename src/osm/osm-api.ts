import type { OsmType } from '../types';

/**
 * Live OSM object state fetched from the public OSM API (issue #4).
 *
 * Modifications must be built from the object's *current* state, not from a
 * stale nearby-lookup snapshot: the exported <modify> needs the current
 * `version` and must merge against the current tag set. The object is
 * fetched immediately before export; if the fetch fails, the modification
 * is reported as an explicit conflict and excluded from the output.
 */
export interface LiveOsmObject {
  type: OsmType;
  id: number;
  /** Current object version — must be included in <modify> entries. */
  version: number;
  /** Current tag set. */
  tags: Record<string, string>;
  /** Current position (nodes only). */
  lat?: number;
  lon?: number;
}

export const OSM_API_BASE = 'https://api.openstreetmap.org';

function unesc(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Parse the canonical XML returned by GET /api/0.6/{node|way|relation}/{id}.
 *
 * Pure function (no DOM dependency) so tests can cover it without network
 * access. The API emits one root element per request, e.g.:
 *
 *   <node id="123" version="7" changeset="..." timestamp="..." lat=".." lon="..">
 *     <tag k="amenity" v="bench"/>
 *   </node>
 *
 * Way/relation responses carry the same header attributes (plus <nd>/<member>
 * children, which are not needed for a tags-only modification and are not
 * exported for ways/relations at all — see osmchange.ts).
 */
export function parseOsmObject(type: OsmType, xml: string): LiveOsmObject {
  const header = new RegExp(`<${type}\\s[^>]*>`).exec(xml)?.[0] ?? '';
  const id = Number(/ id="(\d+)"/.exec(header)?.[1] ?? NaN);
  const version = Number(/ version="(\d+)"/.exec(header)?.[1] ?? NaN);
  if (!Number.isFinite(id) || !Number.isFinite(version)) {
    throw new Error(`Unrecognized ${type} XML from OSM API`);
  }
  const tags: Record<string, string> = {};
  for (const m of xml.matchAll(/<tag k="([^"]*)" v="([^"]*)"\s*\/>/g)) {
    tags[unesc(m[1])] = unesc(m[2]);
  }
  const obj: LiveOsmObject = { type, id, version, tags };
  if (type === 'node') {
    const lat = Number(/ lat="(-?[\d.]+)"/.exec(header)?.[1]);
    const lon = Number(/ lon="(-?[\d.]+)"/.exec(header)?.[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      obj.lat = lat;
      obj.lon = lon;
    }
  }
  return obj;
}

/**
 * Fetch the current state of an OSM object. Throws on HTTP or network
 * errors; callers must treat a thrown error as an explicit conflict.
 */
export async function fetchLiveObject(type: OsmType, id: number): Promise<LiveOsmObject> {
  const res = await fetch(`${OSM_API_BASE}/api/0.6/${type}/${id}`);
  if (!res.ok) throw new Error(`OSM API returned ${res.status} for ${type}/${id}`);
  return parseOsmObject(type, await res.text());
}
