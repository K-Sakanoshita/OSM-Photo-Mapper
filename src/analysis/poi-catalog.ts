import rawCatalog from '../../data/poi-catalog.json';
import type { GeometryPreference } from './feature-classes';

/** Curated, versioned POI vocabulary. It is bundled with the app; only the
 * broad category labels are sent with an image. Source URLs and exact OSM
 * tags are never inferred by the provider. */
export interface PoiEntry {
  id: string;
  featureType?: string;
  label: string;
  keywords: string[];
  tags: Record<string, string>;
  geometry?: GeometryPreference;
}

export interface PoiCategory {
  id: string;
  label: string;
  wiki: string;
  taginfo: string;
  entries: PoiEntry[];
}

export const POI_CATEGORIES: PoiCategory[] = rawCatalog.categories as PoiCategory[];
export const POI_ENTRIES = POI_CATEGORIES.flatMap((category) => category.entries);

const categoriesById = new Map(POI_CATEGORIES.map((category) => [category.id, category]));
const entriesById = new Map(POI_ENTRIES.map((entry) => [entry.id, entry]));

export function getPoiCategory(id: string): PoiCategory | undefined {
  return categoriesById.get(id);
}

export function getPoiEntry(id: string): PoiEntry | undefined {
  return entriesById.get(id);
}

/** Exact, conservative match only. A visually plausible but ambiguous phrase
 * must go to refinement or review, never become an automatic OSM tag. */
export function matchPoiKeyword(categoryId: string, keyword: string): PoiEntry | undefined {
  const category = getPoiCategory(categoryId);
  if (!category) return undefined;
  const normalized = keyword.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  const matches = category.entries.filter((entry) =>
    [entry.id, entry.label, ...entry.keywords, ...Object.values(entry.tags).filter((value) => value !== categoryId)]
      .some((term) => term.toLocaleLowerCase().replace(/\s+/g, ' ') === normalized)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function categoryForEntry(id: string): PoiCategory | undefined {
  return POI_CATEGORIES.find((category) => category.entries.some((entry) => entry.id === id));
}
