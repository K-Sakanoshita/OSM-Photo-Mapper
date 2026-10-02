import { describe, expect, it } from 'vitest';
import {
  parseExifDateTime,
  captureTimeFromExif,
  exifGpsFromData
} from '../src/capture/photo';

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
