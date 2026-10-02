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
  /** Reported horizontal accuracy in meters (>= 0). Absent when the
   *  provider did not report one (e.g. EXIF GPS). */
  accuracy?: number;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Ground speed, m/s (when available). */
  speed?: number;
  /** Device heading, degrees from true/magnetic north (when available). */
  heading?: number;
}

/** Where a photo's capture timestamp came from (quality marker). */
export type TimestampSource = 'exif' | 'file' | 'selected';

/** Provenance of a photo's camera position (issue #10). */
export type CameraPositionSource = 'track' | 'capture-fix' | 'exif';

/**
 * Where the CAMERA was when the photo was taken (issue #10). This is
 * evidence for locating the photographed object — never the object's own
 * coordinates. `source` records how the position was obtained, and
 * `accuracy`/`ageMs` are quality/freshness evidence the reviewer can see.
 */
export interface CameraPosition {
  lat: number;
  lon: number;
  /** Reported horizontal accuracy in meters, when known. */
  accuracy?: number;
  /** Capture time (epoch ms) — the moment the position refers to. */
  timestamp: number;
  /** Time of the underlying fix/sample (epoch ms). */
  fixTimestamp: number;
  /** |capture − fix| in ms: how stale the position is relative to capture. */
  ageMs: number;
  source: CameraPositionSource;
  /** True when interpolated between two track samples. */
  interpolated?: boolean;
  /** True when the capture time lies inside the recorded track span. */
  inSpan?: boolean;
}

/**
 * A captured photo associated with its camera position.
 * Issue #6: timestamp is the capture time from EXIF/file metadata, and the
 * position context is the position at that moment (not the newest sample
 * at selection time).
 * Issue #10: that position is the CAMERA position at capture time, kept
 * independently of continuous Record mode and tagged with its provenance
 * in `cameraPosition`. `gps` is a compatibility alias for downstream
 * consumers (map markers, ray estimation, position evidence).
 */
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
  /** Camera position at capture time, with provenance (issue #10). */
  cameraPosition?: CameraPosition;
  /** Compatibility alias of `cameraPosition` (old shape) for consumers. */
  gps?: GpsSample;
  /** Camera heading at capture, degrees (when available). */
  heading?: number;
  /** Where the capture heading came from, with orientation quality
   *  (issue #3 blocker 1): 'track' (heading interpolated from the GPS
   *  track at capture time) or a device-orientation quality marker from
   *  the OrientationTracker ('compass' / 'absolute-alpha' /
   *  'approximate' — the weaker fallback used only when the track has no
   *  heading). The marker drives the estimator's bearing uncertainty. */
  headingSource?: 'track' | 'compass' | 'absolute-alpha' | 'approximate';
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
  /** Uncertainty of the distance estimate, meters (issue #3 blocker 3).
   *  When absent the estimator assumes a conservative default. */
  distanceUncertaintyM?: number;
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
  /** Bounded imagery-based correction (a few meters at most). A
   *  reviewable PROPOSAL — applied by default but explicit and reversible
   *  (issue #8): the ground-survey estimate is never discarded. */
  refinedPosition?: { lat: number; lon: number };
  /** Whether the refined position is the current working position
   *  (true after analysis applies it; false after the reviewer reverts
   *  to the ground estimate). */
  refinementApplied?: boolean;
  /** Imagery source attribution, shown in review whenever aerial imagery
   *  contributed (issue #8). */
  imagerySource?: string;
  /** OSM object position; set only when the snap is strong and unique. */
  snappedPosition?: { lat: number; lon: number };
  linkedOsmId?: number;
  /** Type of the linked OSM object (issue #4: identity is type + ID). */
  linkedOsmType?: OsmType;
  /** Position uncertainty in meters (drives refinement/snap bounds).
   *  Evidence-derived (issue #3), not a function of confidence alone. */
  uncertaintyMeters: number;
  /** Evidence-derived quality classification (issue #3). */
  positionQuality?: PositionQuality;
  evidence: PositionEvidence[];
  snapConfidence?: number;
}

/**
 * Quality classification of a position estimate (issue #3 acceptance):
 * reviewers must be able to tell strong triangulation from a single-ray
 * projection, weak/parallel geometry, missing orientation, and
 * contradictory observations.
 */
export type PositionQuality =
  | 'triangulated' // >=2 usable rays, good crossing geometry, low fit error
  | 'single-ray' // projection along one bearing (distance-dominated)
  | 'weak-geometry' // rays nearly parallel or baseline too short
  | 'contradictory' // rays or distances strongly disagree
  | 'no-orientation'; // no usable heading: GPS location only

/** Human-readable label for a position quality (review UI). */
export const POSITION_QUALITY_LABEL: Record<PositionQuality, string> = {
  triangulated: 'Triangulated (multi-observation)',
  'single-ray': 'Single-ray projection',
  'weak-geometry': 'Weak geometry (nearly parallel rays)',
  contradictory: 'Contradictory observations',
  'no-orientation': 'No orientation (GPS only)',
};

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
  /** Quality classification of the position estimate (issue #3). */
  positionQuality?: PositionQuality;
  /** Evidence-derived 1-sigma position uncertainty, meters (issue #3). */
  positionUncertaintyMeters?: number;
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
