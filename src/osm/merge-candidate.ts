import type { FeatureCandidate, OsmMatch } from '../types';

/** Reviewer's explicit drag onto an existing object selects that ID and
 * keeps existing tags, with reviewed candidate values taking precedence. */
export function mergeCandidateWithOsm(candidate: FeatureCandidate, match: OsmMatch): void {
  candidate.linkedOsmId = match.osmId;
  candidate.linkedOsmType = match.osmType;
  candidate.status = 'existing';
  candidate.lat = match.lat;
  candidate.lon = match.lon;
  candidate.tags = { ...match.tags, ...candidate.tags };
  candidate.osmMatches = [match];
}
