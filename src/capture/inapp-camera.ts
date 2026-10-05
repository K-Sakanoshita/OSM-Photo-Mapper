/**
 * In-app camera capture via getUserMedia (issue #13, phase 2).
 *
 * Why this exists: the external OS camera (file input) has NO hook at the
 * shutter moment — the app only sees the file again when the user returns,
 * so its orientation readings can never be tied to the actual shutter
 * instant. Capturing the frame IN the app removes that gap: the shutter
 * gesture grabs the live video frame AND the orientation reading at the
 * SAME moment, so the reading's timestamp IS shutter-time evidence and the
 * freshness gate trivially passes (age ≈ 0 ms).
 *
 * The captured frame is encoded as a JPEG data URL (no File object, hence
 * no EXIF) and handed to `capturePhoto` via `image` with
 * `timestampSource: 'shutter'`. The EXIF fallbacks (direction, GPS, date)
 * therefore do not apply to in-app captures — the shutter-moment sources
 * (orientation reading + GPS track/one-shot fix) are the evidence.
 *
 * Positioning: at mode entry (a user gesture — required for both the
 * camera permission and the cleanest GPS fix), the caller starts
 * orientation tracking and requests a one-shot position fix. At the
 * shutter the fix promise is awaited with a SHORT bound so the shutter
 * gesture is never held hostage by a slow GPS lock; if it has not
 * arrived, the capture proceeds with the track (or no) position evidence.
 */

export class InAppCamera {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;

  /** Whether getUserMedia is available in this browser/context. */
  static available(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
    );
  }

  get active(): boolean {
    return this.stream != null;
  }

  /**
   * Open the rear camera and start playback into `video`.
   * MUST be called from a user gesture (browser permission rules).
   */
  async start(video: HTMLVideoElement): Promise<void> {
    if (this.stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    this.stream = stream;
    this.video = video;
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // Autoplay can be blocked; the frame capture still works once the
      // stream has data, and user interaction will allow playback.
    }
  }

  /**
   * Capture the current video frame as a JPEG data URL bounded by
   * `maxDim`. The frame is whatever the sensor delivered at this
   * instant — for the shutter flow this IS the shutter frame.
   */
  captureFrame(maxDim = 1024, quality = 0.72): string {
    const video = this.video;
    if (!this.stream || !video || video.videoWidth === 0) {
      throw new Error('Camera not ready');
    }
    const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  }

  /** Stop the stream and release the camera hardware. */
  stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
  }
}

/** Browser error text varies by vendor; use the stable exception name. */
export function cameraErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  switch (name) {
    case 'NotFoundError': case 'DevicesNotFoundError': return 'No camera was found on this device.';
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError': return 'Camera access was denied. Allow camera access in your browser settings.';
    case 'NotReadableError': case 'TrackStartError': return 'The camera cannot be used. Close other apps using it and try again.';
    case 'OverconstrainedError': return 'This camera does not support the requested capture settings.';
    default: return 'The camera could not be started. Check the connection and browser permissions.';
  }
}
