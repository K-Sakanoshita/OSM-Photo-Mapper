import type { GpsSample } from '../types';
import { surveyDb } from '../db/survey-db';

/**
 * Continuous GPS recorder for a survey session (the movement track).
 *
 * Uses the Geolocation API (watchPosition). Every sample is persisted
 * immediately so a crash loses at most the in-flight second.
 *
 * Issue #3 (camera vs movement bearing): this tracker is the ONLY source
 * of the MOVEMENT track. It does NOT listen to `deviceorientation` — the
 * camera bearing comes exclusively from the OrientationTracker
 * (src/capture/orientation.ts), the single normalized orientation path.
 * The `movementHeading` on a sample is the direction of travel (course
 * over ground) reported by the location provider: contextual evidence
 * only, never a camera heading.
 */
export class GeolocationTracker {
  private watchId: number | null = null;
  private samples: GpsSample[] = [];

  constructor(
    private readonly surveyId: string,
    private readonly onSample?: (sample: GpsSample) => void,
    private readonly onError?: (error: GeolocationPositionError) => void
  ) {}

  /** Begin continuous recording. Resolves once the first fix arrives. */
  async start(): Promise<void> {
    if (this.watchId != null) return;

    await new Promise<void>((resolve, reject) => {
      const opts: PositionOptions = { enableHighAccuracy: true, maximumAge: 1500, timeout: 20000 };
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const sample: GpsSample = {
            id: `gps-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: pos.timestamp,
            speed: pos.coords.speed ?? undefined,
            // Direction of travel (course over ground) — MOVEMENT bearing,
            // not camera bearing (issue #3). No orientation fallback: the
            // two are distinct evidence and must never be conflated.
            movementHeading: pos.coords.heading ?? undefined
          };
          void this.persist(sample);
          resolve();
        },
        (err) => {
          // Temporary GPS loss can recover on the same watch. Permission
          // denial cannot, so release that watch until the next survey session.
          if (err.code === 1) this.stop();
          this.onError?.(err);
          reject(err);
        },
        opts
      );
    });
  }

  stop(): void {
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  get isRecording(): boolean {
    return this.watchId != null;
  }

  get recordedSamples(): GpsSample[] {
    return this.samples;
  }

  /** Most recent sample (or the one nearest a timestamp). */
  nearestSample(at?: number): GpsSample | undefined {
    if (this.samples.length === 0) return undefined;
    if (at == null) return this.samples[this.samples.length - 1];
    let best = this.samples[0];
    let bestDt = Math.abs(best.timestamp - at);
    for (const s of this.samples) {
      const dt = Math.abs(s.timestamp - at);
      if (dt < bestDt) {
        best = s;
        bestDt = dt;
      }
    }
    return best;
  }

  private async persist(sample: GpsSample): Promise<void> {
    this.samples.push(sample);
    this.onSample?.(sample);
    await surveyDb.addGpsSample(this.surveyId, sample);
  }
}
