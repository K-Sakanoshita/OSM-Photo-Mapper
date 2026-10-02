/**
 * Export validation (issue #11): semantic completeness is a separate export
 * gate from geometry completeness.
 *
 * A candidate may be detected and positioned without being ready to export.
 * A coordinate alone must never become a new untagged OSM node.
 *
 * Two independent gates are evaluated for a NEW candidate:
 *
 *  1. `geometry` (issue #9): area-based classes are never created from a
 *     point position — the app does not fabricate polygon/way geometry.
 *
 *  2. `semantics` (issue #11): the candidate must carry a reviewed,
 *     meaningful OSM semantic mapping:
 *     - classes with `requiredTags`: those tags must be present (key AND
 *       value) in the candidate's tag set;
 *     - classes defined by a required review value (generic
 *       `playground=*`): the defining value must be selected — `name=*`
 *       alone never counts as a classification;
 *     - review-only classes (`autoTag: false`): a reviewer-chosen mapping
 *       or meaningful manually entered semantic tags are required;
 *     - unknown feature types: at least one non-`name` tag is required.
 *
 * Unknown/ambiguous candidates are NOT forced into an OSM tag merely to
 * make them exportable — they are blocked with an explicit, reviewer-facing
 * reason and must be resolved in review first.
 */
import type { FeatureCandidate } from '../types';
import {
  commonValuesFor,
  geometryPreferenceFor,
  getFeatureClass
} from './feature-classes';

/** Which gate blocked a candidate (absent when exportable). */
export type ExportGate = 'geometry' | 'semantics';

export interface CandidateExportValidation {
  exportable: boolean;
  /** The gate that blocked the candidate, when `exportable` is false. */
  gate?: ExportGate;
  /** Human-readable, reviewer-facing explanation of the block. */
  reason?: string;
}

export const AREA_BLOCK_REASON =
  'area-based feature class — the app does not fabricate polygon/way geometry from a single photo; ' +
  'link this candidate to an existing object or draw the boundary in an editor';

/** True when a tag entry is usable evidence: non-empty value. */
function hasValue(v: string | undefined): boolean {
  return (v ?? '').trim() !== '';
}

/**
 * Validate a NEW candidate for export. Existing-object modifications are
 * governed by the modify path (live fetch / conflicts) and are not covered
 * here — their tag set is merged onto a real, already-tagged object.
 */
export function validateCandidateExport(c: FeatureCandidate): CandidateExportValidation {
  // Gate 1: geometry policy (issue #9) — independent of semantics.
  const pref = geometryPreferenceFor(c.featureType);
  if (pref === 'area' || pref === 'existing-only') {
    return { exportable: false, gate: 'geometry', reason: AREA_BLOCK_REASON };
  }

  const cls = getFeatureClass(c.featureType);
  const tags = c.tags;

  // Gate 2: semantic completeness (issue #11).
  // 2a. Required class tags must be present with their required values.
  if (cls) {
    const missing = Object.entries(cls.requiredTags).filter(([k, v]) => tags[k] !== v);
    if (missing.length > 0) {
      return {
        exportable: false,
        gate: 'semantics',
        reason: `missing required tag(s): ${missing.map(([k, v]) => `${k}=${v}`).join(', ')}`
      };
    }
  }

  // 2b. Classes defined by a required review value: requiredTags is empty
  //     and the defining key(s) come from commonValues (e.g. generic
  //     playground equipment needs playground=slide|swing|...). The value
  //     must be confirmed from the photo, never guessed.
  const commonKeys = Object.keys(commonValuesFor(c.featureType));
  if (cls && Object.keys(cls.requiredTags).length === 0 && commonKeys.length > 0) {
    const defined = commonKeys.find((k) => hasValue(tags[k]));
    if (!defined) {
      return {
        exportable: false,
        gate: 'semantics',
        reason: `select a defining value: ${commonKeys.map((k) => `${k}=*`).join(' or ')}`
      };
    }
  }

  // 2c. Any remaining case (review-only classes, unknown types): at least
  //     one meaningful semantic tag is required. name=* alone never counts
  //     as a semantic classification.
  const hasSemanticTag = Object.entries(tags).some(([k, v]) => k !== 'name' && hasValue(v));
  if (!hasSemanticTag) {
    if (cls && !cls.autoTag) {
      return {
        exportable: false,
        gate: 'semantics',
        reason:
          cls.mappings && cls.mappings.length > 0
            ? 'no OSM mapping chosen — choose one from the mapping picker, or set semantic tags'
            : 'no OSM mapping — set semantic tags during review (name=* alone is not a mapping)'
      };
    }
    if (!cls) {
      return {
        exportable: false,
        gate: 'semantics',
        reason: 'no semantic tags — set at least one meaningful tag (name=* alone is not a mapping)'
      };
    }
  }

  return { exportable: true };
}
