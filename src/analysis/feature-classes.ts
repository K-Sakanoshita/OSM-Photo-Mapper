import type { Observation } from '../types';

/**
 * MVP feature classes.
 *
 * Tag presets follow current OSM tagging conventions for visually
 * identifiable, node-oriented POIs, and live in one place (not scattered
 * through the UI) so conventions stay consistent and reviewable.
 *
 * Schema (issue #5): required primary tags vs. optional inferred attributes.
 *  - requiredTags: the tags that define the feature; always applied by
 *    default. A node carrying these is a valid instance of the class.
 *  - suggestedTags: optional subtype/detail attributes with a concrete
 *    inferred value. NEVER applied by default — surfaced as suggestions in
 *    the review UI and only added when analysis or the reviewer confirms
 *    them from the photo. (E.g. `bicycle_parking=frame` is a detail tag; the
 *    primary tag is `amenity=bicycle_parking`.)
 *  - commonValues: known-allowed values for a tag whose value CANNOT be
 *    inferred from the class alone (e.g. `playground=<type>`). Offered in
 *    the review UI as a value picker; never applied by default and never
 *    guessed. They also make the key searchable/score-able in OSM lookups.
 */
export interface FeatureClass {
  id: string;
  label: string;
  /** Primary tags that define the feature (always applied by default). */
  requiredTags: Record<string, string>;
  /** Optional detail attributes (suggested only; reviewer/analysis confirms). */
  suggestedTags: Record<string, string>;
  /** Tag keys with a set of known-allowed values, none of which may be
   *  guessed (review-time value picker only). */
  commonValues?: Record<string, string[]>;
  /** Short human description of what to look for. */
  hint: string;
}

export const FEATURE_CLASSES: FeatureClass[] = [
  {
    id: 'bench',
    label: 'Bench',
    requiredTags: { amenity: 'bench' },
    suggestedTags: {},
    hint: 'Outdoor seating.',
  },
  {
    id: 'vending_machine',
    label: 'Vending machine',
    requiredTags: { amenity: 'vending_machine' },
    suggestedTags: {},
    hint: 'Vending machine; add vending=<type> in review when the product type is visible.',
  },
  {
    id: 'playground',
    label: 'Playground equipment',
    // An individual piece of equipment is a node tagged playground=<type>;
    // leisure=playground marks the playground AREA (way/area), not the
    // equipment. The equipment type cannot be guessed: it must come from
    // analysis or the reviewer, who picks from the known-allowed values.
    requiredTags: {},
    suggestedTags: {},
    commonValues: {
      playground: [
        'slide', 'swing', 'roundabout', 'spring_loader', 'climbing_frame',
        'sandbox', 'other'
      ]
    },
    hint: 'A single piece of playground equipment (node). Set playground=<type> from the photo.',
  },
  {
    id: 'information_board',
    label: 'Information board',
    requiredTags: { tourism: 'information' },
    suggestedTags: { information: 'board' },
    hint: 'Physical information board or map display (information=board|map).',
  },
  {
    id: 'drinking_water',
    label: 'Drinking water',
    requiredTags: { amenity: 'drinking_water' },
    suggestedTags: {},
    hint: 'Drinking water fountain.',
  },
  {
    id: 'toilets',
    label: 'Toilets',
    requiredTags: { amenity: 'toilets' },
    suggestedTags: {},
    hint: 'Public toilet facility.',
  },
  {
    id: 'aed',
    label: 'AED',
    // OSM convention: AEDs are tagged emergency=defibrillator
    // (amenity=defibrillator is a deprecated/incorrect variant).
    requiredTags: { emergency: 'defibrillator' },
    suggestedTags: {},
    hint: 'Automated external defibrillator.',
  },
  {
    id: 'bicycle_parking',
    label: 'Bicycle parking',
    // Primary tag is amenity=bicycle_parking; bicycle_parking=<type> is a
    // subtype/detail tag and is only suggested, never applied blindly.
    requiredTags: { amenity: 'bicycle_parking' },
    suggestedTags: { bicycle_parking: 'frame' },
    hint: 'Bicycle parking frame/stand (node).',
  },
  {
    id: 'waste_basket',
    label: 'Waste basket',
    // amenity=waste_basket is a pedestrian waste bin. amenity=recycling is a
    // recycling facility/container — a different feature, not a default here.
    requiredTags: { amenity: 'waste_basket' },
    suggestedTags: {},
    hint: 'Waste bin (node).',
  },
];

export function getFeatureClass(id: string): FeatureClass | undefined {
  return FEATURE_CLASSES.find((f) => f.id === id);
}

/** Required primary tags for a feature class (applied as defaults). */
export function defaultTagsFor(featureType: string): Record<string, string> {
  const cls = getFeatureClass(featureType);
  return cls ? { ...cls.requiredTags } : {};
}

/** Suggested optional attributes for a feature class (review-time only). */
export function suggestedTagsFor(featureType: string): Record<string, string> {
  const cls = getFeatureClass(featureType);
  return cls ? { ...cls.suggestedTags } : {};
}

/** Known-allowed values per tag for a feature class (value picker, review-time). */
export function commonValuesFor(featureType: string): Record<string, string[]> {
  const cls = getFeatureClass(featureType);
  return cls?.commonValues ? { ...cls.commonValues } : {};
}

/** All tag keys that identify/search for a class: required + suggested + common. */
export function definingKeysFor(featureType: string): string[] {
  const cls = getFeatureClass(featureType);
  if (!cls) return [];
  return [...new Set([
    ...Object.keys(cls.requiredTags),
    ...Object.keys(cls.suggestedTags),
    ...Object.keys(cls.commonValues ?? {})
  ])];
}

/** Merge tag suggestions from several observations of the same object. */
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
