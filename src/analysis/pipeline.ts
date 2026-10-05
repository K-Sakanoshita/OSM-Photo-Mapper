import type {
  AnalysisResult,
  FeatureCandidate,
  Observation,
  Photo,
  PhotoAnalysisStatus,
  Survey
} from '../types';
import type {
  AnalysisContext,
  ImageObservationAnalyzer,
  VisualObservation
} from './analyzer';
import { UNKNOWN_FEATURE_TYPE, validateVisualObservations } from './analyzer';
import { cropHashFromDataUrl, type CropHash } from './crop-hash';
import {
  FEATURE_CLASSES,
  defaultTagsFor,
  getFeatureClass,
  mergeTags
} from './feature-classes';
import {
  estimatePosition,
  rayFromPhoto
} from './position';
import type { ObservationRay } from './position';

/**
 * Shared survey analysis pipeline (issue #2).
 *
 * Provider-agnostic: takes ANY ImageObservationAnalyzer, runs it per
 * photo, strictly validates the visual evidence, maps it onto the OSM
 * feature-class policy, preserves independent detections for identity review, builds
 * rays, estimates positions and merges observed tags into reviewable
 * FeatureCandidates.
 *
 * No provider duplicates this business logic — a provider returns raw
 * VisualObservations and nothing else (see analyzer.ts).
 *
 * Failure policy: a provider failure for ONE photo becomes a per-photo
 * error status; the batch continues and the partial result stays usable.
 * Failed photos are visible in the UI and can be re-analyzed (retry)
 * without re-running the successful ones.
 */

/** Observations whose detection confidence is below this threshold are
 *  dropped — an untrusted detection must not seed a candidate. */
export const MIN_DETECTION_CONFIDENCE = 0.4;

/** Detected attributes are only applied as OSM tags when the DETECTION
 *  confidence is at least this — low-confidence attributes stay unset
 *  (carried as unconfirmed evidence instead). */
export const MIN_ATTRIBUTE_CONFIDENCE = 0.7;

export interface AnalysisProgressInfo {
  /** 1-based index of the photo currently processed. */
  index: number;
  /** Total number of photos in this run. */
  total: number;
  /** Outcome of the photo just processed. */
  status: PhotoAnalysisStatus;
}

export interface AnalyzeOptions {
  /** Restrict the run to these photo IDs (retry of failed photos). */
  photoIds?: string[];
  /** Live per-photo progress callback (UI batch progress). */
  onProgress?: (info: AnalysisProgressInfo) => void;
  /**
   * Cross-photo visual matcher (issue #2 blocker 2): computes the
   * perceptual hash of a detection's crop. Defaults to hashing the
   * photo's image data URL in the browser; tests inject a deterministic
   * fake. A null result means "no visual evidence" — the observation
   * can never be merged across photos by identity.
   */
  cropHasher?: CropHasher;
}

/** Computes the 64-bit crop hash for one detection (null on failure). */
export type CropHasher = (photo: Photo, vis: VisualObservation) => Promise<CropHash | null>;

export interface PhotoAnalysisOutcome {
  observations: Observation[];
  statuses: PhotoAnalysisStatus[];
}

export class SurveyAnalysisPipeline {
  constructor(private readonly analyzer: ImageObservationAnalyzer) {}

  /** Provider name (UI/diagnostics). */
  get name(): string {
    return this.analyzer.name;
  }

  /**
   * Run the analyzer over the (subset of) survey photos and validate the
   * results. Per-photo failures are recorded, never thrown.
   */
  async analyzePhotos(
    survey: Survey,
    opts: AnalyzeOptions = {}
  ): Promise<PhotoAnalysisOutcome> {
    const wanted = opts.photoIds
      ? new Set(opts.photoIds)
      : undefined;
    const photos = wanted
      ? survey.photos.filter((p) => wanted.has(p.id))
      : survey.photos;

    const context = {
      surveyId: survey.id,
      featureClasses: FEATURE_CLASSES.map((c) => ({
        id: c.id,
        label: c.label,
        visualAttributes: c.visualAttributeKeys?.map((key) => ({
          key,
          allowedValues: c.commonValues?.[key]
        })),
        visualHint: c.visualHint
      }))
    };

    const observations: Observation[] = [];
    const statuses: PhotoAnalysisStatus[] = [];
    // Issue #2 blocker 2: real visual evidence for cross-photo grouping.
    const hasher: CropHasher =
      opts.cropHasher ?? ((p, vis) => (p.image ? cropHashFromDataUrl(p.image, vis.bbox) : Promise.resolve(null)));

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const ctx: AnalysisContext = { ...context, photo };
      let status: PhotoAnalysisStatus;
      try {
        const raw = await this.analyzer.analyzePhoto(photo, ctx);
        const valid = validateVisualObservations(raw);
        const obs: Observation[] = [];
        for (let j = 0; j < valid.length; j++) {
          const o = toObservation(survey.id, photo, valid[j], j);
          if (o) {
            // Perceptual hash of the cropped detection region. Any
            // failure (undecodable image, no canvas) yields null — the
            // observation then simply carries no visual evidence.
            // The hasher (default or injected) decides whether it can
            // produce a value; the default one returns null for photos
            // without image data.
            const h = await hasher(photo, valid[j]);
            if (h) o.cropHash = h;
            obs.push(o);
          }
        }
        observations.push(...obs);
        status = { photoId: photo.id, status: 'ok', observationCount: obs.length };
      } catch (e) {
        status = {
          photoId: photo.id,
          status: 'error',
          error: e instanceof Error ? e.message : String(e)
        };
      }
      statuses.push(status);
      opts.onProgress?.({ index: i + 1, total: photos.length, status });
    }

