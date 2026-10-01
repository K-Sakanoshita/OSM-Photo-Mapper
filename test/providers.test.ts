import { describe, expect, it } from 'vitest';
import {
  gsiProvider,
  selectProvider,
  type TileProvider,
  type TileSource
} from '../src/imagery/providers';
import { refinePosition } from '../src/analysis/structural-refine';

function fakeSource(id: string, covers: (lat: number, lon: number) => boolean, maxZoom: number): TileSource {
  return {
    id,
    maxZoom,
    covers,
    tileUrl: () => 'https://example.invalid/tile.jpg',
    attribution: `${id} (test source)`
  };
}

describe('selectProvider', () => {
  it('prefers the first (high-res) provider that covers the point', () => {
    const hiRes: TileProvider = {
      source: fakeSource('ortho-municipal', () => true, 20),
      fetchTile: async () => null
    };
    expect(selectProvider(35.7, 139.7, [hiRes, gsiProvider])).toBe(hiRes);
  });

  it('falls back to GSI when the high-res provider has no coverage', () => {
    const hiRes: TileProvider = {
      source: fakeSource('ortho-municipal', () => false, 20),
      fetchTile: async () => null
    };
    expect(selectProvider(35.7, 139.7, [hiRes, gsiProvider])).toBe(gsiProvider);
  });

  it('returns null when no provider covers the point', () => {
    const hiRes: TileProvider = {
      source: fakeSource('ortho-municipal', () => false, 20),
      fetchTile: async () => null
    };
    expect(selectProvider(35.7, 139.7, [hiRes])).toBeNull();
  });

  it('defaults to the built-in stack (GSI nationwide fallback)', () => {
    // GSI nominally covers Japan, so the default stack always resolves.
    expect(selectProvider(35.68, 139.76)).toBe(gsiProvider);
    expect(selectProvider(43.06, 141.35)).toBe(gsiProvider);
  });

  it('uses a regional coverage test, not just a constant', () => {
    // E.g. a municipal ortho layer that only covers one city.
    const tokyo: TileProvider = {
      source: fakeSource(
        'ortho-tokyo',
        (lat, lon) => lat > 35.5 && lat < 35.9 && lon > 139.5 && lon < 139.9,
        20
      ),
      fetchTile: async () => null
    };
    expect(selectProvider(35.68, 139.76, [tokyo, gsiProvider])).toBe(tokyo);
    expect(selectProvider(34.7, 135.2, [tokyo, gsiProvider])).toBe(gsiProvider);
  });
});

describe('refinePosition without a provider', () => {
  it('returns null immediately when no provider covers the point', async () => {
    expect(await refinePosition(null, 'bench', 35.7, 139.7, 10)).toBeNull();
  });
});
