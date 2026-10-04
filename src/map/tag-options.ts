import rawMarker from '../../data/marker.jsonc?raw';
import { POI_ENTRIES } from '../analysis/poi-catalog';

type Rules = Record<string, Record<string, string>>;
const marker = JSON.parse(rawMarker).marker as { tag: Rules; subtag: Record<string, Rules> };
const options = new Map<string, Set<string>>();

function add(key: string, value: string): void {
  // Wildcards select rendering rules; they are not actual OSM tag values.
  if (!key || key === '*' || !value || value === '*') return;
  if (!options.has(key)) options.set(key, new Set());
  options.get(key)!.add(value);
}

for (const rules of [marker.tag, ...Object.values(marker.subtag)]) {
  for (const [key, values] of Object.entries(rules)) {
    for (const value of Object.keys(values)) add(key, value);
  }
}
for (const entry of POI_ENTRIES) {
  for (const [key, value] of Object.entries(entry.tags)) add(key, value);
}

export function tagKeys(): string[] {
  return [...options.keys()].sort();
}

export function tagValues(key: string): string[] {
  return [...(options.get(key) ?? [])].sort();
}
