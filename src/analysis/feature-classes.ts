/**
 * OSM feature-class presets (issue #5, expanded in issue #9).
 *
 * Each class declares:
 * - `requiredTags`: the minimal tag set that identifies the feature. These
 *   are applied by default when the class is `autoTag` (reviewed against
 *   current OSM tagging practice); they are EMPTY for review-only classes.
 * - `suggestedTags`: reasonable details that are only added when the
 *   analysis/reviewer confirms them. They are NOT applied by default.
 * - `commonValues`: known allowed values for a key whose actual value
 *   cannot be inferred from the class alone (e.g. playground=<type>).
 *   Offered as a review-time picker; never guessed.
 *
 * Geometry policy (issue #9):
 * - `geometryPreference` declares how the feature is normally mapped in
 *   OSM: 'node', 'area', 'either', or 'existing-only'.
 * - The app NEVER fabricates polygon/way geometry from a single photo.
 *   Candidates are always point-based. At export time, a candidate whose
 *   class is 'area' or 'existing-only' is NOT emitted as a create — the
 *   reviewer must link it to an existing object or draw the boundary in
 *   an editor. ('node' and 'either' classes may be created as nodes: a
 *   point representation is legitimate for small facilities.)
 *
 * Review-only mappings (issue #9):
 * - `autoTag: true` — the requiredTags are a well-established OSM
 *   convention (reviewed against current tagging practice before being
 *   made an automatic default) and are applied by default.
 * - `autoTag: false` — the OSM mapping is uncertain or genuinely
 *   ambiguous (e.g. statue: tourism=artwork vs historic=memorial;
 *   stone lantern: historic= vs man_made=; komainu: no established
 *   convention at all). No tags are applied by default. `mappings`
 *   (optional) lists candidate tag sets the reviewer chooses from in the
 *   review UI; classes without mappings are pure review-only (the
 *   reviewer sets tags manually). Review-only candidates are also
 *   excluded from automatic OSM snapping — unconfirmed semantics must
 *   not drive object identity.
 *
 * `category` groups classes for hierarchical recognition (issue #9):
 * street_furniture, emergency, religious, playground, transport,
 * business, amenities, artwork_memorial.
 *
 * The analyzer (issue #6) maps its per-photo observations onto these
 * presets; the review UI (issue #4) shows them as editable tag
 * suggestions.
 */
import type { Observation } from '../types';

export type GeometryPreference = 'node' | 'area' | 'either' | 'existing-only';

/** A candidate OSM interpretation for a review-only (autoTag=false)
 *  class. The reviewer chooses at most one in the review UI. */
export interface OsmMapping {
  /** Human-readable name shown in the review UI. */
  label: string;
  tags: Record<string, string>;
  /** Optional explanation shown next to the label. */
  hint?: string;
}

export interface FeatureClass {
  /** Stable ID used in Observation.featureType. */
  id: string;
  /** Human-readable name for the review UI. */
  label: string;
  /** Hierarchical recognition group (issue #9). */
  category: string;
  /** Minimal tag set identifying the feature (empty for review-only). */
  requiredTags: Record<string, string>;
  /** Only applied when confirmed by analysis/review. */
  suggestedTags: Record<string, string>;
  /** Known allowed values for keys whose value cannot be inferred from
   *  the class alone. Offered as a review-time picker. */
  commonValues?: Record<string, string[]>;
  /** Short explanation for reviewers. */
  hint: string;
  /** true — requiredTags may be applied by default (established
   *  convention, reviewed against current tagging practice).
   *  false — review-only: the reviewer must choose/confirm the OSM
   *  semantics before any tags are applied. */
  autoTag: boolean;
  /** How the feature is normally mapped in OSM (geometry policy). */
  geometryPreference: GeometryPreference;
  /** Candidate OSM semantics for review-only classes (optional). */
  mappings?: OsmMapping[];
}