    return { observations, statuses };
  }

  /** Create separately reviewable detections. Identity grouping is explicitly
   * confirmed by the reviewer, not inferred from nearby locations or crop hashes. */
  buildCandidates(survey: Survey, observations: Observation[]): FeatureCandidate[] {
    // Identity is a human decision: proximity and similar crops alone cannot
    // distinguish repeated lanterns/statues. Keep detections independently reviewable.
    return observations.map((obs) => buildCandidate(survey, obs.featureType, [obs]));
  }

  /** Full pipeline: provider -> validated observations -> candidates. */
  async analyze(survey: Survey, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
    const { observations, statuses } = await this.analyzePhotos(survey, opts);
    return {
      observations,
      candidates: this.buildCandidates(survey, observations),
      photoStatuses: statuses,
      analyzerName: this.analyzer.name
    };
  }
}

/* ------------------------------------------------------------------ */
/* Visual observation -> domain Observation                            */
/* ------------------------------------------------------------------ */

/**
 * Convert validated visual evidence into a domain Observation, applying
 * the OSM tag policy from feature-classes.ts:
 *
 *  - autoTag classes: required tags by default; detected attributes
 *    become tags ONLY for keys the class declares as confirmable
 *    (suggestedTags / commonValues / mapping keys) and only when the
 *    detection confidence clears MIN_ATTRIBUTE_CONFIDENCE. commonValues
 *    keys must match an allowed value.
 *  - review-only (autoTag=false) and unknown classes: NO attribute is
 *    applied automatically — all detected attributes are carried as
 *    unconfirmed `detectedAttributes` evidence for the reviewer.
 *  - OCR text is carried as `textSeen` evidence and is NEVER turned into
 *    name=* automatically.
 *
 * Returns null when the detection confidence is below
 * MIN_DETECTION_CONFIDENCE (the observation is dropped).
 */
