import exifr from 'exifr';
import type { GpsSample, Photo, TimestampSource } from '../types';
import { trackPositionAt } from '../analysis/position';
import { surveyDb } from '../db/survey-db';
import type { HeadingReading } from './orientation';
import { associateCameraHeading, HEADING_UNCERTAINTY_DEG } from './orientation';
import {
  exifCameraPosition,
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
 * picker. For EXTERNAL files the preference order is:
 *   1. EXIF DateTimeOriginal / DateTimeDigitized / DateTime  -> 'exif'
 *   2. File metadata modification time (File.lastModified)  -> 'file'
 *   3. Date.now() at selection (explicit fallback)          -> 'selected'
 * For IN-APP camera frames (issue #13 phase 2) the frame is grabbed at
 * the shutter moment, so the caller passes the shutter epoch ms directly
 *  (source 'shutter') — the strongest possible timestamp, and the one
 *  that lets the orientation reading be validated against the actual
 *  shutter instant.
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
 * Camera heading (issue #3): the camera bearing comes ONLY from the
 * device-orientation reading (the single normalized OrientationTracker
 * path), and only when it is FRESH relative to the true capture time —
 * `associateCameraHeading` (src/capture/orientation.ts) applies the
 * freshness gate and records the full provenance (source, uncertainty,
 * timestamp, age) on Photo.cameraHeading. Stale or post-return readings
 * are rejected with an explicit headingNote. The GPS track's heading is
 * the MOVEMENT bearing (direction of travel): it is recorded on
 * Photo.movementHeading as contextual evidence and NEVER used as the
 * camera bearing.
 */

export interface CapturedPhotoInput {
  surveyId: string;
  /** EXTERNAL path: the image file from the OS camera / photo library.
   *  EXIF (capture time, GPS, image direction) is parsed from it. */
  file?: File;
  selectionMethod?: 'file-system-access' | 'file-input';
  /** IN-APP path (issue #13 phase 2): a pre-encoded JPEG data URL
   *  captured from the getUserMedia video at the shutter moment. When
   *  provided, the file/EXIF path is skipped entirely (a canvas frame
   *  has no EXIF) and `timestamp`/`timestampSource` are used as-is. */
  image?: string;
  /** The survey's GPS track (chronological; may be empty — Record mode is
   *  optional). When the capture time is genuinely covered, its position
   *  becomes the photo's camera position with source 'track'. */
  track: GpsSample[];
  /** One-shot position fix requested in the same user gesture as the file
   *  input (issue #10). Used when the track does not cover the capture
   *  time. */
  captureFix?: OneShotFix | null;
  /** Live orientation reading at capture time (issue #3): the ONLY
   *  source of the camera bearing. A normalized heading WITH QUALITY and
   *  TIMESTAMP from the OrientationTracker. Subject to the freshness
   *  gate in `associateCameraHeading` — stale or post-return readings
   *  are rejected with an explicit headingNote. Readings without a
   *  geographic heading (relative/none) contribute nothing.
   *  For in-app captures this reading is taken IN THE SHUTTER GESTURE
   *  (issue #13 phase 2), so its age at the shutter is ~0 ms and it
   *  always passes the freshness gate when a sensor exists. */
  orientation?: HeadingReading | null;
  /** Issue #13 phase 1: epoch ms when the external camera/file picker
   *  was launched (the user-gesture moment, before the OS camera opened).
   *  Orientation readings older than this are rejected as camera bearing —
   *  they describe the pre-camera scene, not the shutter moment. Pass
   *  undefined for in-app camera captures (orientation is read at the
   *  shutter instant instead). */
  pickerLaunchTs?: number;
  /** IN-APP path only (issue #13 phase 2): the shutter-moment epoch ms,
   *  recorded in the same gesture as the frame and orientation capture. */
  timestamp?: number;
  /** IN-APP path only: provenance of `timestamp` (default 'shutter'). */
  timestampSource?: TimestampSource;
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

type ExifData = {
  _readError?: string;
  DateTimeOriginal?: unknown;
  DateTimeDigitized?: unknown;
  DateTime?: unknown;
  GPSLatitude?: unknown;
  GPSLatitudeRef?: unknown;
  GPSLongitude?: unknown;
  GPSLongitudeRef?: unknown;
  GPSImgDirection?: unknown;
  GPSImgDirectionRef?: unknown;
};

/** Read EXIF once per file (issue #10: capture time and GPS share one parse). */
export async function readExif(file: File): Promise<ExifData> {
  try {
    return (await exifr.parse(await file.arrayBuffer(), {
      tiff: true, exif: true, gps: true,
      translateValues: false, reviveValues: false
    })) ?? {};
  } catch (error) {
    // EXIF unreadable — no EXIF data.
    return { _readError: error instanceof Error ? error.message : String(error) };
  }
}

export async function photoFileHash(file: File): Promise<string | undefined> {
  try {
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

/** Restore GPS on a saved photo from its original file (thumbnails have no EXIF). */
export async function restorePhotoGps(photo: Photo, file: File): Promise<Photo> {
  const data = await readExif(file);
  const gps = exifGpsFromData(data);
  if (!gps) throw new Error('No usable GPS coordinates were found in this file. Select the original camera photo.');
  const captureTime = captureTimeFromExif(data);
  if (photo.timestampSource === 'exif' && captureTime && Math.abs(captureTime.timestamp - photo.timestamp) > 2000) {
    throw new Error('This appears to be a different photo. Select the original file for this saved photo.');
  }
  const cameraPosition = exifCameraPosition(gps, photo.timestamp);
  return {
    ...photo,
    cameraPosition,
    gps: { id: `gps-${photo.timestamp}`, lat: gps.lat, lon: gps.lon, timestamp: photo.timestamp }
  };
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
  const lat = dmsToDecimal(latDms) * (data?.GPSLatitudeRef === 'S' ? -1 : 1);
  const lon = dmsToDecimal(lonDms) * (data?.GPSLongitudeRef === 'W' ? -1 : 1);
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
 * EXIF GPSImgDirection (issue #13 phase 2, C): the compass direction of
 * the subject at the SHUTTER moment, written into the file by the camera.
 * Unlike the device-orientation reading (which is read when the user
 * returns to the app), the EXIF tag's timestamp IS the capture time, so
 * it is legitimate shutter-time bearing evidence — but only as a fallback
 * when the device orientation yielded nothing usable.
 *
 * Scan both direction fields because older stored/test data used the
 * exif-js labels in the opposite order. The angle is the first finite
 * number in [0, 360) and the ref the first N/M/T string.
 * A count-1 RATIONAL is normally a number; an array is accepted as well.
 */
export function exifImageDirection(
  data: ExifData | null | undefined
): { angle: number; ref: 'N' | 'M' | 'T' | undefined; detail: string } | undefined {
  if (!data) return undefined;
  const values: unknown[] = [data.GPSImgDirection, data.GPSImgDirectionRef];
  let angle: number | undefined;
  let ref: 'N' | 'M' | 'T' | undefined;
  for (const v of values) {
    if (angle == null && (typeof v === 'number' || (Array.isArray(v) && typeof v[0] === 'number'))) {
      const n = typeof v === 'number' ? v : (v[0] as number);
      if (Number.isFinite(n) && n >= 0 && n < 360) angle = n;
    }
    if (ref == null && typeof v === 'string' && (v === 'N' || v === 'M' || v === 'T')) {
      ref = v;
    }
  }
  if (angle == null) return undefined;
  return { angle, ref, detail: directionRefDetail(ref) };
}

function directionRefDetail(ref: 'N' | 'M' | 'T' | undefined): string {
  switch (ref) {
    case 'N':
      return 'true-north reference';
    case 'M':
      return 'magnetic-north reference — local declination not corrected';
    case 'T':
      return 'grid-north reference — grid convergence not corrected';
    default:
      return 'north reference unknown (assumed true north)';
  }
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
  // Two capture paths (issue #13 phase 2):
  //  - EXTERNAL file: EXIF is read ONCE and shared by the capture-time
  //    and GPS extraction (issue #10), so the camera position and
  //    timestamp come from the same parse.
  //  - IN-APP image: the frame was grabbed at the shutter moment; the
  //    caller passes the shutter timestamp directly and there is no
  //    EXIF to parse (exifData stays empty — the EXIF fallbacks below
  //    simply no-op).
  let timestamp: number;
  let source: TimestampSource;
  let exifData: ExifData = {};
  let image: string;
  if (input.image) {
    timestamp = input.timestamp ?? Date.now();
    source = input.timestampSource ?? 'shutter';
    image = input.image;
  } else {
    const file = input.file;
    if (!file) throw new Error('capturePhoto requires a file or an image');
    exifData = await readExif(file);
    const exifTime = captureTimeFromExif(exifData);
    const lm = file.lastModified;
    timestamp = exifTime?.timestamp ?? (lm > 0 ? lm : Date.now());
    source = exifTime ? 'exif' : lm > 0 ? 'file' : 'selected';
    image = await fileToThumbnail(file);
  }

  const cameraPosition = resolveCameraPosition({
    track: input.track,
    captureTimestamp: timestamp,
    captureFix: input.captureFix,
    exifGps: exifGpsFromData(exifData)
  });

  const photo: Photo = {
    id: `photo-${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
    surveyId: input.surveyId,
    timestamp,
    timestampSource: source,
    image,
    cameraPosition,
    gps: undefined,
    ...(input.file ? { importInfo: {
      fileName: input.file.name,
      fileSize: input.file.size,
      selectionMethod: input.selectionMethod ?? 'file-input',
      exifGpsRead: exifGpsFromData(exifData) != null,
      sha256: await photoFileHash(input.file),
      exifReadError: exifData._readError,
      exifTagCount: Object.keys(exifData).filter((key) => key !== '_readError').length,
      gpsTags: JSON.stringify({ latitude: exifData.GPSLatitude ?? null, latitudeRef: exifData.GPSLatitudeRef ?? null,
        longitude: exifData.GPSLongitude ?? null, longitudeRef: exifData.GPSLongitudeRef ?? null })
    } } : {}),
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
      // Direction of travel at capture — MOVEMENT bearing, contextual
      // only (issue #3: never a camera bearing).
      movementHeading:
        cameraPosition.source === 'track' ? trackPositionAt(input.track, timestamp)?.movementHeading : undefined
    };
  }

  // Issue #3: the camera bearing comes ONLY from the device-orientation
  // reading, and only when it passes the freshness gate relative to the
  // true capture time. Full provenance (source, uncertainty, timestamp,
  // age) is recorded on Photo.cameraHeading; rejections are explained on
  // Photo.headingNote. The track's movement heading is stored separately
  // as contextual evidence and never used as the camera bearing.
  const { cameraHeading, headingNote } = associateCameraHeading(
    input.orientation,
    timestamp,
    input.pickerLaunchTs
  );
  photo.cameraHeading = cameraHeading;
  photo.headingNote = headingNote;

  // Issue #13 phase 2 (C): EXIF direction fallback. When the device
  // orientation yielded no usable shutter-time bearing (rejected as
  // stale/pre-launch/post-return, unavailable, or never captured), the
  // EXIF GPSImgDirection tag — written by the camera AT the shutter
  // moment — is the next-best evidence of where the lens pointed. The
  // stale/rejection note is replaced by the EXIF provenance, because the
  // photo now DOES carry a (fallback) camera heading.
  if (photo.cameraHeading == null) {
    const dir = exifImageDirection(exifData);
    if (dir) {
      photo.cameraHeading = {
        bearing: dir.angle,
        source: 'exif-direction',
        uncertaintyDeg: HEADING_UNCERTAINTY_DEG['exif-direction'],
        timestamp,
        ageMs: 0,
        detail: `EXIF GPSImgDirection (${dir.detail})`
      };
      photo.headingNote = undefined;
    }
  }
  // Issue #13 phase 1 provenance: record when the external picker was
  // launched, so the review UI can explain pre-launch rejections.
  photo.pickerLaunchedAt = input.pickerLaunchTs;
  photo.movementHeading = trackPositionAt(input.track, timestamp)?.movementHeading;

  await surveyDb.addPhoto(input.surveyId, photo);
  return photo;
}