export const FEATURE_CLASSES: FeatureClass[] = [
  // ---- business ----
  {
    id: 'vending_machine',
    label: 'Vending machine',
    category: 'business',
    requiredTags: { amenity: 'vending_machine' },
    suggestedTags: {},
    hint: 'Drink/snack vending machine',
    autoTag: true,
    geometryPreference: 'node'
  },
  // ---- amenities ----
  {
    id: 'toilets',
    label: 'Public toilets',
    category: 'amenities',
    requiredTags: { amenity: 'toilets' },
    suggestedTags: { toilets: 'public' },
    commonValues: { toilets: ['public', 'fee', 'free', 'semi_public'] },
    hint: 'The access type (public/fee/free) must be confirmed, not guessed',
    autoTag: true,
    geometryPreference: 'either'
  },
  // ---- emergency ----
  {
    id: 'aed',
    label: 'AED (defibrillator)',
    category: 'emergency',
    // OSM convention: emergency=defibrillator (NOT amenity=defibrillator).
    // See https://wiki.openstreetmap.org/wiki/Tag:emergency%3Ddefibrillator
    requiredTags: { emergency: 'defibrillator' },
    suggestedTags: {},
    hint: 'Use emergency=defibrillator; the amenity= prefix is wrong for AEDs',
    autoTag: true,
    geometryPreference: 'node'
  },
  {
    id: 'fire_extinguisher',
    label: 'Fire extinguisher',
    category: 'emergency',
    requiredTags: { emergency: 'extinguisher' },
    suggestedTags: {},
    hint: 'Usually mounted on a building wall',
    autoTag: true,
    geometryPreference: 'node'
  },
  {
    id: 'fire_hydrant',
    label: 'Fire hydrant',
    category: 'emergency',
    requiredTags: { emergency: 'fire_hydrant' },
    suggestedTags: {},
    hint: 'Street-side hydrant',
    autoTag: true,
    geometryPreference: 'node'
  },
  {
    id: 'fire_hose',
    label: 'Fire hose',
    category: 'emergency',
    // Documented: https://wiki.openstreetmap.org/wiki/Tag:emergency%3Dfire_hose
    requiredTags: { emergency: 'fire_hose' },
    suggestedTags: {},
    hint: 'Hose cabinet / fire-hose equipment point',
    autoTag: true,
    geometryPreference: 'node'
  },
  // ---- street furniture ----
  {
    id: 'bench',
    label: 'Bench',
    category: 'street_furniture',
    requiredTags: { amenity: 'bench' },
    suggestedTags: {},
    hint: 'Park/street bench',
    autoTag: true,
    geometryPreference: 'node'
  },
  {
    id: 'waste_basket',
    label: 'Waste basket',
    category: 'street_furniture',
    // OSM convention: amenity=waste_basket (not amenity=recycling/bin).
    requiredTags: { amenity: 'waste_basket' },
    suggestedTags: {},
    hint: 'Street trash bin',
    autoTag: true,
    geometryPreference: 'node'
  },
  {
    id: 'drinking_water',
    label: 'Drinking water',
    category: 'street_furniture',
    requiredTags: { amenity: 'drinking_water' },
    suggestedTags: {},
    hint: 'Drinking water station',
    autoTag: true,
    geometryPreference: 'node'
  },
  {
    id: 'information_board',
    label: 'Information board',
    category: 'street_furniture',
    // OSM convention: amenity=information + information=board (a
    // bare amenity=information means an information POINT/office).
    requiredTags: { amenity: 'information', information: 'board' },
    suggestedTags: {},
    hint: 'Physical notice/tourist board; information=board distinguishes it from an info point',
    autoTag: true,
    geometryPreference: 'node'
  },
  {
    id: 'street_lamp',
    label: 'Street lamp',
    category: 'street_furniture',
    // Documented convention: highway=street_lamp for lamp POINTS
    // (rendered as street lights), not a lighting=* guess.
    requiredTags: { highway: 'street_lamp' },
    suggestedTags: {},
    hint: 'Street light; lamp type is not visible from a photo, so nothing is guessed',
    autoTag: true,
    geometryPreference: 'node'
  },
  {
    id: 'manhole',
    label: 'Manhole',
    category: 'street_furniture',
    // OSM convention: man_made=manhole (+ optional manhole=<type>).
    // The utility type cannot be seen from a photo, so it is not guessed.
    requiredTags: { man_made: 'manhole' },
    suggestedTags: {},
    hint: 'Round cover over an underground access point; utility type not visible from a photo',
    autoTag: true,
    geometryPreference: 'node'
  },
  {
    id: 'bollard',
    label: 'Bollard',
    category: 'street_furniture',
    requiredTags: { barrier: 'bollard' },
    suggestedTags: {},
    hint: 'Single bollard as a node; a ROW of bollards is normally a way (draw it in the editor)',
    autoTag: true,
    geometryPreference: 'either'
  },
  {
    id: 'clock',
    label: 'Public clock',
    category: 'street_furniture',
    // Approved proposal: amenity=clock — "a public visible clock" (node).
    requiredTags: { amenity: 'clock' },
    suggestedTags: {},
    hint: 'Standalone public clock (station facade, park, etc.)',
    autoTag: true,
    geometryPreference: 'node'
  },
  // ---- religious ----
  {
    id: 'torii',
    label: 'Torii',
    category: 'religious',
    // Established convention in Japan: historic=torii.
    requiredTags: { historic: 'torii' },
    suggestedTags: {},
    hint: 'Shrine gate',
    autoTag: true,
    geometryPreference: 'node'
  },
  {
    id: 'stone_lantern',
    label: 'Stone lantern',
    category: 'religious',
    // No established convention: both historic=stone_lantern (9 objects
    // worldwide) and man_made=stone_lantern (18) are in use — ambiguous,
    // so this class is review-only with two candidate mappings.
    requiredTags: {},
    suggestedTags: {},
    hint: 'Tagging convention is unsettled (historic= vs man_made=) — choose a mapping or edit the tags',
    autoTag: false,
    geometryPreference: 'node',
    mappings: [
      { label: 'historic=stone_lantern', tags: { historic: 'stone_lantern' } },
      { label: 'man_made=stone_lantern', tags: { man_made: 'stone_lantern' } }
    ]
  },
  {
    id: 'komainu',
    label: 'Komainu (guardian lion-dog)',
    category: 'religious',
    // No established OSM convention exists for komainu (verified against
    // live data) — pure review-only: the reviewer decides the tags.
    requiredTags: {},
    suggestedTags: {},
    hint: 'No established OSM tag — set the tags manually during review',
    autoTag: false,
    geometryPreference: 'node'
  },
  // ---- artwork / memorial ----
  {
    id: 'statue',
    label: 'Statue',
    category: 'artwork_memorial',
    // Genuinely ambiguous: the same statue may legitimately be mapped as
    // an artwork or as a memorial — the reviewer must decide.
    requiredTags: {},
    suggestedTags: {},
    hint: 'Artwork vs memorial is a judgment call — choose a mapping or edit the tags',
    autoTag: false,
    geometryPreference: 'node',
    mappings: [
      {
        label: 'Artwork (tourism=artwork)',
        tags: { tourism: 'artwork', artwork_type: 'statue' },
        hint: 'For statues valued as artworks/sculptures'
      },
      {
        label: 'Memorial (historic=memorial)',
        tags: { historic: 'memorial', memorial: 'statue' },
        hint: 'For statues that commemorate a person/event'
      }
    ]
  },
  // ---- playground ----
  {
    id: 'playground',
    label: 'Playground equipment',
    category: 'playground',
    // The equipment TYPE (slide/swing/...) cannot be assumed, so NO tag
    // value is guessed by default. The type must come from photo
    // analysis or from the reviewer (commonValues picker).
    requiredTags: {},
    suggestedTags: {},
    commonValues: { playground: ['slide', 'swing', 'roundabout', 'sandbox', 'other'] },
    hint: 'Single piece of playground equipment; the type must be confirmed, not guessed',
    autoTag: true,
    geometryPreference: 'node'
  },
  {
    id: 'playground_area',
    label: 'Playground (area)',
    category: 'playground',
    // A playground as a facility is normally an area (leisure=playground).
    // The app must NOT fabricate a polygon from a single photo: this class
    // is export-blocked for new objects — link to an existing object or
    // draw the boundary in an editor.
    requiredTags: { leisure: 'playground' },
    suggestedTags: {},
    hint: 'Playground facility; area-based — the app will not create geometry for it, so link or draw in an editor',
    autoTag: true,
    geometryPreference: 'area'
  },
  // ---- transport ----
  {
    id: 'bicycle_parking',
    label: 'Bicycle parking',
    category: 'transport',
    // amenity=bicycle_parking is established; the subtype (frame/rack/
    // block/...) is only suggested, and the reviewer confirms it.
    // Area-capable: a parking field is normally a way, but a single frame
    // is a node — hence 'either'.
    requiredTags: { amenity: 'bicycle_parking' },
    suggestedTags: { bicycle_parking: 'frame' },
    commonValues: { bicycle_parking: ['frame', 'rack', 'block', 'bay', 'sheltered_bay', 'lockable', 'other'] },
    hint: 'Bike parking; subtype tag only when confirmed',
    autoTag: true,
    geometryPreference: 'either'
  },
  {
    id: 'bicycle_repair_station',
    label: 'Bicycle repair station',
    category: 'transport',
    // Documented: amenity=bicycle_repair_station
    // (https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dbicycle_repair_station)
    requiredTags: { amenity: 'bicycle_repair_station' },
    suggestedTags: {},
    hint: 'Self-service pump/tool station; the exact equipment is not guessed',
    autoTag: true,
    geometryPreference: 'either'
  }
];