function toObservation(
  surveyId: string,
  photo: Photo,
  vis: VisualObservation,
  index: number
): Observation | null {
  if (vis.detectionConfidence < MIN_DETECTION_CONFIDENCE) return null;

  const cls = getFeatureClass(vis.featureType);
  const featureType = cls ? cls.id : UNKNOWN_FEATURE_TYPE;

  const tagSuggestions: Record<string, string> = { ...defaultTagsFor(featureType) };
  let detectedAttributes: Record<string, string> | undefined;
  const attributes = { ...vis.attributes };
  let conflictingPlaygroundSubtype = false;

  // Vision models sometimes describe the visible equipment as
  // equipment=swing. This is evidence, not an OSM tag: only the
  // playground class may translate a valid subtype to playground=*.
  if (featureType === 'playground' && attributes.equipment) {
    const equipment = attributes.equipment;
    const allowed = cls?.commonValues?.playground ?? [];
    if (allowed.includes(equipment)) {
      if (!attributes.playground) {
        attributes.playground = equipment;
        delete attributes.equipment;
      } else if (attributes.playground === equipment) {
        delete attributes.equipment;
      } else {
        conflictingPlaygroundSubtype = true;
      }
    }
  }

  if (cls && cls.autoTag && Object.keys(attributes).length > 0) {
    const confirmable = confirmableKeysFor(cls);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'playground' && conflictingPlaygroundSubtype) {
        detectedAttributes = { ...(detectedAttributes ?? {}), [key]: value };
        continue;
      }
      if (!confirmable.has(key)) {
        // Outside the class tag policy -> unconfirmed evidence.
        detectedAttributes = { ...(detectedAttributes ?? {}), [key]: value };
        continue;
      }
      // Low-confidence attributes remain unset (issue #2).
      if (vis.detectionConfidence < MIN_ATTRIBUTE_CONFIDENCE) {
        detectedAttributes = { ...(detectedAttributes ?? {}), [key]: value };
        continue;
      }
      const allowed = allowedValuesFor(cls, key);
      // commonValues keys: the value must be one of the declared values.
      if (allowed && !allowed.includes(value)) {
        detectedAttributes = { ...(detectedAttributes ?? {}), [key]: value };
        continue;
      }
      tagSuggestions[key] = value;
    }
  } else if (Object.keys(attributes).length > 0) {
    // Review-only / unknown classes: nothing is applied automatically.
    detectedAttributes = attributes;
  }

  return {
    id: `obs-${photo.id}-${index}`,
    photoId: photo.id,
    surveyId,
    featureType,
    bbox: vis.bbox,
    ...(vis.distanceEstimate != null ? { distanceEstimate: vis.distanceEstimate } : {}),
    ...(vis.distanceUncertaintyM != null ? { distanceUncertaintyM: vis.distanceUncertaintyM } : {}),
    ...(vis.ocrText != null ? { textSeen: vis.ocrText } : {}),
    ...(vis.ocrConfidence != null ? { ocrConfidence: vis.ocrConfidence } : {}),
    tagSuggestions,
    tagConfidence: vis.detectionConfidence,
    detectionConfidence: vis.detectionConfidence,
    ...(detectedAttributes != null && Object.keys(detectedAttributes).length > 0
      ? { detectedAttributes }
      : {}),
    ...(vis.identityEvidence != null ? { identityEvidence: vis.identityEvidence } : {})
  };
}

/** Keys a provider-detected attribute may be applied to for this class:
 *  suggestedTags keys + commonValues keys + mapping keys (issue #2: the
 *  OSM tag policy stays in feature-classes.ts). */
function confirmableKeysFor(cls: {
  suggestedTags: Record<string, string>;
  commonValues?: Record<string, string[]>;
  mappings?: { tags: Record<string, string> }[];
}): Set<string> {
  const keys = new Set<string>(Object.keys(cls.suggestedTags));
  if (cls.commonValues) {
    for (const k of Object.keys(cls.commonValues)) keys.add(k);
  }
  for (const m of cls.mappings ?? []) {
    for (const k of Object.keys(m.tags)) keys.add(k);
  }
  return keys;
}

function allowedValuesFor(
  cls: { commonValues?: Record<string, string[]> },
  key: string
): string[] | undefined {
  return cls.commonValues?.[key];
}

/* ------------------------------------------------------------------ */
/* Grouping + candidate building */
/* ------------------------------------------------------------------ */

export function buildCandidate(
  survey: Survey,
  featureType: string,
  cluster: Observation[]
): FeatureCandidate {
  const rays = cluster
    .map((obs) => {
      const photo = survey.photos.find((p) => p.id === obs.photoId);
      if (!photo) return null;
      return rayFromPhoto(photo, obs);
    })
    .filter((r): r is ObservationRay => r !== null);

  const warnings: string[] = [];
  let lat: number | undefined;
  let lon: number | undefined;
  let positionConfidence = 0;
  // Issue #3: evidence-derived quality + uncertainty travel with the
  // candidate so review/export can classify it explicitly.
  let positionQuality: FeatureCandidate['positionQuality'];
  let positionUncertaintyMeters: number | undefined;

  if (rays.length > 0) {
    const est = estimatePosition(rays);
    lat = est.lat;
    lon = est.lon;
    positionConfidence = est.positionConfidence;
    positionQuality = est.positionQuality;
    positionUncertaintyMeters = est.uncertaintyMeters;
    warnings.push(...est.warnings);
    // Issue #5: weakly-determined positions must be flagged, not silently
    // snapped, so reviewers verify them before mapping.
    if (positionConfidence < 0.35) {
      warnings.push('Position is a low-confidence estimate — verify before mapping.');
    }
  } else {
    warnings.push('No usable camera GPS position for this observation. Place its pin on the map.');
  }

  const tags = mergeTags(cluster);
  const tagConfidence = cluster.reduce((m, o) => Math.max(m, o.tagConfidence), 0);

  return {
    id: `cand-${cluster[0].id}`,
    surveyId: survey.id,
    featureType,
    lat,
    lon,
    positionConfidence,
    tagConfidence,
    tags,
    observationIds: cluster.map((o) => o.id),
    osmMatches: [],
    positionQuality,
    positionUncertaintyMeters,
    warnings,
    status: 'new'
  };
}
