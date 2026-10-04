import { describe, expect, it } from 'vitest';
import { BROWSER_VISION_VERSION, browserVisionConfig as config, clipLabels, clipResult, nsfwResult, requiresPhotoReview, type BrowserVisionResult } from '../src/analysis/browser-vision/policy';
const nsfwScores = (porn = .01, hentai = .01, sexy = .01) => ['Porn', 'Hentai', 'Sexy', 'Neutral', 'Drawing'].map((label, i) => ({ label, score: [porn, hentai, sexy, .96, .01][i] }));
const result = (): BrowserVisionResult => ({ version: BROWSER_VISION_VERSION, checkedAt: 1, nsfw: nsfwResult(nsfwScores()), clip: { status: 'error', model: config.clip.model, error: 'offline' } });
describe('browser-local photo decision policy', () => {
  it('flags explicit and suggestive results at configured thresholds', () => {
    expect(nsfwResult(nsfwScores(.5, .4)).verdict).toBe('review');
    expect(nsfwResult(nsfwScores(.01, .01, config.nsfw.suggestiveThreshold)).verdict).toBe('review');
    expect(nsfwResult(nsfwScores()).verdict).toBe('clear');
  });
  it('requires explicit review after NSFW failure or flag, including missing and stale data', () => {
    expect(requiresPhotoReview()).toBe(true);
    const value = result(); value.nsfw.status = 'error';
    expect(requiresPhotoReview(value)).toBe(true);
    value.reviewedForSending = true;
    expect(requiresPhotoReview(value)).toBe(false);
    value.version = 'old';
    expect(requiresPhotoReview(value)).toBe(true);
  });
  it('never treats a CLIP error or a low OSM similarity as an NSFW finding', () => {
    expect(requiresPhotoReview(result())).toBe(false);
  });
  it('marks OSM purpose separately and leaves OSM tags to the existing analyzer', () => {
    const scores = clipLabels.map((c) => ({ label: c.id, score: c.id === 'religious' ? .8 : .01 }));
    const value = clipResult(scores);
    expect(value.purpose).toBe('poi');
    expect(value.categories?.[0].label).toBe('religious');
    scores.find((s) => s.label === 'religious')!.score = .01;
    scores.find((s) => s.label === 'person')!.score = .8;
    expect(clipResult(scores).purpose).toBe('other');
    scores.find((s) => s.label === 'religious')!.score = .79;
    expect(clipResult(scores).purpose).toBe('uncertain');
  });
  it('rejects invalid or incomplete predictions rather than reporting a safe image', () => {
    expect(() => nsfwResult([{ label: 'Porn', score: NaN }])).toThrow();
    expect(() => nsfwResult([{ label: 'Neutral', score: 1 }])).toThrow();
    expect(() => clipResult([{ label: 'religious', score: .9 }])).toThrow();
  });
});
