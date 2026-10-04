interface PhotoPickerHost {
  showOpenFilePicker?: (options: { multiple: false; startIn: 'pictures' }) => Promise<Array<{ getFile(): Promise<File> }>>;
}

/** Return the original File without decoding or re-encoding its bytes.
 * undefined means the legacy input picker was opened; null means cancelled. */
export async function pickPhotoFile(
  fallback: () => void,
  host: PhotoPickerHost = window as Window & PhotoPickerHost
): Promise<File | null | undefined> {
  if (typeof host.showOpenFilePicker !== 'function') {
    fallback();
    return undefined;
  }
  try {
    // Call directly in the button gesture, before awaiting any other work.
    const [handle] = await host.showOpenFilePicker({ multiple: false, startIn: 'pictures' });
    return handle ? await handle.getFile() : null;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return null;
    throw error;
  }
}
