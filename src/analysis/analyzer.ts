import type { BBox, Photo } from '../types';

/**
 * Provider-facing analysis contract (issue #2).
 *
 * The architecture is deliberately split so that NO provider duplicates the
 * candidate/position business logic:
 *
 *   ImageObservationAnalyzer          (OpenAI vision)
 *     photo -> VisualObservation[]          raw VISUAL evidence only
 *                    |
 *                    v
 *   SurveyAnalysisPipeline            (shared, provider-agnostic)
 *     validate observations (strict schema)
 *     map visual classes to the OSM policy (feature-classes.ts)
 *     group the same object across photos
 *     build rays / estimate position
 *     merge observed tags
 *     create FeatureCandidate[]
 *
 * A provider returns VISUAL EVIDENCE — never final OSM edits. OSM tag
 * policy (required/suggested/common-values/mappings) stays entirely in
 * `feature-classes.ts` and the review/domain code.
 *
 * Provider requirements (issue #2):
 *  - zero, one or many objects per photo (empty array is a valid answer);
 *  - unknown objects stay `unknown` — never forced into a supported class;
 *  - OCR text is UNTRUSTED evidence: it is carried for the reviewer and is
 *    never automatically turned into `name=*`;
 *  - low-confidence attributes remain unset;
 *  - a single provider failure must reject/throw for THAT photo only —
 *    the pipeline turns it into a per-photo error and continues the batch.
 */

/**
 * Raw visual evidence for ONE detected object in ONE photo.
 *
 * This is what a vision provider returns. It deliberately contains no OSM
 * tag policy: `attributes` are raw detected properties (e.g.
 * `{ color: 'red' }`), and the shared pipeline decides which of them may
 * become OSM tags based on the feature class's declared policy.
 */
export interface VisualObservation {
  /**
   * Feature class ID from the supported list (see feature-classes.ts),
   * or the literal `'unknown'` when the object does not match any
   * supported class. Unknown observations are kept as reviewable
   * candidates rather than discarded or forced into a class.
   */
  featureType: string;
  /** Normalized bounding box, all coordinates in 0..1 image space. */
  bbox: BBox;
  /**
   * Raw detected visual attributes (property name -> value), e.g.
   * `{ color: 'green', material: 'wood' }`. The pipeline maps these to
   * OSM tags ONLY for keys the feature class declares as confirmable
   * (suggestedTags / commonValues / mapping keys) and only above the
   * attribute confidence threshold.
   */
  attributes: Record<string, string>;
  /**
   * Untrusted OCR text visible in/around the object. Carried to the
   * reviewer as evidence; NEVER automatically applied as name=*.
   */
  ocrText?: string;
  /** Confidence in the OCR reading, 0..1. */
  ocrConfidence?: number;
  /** Confidence that the detected object is real and correctly classed, 0..1. */
  detectionConfidence: number;
  /** Rough estimated distance to the object, meters (weak signal). */
  distanceEstimate?: number;
  /** Uncertainty of the distance estimate, meters. */
  distanceUncertaintyM?: number;
  /**
   * Optional visual identity evidence (embedding hash / descriptor label)
   * for cross-photo same-object grouping. When two observations from
   * different photos carry the same non-empty value, the pipeline treats
   * them as the same object even if projected proximity would not merge
   * them.
   */
  identityEvidence?: string;
}

/** Sentinel class ID for objects that match no supported feature class. */
export const UNKNOWN_FEATURE_TYPE = 'unknown';

/** Context handed to the provider for each photo. */
export interface AnalysisContext {
  surveyId: string;
  /** The photo being analyzed (image data URL, capture time, camera…). */
  photo: Photo;
  /**
   * The supported feature classes and visually inferable metadata,
   * so the provider's prompt/schema knows the closed vocabulary. Anything
   * else must be reported as 'unknown'.
   */
  featureClasses: {
    id: string;
    label: string;
    visualAttributes?: { key: string; allowedValues?: string[] }[];
    visualHint?: string;
  }[];
}

