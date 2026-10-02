import type { FeatureCandidate, OsmType, Survey } from '../types';
import type { LiveOsmObject } from './osm-api';
import { validateCandidateExport } from '../analysis/export-validation';

/**
 * OSMChange exporter (issue #4).
 *
 * Emits only the standard osmChange constructs:
 *
 *   <osmChange>
 *     <create>…</create>
 *     <modify>…</modify>
 *   </osmChange>
 *
 * The changeset and its comment are NOT part of the osmChange file — they
 * belong to a separate changeset workflow (the editor creates the changeset
 * at import time; the MVP contract is editor-import-only).
 *
 * Safety rules enforced here:
 *
 *  - No custom constructs (never `<add>`/`<creadetag>`).
 *  - `<modify>` entries carry the object's *current* version and merge the
 *    candidate's tags against its *current* tag set (fetched immediately
 *    before export — see osm-api.ts).
 *  - Only node modifications are exported. A way modify would require the
 *    full node reference list and structure, which the MVP does not fetch,
 *    so way/relation modifications are blocked and reported; linked
 *    ways/relations may still serve as duplicate/existing references.
 *  - A modify whose live object could not be fetched is reported as an
 *    explicit conflict and excluded from the file.
 *  - Geometry policy (issue #9): a candidate whose feature class is
 *    area-based ('area' or 'existing-only') is NEVER emitted as a create
 *    from a point position — the app must not fabricate polygon/way
 *    geometry from a single photo. Such candidates are reported in
 *    `geometryBlocked`; the reviewer links them to an existing object or
 *    draws the boundary in an editor. ('node' and 'either' classes are
 *    created as nodes: a point representation is legitimate for small
 *    facilities.)
 *  - Semantic gate (issue #11): a NEW candidate is only created when it
 *    carries a reviewed, meaningful semantic tag mapping (see
 *    export-validation.ts). A coordinate alone never becomes an untagged
 *    OSM node; unresolved candidates are reported in `semanticsBlocked`
 *    and excluded from the file until resolved in review.
 */

export interface OsmChangeConflict {
  candidateId: string;
  osmType: OsmType;
  osmId: number;
  reason: string;
}

export interface OsmChangeBlocked {
  candidateId: string;
  osmType: OsmType;
  osmId: number;
}

export interface OsmChangeResult {
  /** Standard osmChange XML, or '' when there is nothing to export. */
  xml: string;
  creates: number;
  modifies: number;
  /** Modifications excluded because the live object could not be fetched. */
  conflicts: OsmChangeConflict[];
  /** Modifications excluded because way/relation modify is not supported. */
  blocked: OsmChangeBlocked[];
  /** New candidates excluded by the geometry policy (area-based classes
   *  are never created as fabricated polygons from a single photo). */
  geometryBlocked: { candidateId: string; featureType: string; reason: string }[];
  /** New candidates excluded by the semantic gate (issue #11): no reviewed,
   *  meaningful OSM tag mapping yet. Distinguishable from geometryBlocked. */
  semanticsBlocked: { candidateId: string; featureType: string; reason: string }[];
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tagXml(tags: Record<string, string>): string {
  return Object.entries(tags)
    .map(([k, v]) => `      <tag k="${esc(k)}" v="${esc(v)}"/>`)
    .join('\n');
}

/** Resolve the type of a candidate's linked object (default: node). */
export function linkedOsmType(c: FeatureCandidate): OsmType {
  return c.linkedOsmType ?? 'node';
}

export function buildOsmChange(
  survey: Survey,
  /** Live object state keyed by `${type}/${id}`, fetched right before export. */
  live: Map<string, LiveOsmObject>
): OsmChangeResult {
  const conflicts: OsmChangeConflict[] = [];
  const blocked: OsmChangeBlocked[] = [];
  const geometryBlocked: OsmChangeResult['geometryBlocked'] = [];
  const semanticsBlocked: OsmChangeResult['semanticsBlocked'] = [];
  const modifyBlocks: string[] = [];

  // Export gates for new candidates (issues #9/#11): geometry policy AND
  // semantic completeness are independent gates. A candidate may be
  // detected and positioned without being ready to export.
  const creates: FeatureCandidate[] = survey.candidates
    .filter((c) => c.status === 'new' && c.lat != null && c.lon != null)
    .filter((c) => {
      const v = validateCandidateExport(c);
      if (v.exportable) return true;
      const entry = { candidateId: c.id, featureType: c.featureType, reason: v.reason ?? '' };
      if (v.gate === 'geometry') geometryBlocked.push(entry);
      else semanticsBlocked.push(entry);
      return false;
    });

  for (const c of survey.candidates) {
    if (c.status !== 'existing' || c.linkedOsmId == null) continue;
    const type = linkedOsmType(c);
    if (type !== 'node') {
      blocked.push({ candidateId: c.id, osmType: type, osmId: c.linkedOsmId });
      continue;
    }
    const obj = live.get(`node/${c.linkedOsmId}`);
    if (!obj) {
      conflicts.push({
        candidateId: c.id,
        osmType: 'node',
        osmId: c.linkedOsmId,
        reason: 'live object unavailable — current version/tags could not be fetched'
      });
      continue;
    }
    const tags: Record<string, string> = { ...obj.tags };
    Object.assign(tags, c.tags);
    if (c.name && !('name' in tags)) tags.name = c.name;
    const coords =
      c.lat != null && c.lon != null
        ? ` lat="${c.lat.toFixed(7)}" lon="${c.lon.toFixed(7)}"`
        : '';
    modifyBlocks.push(
      `    <node id="${c.linkedOsmId}" version="${obj.version}"${coords}>\n${tagXml(tags)}\n    </node>`
    );
  }

  const createBlocks = creates.map((c, i) => {
    const tags: Record<string, string> = { ...c.tags };
    if (c.name && !('name' in tags)) tags.name = c.name;
    return (
      `    <node id="${-(i + 1)}" lat="${c.lat!.toFixed(7)}" lon="${c.lon!.toFixed(7)}">\n` +
      `${tagXml(tags)}\n    </node>`
    );
  });

  const sections: string[] = [];
  if (createBlocks.length > 0) {
    sections.push('  <create>\n' + createBlocks.join('\n') + '\n  </create>');
  }
  if (modifyBlocks.length > 0) {
    sections.push('  <modify>\n' + modifyBlocks.join('\n') + '\n  </modify>');
  }

  const xml =
    sections.length === 0
      ? ''
      : ['<?xml version="1.0" encoding="UTF-8"?>', '<osmChange>', ...sections, '</osmChange>', ''].join('\n');

  return {
    xml,
    creates: createBlocks.length,
    modifies: modifyBlocks.length,
    conflicts,
    blocked,
    geometryBlocked,
    semanticsBlocked
  };
}
