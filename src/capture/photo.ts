import type { GpsSample, Photo } from '../types';
import { surveyDb } from '../db/survey-db';

/**
 * Photo capture helpers.
 *
 * The captured image is downscaled to a bounded thumbnail (JPEG) before being
 * stored, keeping IndexedDB sizes sane while still being useful for review and
 * (later) server-side analysis.
 */

export interface CapturedPhotoInput {
  surveyId: string;
  file: File;
  gps?: GpsSample;
  heading?: number;
  note?: string;
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

/** Capture a photo: thumbnail it, attach GPS/heading context, persist it. */
export async function capturePhoto(input: CapturedPhotoInput): Promise<Photo> {
  const timestamp = Date.now();
  const image = await fileToThumbnail(input.file);

  const photo: Photo = {
    id: `photo-${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
    surveyId: input.surveyId,
    timestamp,
    image,
    gps: input.gps,
    heading: input.heading,
    note: input.note
  };

  await surveyDb.addPhoto(input.surveyId, photo);
  return photo;
}
