import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseExifDateTime,
  captureTimeFromExif,
  exifGpsFromData,
  exifImageDirection,
  readExif,
  restorePhotoGps,
  capturePhoto
} from '../src/capture/photo';
import type { HeadingReading } from '../src/capture/orientation';
import type { Photo } from '../src/types';

// capturePhoto persists via IndexedDB — not available in Node. The
// persistence is orthogonal to the capture logic under test.
vi.mock('../src/db/survey-db', () => ({
  surveyDb: { addPhoto: vi.fn(async () => undefined) }
}));

describe('restorePhotoGps', () => {
  it('restores camera GPS from the original JPEG while retaining saved evidence', async () => {
    const bytes = readFileSync(new URL('./fixtures/gps.jpg', import.meta.url));
    const saved: Photo = { id: 'photo-old', surveyId: 'survey-1', timestamp: 123, image: 'saved-thumbnail' };
    const restored = await restorePhotoGps(saved, new File([bytes], 'gps.jpg', { type: 'image/jpeg' }));
    expect(restored.id).toBe(saved.id);
    expect(restored.image).toBe(saved.image);
    expect(restored.cameraPosition?.source).toBe('exif');
    expect(restored.gps?.lat).toBeCloseTo(35.681, 5);
    expect(restored.gps?.lon).toBeCloseTo(139.767, 5);
  });

  it('rejects a file without GPS', async () => {
    const saved: Photo = { id: 'photo-old', surveyId: 'survey-1', timestamp: 123 };
    await expect(restorePhotoGps(saved, new File(['not a JPEG'], 'no-gps.jpg'))).rejects.toThrow('No usable GPS');
  });
});

describe('parseExifDateTime (issue #6: EXIF capture time)', () => {
  it('parses the standard EXIF format "YYYY:MM:DD HH:MM:SS"', () => {
    expect(parseExifDateTime('2026:09:30 14:22:31')).toBe(new Date(2026, 8, 30, 14, 22, 31).getTime());
  });

  it('tolerates a fractional-seconds suffix', () => {
    expect(parseExifDateTime('2026:09:30 14:22:31.123')).toBe(new Date(2026, 8, 30, 14, 22, 31).getTime());
  });

  it('accepts a "T" date/time separator', () => {
    expect(parseExifDateTime('2026:09:30T14:22:31')).toBe(new Date(2026, 8, 30, 14, 22, 31).getTime());
  });

  it('rejects dash-separated dates (not EXIF format)', () => {
    expect(parseExifDateTime('2026-09-30 14:22:31')).toBeUndefined();
  });

  it('rejects malformed or non-string input', () => {
    expect(parseExifDateTime('nope')).toBeUndefined();
    expect(parseExifDateTime('2026:13:45 99:99:99')).toBeUndefined();
    expect(parseExifDateTime(undefined)).toBeUndefined();
    expect(parseExifDateTime(12345)).toBeUndefined();
    expect(parseExifDateTime(null)).toBeUndefined();
  });
});

describe('captureTimeFromExif (issue #10: shared EXIF parse)', () => {
  it('prefers DateTimeOriginal over the other date tags', () => {
    const ts = captureTimeFromExif({
      DateTimeOriginal: '2026:09:30 14:22:31',
      DateTimeDigitized: '2026:09:30 15:00:00'
    } as never)!;
    expect(ts.source).toBe('exif');
    expect(ts.timestamp).toBe(new Date(2026, 8, 30, 14, 22, 31).getTime());
  });

  it('falls back to DateTime, then reports nothing when absent', () => {
    expect(captureTimeFromExif({ DateTime: '2026:09:30 12:00:00' } as never)?.timestamp)
      .toBe(new Date(2026, 8, 30, 12, 0, 0).getTime());
    expect(captureTimeFromExif({} as never)).toBeUndefined();
  });
});

