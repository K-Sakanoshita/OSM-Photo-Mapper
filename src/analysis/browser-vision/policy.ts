import config from '../../../data/browser-vision.json';
export { config as browserVisionConfig };
export const BROWSER_VISION_VERSION = `${config.version}:${config.nsfw.model}:${config.clip.model}:${config.clip.dtype}`;
export interface Score { label: string; score: number }
export interface NsfwResult {
  status: 'done' | 'error'; model: string; verdict?: 'clear' | 'review';
  scores?: Score[]; explicitScore?: number; suggestiveScore?: number; error?: string;
}
export interface ClipResult {
  status: 'done' | 'error'; model: string; purpose?: 'poi' | 'other' | 'uncertain';
  categories?: Score[]; scores?: Score[]; error?: string;
}
export interface BrowserVisionResult {
  version: string; checkedAt: number; nsfw: NsfwResult; clip: ClipResult;
  /** Explicit per-photo reviewer override; never inferred from CLIP. */
  reviewedForSending?: boolean;
}
export const clipLabels = [
  ...config.clip.categories.map((c) => ({ ...c, poi: true })),
  ...config.clip.otherLabels.map((c) => ({ ...c, poi: false }))
];
export function validateScores(scores: Score[]): Score[] {
  if (!scores.length || scores.some((s) => !Number.isFinite(s.score) || s.score < 0 || s.score > 1)) throw new Error('Invalid local classifier scores');
  return scores;
}
export function nsfwResult(scores: Score[]): NsfwResult {
  validateScores(scores);
  for (const label of ['Porn', 'Hentai', 'Sexy', 'Neutral', 'Drawing']) if (!scores.some((s) => s.label === label)) throw new Error('Incomplete NSFW results');
  const score = (label: string) => scores.find((s) => s.label === label)!.score;
  const explicitScore = Math.min(1, score('Porn') + score('Hentai'));
  const suggestiveScore = score('Sexy');
  return { status: 'done', model: config.nsfw.model, scores, explicitScore, suggestiveScore,
    verdict: explicitScore >= config.nsfw.explicitThreshold || suggestiveScore >= config.nsfw.suggestiveThreshold ? 'review' : 'clear' };
}
export function clipResult(scores: Score[]): ClipResult {
  validateScores(scores);
  if (scores.length !== clipLabels.length || clipLabels.some((c) => !scores.some((s) => s.label === c.id))) throw new Error('Incomplete CLIP results');
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const topPoi = sorted.find((s) => clipLabels.find((c) => c.id === s.label)!.poi)!;
  const topOther = sorted.find((s) => !clipLabels.find((c) => c.id === s.label)!.poi)!;
  const purpose = Math.abs(topPoi.score - topOther.score) < config.clip.margin ? 'uncertain' : topPoi.score > topOther.score ? 'poi' : 'other';
  return { status: 'done', model: config.clip.model, purpose, scores: sorted,
    categories: sorted.filter((s) => config.clip.categories.some((c) => c.id === s.label)).slice(0, 3) };
}
export function requiresPhotoReview(result?: BrowserVisionResult): boolean {
  if (!result || result.version !== BROWSER_VISION_VERSION) return true;
  return !result.reviewedForSending && (result.nsfw.status !== 'done' || result.nsfw.verdict !== 'clear');
}
