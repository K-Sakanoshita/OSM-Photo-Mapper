import { describe, expect, it } from 'vitest';
import { parseExifDateTime } from '../src/capture/photo';

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