const byId = new Map(FEATURE_CLASSES.map((c) => [c.id, c]));

export function getFeatureClass(id: string): FeatureClass | undefined {
  return byId.get(id);
}

/** Default (required) tags for a class. Review-only classes return {} —
 *  their semantics are never applied by default (issue #9). */
export function defaultTagsFor(featureType: string): Record<string, string> {
  const cls = getFeatureClass(featureType);
  return cls ? { ...cls.requiredTags } : {};
}

export function suggestedTagsFor(featureType: string): Record<string, string> {
  const cls = getFeatureClass(featureType);
  return cls ? { ...cls.suggestedTags } : {};
}

export function commonValuesFor(featureType: string): Record<string, string[]> {
  const cls = getFeatureClass(featureType);
  return cls?.commonValues ? { ...cls.commonValues } : {};
}

/** Candidate OSM semantics for a review-only class ([] if none). */
export function mappingsFor(featureType: string): OsmMapping[] {
  return getFeatureClass(featureType)?.mappings ?? [];
}

/** Geometry policy for a class ('node' for unknown types). */
export function geometryPreferenceFor(featureType: string): GeometryPreference {
  return getFeatureClass(featureType)?.geometryPreference ?? 'node';
}

/** Keys whose presence identifies the class — used for OSM duplicate
 *  lookup and scoring. For review-only classes the keys of the candidate
 *  mappings are included, so existing objects using ANY of the plausible
 *  conventions can still be found (issue #9). */
