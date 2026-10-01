import EXIF from 'exif-js';
import type { GpsSample, Photo, TimestampSource } from '../types';
import { trackPositionAt } from '../analysis/position';
import { surveyDb } from '../db/survey-db';

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
 * GPS association: the photo is matched to the track sample (or the
 * interpolated position between samples) nearest the capture time — not the
 * newest sample at selection time.
 *
 * EXIF GPS coordinates are deliberately IGNORED: they describe the camera
 * position, not the target object, and using them would bias object
 * placement toward the capture point.
 */

export interface CapturedPhotoInput {
  surveyId: string;
  file: File;
  /** The survey's GPS track (chronological); used to place the photo in time. */
  track: GpsSample[];
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

/**
 * Best-effort true capture time for a photo file, with provenance.
 *
 * EXIF dates carry no timezone; they are interpreted in the device's local
 * timezone, which is correct for photos taken on this device. Photos taken
 * elsewhere can be off by the timezone delta — an accepted MVP limitation.
 */
export async function resolveCaptureTime(file: File): Promise<{ timestamp: number; source: TimestampSource }> {
  try {
    const data = EXIF.readFromBinaryFile(await file.arrayBuffer());
    const exifTs =
      parseExifDateTime(data.DateTimeOriginal) ??
      parseExifDateTime(data.DateTimeDigitized) ??
      parseExifDateTime(data.DateTime);
    if (exifTs != null) return { timestamp: exifTs, source: 'exif' };
    // NOTE: EXIF GPS tags are read here only to prove EXIF is present; the
    // coordinates themselves are deliberately never used as the object
    // position (they mark the camera, not the object).
  } catch {
    // EXIF unreadable — fall through to file metadata.
  }
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

/** Capture a photo: resolve its true capture time, place it on the GPS
 *  track at that moment, thumbnail it, and persist. */
export async function capturePhoto(input: CapturedPhotoInput): Promise<Photo> {
  const { timestamp, source } = await resolveCaptureTime(input.file);
  const gps = trackPositionAt(input.track, timestamp);
  const image = await fileToThumbnail(input.file);

  const photo: Photo = {
    id: `photo-${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
    surveyId: input.surveyId,
    timestamp,
    timestampSource: source,
    image,
    gps,
    heading: input.heading,
    note: input.note
  };

  await surveyDb.addPhoto(input.surveyId, photo);
  return photo;
}
