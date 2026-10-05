import { expect, it } from 'vitest';
import { livePhotoLimitState } from '../src/capture/photo-limit';
it('warns at 20 and blocks at 30 only for live surveys', () => {
  expect(livePhotoLimitState('live', 19).warn).toBe(false);
  expect(livePhotoLimitState('live', 20)).toEqual({ warn: true, full: false, remaining: 10 });
  expect(livePhotoLimitState('live', 29).full).toBe(false);
  expect(livePhotoLimitState('live', 30)).toEqual({ warn: true, full: true, remaining: 0 });
  expect(livePhotoLimitState(undefined, 31).full).toBe(true);
  expect(livePhotoLimitState('static', 100).full).toBe(false);
  expect(livePhotoLimitState('static', 100).warn).toBe(false);
});
