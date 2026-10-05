export const LIVE_PHOTO_LIMIT = 30;
export const LIVE_PHOTO_WARNING = 20;

export function livePhotoLimitState(mode: 'live' | 'static' | undefined, count: number) {
  const live = mode !== 'static';
  return { full: live && count >= LIVE_PHOTO_LIMIT, warn: live && count >= LIVE_PHOTO_WARNING,
    remaining: Math.max(0, LIVE_PHOTO_LIMIT - count) };
}
