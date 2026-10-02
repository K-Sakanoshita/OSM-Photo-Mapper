import type { AnalysisResult, Photo, Survey } from '../types';
import type { AnalysisContext, ImageObservationAnalyzer, VisualObservation } from './analyzer';
import { FEATURE_CLASSES } from './feature-classes';
import type { AnalyzeOptions } from './pipeline';
import { SurveyAnalysisPipeline } from './pipeline';

/**
 * Deterministic mock analyzer (issue #2: now a plain
 * ImageObservationAnalyzer).
 *
 * There is no real vision API in the MVP skeleton, so this stand-in
 * fabricates plausible VISUAL EVIDENCE to exercise the full pipeline
 * (photos -> validated observations -> grouped candidates -> estimated
 * positions) without any network access. It is NOT a substitute for real
 * image analysis — swap in a real ImageObservationAnalyzer (e.g.
 * OpenAIVisionAnalyzer) via the UI.
 *
 * The provider now returns only VisualObservations; ALL candidate /
 * position / tag business logic lives in the shared
 * SurveyAnalysisPipeline (issue #2 architecture).
 *
 * Behavior:
 *  - Each photo yields one observation. The feature type comes from the
 *    photo note if it names a known class, otherwise it is assigned
 *    deterministically from the photo id (hash -> class index).
 *  - A single bbox near image center and a bounded distance estimate
 *    (with uncertainty) are used.
 */
export class MockAnalyzer implements ImageObservationAnalyzer {
  readonly name = 'mock';

  async analyzePhoto(photo: Photo, _context: AnalysisContext): Promise<VisualObservation[]> {
    const fromNote = this.inferFeatureType(photo.note);
    const featureType = fromNote?.id
      ?? FEATURE_CLASSES[simpleHash(photo.id) % FEATURE_CLASSES.length].id;

    const seed = simpleHash(photo.id);
    return [
      {
        featureType,
        bbox: {
          x: 0.35 + ((seed % 10) / 10) * 0.2, // 0.35..0.55
          y: 0.4,
          w: 0.2,
          h: 0.25
        },
        attributes: {},
        detectionConfidence: 0.45 + ((seed % 5) / 100), // 0.45..0.89
        distanceEstimate: 3 + (seed % 20), // 3..22 m
        distanceUncertaintyM: 2 + (seed % 4) // 2..5 m
      }
    ];
  }

  /** Convenience wrapper running the full shared pipeline (kept for
   *  tests / demo wiring). */
  async analyze(survey: Survey, opts?: AnalyzeOptions): Promise<AnalysisResult> {
    return new SurveyAnalysisPipeline(this).analyze(survey, opts);
  }

  private inferFeatureType(note?: string) {
    if (!note) return undefined;
    const n = note.trim().toLowerCase();
    return FEATURE_CLASSES.find(
      (c) => n === c.id || n === c.label.toLowerCase()
    );
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
