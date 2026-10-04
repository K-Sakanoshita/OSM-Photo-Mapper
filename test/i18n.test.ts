import { describe, expect, it } from 'vitest';
import { appRootUrl, t } from '../src/i18n';

describe('language entry points', () => {
  it('translates controls and dynamic summaries while preserving English output', () => {
    expect(t('Undo delete pin', 'ja')).toBe('ピン削除を元に戻す');
    expect(t('Undo delete pin', 'en')).toBe('Undo delete pin');
    expect(t('Photos (3)', 'ja')).toBe('写真（3枚）');
    expect(t('Source: Placed manually on map', 'ja')).toBe('解析元：地図上に手動配置');
    expect(t('Candidates (2)', 'en')).toBe('Candidates (2)');
  });
  it('preserves OSM tags and external error details', () => {
    expect(t('playground=swing', 'ja')).toBe('playground=swing');
    expect(t('OCR: Shop', 'ja')).toBe('文字認識：Shop');
    expect(t('Note: Bench', 'ja')).toBe('メモ：Bench');
    expect(t('OpenAI API error 400: unsupported model', 'ja')).toBe('OpenAI API error 400: unsupported model');
  });
  it('translates position diagnostics, nested review reasons and GPS status', () => {
    expect(t('Detection: clock 46% · ', 'ja')).toBe('検出：clock 46% · ');
    expect(t('Needs tag review: select a defining value: playground=*', 'ja'))
      .toBe('タグの確認が必要：種類を表す値を選択してください：playground=*');
    expect(t(' none — No geographic heading (Not started)', 'ja'))
      .toBe(' なし — 地理的な方位なし（未開始）');
    expect(t('GPS ready: 34.17733, 134.60637 · ±10 m · 2 s · live · track 3', 'ja'))
      .toBe('GPS取得済み：34.17733, 134.60637 · ±10 m · 2秒前 · 現在の測位 · 軌跡3件');
    expect(t('estimate 34.17733, 134.60637', 'ja')).toBe('推定 34.17733, 134.60637');
    expect(t('GPS accuracy is coarse (mean ~30 m).', 'en'))
      .toBe('GPS accuracy is coarse (mean ~30 m).');
  });
  it('resolves shared assets from either locale under a GitHub Pages subpath', () => {
    for (const page of ['https://example.com/mapper/', 'https://example.com/mapper/index.html',
      'https://example.com/mapper/en', 'https://example.com/mapper/en/', 'https://example.com/mapper/en/index.html']) {
      expect(appRootUrl(page).href).toBe('https://example.com/mapper/');
      expect(new URL('tiles/osmfj_poi.json', appRootUrl(page)).href).toBe('https://example.com/mapper/tiles/osmfj_poi.json');
    }
  });
});
