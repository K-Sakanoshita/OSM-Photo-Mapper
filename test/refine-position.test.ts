/**
 * refinePosition integration: resolution pre-check + imagery provenance.
 * stitchRegion is mocked (it needs canvas + network, unavailable in Node);
 * the pure parts (pre-check, attribution carry-through, evidence gate) are
 * exercised here.
 */
import { describe, expect, it, vi } from 'vitest';
import { PixelGrid, type PixelGridData } from '../src/imagery/region';
import type { TileProvider, TileSource } from '../src/imagery/providers';

const { mockStitch } = vi.hoisted(() => ({ mockStitch: vi.fn() }));

vi.mock('../src/imagery/region', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/imagery/region')>();
  return {
    ...actual,
    stitchRegion: mockStitch
  };
});

import { refinePosition } from '../src/analysis/structural-refine';

const NORTH = 35.705;
const WEST = 139.7;
const MPP = 0.7; // z18-class ground resolution
const SIZE = 64;

/** Boundary scene: sharp vertical edge at x=32 (10 px east of the start). */
function edgeGrid(): PixelGrid {
  const luma = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) luma[y * SIZE + x] = x < 32 ? 200 : 60;
  }
  const dLat = (SIZE * MPP) / 111320;
  const dLon = (SIZE * MPP) / (111320 * Math.cos((NORTH * Math.PI) / 180));
  const data: PixelGridData = {
    width: SIZE,
    height: SIZE,
    northLat: NORTH,
    southLat: NORTH - dLat,
    westLon: WEST,
    eastLon: WEST + dLon,
    mPerPixel: MPP,
    luma
  };
  return new PixelGrid(data);
}

function provider(maxZoom: number, id = 'ortho-test', attribution = 'Test Ortho (c) 2026'): TileProvider {
  const source: TileSource = {
    id,
    maxZoom,
    covers: () => true,
    tileUrl: () => 'https://example.invalid/tile.jpg',
    attribution
  };
  return { source, fetchTile: async () => null };
}

describe('refinePosition resolution pre-check', () => {
  it('refuses coarse providers BEFORE stitching (no tile traffic)', async () => {
    mockStitch.mockReset();
    mockStitch.mockResolvedValue(null);
    const coarse = provider(15); // z15 -> ~190 m/px, far above the gate
    const res = await refinePosition(coarse, 'vending_machine', 35.704, 139.701, 10);
    expect(res).toBeNull();
    expect(mockStitch).not.toHaveBeenCalled();
  });

  it('lets z18-class providers (0.7–0.86 m/px at Japan latitudes) proceed to stitching', async () => {
    mockStitch.mockReset();
    mockStitch.mockResolvedValue(null); // tiles unavailable -> graceful null
    const z18 = provider(18);
    const res = await refinePosition(z18, 'vending_machine', 35.704, 139.701, 10);
    expect(res).toBeNull();
    expect(mockStitch).toHaveBeenCalledTimes(1);
  });

  it('refines with a z18-class grid and degrades to null on coarse output', async () => {
    mockStitch.mockReset();
    // First: the stitched grid comes back at 0.7 m/px -> refinement works.
    const start = edgeGrid().pixelCenter(22, 32)!;
    mockStitch.mockResolvedValueOnce(edgeGrid());
    const ok = await refinePosition(provider(18), 'vending_machine', start.lat, start.lon, 10);
    expect(ok).not.toBeNull();
    expect(ok!.deltaM).toBeLessThanOrEqual(10 + 1e-6);

    // Then: a zoom fallback produced a coarse grid (1.5 m/px) -> the
    // evidence gate refuses it even though stitching "succeeded".
    mockStitch.mockResolvedValueOnce(coarseGrid());
    const rejected = await refinePosition(provider(18), 'vending_machine', start.lat, start.lon, 10);
    expect(rejected).toBeNull();
    expect(mockStitch).toHaveBeenCalledTimes(2);
  });
});

/** Same boundary scene at 1.5 m/px (z17-class). */
function coarseGrid(): PixelGrid {
  const mpp = 1.5;
  const luma = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) luma[y * SIZE + x] = x < 32 ? 200 : 60;
  }
  const dLat = (SIZE * mpp) / 111320;
  const dLon = (SIZE * mpp) / (111320 * Math.cos((NORTH * Math.PI) / 180));
  const data: PixelGridData = {
    width: SIZE,
    height: SIZE,
    northLat: NORTH,
    southLat: NORTH - dLat,
    westLon: WEST,
    eastLon: WEST + dLon,
    mPerPixel: mpp,
    luma
  };
  return new PixelGrid(data);
}

describe('refinePosition imagery provenance', () => {
  it('carries the imagery source id and attribution into the result', async () => {
    mockStitch.mockReset();
    mockStitch.mockResolvedValue(edgeGrid());
    const start = edgeGrid().pixelCenter(22, 32)!;
    const p = provider(18, 'ortho-tokyo-2025', '© 東京都 正射画像 2025');
    const res = await refinePosition(p, 'vending_machine', start.lat, start.lon, 10);
    expect(res).not.toBeNull();
    expect(res!.sourceId).toBe('ortho-tokyo-2025');
    expect(res!.attribution).toBe('© 東京都 正射画像 2025');
    // The refinement evidence is unchanged by the provenance fields.
    expect(res!.evidence.source).toBe('aerial-structure');
  });
});
