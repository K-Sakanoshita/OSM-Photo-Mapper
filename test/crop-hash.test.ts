import { describe, expect, it } from 'vitest';
import {
  dhashFromImageData,
  hammingDistance,
  hashesMatch,
  HASH_MERGE_MAX_HAMMING,
  type ImageDataLike
} from '../src/analysis/crop-hash';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Build a synthetic WxH grayscale image (r=g=b=value) as ImageDataLike. */
function makeImage(w: number, h: number, fill: (x: number, y: number) => number): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fill(x, y))));
      const off = (y * w + x) * 4;
      data[off] = v;
      data[off + 1] = v;
      data[off + 2] = v;
      data[off + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const FULL = { x: 0, y: 0, w: 1, h: 1 };

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe('crop-hash (issue #2 blocker 2: perceptual hash of detection crops)', () => {
  describe('dhashFromImageData', () => {
    it('produces a well-formed 16-hex-char 64-bit hash', () => {
      const img = makeImage(32, 32, (x) => (x < 16 ? 0 : 255));
      const h = dhashFromImageData(img, FULL);
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is deterministic', () => {
      const img = makeImage(32, 32, (x, y) => (x + y) % 256);
      expect(dhashFromImageData(img, FULL)).toBe(dhashFromImageData(img, FULL));
    });

    it('identical crops hash identically (hamming distance 0)', () => {
      const a = makeImage(64, 48, (x, y) => ((x * 7 + y * 13) % 256));
      const b = makeImage(64, 48, (x, y) => ((x * 7 + y * 13) % 256));
      const ha = dhashFromImageData(a, FULL)!;
      const hb = dhashFromImageData(b, FULL)!;
      expect(ha).toBe(hb);
      expect(hammingDistance(ha, hb)).toBe(0);
    });

    it('nearly identical crops (slight brightness jitter) still match', () => {
      // Simulates the same object photographed twice with slightly
      // different exposure: +/- 6 levels of noise on a structured image.
      const base = (x: number, y: number) => ((x * 7 + y * 13) % 256);
      const a = makeImage(64, 48, base);
      const b = makeImage(64, 48, (x, y) => base(x, y) + (((x * 31 + y * 17) % 13) - 6));
      const ha = dhashFromImageData(a, FULL)!;
      const hb = dhashFromImageData(b, FULL)!;
      const d = hammingDistance(ha, hb)!;
      expect(d).toBeLessThanOrEqual(HASH_MERGE_MAX_HAMMING);
      expect(hashesMatch(ha, hb)).toBe(true);
    });

    it('clearly different crops do NOT match', () => {
      // Checkerboard vs inverted checkerboard: opposite local structure
      // across the whole crop. 32-px cells are needed because the 9x8
      // hash grid samples ~28 px apart on a 256-px crop.
      const cb = (x: number, y: number, invert: boolean) => {
        const on = (((x >> 5) + (y >> 5)) % 2 === 0);
        return on === invert ? 255 : 0;
      };
      const a = makeImage(256, 192, (x, y) => cb(x, y, false));
      const b = makeImage(256, 192, (x, y) => cb(x, y, true));
      const ha = dhashFromImageData(a, FULL)!;
      const hb = dhashFromImageData(b, FULL)!;
      expect(hammingDistance(ha, hb)!).toBeGreaterThan(HASH_MERGE_MAX_HAMMING);
      expect(hashesMatch(ha, hb)).toBe(false);
    });

    it('respects the bbox (same image, different crops -> different hashes)', () => {
      // 256x256 image: left half is an 8-px checkerboard, right half the
      // INVERTED checkerboard. Two same-sized crops, one in each half:
      // identical size, different pixels -> different hashes. (8-px cells
      // because the 9x8 grid samples ~7 px apart on a 64-px crop.)
      const img = makeImage(256, 256, (x, y) => {
        const on = (((x >> 3) + (y >> 3)) % 2 === 0);
        return x < 128 ? (on ? 255 : 0) : on ? 0 : 255;
      });
      const leftCrop = dhashFromImageData(img, { x: 0, y: 0, w: 0.25, h: 0.25 })!;
      const rightCrop = dhashFromImageData(img, { x: 0.75, y: 0, w: 0.25, h: 0.25 })!;
      expect(hashesMatch(leftCrop, rightCrop)).toBe(false);
    });

    it('returns null for unusable input', () => {
      expect(dhashFromImageData({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, FULL)).toBeNull();
      expect(dhashFromImageData(makeImage(8, 8, () => 128), { x: 0, y: 0, w: 0, h: 0.5 })).toBeNull();
      expect(
        dhashFromImageData(makeImage(8, 8, () => 128), { x: NaN, y: 0, w: 0.5, h: 0.5 })
      ).toBeNull();
    });
  });

  describe('hammingDistance / hashesMatch', () => {
    it('computes exact bit differences', () => {
      expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
      expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
      expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
      expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4);
    });

    it('returns null for malformed hashes', () => {
      expect(hammingDistance('xyz', '0000000000000000')).toBeNull();
      expect(hammingDistance('000000000000000', '0000000000000000')).toBeNull(); // 15 chars
      expect(hammingDistance('000000000000000g', '0000000000000000')).toBeNull(); // not hex
    });

    it('hashesMatch respects the threshold boundary', () => {
      // 12 differing bits (0xFFF: 12 low bits set) -> match.
      expect(hashesMatch('0000000000000000', '0000000000000fff')).toBe(true);
      // 13 differing bits (0x1FFF) -> no match (conservative).
      expect(hashesMatch('0000000000000000', '0000000000001fff')).toBe(false);
      expect(HASH_MERGE_MAX_HAMMING).toBe(12);
    });
  });
});
