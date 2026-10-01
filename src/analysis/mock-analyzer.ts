import type { AnalysisResult, FeatureCandidate, Observation, Survey } from '../types';
import type { FeatureAnalyzer } from './analyzer';
import { FEATURE_CLASSES, defaultTagsFor, mergeTags } from './feature-classes';
import {
  bearingToLatLon,
  distanceMeters,
  estimatePosition,
  imageBearing,
  rayFromPhoto,
} from './position';
import type { ObservationRay } from './position';

/**
 * Deterministic mock analyzer.
 *
 * There is no real vision API in the MVP skeleton, so this stand-in fabricates
 * plausible observations to exercise the full pipeline (photos -> observations
 * -> grouped candidates -> estimated positions). It is NOT a substitute for
 * real image analysis; swap in a real FeatureAnalyzer when available.
 *
 * Behavior:
 *  - Each photo yields one observation. The feature type comes from the photo
 *    note if it names a known class, otherwise it is assigned round-robin.
 *  - A single bbox near image center and a bounded distance estimate are used.
 *  - Observations are clustered into candidates by feature type + projected
 *    proximity, so the same object seen from several photos merges into one
 *    candidate (exercising multi-ray position estimation).
 */
export class MockAnalyzer implements FeatureAnalyzer {
  readonly name = 'mock';

  async analyze(survey: Survey): Promise<AnalysisResult> {
    const observations: Observation[] = [];
    let rr = 0;

    for (const photo of survey.photos) {
      const cls = this.inferFeatureType(photo.note);
      const featureType = cls ? cls.id : FEATURE_CLASSES[rr % FEATURE_CLASSES.length].id;
      rr++;

      const seed = simpleHash(photo.id);
      const bbox = {
        x: 0.35 + ((seed % 10) / 10) * 0.2, // 0.35..0.55
        y: 0.4,
        w: 0.2,
        h: 0.25,
      };
      const distanceEstimate = 3 + (seed % 20); // 3..22 m

      observations.push({
        id: `obs-${photo.id}`,
        photoId: photo.id,
        surveyId: survey.id,
        featureType,
        bbox,
        distanceEstimate,
        tagSuggestions: defaultTagsFor(featureType),
        tagConfidence: 0.45 + ((seed % 5) / 100), // 0.45..0.89
      });
    }

    const candidates = this.clusterToCandidates(survey, observations);
    return { observations, candidates };
  }

  private inferFeatureType(note?: string) {
    if (!note) return undefined;
    const n = note.trim().toLowerCase();
    return FEATURE_CLASSES.find(
      (c) => n === c.id || n === c.label.toLowerCase()
    );
  }

  /** Projected point for a single observation (single-ray projection). */
  private projectPoint(survey: Survey, obs: Observation): { lat: number; lon: number } | null {
    const photo = survey.photos.find((p) => p.id === obs.photoId);
    if (!photo?.gps) return null;
    const hasHeading = photo.heading != null;
    const bearing = hasHeading ? imageBearing(photo.heading!, obs.bbox) : 0;
    if (!hasHeading || (obs.distanceEstimate ?? 0) <= 0) {
      return { lat: photo.gps.lat, lon: photo.gps.lon };
    }
    return bearingToLatLon(photo.gps.lat, photo.gps.lon, bearing, obs.distanceEstimate!);
  }

  private clusterToCandidates(survey: Survey, observations: Observation[]): FeatureCandidate[] {
    // Group key: feature type. Within a type, cluster by projected proximity.
    const byType = new Map<string, Observation[]>();
    for (const obs of observations) {
      const list = byType.get(obs.featureType) ?? [];
      list.push(obs);
      byType.set(obs.featureType, list);
    }

    const candidates: FeatureCandidate[] = [];
    const CLUSTER_RADIUS_M = 18;

    for (const [featureType, obsList] of byType) {
      const clusters: Observation[][] = [];
      for (const obs of obsList) {
        const p = this.projectPoint(survey, obs);
        let target: Observation[] | undefined;
        if (p) {
          for (const cluster of clusters) {
            const rep = this.projectPoint(survey, cluster[0]);
            if (rep && distanceMeters(p.lat, p.lon, rep.lat, rep.lon) <= CLUSTER_RADIUS_M) {
              target = cluster;
              break;
            }
          }
        }
        if (target) target.push(obs);
        else clusters.push([obs]);
      }

      for (const cluster of clusters) {
        candidates.push(this.buildCandidate(survey, featureType, cluster));
      }
    }

    return candidates;
  }

  private buildCandidate(
    survey: Survey,
    featureType: string,
    cluster: Observation[]
  ): FeatureCandidate {
    const rays = cluster
      .map((obs) => {
        const photo = survey.photos.find((p) => p.id === obs.photoId);
        if (!photo) return null;
        return rayFromPhoto(photo, obs.bbox, obs.distanceEstimate);
      })
      .filter((r): r is ObservationRay => r !== null);

    const warnings: string[] = [];
    let lat: number | undefined;
    let lon: number | undefined;
    let positionConfidence = 0;

    if (rays.length > 0) {
      const est = estimatePosition(rays);
      lat = est.lat;
      lon = est.lon;
      positionConfidence = est.positionConfidence;
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
      warnings,
      status: 'new',
    };
  }
}

/** Small deterministic string hash (FNV-1a 32-bit), for stable mock values. */
function simpleHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