export function definingKeysFor(featureType: string): string[] {
  const cls = getFeatureClass(featureType);
  if (!cls) return [];
  const keys = new Set<string>();
  for (const k of Object.keys(cls.requiredTags)) keys.add(k);
  for (const k of Object.keys(cls.suggestedTags)) keys.add(k);
  if (cls.commonValues) {
    for (const k of Object.keys(cls.commonValues)) keys.add(k);
  }
  if (!cls.autoTag) {
    for (const m of cls.mappings ?? []) {
      for (const k of Object.keys(m.tags)) keys.add(k);
    }
  }
  return [...keys];
}

/** Apply a chosen OSM mapping to a candidate's tag set (issue #9).
 *  Returns a NEW object. Keys belonging to OTHER mappings are removed —
 *  but only when their value still equals that other mapping's value, so
 *  tags set manually by the reviewer are never clobbered. */
export function applyMappingToTags(
  tags: Record<string, string>,
  chosen: OsmMapping,
  all: OsmMapping[]
): Record<string, string> {
  const next = { ...tags };
  const chosenKeys = new Set(Object.keys(chosen.tags));
  for (const [k, v] of Object.entries(chosen.tags)) next[k] = v;
  for (const other of all) {
    if (other === chosen) continue;
    for (const [k, v] of Object.entries(other.tags)) {
      if (chosenKeys.has(k)) continue;
      if (next[k] === v) delete next[k];
    }
  }
  return next;
}

/** Which (if any) of the class's candidate mappings is already reflected
 *  in the candidate's tags — used to preselect the review UI picker. */
export function findChosenMapping(
  featureType: string,
  tags: Record<string, string>
): OsmMapping | null {
  for (const m of mappingsFor(featureType)) {
    const entries = Object.entries(m.tags);
    if (entries.length > 0 && entries.every(([k, v]) => tags[k] === v)) return m;
  }
  return null;
}

/** Merge tag suggestions from multiple observations of the same object
 *  into one tag set. Later, higher-confidence observations take
 *  precedence per key; class defaults fill in keys no observation
 *  suggested. */
export function mergeTags(observations: Observation[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const obs of observations) {
    // Later, higher-confidence observations take precedence for a key.
    for (const [key, value] of Object.entries(obs.tagSuggestions)) {
      if (!(key in merged) || (value && !merged[key])) merged[key] = value;
    }
  }
  // Fill in required class defaults for keys that were never suggested.
  for (const obs of observations) {
    for (const [key, value] of Object.entries(defaultTagsFor(obs.featureType))) {
      if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}
