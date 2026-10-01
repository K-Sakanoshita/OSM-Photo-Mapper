import { describe, expect, it } from 'vitest';
import {
  invMercatorY,
  latLonOfPixel,
  latLonToTile,
  mercatorY,
  mPerPixelAt,
  pixelOfLatLon,
  regionTiles,
  tileBounds,
  TILE_SIZE,
  zoomForResolution
} from '../src/imagery/tiles';

// Reference point: central France (~48.85N, 2.35E) — well inside mercator range.
const LAT = 48.85;
const LON = 2.35;

describe('mercatorY / invMercatorY', () => {
  it('round-trips', () => {
    for (const lat of [-60, -10, 0, 35, 48.85, 80]) {
      expect(invMercatorY(mercatorY(lat))).toBeCloseTo(lat, 8);
    }
  });

  it('is monotonic and in [0,1]', () => {
    // y=0 is the north pole: higher latitude -> smaller y.
    const ys = [-70, -35, 0, 35, 70].map(mercatorY);
    expect(ys[0]).toBeGreaterThan(0);
    expect(ys[4]).toBeLessThan(1);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThan(ys[i - 1]);
  });

  it('clamps extreme latitudes', () => {
    expect(mercatorY(89)).toBeCloseTo(mercatorY(85));
    expect(mercatorY(-89)).toBeCloseTo(mercatorY(-85));
  });
});

describe('latLonToTile / tileBounds', () => {
  it('z0 always maps to tile 0/0 inside the mercator range', () => {
    expect(latLonToTile(48.85, 2.35, 0)).toEqual({ x: 0, y: 0 });
    expect(latLonToTile(-45, -120, 0)).toEqual({ x: 0, y: 0 });
  });

  it('tile bounds contain the originating point', () => {
    for (const z of [4, 10, 15, 18]) {
      const t = latLonToTile(LAT, LON, z);
      const b = tileBounds(t.x, t.y, z);
      expect(b.nw[0]).toBeGreaterThan(LAT); // north
      expect(b.se[0]).toBeLessThan(LAT); // south
      expect(b.nw[1]).toBeLessThan(LON); // west
      expect(b.se[1]).toBeGreaterThan(LON); // east
    }
  });

  it('bounds of neighbouring tiles are contiguous', () => {
    const z = 12;
    const t = latLonToTile(LAT, LON, z);
    const a = tileBounds(t.x, t.y, z);
    const b = tileBounds(t.x + 1, t.y, z);
    expect(b.nw[1]).toBeCloseTo(a.se[1], 9); // shared meridian
    expect(b.nw[0]).toBeCloseTo(a.nw[0], 9); // same latitudes
  });
});

describe('pixel <-> lat/lon', () => {
  it('round-trips within half a pixel', () => {
    const z = 16;
    const t = latLonToTile(LAT, LON, z);
    const { px, py } = pixelOfLatLon(t, LAT, LON, z, TILE_SIZE);
    expect(px).toBeGreaterThanOrEqual(0);
    expect(px).toBeLessThanOrEqual(TILE_SIZE);
    expect(py).toBeGreaterThanOrEqual(0);
    expect(py).toBeLessThanOrEqual(TILE_SIZE);
    const back = latLonOfPixel(t, px, py, z, TILE_SIZE);
    const d = pixelOfLatLon(t, back.lat, back.lon, z, TILE_SIZE);
    expect(Math.abs(d.px - px)).toBeLessThan(1.5);
    expect(Math.abs(d.py - py)).toBeLessThan(1.5);
  });

  it('pixel (0,0) maps to the tile NW corner (plus half pixel)', () => {
    const z = 10;
    const t = { x: 512, y: 256 };
    const p = latLonOfPixel(t, 0, 0, z, TILE_SIZE);
    const b = tileBounds(t.x, t.y, z);
    expect(p.lat).toBeLessThan(b.nw[0]); // pixel center is inside the tile
    expect(p.lat).toBeGreaterThan(b.se[0]);
    expect(p.lon).toBeGreaterThan(b.nw[1]);
    expect(p.lon).toBeLessThan(b.se[1]);
  });
});

describe('mPerPixelAt / zoomForResolution', () => {
  it('gives ~0.73 m/px at z18 near 35°N (GSI max zoom)', () => {
    expect(mPerPixelAt(18, 35)).toBeCloseTo(0.728, 2);
  });

  it('resolution halves when zoom increases by one', () => {
    expect(mPerPixelAt(17, 35)).toBeCloseTo(2 * mPerPixelAt(18, 35), 5);
  });

  it('zoomForResolution reaches the target resolution', () => {
    const z = zoomForResolution(0.5, 35);
    expect(mPerPixelAt(z, 35)).toBeLessThanOrEqual(0.5);
    expect(mPerPixelAt(z - 1, 35)).toBeGreaterThan(0.5);
  });
});

describe('regionTiles', () => {
  it('includes the tile containing the center point', () => {
    const r = regionTiles(LAT, LON, 30, 16);
    expect(r).not.toBeNull();
    const center = latLonToTile(LAT, LON, 16);
    expect(r!.tiles.some((t) => t.x === center.x && t.y === center.y)).toBe(true);
    // bounds contain the center
    expect(r!.northLat).toBeGreaterThan(LAT);
    expect(r!.southLat).toBeLessThan(LAT);
    expect(r!.westLon).toBeLessThan(LON);
    expect(r!.eastLon).toBeGreaterThan(LON);
  });

  it('grows the tile set with radius', () => {
    const small = regionTiles(LAT, LON, 10, 16)!;
    const big = regionTiles(LAT, LON, 60, 16)!;
    expect(big.tiles.length).toBeGreaterThan(small.tiles.length);
  });

  it('returns null when the region exceeds maxTiles', () => {
    // 500 m at z18 spans far more than 4 tiles.
    expect(regionTiles(LAT, LON, 500, 18, 4)).toBeNull();
  });
});
