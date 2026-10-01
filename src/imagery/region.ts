/**
 * Stitching aerial imagery tiles into a small analyzable region (issue #8).
 *
 * `PixelGrid` is pure (grayscale luminance + exact mercator pixel<->geo
 * mapping) and fully unit-testable in Node. `stitchRegion` is the browser
 * path: it fetches the few tiles around a candidate, composites them and
 * derives the luminance grid. Every failure mode degrades to null so the
 * caller keeps the raw ground-survey estimate.
 */
import type { TileProvider } from './providers';
import {
  invMercatorY,
  mercatorY,
  mPerPixelAt,
  regionTiles,
  TILE_SIZE,
  tileBounds,
  zoomForResolution
} from './tiles';

export interface PixelGridData {
  width: number;
  height: number;
  /** Geographic bounds of the stitched region (degrees). */
  northLat: number;
  southLat: number;
  westLon: number;
  eastLon: number;
  /** Ground resolution, meters per pixel (after downsampling). */
  mPerPixel: number;
  /** Row-major grayscale luminance, 0..255, length width*height. */
  luma: Float32Array;
}

export class PixelGrid {
  constructor(private readonly d: PixelGridData) {}

  get width(): number { return this.d.width; }
  get height(): number { return this.d.height; }
  get mPerPixel(): number { return this.d.mPerPixel; }

  private get mTop(): number { return mercatorY(this.d.northLat); }
  private get mBot(): number { return mercatorY(this.d.southLat); }

  /** Lat/lon of a pixel center (px, py). Out-of-range -> null. */
  pixelCenter(px: number, py: number): { lat: number; lon: number } | null {
    const { width, height, westLon, eastLon } = this.d;
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    const my = this.mTop + ((py + 0.5) / height) * (this.mBot - this.mTop);
    const lon = westLon + ((px + 0.5) / width) * (eastLon - westLon);
    return { lat: invMercatorY(my), lon };
  }

  /** Pixel (center) of a lat/lon. Outside the region -> null. */
  pixelOf(latDeg: number, lonDeg: number): { px: number; py: number } | null {
    const { width, height, westLon, eastLon } = this.d;
    if (lonDeg < westLon || lonDeg > eastLon) return null;
    const my = mercatorY(latDeg);
    if (my < this.mTop || my > this.mBot) return null;
    const px = Math.floor(((lonDeg - westLon) / (eastLon - westLon)) * width);
    const py = Math.floor(((my - this.mTop) / (this.mBot - this.mTop)) * height);
    return { px: Math.min(width - 1, Math.max(0, px)), py: Math.min(height - 1, Math.max(0, py)) };
  }

  /** Luminance at a pixel (0 outside the grid). */
  sample(px: number, py: number): number {
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return 0;
    return this.d.luma[py * this.width + px];
  }

  /**
   * Local structure statistics over a square window around (px, py):
   *  - mean: mean luminance (0..255)
   *  - grad: mean absolute luminance difference to the right and lower
   *          neighbours (edge strength proxy, 0..255)
   */
  windowStats(px: number, py: number, r: number): { mean: number; grad: number; n: number } {
    let sum = 0;
    let gradSum = 0;
    let n = 0;
    let g = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
        const v = this.d.luma[y * this.width + x];
        sum += v;
        n++;
        if (x + 1 < this.width) {
          gradSum += Math.abs(v - this.d.luma[y * this.width + x + 1]);
          g++;
        }
        if (y + 1 < this.height) {
          gradSum += Math.abs(v - this.d.luma[(y + 1) * this.width + x]);
          g++;
        }
      }
    }
    if (n === 0) return { mean: 0, grad: 0, n: 0 };
    return { mean: sum / n, grad: g > 0 ? gradSum / g : 0, n };
  }
}

const MAX_PIXEL_BUDGET = 1_400_000;
const MAX_TILES = 9;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): AnyCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h);
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toLuma(ctx: Ctx2D, w: number, h: number): Float32Array {
  const img = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = 0.2126 * img[i * 4] + 0.7152 * img[i * 4 + 1] + 0.0722 * img[i * 4 + 2];
  }
  return out;
}

/**
 * Fetch + composite the imagery around (lat, lon) covering `radiusM`,
 * targeting `targetMetersPerPixel` (clamped to the provider's maxZoom).
 * Returns null on any gap/error — the caller keeps the raw estimate.
 */
export async function stitchRegion(
  provider: TileProvider,
  latDeg: number,
  lonDeg: number,
  radiusM: number,
  targetMetersPerPixel: number = 0.5
): Promise<PixelGrid | null> {
  const maxZoom = provider.source.maxZoom;

  let region: ReturnType<typeof regionTiles> | null = null;
  let zoom = Math.min(zoomForResolution(targetMetersPerPixel, latDeg), maxZoom);
  for (let attempt = 0; attempt < 3 && !region; attempt++) {
    region = regionTiles(latDeg, lonDeg, radiusM, zoom, MAX_TILES);
    if (!region) zoom--;
  }
  if (!region) return null;

  const n = Math.pow(2, region.zoom);
  const widthPx = Math.ceil((((region.eastLon - region.westLon) / 360) * n * TILE_SIZE));
  const heightPx = Math.ceil(((mercatorY(region.southLat) - mercatorY(region.northLat)) * n * TILE_SIZE));
  if (widthPx <= 0 || heightPx <= 0 || widthPx * heightPx > MAX_PIXEL_BUDGET) return null;

  const canvas = makeCanvas(widthPx, heightPx);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Neutral fill so partial coverage never reads as "dark structure".
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, widthPx, heightPx);

  for (const t of region.tiles) {
    const bmp = await provider.fetchTile(t.x, t.y, region.zoom);
    if (!bmp) return null; // coverage gap -> degrade gracefully
    const b = tileBounds(t.x, t.y, region.zoom);
    const dx = (((b.nw[1] - region.westLon) / 360) * n * TILE_SIZE);
    const dy = ((mercatorY(b.nw[0]) - mercatorY(region.northLat)) * n * TILE_SIZE);
    ctx.drawImage(bmp, Math.round(dx), Math.round(dy), TILE_SIZE, TILE_SIZE);
    bmp.close();
  }

  // Downsample to a bounded grid (block averaging).
  const maxDim = 384;
  const scale = Math.min(1, maxDim / Math.max(widthPx, heightPx));
  const w = Math.max(1, Math.round(widthPx * scale));
  const h = Math.max(1, Math.round(heightPx * scale));

  let luma: Float32Array;
  if (scale >= 1) {
    luma = toLuma(ctx, widthPx, heightPx);
  } else {
    const small = makeCanvas(w, h);
    if (!small) return null;
    const sctx = small.getContext('2d');
    if (!sctx) return null;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(canvas, 0, 0, widthPx, heightPx, 0, 0, w, h);
    luma = toLuma(sctx, w, h);
  }

  const centerLat = (region.northLat + region.southLat) / 2;
  const mPerPixel = mPerPixelAt(region.zoom, centerLat) / scale;

  return new PixelGrid({
    width: w,
    height: h,
    northLat: region.northLat,
    southLat: region.southLat,
    westLon: region.westLon,
    eastLon: region.eastLon,
    mPerPixel,
    luma
  });
}
