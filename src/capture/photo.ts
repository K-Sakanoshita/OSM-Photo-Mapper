import EXIF from 'exif-js';
import type { GpsSample, Photo, TimestampSource } from '../types';
import { trackPositionAt } from '../analysis/position';
import { surveyDb } from '../db/survey-db';
import {
  resolveCameraPosition,
  type ExifGps,
  type OneShotFix
} from './camera-position';

/**
 * Photo capture helpers.
 *
 * The captured image is downscaled to a bounded thumbnail (JPEG) before being
 * stored, keeping IndexedDB sizes sane while still being useful for review and
 * (later) server-side analysis.
 *
 * Capture time resolution (issue #6): we use the true capture timestamp when
 * available rather than the moment the user returns from the camera/file
 * picker. Preference order:
 *   1. EXIF DateTimeOriginal / DateTimeDigitized / DateTime  -> 'exif'
 *   2. File metadata modification time (File.lastModified)  -> 'file'
 *   3. Date.now() at selection (explicit fallback)          -> 'selected'
 * The source is recorded on the photo (Photo.timestampSource) so the review
 * UI can flag low-quality associations.
 *
 * Camera position (issue #10): the photo is associated with the CAMERA
 * position at the true capture time, resolved with explicit provenance by
 * `resolveCameraPosition` (src/capture/camera-position.ts):
 *   1. 'track'       — track position at capture time, but ONLY when the
 *                      capture moment is genuinely covered by fresh samples
 *                      (a stale endpoint outside the span is rejected).
 *   2. 'capture-fix' — one-shot fix requested in the same user gesture as
 *                      the camera/file input (Record mode is optional).
 *   3. 'exif'        — EXIF GPS coordinates (lowest-precedence fallback).
 * The camera position is evidence for locating the photographed object —
 * it never becomes the object's own coordinates.
 *
 * Heading (issue #6): the heading interpolated from the track AT CAPTURE
 * TIME is preferred. The device heading at file-picker return is only an
 * explicit fallback (used when the track has no heading); the provenance is
 * recorded via Photo.headingSource.
 */

export interface CapturedPhotoInput {
  surveyId: string;
  file: File;
  /** The survey's GPS track (chronological; may be empty — Record mode is
   *  optional). When the capture time is genuinely covered, its position
   *  becomes the photo's camera position with source 'track'. */
  track: GpsSample[];
  /** One-shot position fix requested in the same user gesture as the file
   *  input (issue #10). Used when the track does not cover the capture
   *  time. */
  captureFix?: OneShotFix | null;
  /** Device compass heading at file-picker return. Fallback only: the
   *  track heading at capture time takes precedence when available. */
  heading?: number;
  note?: string;
}