describe('exifGpsFromData (issue #10: EXIF GPS as lowest-precedence fallback)', () => {
  it('reads GPS from an actual JPEG file', async () => {
    const bytes = readFileSync(new URL('./fixtures/gps.jpg', import.meta.url));
    const file = new File([bytes], 'gps.jpg', { type: 'image/jpeg' });
    const gps = exifGpsFromData(await readExif(file));
    expect(gps?.lat).toBeCloseTo(35.681, 5);
    expect(gps?.lon).toBeCloseTo(139.767, 5);
  });

  it('converts DMS rationals to decimal degrees (N/E)', () => {
    // 35°35'00.0" N, 139°45'00.0" E = 35.583333, 139.75
    const gps = exifGpsFromData({
      GPSLatitude: [35, 35, 0],
      GPSLatitudeRef: 'N',
      GPSLongitude: [139, 45, 0],
      GPSLongitudeRef: 'E'
    } as never)!;
    expect(gps.lat).toBeCloseTo(35 + 35 / 60, 6);
    expect(gps.lon).toBeCloseTo(139 + 45 / 60, 6);
  });

  it('negates southern/western hemispheres', () => {
    const gps = exifGpsFromData({
      GPSLatitude: [35, 0, 0],
      GPSLatitudeRef: 'S',
      GPSLongitude: [139, 0, 0],
      GPSLongitudeRef: 'W'
    } as never)!;
    expect(gps.lat).toBeCloseTo(-35, 6);
    expect(gps.lon).toBeCloseTo(-139, 6);
  });

  it('handles fractional seconds', () => {
    const gps = exifGpsFromData({
      GPSLatitude: [35, 35, 30],
      GPSLatitudeRef: 'N',
      GPSLongitude: [139, 45, 30],
      GPSLongitudeRef: 'E'
    } as never)!;
    expect(gps.lat).toBeCloseTo(35 + 35 / 60 + 30 / 3600, 6);
  });

  it('returns undefined when GPS tags are missing or malformed', () => {
    expect(exifGpsFromData({} as never)).toBeUndefined();
    expect(exifGpsFromData({ GPSLatitude: [35, 35], GPSLongitude: [139, 45, 0] } as never)).toBeUndefined();
    expect(exifGpsFromData(null)).toBeUndefined();
    expect(exifGpsFromData(undefined)).toBeUndefined();
  });

  it('rejects out-of-range coordinates (broken EXIF)', () => {
    expect(
      exifGpsFromData({
        GPSLatitude: [91, 0, 0],
        GPSLatitudeRef: 'N',
        GPSLongitude: [139, 0, 0],
        GPSLongitudeRef: 'E'
      } as never)
    ).toBeUndefined();
    expect(
      exifGpsFromData({
        GPSLatitude: [35, 0, 0],
        GPSLatitudeRef: 'N',
        GPSLongitude: [181, 0, 0],
        GPSLongitudeRef: 'E'
      } as never)
    ).toBeUndefined();
  });
});

