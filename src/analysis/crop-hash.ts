/**
 * Perceptual hashing of cropped detection regions (issue #2 blocker 2).
 *
 * Cross-photo same-object grouping must rest on REAL visual evidence,
 * not on independently generated free-form identity strings (two
 * distinct same-class objects within the merge radius can produce
 * identical provider identity labels). This module compares the actual
 * pixels of the detected region:
 *
 *  - the bbox crop of each photo is reduced to a dHash (difference hash):
 *    a 64-bit fingerprint of the crop's low-frequency structure;
 *  - two crops are considered the same visual object when their Hamming
 *    distance is at or below HASH_MERGE_MAX_HAMMING;
 *  - geometry remains a NECESSARY condition (see pipeline.ts): a visual
 *    match only bridges clusters whose projected points agree.
 *
 * The core (`dhashFromImageData`, `hammingDistance`) is pure and
 * dependency-free — fully unit-testable without a DOM. The browser
 * helper (`cropHashFromDataUrl`) degrades gracefully: any decode/canvas
 * failure yields null (no hash), which the pipeline treats as "no
 * visual evidence" — such observations can never be merged across
 * photos by identity.
 */

import type { BBox } from '../types';

/** Maximum Hamming distance (of 64 bits) at which two crop hashes still
 *  count as the same visual object. Conservative on purpose: a missed
 *  merge leaves two review candidates (the reviewer can still see both),
 *  while a false merge fabricates one fake object. */
export const HASH_MERGE_MAX_HAMMING = 12;

/** A 64-bit dHash rendered as exactly 16 lowercase hex characters. */
export type CropHash = string;

/** Minimal image-data shape (ImageData-compatible). */
export interface ImageDataLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

const DW = 9; // sample width  (DW-1) * DH comparisons = 64 bits
const DH = 8; // sample height

/**
 * Compute the 64-bit dHash of the bbox region of an image (pure).
 *
 * The crop is sampled (nearest neighbor) onto a 9x8 grayscale grid;
 * bit i is set when a pixel is darker than the pixel to its right.
 * Returns null when the image or bbox is unusable.
 */
export function dhashFromImageData(img: ImageDataLike, bbox: BBox): CropHash | null {
  const { width: W, height: H, data } = img;
  if (!W || !H || data.length < W * H * 4) return null;
  if (!bboxIsUsable(bbox)) return null;
  const x = clamp01(bbox.x);
  const y = clamp01(bbox.y);
  const w = clamp01(bbox.w);
  const h = clamp01(bbox.h);

  // Nearest-neighbor sample of the crop onto the 9x8 grid.
  const gray = new Float64Array(DW * DH);
  for (let sy = 0; sy < DH; sy++) {
    for (let sx = 0; sx < DW; sx++) {
      const px = Math.min(W - 1, Math.floor((x + ((sx + 0.5) / DW) * w) * W));
      const py = Math.min(H - 1, Math.floor((y + ((sy + 0.5) / DH) * h) * H));
      const off = (py * W + px) * 4;
      gray[sy * DW + sx] =
        (data[off] * 299 + data[off + 1] * 587 + data[off + 2] * 114) / 1000;
    }
  }

  // MSB-first packing, row by row (64 bits total).
  let bits = 0n;
  let bitIndex = 63;
  for (let sy = 0; sy < DH; sy++) {
    for (let sx = 0; sx < DW - 1; sx++) {
      if (gray[sy * DW + sx] < gray[sy * DW + sx + 1]) bits |= 1n << BigInt(bitIndex);
      bitIndex -= 1;
    }
  }
  return bits.toString(16).padStart(16, '0');
}

/**
 * Hamming distance between two 16-hex-char crop hashes (0..64).
 * Returns null when either value is not a well-formed 64-bit hex hash.
 */
export function hammingDistance(a: string, b: string): number | null {
  const va = parseHash(a);
  const vb = parseHash(b);
  if (va === null || vb === null) return null;
  let x = va ^ vb;
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** True when two crop hashes denote the same visual object. */
export function hashesMatch(a: string, b: string): boolean {
  const d = hammingDistance(a, b);
  return d !== null && d <= HASH_MERGE_MAX_HAMMING;
}

function parseHash(h: string): bigint | null {
  if (typeof h !== 'string' || !/^[0-9a-f]{16}$/i.test(h)) return null;
  try {
    return BigInt('0x' + h);
  } catch {
    return null;
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** A bbox is usable when all four values are finite and both
 *  dimensions are positive. Malformed bboxes (NaN/Infinity/zero area)
 *  must yield null rather than silently hashing the wrong region. */
function bboxIsUsable(bbox: BBox): boolean {
  return (
    Number.isFinite(bbox.x) &&
    Number.isFinite(bbox.y) &&
    Number.isFinite(bbox.w) &&
    Number.isFinite(bbox.h) &&
    bbox.w > 0 &&
    bbox.h > 0
  );
}

/**
 * Browser helper: decode a photo data URL, draw the bbox crop onto an
 * offscreen canvas, and hash it. Any failure (invalid image, missing
 * canvas support, taint) resolves to null — never throws.
 */
export async function cropHashFromDataUrl(dataUrl: string, bbox: BBox): Promise<CropHash | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return null;
    if (!bboxIsUsable(bbox)) return null;

    const x = clamp01(bbox.x);
    const y = clamp01(bbox.y);
    const w = clamp01(bbox.w);
    const h = clamp01(bbox.h);

    const cw = Math.max(1, Math.round(w * img.naturalWidth));
    const chh = Math.max(1, Math.round(h * img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = chh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(
      img,
      Math.round(x * img.naturalWidth),
      Math.round(y * img.naturalHeight),
      cw,
      chh,
      0,
      0,
      cw,
      chh
    );
    const data = ctx.getImageData(0, 0, cw, chh);
    return dhashFromImageData(
      { data: data.data, width: data.width, height: data.height },
      // The canvas already contains only the crop.
      { x: 0, y: 0, w: 1, h: 1 }
    );
  } catch {
    return null;
  }
}
