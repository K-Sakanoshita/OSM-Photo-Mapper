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

/** Where a photo's capture timestamp came from (quality marker). */
export type TimestampSource = 'exif' | 'file' | 'selected';

/** A captured photo associated with the nearest GPS context. */
export interface Photo {
  id: string;
  surveyId: string;
  /** Epoch milliseconds of capture. */
  timestamp: number;
  /** Provenance of `timestamp`: EXIF capture time, file metadata, or the
   *  post-selection fallback. Used to flag low-quality associations. */
  timestampSource?: TimestampSource;
  /** JPEG image data (base64) or a pointer; kept out of the index for MVP. */
  image?: string;
  /** Track sample (or interpolation between samples) at capture time. */
  gps?: GpsSample;
  /** Camera heading at capture, degrees (when available). */
  heading?: number;
  /** Provenance of `heading`: interpolated from the GPS track at capture
   *  time ('track') or the device compass at file-picker return ('device',
   *  a weaker fallback that can lag the true capture moment). */
  headingSource?: 'track' | 'device';
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

/**
 * OSM object type. Node, way and relation IDs are independent namespaces,
 * so a linked object is always identified by type + ID together (issue #4).
 */
export type OsmType = 'node' | 'way' | 'relation';

/** A nearby existing OSM object relevant to a candidate. */
export interface OsmMatch {
  osmType: OsmType;
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
/** One provenance entry for a position solution (issue #8). */
export interface PositionEvidence {
  source: 'gps-track' | 'ray-projection' | 'aerial-structure' | 'osm-object';
  label: string;
  detail?: string;
}

/**
 * Full provenance chain for a candidate's position (issue #8):
 * ground-survey estimate -> bounded aerial refinement -> conditional OSM snap.
 * The raw estimate is never discarded.
 */
export interface PositionSolution {
  estimatedPosition: { lat: number; lon: number };
  /** Bounded imagery-based correction (a few meters at most). */
  refinedPosition?: { lat: number; lon: number };
  /** OSM object position; set only when the snap is strong and unique. */
  snappedPosition?: { lat: number; lon: number };
  linkedOsmId?: number;
  /** Type of the linked OSM object (issue #4: identity is type + ID). */
  linkedOsmType?: OsmType;
  /** Position uncertainty in meters (drives refinement/snap bounds). */
  uncertaintyMeters: number;
  evidence: PositionEvidence[];
  snapConfidence?: number;
}

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
  /** Type of the linked OSM object (issue #4: identity is type + ID). */
  linkedOsmType?: OsmType;
  /** Provenance chain for the position (issue #8); provenance only —
   *  `lat`/`lon` remain the working position used for display/export. */
  positionSolution?: PositionSolution;
}

/**
 * Survey row stored in the `surveys` IndexedDB store.
 *
 * Deliberately metadata-only: GPS samples, photos, observations and
 * candidates live in their own normalized child stores, so the survey row
 * never carries (duplicates) image payloads or stale child arrays.
 */
export interface SurveyMeta {
  id: string;
  name: string;
  createdAt: number;
  /** Whether the GPS track is being actively recorded (session flag). */
  recording: boolean;
}

/** A top-level walking survey session (in-memory view, reconstructed on load). */
export interface Survey extends SurveyMeta {
  /** Continuous GPS track recorded during the session. */
  gpsSamples: GpsSample[];
  photos: Photo[];
  candidates: FeatureCandidate[];
}

/** The result of running the analysis pipeline on a survey. */
export interface AnalysisResult {
  observations: Observation[];
  candidates: FeatureCandidate[];
}
