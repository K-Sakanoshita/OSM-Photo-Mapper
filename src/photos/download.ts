import { Zip, ZipPassThrough, strToU8 } from 'fflate';
import type { Survey } from '../types';

export function safeDownloadName(name: string): string {
  return name.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 120) || 'survey';
}

/** Save the stored bytes unchanged; camera metadata is also retained in JSON. */
export async function buildSurveyPhotoZip(survey: Survey, progress?: (done: number, total: number) => void): Promise<Blob> {
  const photos = survey.photos.filter((photo) => photo.image);
  if (!photos.length) throw new Error('No photos to download');
  const parts: ArrayBuffer[] = [];
  const archive = new Zip((error, chunk) => {
    if (error) throw error;
    parts.push(chunk.slice().buffer as ArrayBuffer);
  });
  const add = (name: string, bytes: Uint8Array) => {
    const file = new ZipPassThrough(name);
    archive.add(file);
    file.push(bytes, true);
  };
  const records = [];
  for (let index = 0; index < photos.length; index++) {
    const photo = photos[index];
    const match = /^data:image\/(jpeg|png|webp);base64,([\s\S]+)$/i.exec(photo.image!);
    if (!match) throw new Error('Stored photo format cannot be downloaded');
    const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    const originalName = photo.importInfo?.fileName?.replace(/\.[^.]+$/, '') ?? photo.id;
    const filename = `photos/${String(index + 1).padStart(4, '0')}-${safeDownloadName(originalName)}.${extension}`;
    const decoded = atob(match[2]);
    add(filename, Uint8Array.from(decoded, (char) => char.charCodeAt(0)));
    const { image: _image, ...metadata } = photo;
    records.push({ filename, ...metadata });
    progress?.(index + 1, photos.length);
    // Allow the busy indicator to paint between photos on mobile devices.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  add('photos.json', strToU8(JSON.stringify({ version: 1, survey: { id: survey.id, name: survey.name, createdAt: survey.createdAt, captureMode: survey.captureMode }, photos: records }, null, 2)));
  archive.end();
  return new Blob(parts, { type: 'application/zip' });
}

export function downloadPhotoZip(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeDownloadName(name)}-photos.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
