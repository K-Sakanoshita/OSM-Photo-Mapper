import rawMarker from '../../data/marker.jsonc?raw';

type Rules = Record<string, Record<string, string>>;
const config = JSON.parse(rawMarker).marker as { tag: Rules; subtag: Record<string, Rules> };

/** Configuration order decides which defining tag wins. Subtags only
 * override an icon when their parent key=value also matches. */
export function iconForTags(tags: Record<string, string>): string {
  for (const [key, values] of Object.entries(config.tag)) {
    if (key === '*' || !tags[key]) continue;
    const icon = values[tags[key]] ?? values['*'];
    if (!icon) continue;
    for (const [subkey, subvalues] of Object.entries(config.subtag[`${key}=${tags[key]}`] ?? {})) {
      const override = tags[subkey] && (subvalues[tags[subkey]] ?? subvalues['*']);
      if (override) return override;
    }
    return icon;
  }
  return config.tag['*']['*'];
}

export function iconUrl(filename: string): string {
  return new URL(`icon/${filename}`, document.baseURI).href;
}
