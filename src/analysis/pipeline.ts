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
import {
  FEATURE_CLASSES,
  defaultTagsFor,
  getFeatureClass,
  mergeTags
} from './feature-classes';
import {
  bearingToLatLon,
  distanceMeters,
  estimatePosition,
  imageBearing,
  rayFromPhoto
} from './position';
import type { ObservationRay } from './position';

/**
 * Shared survey analysis pipeline (issue #2).
 *
 * Provider-agnostic: takes ANY ImageObservationAnalyzer, runs it per
 * photo, strictly validates the visual evidence, maps it onto the OSM
 * feature-class policy, groups the same object across photos, builds
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

/** Projected points within this distance (meters) of an existing cluster
 *  representative are treated as the same object. */
const CLUSTER_RADIUS_M = 18;

/** Maximum distance (meters) between two projected cluster points for
 *  shared identityEvidence to bridge them (issue #2 blocker 2). Identity
 *  evidence is SOFT evidence: it may merge clusters beyond the spatial
 *  radius, but contradictory geometry (clusters farther apart than this)
 *  overrides it. Clusters without any projected point are never merged
 *  by identity alone. */
const IDENTITY_MERGE_RADIUS_M = 50;

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
}

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
      featureClasses: FEATURE_CLASSES.map((c) => ({ id: c.id, label: c.label }))
    };

    const observations: Observation[] = [];
    const statuses: PhotoAnalysisStatus[] = [];

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
          if (o) obs.push(o);
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

  /**
   * Group validated observations into candidates: same feature type +
   * projected proximity (and identical identityEvidence) = same object.
   * Pure and provider-agnostic — safe to re-run on merged observation
   * sets after a retry.
   */
  buildCandidates(survey: Survey, observations: Observation[]): FeatureCandidate[] {
    // Group key: feature type. Within a type, cluster by projected
    // proximity; then merge clusters that share identityEvidence.
    const byType = new Map<string, Observation[]>();
    for (const obs of observations) {
      const list = byType.get(obs.featureType) ?? [];
      list.push(obs);
      byType.set(obs.featureType, list);
    }

    const candidates: FeatureCandidate[] = [];
    for (const [featureType, obsList] of byType) {
      let clusters: Observation[][] = [];
      for (const obs of obsList) {
        const p = projectPoint(survey, obs);
        let target: Observation[] | undefined;
        if (p) {
          for (const cluster of clusters) {
            // Issue #2 blocker 1: detections from the SAME photo are never
            // merged by spatial proximity — one photo can show several
            // objects that project to (near-)identical points, and the old
            // camera-position fallback collapsed them into one fake object.
            // Same-photo detections stay distinct unless explicit
            // cross-photo identity evidence says otherwise (identity merge
            // below). Invariant: no cluster ever holds two observations
            // from the same photo.
            if (cluster.some((m) => m.photoId === obs.photoId)) continue;
            const rep = projectPoint(survey, cluster[0]);
            if (rep && distanceMeters(p.lat, p.lon, rep.lat, rep.lon) <= CLUSTER_RADIUS_M) {
              target = cluster;
              break;
            }
          }
        }
        if (target) target.push(obs);
        else clusters.push([obs]);
      }

      // Cross-photo identity evidence (issue #2): SOFT same-object
      // evidence from the provider. It may bridge clusters beyond the
      // spatial radius, but only when both clusters have usable projected
      // points within IDENTITY_MERGE_RADIUS_M — contradictory geometry
      // overrides the identity claim (issue #2 blocker 2).
      clusters = mergeByIdentity(survey, clusters);

      for (const cluster of clusters) {
        candidates.push(buildCandidate(survey, featureType, cluster));
      }
    }

    return candidates;
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

  if (cls && cls.autoTag && Object.keys(vis.attributes).length > 0) {
    const confirmable = confirmableKeysFor(cls);
    for (const [key, value] of Object.entries(vis.attributes)) {
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
  } else if (Object.keys(vis.attributes).length > 0) {
    // Review-only / unknown classes: nothing is applied automatically.
    detectedAttributes = { ...vis.attributes };
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
/* Grouping + candidate building (moved out of MockAnalyzer, issue #2) */
/* ------------------------------------------------------------------ */

/**
 * Projected point for a single observation (single-ray projection).
 *
 * Issue #2 blocker 1: the point exists ONLY when the observation carries
 * usable position evidence — the photo's camera position AND camera
 * heading (issue #3: device orientation only, never the movement
 * heading) AND a positive distance estimate. There is deliberately NO
 * fallback to the camera position: projecting a no-distance detection at
 * the camera's own location would collapse every object in the photo
 * onto one point and merge separate objects into a single fake cluster.
 * Without position evidence the observation has no projected point and
 * each such observation stays a distinct singleton candidate.
 */
function projectPoint(survey: Survey, obs: Observation): { lat: number; lon: number } | null {
  const photo = survey.photos.find((p) => p.id === obs.photoId);
  const ch = photo?.cameraHeading;
  const dist = obs.distanceEstimate;
  if (!photo?.gps || ch == null || dist == null || !Number.isFinite(dist) || dist <= 0) {
    return null;
  }
  const bearing = imageBearing(ch.bearing, obs.bbox);
  return bearingToLatLon(photo.gps.lat, photo.gps.lon, bearing, dist);
}

/**
 * Merge clusters that share a non-empty identityEvidence value —
 * cross-photo same-object evidence from the provider (issue #2).
 *
 * Issue #2 blocker 2: identityEvidence is SOFT evidence, not a verdict.
 * A merge happens ONLY when BOTH clusters have a usable projected point
 * (see `projectPoint`) and those points are within IDENTITY_MERGE_RADIUS_M
 * of each other. Contradictory geometry (projected points farther apart)
 * overrides the identity claim; clusters without position evidence are
 * never merged by identity alone. Merges are connected components over
 * pairwise-compatible links (union-find), so a transitive chain only
 * forms through steps that each pass the geometry check.
 */
function mergeByIdentity(survey: Survey, clusters: Observation[][]): Observation[][] {
  if (clusters.length < 2) return clusters;

  // Representative projected point per cluster (first observation that
  // has one; null when the cluster has no position evidence).
  const repPoints = clusters.map((cluster) => {
    for (const o of cluster) {
      const p = projectPoint(survey, o);
      if (p) return p;
    }
    return null;
  });

  // Cluster indices per identity value.
  const byIdentity = new Map<string, number[]>();
  clusters.forEach((cluster, ci) => {
    const seen = new Set<string>();
    for (const o of cluster) {
      const v = o.identityEvidence;
      if (v && !seen.has(v)) {
        seen.add(v);
        const list = byIdentity.get(v) ?? [];
        list.push(ci);
        byIdentity.set(v, list);
      }
    }
  });

  // Union-find over cluster indices.
  const parent = clusters.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (const list of byIdentity.values()) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const pa = repPoints[list[a]];
        const pb = repPoints[list[b]];
        if (!pa || !pb) continue; // no position evidence -> no merge
        if (distanceMeters(pa.lat, pa.lon, pb.lat, pb.lon) > IDENTITY_MERGE_RADIUS_M) continue;
        union(list[a], list[b]);
      }
    }
  }

  // Collect connected components.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < clusters.length; i++) {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(i);
    groups.set(r, g);
  }
  const merged: Observation[][] = [];
  for (const g of groups.values()) {
    merged.push(g.flatMap((i) => clusters[i]));
  }
  return merged;
}

function buildCandidate(
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
    warnings.push('No usable GPS position for this observation.');
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
