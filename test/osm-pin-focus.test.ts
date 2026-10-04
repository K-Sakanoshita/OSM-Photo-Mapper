import { describe, expect, it, vi } from 'vitest';
import { MapView } from '../src/map/map-view';
import type { FeatureCandidate } from '../src/types';

function marker(id: string) {
  const element = { dataset: { osmId: id, candidateIds: '[]' }, style: { outline: '' },
    classList: { toggle: vi.fn() } };
  let open = false;
  const popup = { remove: vi.fn(() => { open = false; }), isOpen: () => open };
  return { getElement: () => element, getPopup: () => popup,
    togglePopup: vi.fn(() => { open = true; }) };
}

describe('show nearby OSM pin', () => {
  it('highlights the exact object, opens its popup and switches focus on the next request', () => {
    const node = marker('node/1');
    const way = marker('way/1');
    const flyTo = vi.fn();
    const view = Object.assign(Object.create(MapView.prototype), {
      map: { getSource: () => undefined, flyTo },
      osmMarkers: [node, way], selectedCandidateId: null, focusedOsmId: null,
      candidateData: { type: 'FeatureCollection', features: [] }
    }) as MapView;
    const match = { osmId: 1, osmType: 'node', lat: 34, lon: 135 } as FeatureCandidate['osmMatches'][number];
    view.showOsmMatch(match);
    expect(node.getElement().style.outline).toBe('4px solid #ffca28');
    expect(way.getElement().style.outline).toBe('');
    expect(node.getPopup().isOpen()).toBe(true);
    expect(flyTo).toHaveBeenCalledWith({ center: [135, 34], zoom: 19 });
    view.showOsmMatch({ ...match, osmType: 'way' });
    expect(node.getElement().style.outline).toBe('');
    expect(node.getPopup().isOpen()).toBe(false);
    expect(way.getElement().style.outline).toBe('4px solid #ffca28');
    expect(way.getPopup().isOpen()).toBe(true);
    expect(way.getElement().classList.toggle).toHaveBeenLastCalledWith('osm-pin-focused', true);
  });
});
