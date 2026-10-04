interface PhotoPickerHost {
  showOpenFilePicker?: (options: { multiple: boolean; startIn: 'pictures' }) => Promise<Array<{ getFile(): Promise<File> }>>;
}

export function supportsPhotoFilePicker(host: PhotoPickerHost = window as Window & PhotoPickerHost): boolean {
  return typeof host.showOpenFilePicker === 'function';
}

/** Return the original File without decoding or re-encoding its bytes.
 * undefined means the legacy input picker was opened; null means cancelled. */
export async function pickPhotoFile(
  fallback: () => void,
  host: PhotoPickerHost = window as Window & PhotoPickerHost
): Promise<File | null | undefined> {
  const files = await selectPhotoFiles(fallback, host, false);
  return files ? files[0] ?? null : files;
}

/** Select multiple originals, retaining their order and unmodified bytes. */
export function pickPhotoFiles(
  fallback: () => void,
  host: PhotoPickerHost = window as Window & PhotoPickerHost
): Promise<File[] | null | undefined> {
  return selectPhotoFiles(fallback, host, true);
}

async function selectPhotoFiles(
  fallback: () => void, host: PhotoPickerHost, multiple: boolean
): Promise<File[] | null | undefined> {
  if (typeof host.showOpenFilePicker !== 'function') {
    fallback();
    return undefined;
  }
  try {
    // Call directly in the button gesture, before awaiting any other work.
    const handles = await host.showOpenFilePicker({ multiple, startIn: 'pictures' });
    if (!handles.length) return null;
    return Promise.all((multiple ? handles : handles.slice(0, 1)).map(handle => handle.getFile()));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return null;
    throw error;
  }
}