/** EXIF date strings look like "2026:09:30 14:22:31" (colons in the date). */
export function parseExifDateTime(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined;
  const m = s.trim().match(/^\s?(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  // Reject out-of-range fields: JS Date silently rolls them over, which
  // would turn a garbage string into a plausible-but-wrong timestamp.
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return undefined;
  const ts = new Date(y, mo - 1, d, h, mi, sec).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

type ExifData = ReturnType<typeof EXIF.readFromBinaryFile>;

/** Read EXIF once per file (issue #10: capture time and GPS share one parse). */
export async function readExif(file: File): Promise<ExifData> {
  try {
    return EXIF.readFromBinaryFile(await file.arrayBuffer());
  } catch {
    // EXIF unreadable — no EXIF data.
    return {};
  }
}

/**
 * Capture time from EXIF data, when present.
 *
 * EXIF dates carry no timezone; they are interpreted in the device's local
 * timezone, which is correct for photos taken on this device. Photos taken
 * elsewhere can be off by the timezone delta — an accepted MVP limitation.
 */
export function captureTimeFromExif(
  data: ExifData
): { timestamp: number; source: 'exif' } | undefined {
  const exifTs =
    parseExifDateTime(data.DateTimeOriginal) ??
    parseExifDateTime(data.DateTimeDigitized) ??
    parseExifDateTime(data.DateTime);
  return exifTs != null ? { timestamp: exifTs, source: 'exif' } : undefined;
}

/**
 * Extract GPS coordinates from EXIF data (issue #10, lowest-precedence
 * camera-position fallback). EXIF stores degrees/minutes/seconds as
 * rationals; exif-js hands them over as number arrays plus N/S/E/W refs.
 */
export function exifGpsFromData(data: ExifData | null | undefined): ExifGps | undefined {
  const latDms = data?.GPSLatitude;
  const lonDms = data?.GPSLongitude;
  if (!Array.isArray(latDms) || !Array.isArray(lonDms)) return undefined;
  if (latDms.length < 3 || lonDms.length < 3) return undefined;
  const lat = dmsToDecimal(latDms) * (data.GPSLatitudeRef === 'S' ? -1 : 1);
  const lon = dmsToDecimal(lonDms) * (data.GPSLongitudeRef === 'W' ? -1 : 1);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return undefined;
  }
  return { lat, lon };
}

function dmsToDecimal(dms: number[]): number {
  const [d, m, s] = dms;
  return (d ?? 0) + (m ?? 0) / 60 + (s ?? 0) / 3600;
}

/**
 * Best-effort true capture time for a photo file, with provenance.
 */
export async function resolveCaptureTime(file: File): Promise<{ timestamp: number; source: TimestampSource }> {
  const exifTime = captureTimeFromExif(await readExif(file));
  if (exifTime) return exifTime;
  // File.lastModified is Date.now()-based and reliable for camera captures;
  // for imported files it is the last write time of the copy, so it is only a
  // fallback (source 'file'), not as good as EXIF.
  const lm = file.lastModified;
  if (lm > 0) return { timestamp: lm, source: 'file' };
  return { timestamp: Date.now(), source: 'selected' };
}

/** Downscale a image file to a JPEG data URL bounded by maxDim. */
export async function fileToThumbnail(
  file: File,
  maxDim = 1024,
  quality = 0.72
): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return await new Promise<string>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('Failed to encode image'));
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      },
      'image/jpeg',
      quality
    );
  });
}

/** Capture a photo: resolve its true capture time, resolve the CAMERA
 *  position at that moment (with provenance), thumbnail it, and persist. */
export async function capturePhoto(input: CapturedPhotoInput): Promise<Photo> {
  // EXIF is read ONCE and shared by the capture-time and GPS extraction
  // (issue #10), so the camera position and timestamp come from the same
  // parse.
  const exifData = await readExif(input.file);
  const exifTime = captureTimeFromExif(exifData);
  const lm = input.file.lastModified;
  const timestamp = exifTime?.timestamp ?? (lm > 0 ? lm : Date.now());
  const source: TimestampSource = exifTime ? 'exif' : lm > 0 ? 'file' : 'selected';

  const cameraPosition = resolveCameraPosition({
    track: input.track,
    captureTimestamp: timestamp,
    captureFix: input.captureFix,
    exifGps: exifGpsFromData(exifData)
  });
  const image = await fileToThumbnail(input.file);

  const photo: Photo = {
    id: `photo-${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
    surveyId: input.surveyId,
    timestamp,
    timestampSource: source,
    image,
    cameraPosition,
    gps: undefined,
    note: input.note
  };

  // Compatibility alias of cameraPosition for consumers that read the old
  // shape (map markers, ray estimation, position evidence).
  if (cameraPosition) {
    photo.gps = {
      id: `gps-${cameraPosition.timestamp}`,
      lat: cameraPosition.lat,
      lon: cameraPosition.lon,
      accuracy: cameraPosition.accuracy,
      timestamp: cameraPosition.timestamp,
      heading:
        cameraPosition.source === 'track' ? trackPositionAt(input.track, timestamp)?.heading : undefined
    };
  }

  // Prefer the heading associated with the capture-time track position;
  // fall back to the runtime device heading only when the track has none.
  if (photo.gps?.heading != null) {
    photo.heading = photo.gps.heading;
    photo.headingSource = 'track';
  } else if (input.heading != null) {
    photo.heading = input.heading;
    photo.headingSource = 'device';
  }

  await surveyDb.addPhoto(input.surveyId, photo);
  return photo;
}
