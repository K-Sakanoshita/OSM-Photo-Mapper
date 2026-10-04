import japanese from '../data/locales/ja.json';

export type Language = 'ja' | 'en';
export const language: Language = typeof document !== 'undefined' && document.documentElement.lang === 'en' ? 'en' : 'ja';
const messages: Record<string, string> = japanese.messages;
const templates = Object.entries(japanese.templates)
  // Specific diagnostics must match before generic composed messages.
  .sort(([a], [b]) => b.replace(/\{\w+\}/g, '').length - a.replace(/\{\w+\}/g, '').length)
  .map(([source, translation]) => {
  const names: string[] = [];
  const parts = source.split(/(\{\w+\})/g).map((part) => {
    if (/^\{\w+\}$/.test(part)) {
      names.push(part.slice(1, -1));
      return ['number', 'count', 'photos', 'candidates', 'observations'].includes(part.slice(1, -1)) ? '(\\d+)' : '(.+?)';
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { regex: new RegExp(`^${parts.join('')}$`), names, translation };
});

/** English source messages are the fallback; OSM tags and provider errors
 * remain verbatim when no translation is registered. */
export function t(text: string, locale: Language = language, depth = 0): string {
  if (locale === 'en') return text;
  if (messages[text]) return messages[text];
  const trimmed = text.trim();
  if (messages[trimmed]) return text.replace(trimmed, messages[trimmed]);
  if (depth < 4) {
    for (const template of templates) {
      const match = template.regex.exec(text) ?? template.regex.exec(trimmed);
      if (!match) continue;
      const translated = template.translation.replace(/\{(\w+)\}/g, (_token, name: string) => {
        const value = match[template.names.indexOf(name) + 1];
        return ['text', 'tags', 'coordinates', 'key', 'tag', 'id', 'date', 'error', 'note', 'type'].includes(name)
          ? value : t(value, locale, depth + 1);
      });
      return text.replace(match[0], translated);
    }
  }
  return text;
}

/** Both language entry points share root assets and the same service worker. */
export function appRootUrl(pageUrl: string): URL {
  const page = new URL(pageUrl);
  const rootPath = page.pathname.replace(/\/en(?:\/(?:index\.html)?)?$/, '/');
  return rootPath !== page.pathname ? new URL(rootPath, page) : new URL('./', page);
}

export function appAssetUrl(path: string): string {
  return new URL(path, appRootUrl(document.baseURI)).href;
}
