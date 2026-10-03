import { describe, expect, it } from 'vitest';
import { clearProxySettings, loadProxySettings, saveProxySettings } from '../src/analysis/proxy-settings';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); }
  };
}

describe('proxy settings on the operator device', () => {
  it('restores endpoint and masked-input token data after reload, then forgets both', () => {
    const storage = memoryStorage();
    expect(loadProxySettings(storage)).toEqual({ settings: null, available: true });
    expect(saveProxySettings(storage, { endpoint: 'https://proxy.example/v1/responses', token: 'test-token' })).toBe(true);
    expect(loadProxySettings(storage)).toEqual({
      settings: { endpoint: 'https://proxy.example/v1/responses', token: 'test-token' }, available: true
    });
    expect(clearProxySettings(storage)).toBe(true);
    expect(loadProxySettings(storage)).toEqual({ settings: { endpoint: '', token: '' }, available: true });
    expect([...Array(storage.length)].map((_, i) => storage.key(i)).some((key) => key?.endsWith('.v1') && storage.getItem(key)?.includes('test-token'))).toBe(false);
  });

  it('falls back to in-memory use when storage is blocked', () => {
    const blocked = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); }
    } as unknown as Storage;
    expect(loadProxySettings(blocked).available).toBe(false);
    expect(saveProxySettings(blocked, { endpoint: 'https://proxy.example', token: 'test-token' })).toBe(false);
    expect(clearProxySettings(blocked)).toBe(false);
  });

  it('ignores malformed stored values', () => {
    const storage = memoryStorage();
    storage.setItem('osm-photo-mapper.proxy-settings.v1', '{bad');
    expect(loadProxySettings(storage).settings).toBeNull();
  });
});
