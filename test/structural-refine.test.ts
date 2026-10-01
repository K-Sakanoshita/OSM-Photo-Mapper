import { describe, expect, it } from 'vitest';
import { PixelGrid } from '../src/imagery/region';
import { refineByStructure } from '../src/analysis/structural-refine';

const NORTH = 48.815;
const WEST = 2.33;
const MPP = 0.7; // meters per pixel
const SIZE = 64;

/** Build a synthetic grid: `fill(x, y)` -> luminance. Bounds derived from mPerPixel. */
function makeGrid(fill: (x: number, y: number) => number): PixelGrid {
  const luma = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) luma[y * SIZE + x] = fill(x, y);
  }
  const dLat = (SIZE * MPP) / 111320;
  const dLon = (SIZE * MPP) / (111320 * Math.cos((NORTH * Math.PI) / 180));
  return new PixelGrid({
    width: SIZE,
    height: SIZE,
    northLat: NORTH,
    southLat: NORTH - dLat,
    westLon: WEST,
    eastLon: WEST + dLon,
    mPerPixel: MPP,
    luma
  });
}

/** Grid with a sharp vertical brightness boundary at x=32 (building edge). */
const EDGE_GRID = makeGrid((x) => (x < 32 ? 200 : 60));

describe('refineByStructure', () => {
  it('moves a structure-bound feature toward building edges', () => {
    // Candidate in the open bright area, ~10 px (7 m) west of the boundary.
    const start = EDGE_GRID.pixelCenter(22, 32)!;
    const res = refineByStructure(EDGE_GRID, start.lat, start.lon, 'vending_machine', 10);
    expect(res).not.toBeNull();
    expect(res!.deltaM).toBeLessThanOrEqual(10 + 1e-6);
    const p = EDGE_GRID.pixelOf(res!.lat, res!.lon)!;
    expect(p.px).toBeGreaterThan(22); // moved east, toward the edge
    expect(res!.evidence.source).toBe('aerial-structure');
  });

  it('moves an open-ground feature away from structure', () => {
    // Candidate near the boundary; benches prefer smooth open ground.
    const start = EDGE_GRID.pixelCenter(30, 32)!;
    const res = refineByStructure(EDGE_GRID, start.lat, start.lon, 'bench', 10);
    expect(res).not.toBeNull();
    const p = EDGE_GRID.pixelOf(res!.lat, res!.lon)!;
    expect(p.px).toBeLessThan(30); // moved west, away from the edge
    expect(res!.deltaM).toBeLessThanOrEqual(10 + 1e-6);
  });

  it('does not move on flat, uniform imagery (no meaningful improvement)', () => {
    const flat = makeGrid(() => 150);
    const start = flat.pixelCenter(30, 30)!;
    expect(refineByStructure(flat, start.lat, start.lon, 'vending_machine', 10)).toBeNull();
    expect(refineByStructure(flat, start.lat, start.lon, 'bench', 10)).toBeNull();
  });

  it('never exceeds the correction bound', () => {
    // Boundary is 10 px (~7 m) away; a 3 m bound cannot reach it.
    const start = EDGE_GRID.pixelCenter(22, 32)!;
    const res = refineByStructure(EDGE_GRID, start.lat, start.lon, 'vending_machine', 3);
    // Either no move, or a move strictly within the bound.
    if (res) expect(res.deltaM).toBeLessThanOrEqual(3 + 1e-6);
    // With such a tight bound the samples never reach the edge -> no move.
    expect(res).toBeNull();
  });

  it('caps correction at the hard 10 m maximum', () => {
    const start = EDGE_GRID.pixelCenter(22, 32)!;
    const res = refineByStructure(EDGE_GRID, start.lat, start.lon, 'vending_machine', 50);
    expect(res).not.toBeNull();
    expect(res!.deltaM).toBeLessThanOrEqual(10 + 1e-6);
  });

  it('returns null for positions outside the stitched region', () => {
    expect(
      refineByStructure(EDGE_GRID, NORTH + 0.01, WEST, 'vending_machine', 10)
    ).toBeNull();
  });

  it('returns null when the bound is below 1 m', () => {
    const start = EDGE_GRID.pixelCenter(22, 32)!;
    expect(refineByStructure(EDGE_GRID, start.lat, start.lon, 'vending_machine', 0.5)).toBeNull();
  });
});

describe('PixelGrid mapping', () => {
  it('pixelOf/pixelCenter round-trip', () => {
    const g = EDGE_GRID;
    const c = g.pixelCenter(17, 29)!;
    const p = g.pixelOf(c.lat, c.lon)!;
    expect(Math.abs(p.px - 17)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.py - 29)).toBeLessThanOrEqual(1);
  });

  it('windowStats detects the boundary', () => {
    const atEdge = EDGE_GRID.windowStats(31, 32, 2);
    const inField = EDGE_GRID.windowStats(10, 32, 2);
    expect(atEdge.grad).toBeGreaterThan(inField.grad);
    expect(inField.grad).toBeCloseTo(0, 5);
    expect(atEdge.mean).toBeLessThan(inField.mean);
  });
});
