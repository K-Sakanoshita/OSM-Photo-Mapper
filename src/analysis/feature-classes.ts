import type { Observation } from '../types';

/**
 * MVP feature classes.
 *
 * Tag presets are based on current OSM tagging conventions for visually
 * identifiable, node-oriented POIs. These live in one place (not scattered
 * through the UI) so conventions stay consistent and reviewable.
 */
export interface FeatureClass {
  id: string;
  label: string;
  /** Default OSM tags applied when nothing better is known. */
  baseTags: Record<string, string>;
  /** Short human description of what to look for. */
  hint: string;
}

export const FEATURE_CLASSES: FeatureClass[] = [
  {
    id: 'bench',
    label: 'Bench',
    baseTags: { amenity: 'bench' },
    hint: 'Outdoor seating.',
  },
  {
    id: 'vending_machine',
    label: 'Vending machine',
    baseTags: { amenity: 'vending_machine' },
    hint: 'Vending machine; add vending=* for product type.',
  },
  {
    id: 'playground',
    label: 'Playground equipment',
    baseTags: { leisure: 'playground', playground: 'slide' },
    hint: 'A single piece of playground equipment (node).',
  },
  {
    id: 'information_board',
    label: 'Information board',
    baseTags: { tourism: 'information', information: 'board' },
    hint: 'Physical information board or map display.',
  },
  {
    id: 'drinking_water',
    label: 'Drinking water',
    baseTags: { amenity: 'drinking_water' },
    hint: 'Drinking water fountain.',
  },
  {
    id: 'toilets',
    label: 'Toilets',
    baseTags: { amenity: 'toilets' },
    hint: 'Public toilet facility.',
  },
  {
    id: 'aed',
    label: 'AED',
    baseTags: { amenity: 'defibrillator' },
    hint: 'Automated external defibrillator.',
  },
  {
    id: 'bicycle_parking',
    label: 'Bicycle parking',
    baseTags: { bicycle_parking: 'frame' },
    hint: 'Bicycle parking frame/stand (node).',
  },
  {
    id: 'waste_basket',
    label: 'Waste basket',
    baseTags: { amenity: 'recycling' },
    hint: 'Waste/recycling bin (node).',
  },
];

export function getFeatureClass(id: string): FeatureClass | undefined {
  return FEATURE_CLASSES.find((f) => f.id === id);
}

export function defaultTagsFor(featureType: string): Record<string, string> {
  const cls = getFeatureClass(featureType);
  return cls ? { ...cls.baseTags } : {};
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
  // Fill in class defaults for keys that were never suggested.
  for (const obs of observations) {
    for (const [key, value] of Object.entries(defaultTagsFor(obs.featureType))) {
      if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}