/**
 * The provider-facing contract. Implementation: OpenAIVisionAnalyzer
 * (BYOK remote vision API). Providers must not duplicate pipeline business logic.
 */
export interface ImageObservationAnalyzer {
  /** Human-readable provider name (shown in UI / diagnostics). */
  readonly name: string;
  /**
   * Analyze ONE photo. Resolves to zero/one/many validated
   * VisualObservations; rejects (throws) on provider/API failure — the
   * pipeline records the error for that photo and continues the batch.
   */
  analyzePhoto(photo: Photo, context: AnalysisContext): Promise<VisualObservation[]>;
}

/* ------------------------------------------------------------------ */
/* Strict schema validation of provider output                          */
/* ------------------------------------------------------------------ */

/**
 * Strictly validate one provider-returned object as a VisualObservation.
 *
 * Provider output is UNTRUSTED (it comes from an LLM JSON response).
 * Returns a CLEANED copy with every field coerced/clamped to a safe
 * value, or `null` when the object is unusable (missing bbox, non-finite
 * confidence, out-of-range box). The pipeline re-runs this on every
 * observation as defense in depth.
 */
export function validateVisualObservation(raw: unknown): VisualObservation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  // bbox: object with four finite numbers in 0..1, positive w/h, in-bounds.
  const b = r.bbox;
  if (typeof b !== 'object' || b === null) return null;
  const bb = b as Record<string, unknown>;
  const nums = [bb.x, bb.y, bb.w, bb.h].map(num01);
  if (nums.some((n) => n === null)) return null;
  const [x, y, w, h] = nums as [number, number, number, number];
  if (!(w > 0 && h > 0)) return null;
  if (x + w > 1.000001 || y + h > 1.000001) return null;
  const bbox: BBox = {
    x: clamp01(x),
    y: clamp01(y),
    w: Math.min(w, 1 - x),
    h: Math.min(h, 1 - y)
  };

  // detectionConfidence: required, finite 0..1.
  const detectionConfidence = num01(r.detectionConfidence);
  if (detectionConfidence === null) return null;

  // featureType: keep any non-empty string as-is (this pure validator
  // does not know the closed vocabulary). Empty/missing -> 'unknown'.
  // Vocabulary normalization (unrecognized id -> 'unknown') is done by
  // providers that know the class list and re-checked by the pipeline.
  const featureType = typeof r.featureType === 'string' && r.featureType.trim() !== ''
    ? r.featureType.trim()
    : UNKNOWN_FEATURE_TYPE;

  // attributes: keep only finite string key/value pairs.
  const attributes: Record<string, string> = {};
  if (typeof r.attributes === 'object' && r.attributes !== null) {
    for (const [k, v] of Object.entries(r.attributes as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string' && v.trim() !== '') {
        attributes[k] = v.trim();
      }
    }
  }

  const ocrText =
    typeof r.ocrText === 'string' && r.ocrText.trim() !== '' ? r.ocrText.trim() : undefined;
  const ocrConfidence = num01(r.ocrConfidence);
  const distanceEstimate = finitePos(r.distanceEstimate);
  const distanceUncertaintyM = finitePos(r.distanceUncertaintyM);
  const identityEvidence =
    typeof r.identityEvidence === 'string' && r.identityEvidence.trim() !== ''
      ? r.identityEvidence.trim()
      : undefined;

  return {
    featureType,
    bbox,
    attributes,
    ocrText,
    ...(ocrConfidence !== null ? { ocrConfidence } : {}),
    detectionConfidence,
    ...(distanceEstimate !== null ? { distanceEstimate } : {}),
    ...(distanceUncertaintyM !== null ? { distanceUncertaintyM } : {}),
    ...(identityEvidence !== null ? { identityEvidence } : {})
  };
}

/** Validate a whole provider response array; drops unusable entries. */
export function validateVisualObservations(raw: unknown): VisualObservation[] {
  if (!Array.isArray(raw)) return [];
  const out: VisualObservation[] = [];
  for (const item of raw) {
    const v = validateVisualObservation(item);
    if (v) out.push(v);
  }
  return out;
}

function num01(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : null;
}

function finitePos(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
