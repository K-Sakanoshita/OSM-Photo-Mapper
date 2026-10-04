import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { pickPhotoFile } from '../src/capture/photo-picker';
import { exifGpsFromData, readExif, photoFileHash } from '../src/capture/photo';

describe('original photo picker', () => {
  it('opens immediately and reads original bytes with EXIF GPS intact', async () => {
    const bytes = readFileSync(new URL('./fixtures/gps.jpg', import.meta.url));
    const file = new File([bytes], 'original.jpg', { type: 'image/jpeg' });
    const fallback = vi.fn();
    const showOpenFilePicker = vi.fn(async () => [{ getFile: async () => file }]);
    const selected = pickPhotoFile(fallback, { showOpenFilePicker });
    expect(showOpenFilePicker).toHaveBeenCalledWith({ multiple: false, startIn: 'pictures' });
    const result = await selected;
    expect(result).toBe(file);
    expect(new Uint8Array(await result!.arrayBuffer())).toEqual(new Uint8Array(bytes));
    expect(exifGpsFromData(await readExif(result!))?.lat).toBeCloseTo(35.681, 5);
    expect(await photoFileHash(result!)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(fallback).not.toHaveBeenCalled();
  });

  it('opens the legacy input immediately when the API is unavailable', async () => {
    const fallback = vi.fn();
    const result = pickPhotoFile(fallback, {});
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await result).toBeUndefined();
  });

  it('does not open a second picker when the user cancels', async () => {
    const fallback = vi.fn();
    expect(await pickPhotoFile(fallback, {
      showOpenFilePicker: async () => { throw new DOMException('Cancelled', 'AbortError'); }
    })).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('reports read failures without silently changing the selected file', async () => {
    await expect(pickPhotoFile(vi.fn(), {
      showOpenFilePicker: async () => [{ getFile: async () => { throw new Error('Unreadable file'); } }]
    })).rejects.toThrow('Unreadable file');
  });
});
