/** Local operator settings for the proxy. Never store the OpenAI API key here. */
const STORAGE_KEY = 'osm-photo-mapper.proxy-settings.v1';
const CLEARED_KEY = 'osm-photo-mapper.proxy-settings-cleared.v1';

export interface ProxySettings {
  endpoint: string;
  token: string;
}

export function loadProxySettings(storage: Pick<Storage, 'getItem'> | null): {
  settings: ProxySettings | null;
  available: boolean;
} {
  if (!storage) return { settings: null, available: false };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {
      settings: storage.getItem(CLEARED_KEY) === '1' ? { endpoint: '', token: '' } : null,
      available: true
    };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { settings: null, available: true };
    const row = parsed as Record<string, unknown>;
    if (typeof row.endpoint !== 'string' || typeof row.token !== 'string') {
      return { settings: null, available: true };
    }
    return { settings: { endpoint: row.endpoint, token: row.token }, available: true };
  } catch {
    return { settings: null, available: false };
  }
}

export function saveProxySettings(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, settings: ProxySettings): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
    storage.removeItem(CLEARED_KEY);
    return true;
  } catch {
    return false;
  }
}

export function clearProxySettings(storage: Pick<Storage, 'removeItem' | 'setItem'> | null): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(STORAGE_KEY);
    storage.setItem(CLEARED_KEY, '1');
    return true;
  } catch {
    return false;
  }
}
