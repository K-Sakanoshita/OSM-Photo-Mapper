/**
 * Core data model for OSM Photo Mapper.
 *
 * Intentionally NOT `Photo -> Pin`. The chain is:
 *   Survey -> Photos -> Observations -> Feature candidates -> OSM edit candidates
 * A photo may contain several observations, and several photos may describe the
 * same real-world feature.
 */

/** A continuous GPS position sample recorded during a survey. */
export interface GpsSample {
  id: string;
  /** WGS84 latitude, degrees. */
  lat: number;
  /** WGS84 longitude, degrees. */
  lon: number;
  /** Reported horizontal accuracy, meters (>= 0). */
  accuracy: number;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Ground speed, m/s (when available). */
  speed?: number;
  /** Device heading, degrees from true/magnetic north (when available). */
  heading?: number;
}

/** A captured photo associated with the nearest GPS context. */
export interface Photo {
  id: string;
  surveyId: string;
  /** Epoch milliseconds of capture. */
  timestamp: number;
  /** JPEG image data (base64) or a pointer; kept out of the index for MVP. */
  image?: string;
  /** Nearest GPS sample at capture time. */
  gps?: GpsSample;
  /** Camera/device heading at capture, degrees (when available). */
  heading?: number;
  /** Free-form field note. */
  note?: string;
}

/** Normalized bounding box within the image, 0..1 relative to width/height. */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One detected feature instance within a single photo. */
export interface Observation {
  id: string;
  photoId: string;
  surveyId: string;
  /** Detected feature class id (see feature-classes). */
  featureType: string;
  /** Where in the image the object appears (0..1 normalized). */
  bbox: BBox;
  /** Rough estimated distance to the object, meters (weak signal). */
  distanceEstimate?: number;
  /** Text visible in/around the object, if useful. */
  textSeen?: string;
  /** Suggested OSM tag key/value pairs. */
  tagSuggestions: Record<string, string>;
  /** 0..1 confidence in the detection/tags. */
  tagConfidence: number;
}

/** A nearby existing OSM object relevant to a candidate. */
export interface OsmMatch {
  osmType: 'node' | 'way' | 'relation';
  osmId: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
  /** 0..1 how plausibly this object matches the observation. */
  matchScore: number;
}

/** Review disposition of a candidate. */
export type CandidateStatus = 'new' | 'existing' | 'excluded';

/** A merged, reviewable map feature derived from one or more observations. */
export interface FeatureCandidate {
  id: string;
  surveyId: string;
  featureType: string;
  /** Estimated position (set once analysis runs; draggable in review). */
  lat?: number;
  lon?: number;
  /** 0..1 confidence in the estimated position (separate from tags). */
  positionConfidence: number;
  /** 0..1 confidence in the tags (separate from position). */
  tagConfidence: number;
  /** Merged suggested tags. */
  tags: Record<string, string>;
  /** The observations that produced this candidate. */
  observationIds: string[];
  /** Nearby existing OSM objects considered during analysis. */
  osmMatches: OsmMatch[];
  /** Human-readable review flags / warnings. */
  warnings: string[];
  /** Reviewer-chosen disposition. */
  status: CandidateStatus;
  /** Name entered/corrected by the reviewer. */
  name?: string;
  /** OSM id the reviewer linked this candidate to (for 'existing'). */
  linkedOsmId?: number;
}

/** A top-level walking survey session. */
export interface Survey {
  id: string;
  name: string;
  createdAt: number;
  /** Continuous GPS track recorded during the session. */
  gpsSamples: GpsSample[];
  photos: Photo[];
  candidates: FeatureCandidate[];
  /** Whether the GPS track is being actively recorded. */
  recording: boolean;
}

/** The result of running the analysis pipeline on a survey. */
export interface AnalysisResult {
  observations: Observation[];
  candidates: FeatureCandidate[];
}
