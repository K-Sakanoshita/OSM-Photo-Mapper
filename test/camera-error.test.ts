import { expect, it } from 'vitest';
import { cameraErrorMessage } from '../src/capture/inapp-camera';
import { t } from '../src/i18n';
it('translates a missing camera independently of browser error wording', () => {
  expect(t(cameraErrorMessage(new DOMException('Requested device not found', 'NotFoundError')), 'ja')).toBe('この端末にカメラが見つかりません。');
  expect(cameraErrorMessage({ name: 'DevicesNotFoundError', message: 'different text' })).toBe('No camera was found on this device.');
  expect(t(cameraErrorMessage({ name: 'NotAllowedError' }), 'ja')).toContain('許可');
  expect(t(cameraErrorMessage(null), 'ja')).toContain('カメラを起動できません');
});
