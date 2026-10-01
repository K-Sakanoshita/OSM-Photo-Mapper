import type { AnalysisResult, Survey } from '../types';

/**
 * Abstraction over the image-analysis provider.
 *
 * The exact provider is intentionally decoupled so the app is not tied to one
 * vendor. A real implementation would call a vision API per photo, detect
 * feature instances, read visible text, and estimate distances. The rest of the
 * app only depends on this interface returning observations + candidates.
 */
export interface FeatureAnalyzer {
  /** Human-readable provider name (shown in UI / diagnostics). */
  readonly name: string;
  /** Run analysis over a survey's photos. */
  analyze(survey: Survey): Promise<AnalysisResult>;
}

/** A no-op analyzer useful for tests / wiring. Returns empty results. */
export class NoopAnalyzer implements FeatureAnalyzer {
  readonly name = 'none';
  analyze(_survey: Survey): Promise<AnalysisResult> {
    return Promise.resolve({ observations: [], candidates: [] });
  }
}
