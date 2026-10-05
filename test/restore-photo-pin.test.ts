import { expect, it } from 'vitest';
import { buildCandidate } from '../src/analysis/pipeline';
import type { Survey, Observation } from '../src/types';
it('rebuilds a deleted photo detection without GPS for manual map placement', () => {
  const survey = { id: 's', photos: [{ id: 'p', surveyId: 's', timestamp: 0 }], candidates: [] } as unknown as Survey;
  const observation = { id: 'obs', surveyId: 's', photoId: 'p', featureType: 'playground', tagConfidence: 0.9,
    tagSuggestions: { playground: 'swing' }, bbox: { x: 0, y: 0, w: 1, h: 1 } } as Observation;
  const candidate = buildCandidate(survey, observation.featureType, [observation]);
  expect(candidate.observationIds).toEqual(['obs']);
  expect(candidate.tags).toEqual({ playground: 'swing' });
  expect(candidate.lat).toBeUndefined();
  expect(candidate.warnings.join(' ')).toContain('Place its pin on the map');
});
