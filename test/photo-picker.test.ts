import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { pickPhotoFile, pickPhotoFiles } from '../src/capture/photo-picker';
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


describe('multiple original photos', () => {
  it('opens once with multiple selection and returns every original in order', async () => {
    const files = [new File(['first'], 'first.jpg'), new File(['second'], 'second.jpg')];
    const picker = vi.fn(async () => files.map(file => ({ getFile: async () => file })));
    const fallback = vi.fn();
    const selection = pickPhotoFiles(fallback, { showOpenFilePicker: picker });
    expect(picker).toHaveBeenCalledWith({ multiple: true, startIn: 'pictures' });
    const selected = await selection;
    expect(selected).toEqual(files);
    expect(selected?.[0]).toBe(files[0]);
    expect(selected?.[1]).toBe(files[1]);
    expect(await selected?.[1].text()).toBe('second');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('supports fallback and cancellation without reopening the picker', async () => {
    const fallback = vi.fn();
    expect(await pickPhotoFiles(fallback, {})).toBeUndefined();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await pickPhotoFiles(fallback, { showOpenFilePicker: async () => { throw new DOMException('Cancelled', 'AbortError'); } })).toBeNull();
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