describe('exifImageDirection (issue #13 phase 2: EXIF direction fallback)', () => {
  it('reads the angle and ref despite exif-js SWAPPED tag names', () => {
    // exif-js quirk: GPSImgDirectionRef holds the ANGLE (RATIONAL -> Number),
    // GPSImgDirection holds the REF string.
    const dir = exifImageDirection({
      GPSImgDirection: 'T',
      GPSImgDirectionRef: 187.5
    } as never)!;
    expect(dir.angle).toBe(187.5);
    expect(dir.ref).toBe('T');
    expect(dir.detail).toContain('grid-north reference');
  });

  it('also works with spec-correct naming (angle in GPSImgDirection)', () => {
    const dir = exifImageDirection({
      GPSImgDirection: 90,
      GPSImgDirectionRef: 'N'
    } as never)!;
    expect(dir.angle).toBe(90);
    expect(dir.ref).toBe('N');
    expect(dir.detail).toBe('true-north reference');
  });

  it('reports magnetic-north provenance for ref "M"', () => {
    const dir = exifImageDirection({
      GPSImgDirection: 'M',
      GPSImgDirectionRef: 270.25
    } as never)!;
    expect(dir.ref).toBe('M');
    expect(dir.detail).toContain('magnetic-north reference');
    expect(dir.detail).toContain('declination not corrected');
  });

  it('accepts an angle without a ref (assumes true north in the detail)', () => {
    const dir = exifImageDirection({ GPSImgDirectionRef: 45 } as never)!;
    expect(dir.angle).toBe(45);
    expect(dir.ref).toBeUndefined();
    expect(dir.detail).toContain('assumed true north');
  });

  it('tolerates the array form of the RATIONAL angle', () => {
    const dir = exifImageDirection({
      GPSImgDirection: 'N',
      GPSImgDirectionRef: [135]
    } as never)!;
    expect(dir.angle).toBe(135);
  });

  it('returns undefined without a usable angle', () => {
    // Ref string alone: no angle.
    expect(exifImageDirection({ GPSImgDirection: 'N' } as never)).toBeUndefined();
    // Out of range.
    expect(exifImageDirection({ GPSImgDirectionRef: 360 } as never)).toBeUndefined();
    expect(exifImageDirection({ GPSImgDirectionRef: -5 } as never)).toBeUndefined();
    expect(exifImageDirection({ GPSImgDirectionRef: NaN } as never)).toBeUndefined();
    // Missing / null.
    expect(exifImageDirection({} as never)).toBeUndefined();
    expect(exifImageDirection(null)).toBeUndefined();
    expect(exifImageDirection(undefined)).toBeUndefined();
  });

  it('ignores non-angle garbage in the scanned keys', () => {
    expect(
      exifImageDirection({
        GPSImgDirection: 'X',
        GPSImgDirectionRef: 'junk'
      } as never)
    ).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* capturePhoto — in-app image path (issue #13, phase 2)               */
/* ------------------------------------------------------------------ */

const SHUTTER_TS = 1_700_000_000_000;

function readingAt(ts: number, heading = 90): HeadingReading {
  return { heading, quality: 'compass', detail: 'platform compass', timestamp: ts };
}

describe('capturePhoto in-app image path (issue #13 phase 2)', () => {
  it('passes the shutter timestamp and source through untouched', async () => {
    const photo = await capturePhoto({
      surveyId: 'sv1',
      image: 'data:image/jpeg;base64,AA',
      timestamp: SHUTTER_TS,
      timestampSource: 'shutter',
      track: [],
      orientation: readingAt(SHUTTER_TS)
    });
    expect(photo.timestamp).toBe(SHUTTER_TS);
    expect(photo.timestampSource).toBe('shutter');
    expect(photo.image).toBe('data:image/jpeg;base64,AA');
    expect(photo.pickerLaunchedAt).toBeUndefined();
  });

  it('defaults to a shutter timestamp when none is given', async () => {
    const before = Date.now();
    const photo = await capturePhoto({
      surveyId: 'sv1',
      image: 'data:image/jpeg;base64,AA',
      track: [],
      orientation: undefined
    });
    const after = Date.now();
    expect(photo.timestamp).toBeGreaterThanOrEqual(before);
    expect(photo.timestamp).toBeLessThanOrEqual(after);
    expect(photo.timestampSource).toBe('shutter');
  });

  it('accepts a shutter-moment orientation reading (age ~0)', async () => {
    const photo = await capturePhoto({
      surveyId: 'sv1',
      image: 'data:image/jpeg;base64,AA',
      timestamp: SHUTTER_TS,
      timestampSource: 'shutter',
      track: [],
      orientation: readingAt(SHUTTER_TS)
    });
    expect(photo.cameraHeading).toMatchObject({ bearing: 90, source: 'compass', ageMs: 0 });
    expect(photo.headingNote).toBeUndefined();
  });

  it('rejects a stale orientation reading with an explicit note', async () => {
    const photo = await capturePhoto({
      surveyId: 'sv1',
      image: 'data:image/jpeg;base64,AA',
      timestamp: SHUTTER_TS,
      timestampSource: 'shutter',
      track: [],
      orientation: readingAt(SHUTTER_TS - 60_000)
    });
    expect(photo.cameraHeading).toBeUndefined();
    expect(photo.headingNote).toMatch(/stale/);
  });

  it('records no bearing for a reading without a geographic heading', async () => {
    const photo = await capturePhoto({
      surveyId: 'sv1',
      image: 'data:image/jpeg;base64,AA',
      timestamp: SHUTTER_TS,
      timestampSource: 'shutter',
      track: [],
      orientation: { heading: undefined, quality: 'none', detail: 'no sensor' }
    });
    expect(photo.cameraHeading).toBeUndefined();
    expect(photo.headingNote).toMatch(/No geographic heading/);
  });

  it('does not apply the EXIF direction fallback (a canvas frame has no EXIF)', async () => {
    const photo = await capturePhoto({
      surveyId: 'sv1',
      image: 'data:image/jpeg;base64,AA',
      timestamp: SHUTTER_TS,
      timestampSource: 'shutter',
      track: [],
      orientation: undefined
    });
    // No orientation and empty EXIF: no bearing of any source, and no
    // silent fallback pretending otherwise.
    expect(photo.cameraHeading).toBeUndefined();
  });

  it('resolves the camera position from the one-shot fix', async () => {
    const photo = await capturePhoto({
      surveyId: 'sv1',
      image: 'data:image/jpeg;base64,AA',
      timestamp: SHUTTER_TS,
      timestampSource: 'shutter',
      track: [],
      captureFix: { lat: 35.7, lon: 139.8, accuracy: 5, timestamp: SHUTTER_TS }
    });
    expect(photo.cameraPosition).toMatchObject({ lat: 35.7, lon: 139.8, source: 'capture-fix' });
  });

  it('requires a file or an image', async () => {
    await expect(
      capturePhoto({ surveyId: 'sv1', track: [] })
    ).rejects.toThrow('requires a file or an image');
  });
});
