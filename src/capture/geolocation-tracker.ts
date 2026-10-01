import type { GpsSample } from '../types';
import { surveyDb } from '../db/survey-db';

/**
 * Continuous GPS + heading recorder for a survey session.
 *
 * Uses the Geolocation API (watchPosition) for the movement track and the
 * DeviceOrientationEvent API for heading when the device/browser supports it.
 * Every sample is persisted immediately so a crash loses at most the in-flight
 * second.
 */
export class GeolocationTracker {
  private watchId: number | null = null;
  private samples: GpsSample[] = [];
  private headingListener: ((e: DeviceOrientationEvent) => void) | null = null;
  private lastHeading: number | undefined;

  constructor(
    private readonly surveyId: string,
    private readonly onSample?: (sample: GpsSample) => void
  ) {}

  /** Begin continuous recording. Resolves once the first fix arrives. */
  async start(): Promise<void> {
    if (this.watchId != null) return;
    this.startHeading();

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
            heading: pos.coords.heading ?? this.lastHeading
          };
          void this.persist(sample);
          resolve();
        },
        (err) => {
          this.stop();
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
    if (this.headingListener) {
      window.removeEventListener('deviceorientation', this.headingListener);
      this.headingListener = null;
    }
  }

  get isRecording(): boolean {
    return this.watchId != null;
  }

  get recordedSamples(): GpsSample[] {
    return this.samples;
  }

  get currentHeading(): number | undefined {
    return this.lastHeading;
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

  private startHeading(): void {
    const DOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    const attach = () => {
      this.headingListener = (e: DeviceOrientationEvent) => {
        // Absolute heading when available; fall back to webkitCompass.
        const h = e.absolute ? e.alpha : (e as unknown as { webkitCompass?: number }).webkitCompass;
        if (typeof h === 'number' && !Number.isNaN(h)) {
          // device alpha is clockwise-from-north already on most platforms.
          this.lastHeading = h;
        }
      };
      window.addEventListener('deviceorientation', this.headingListener);
    };

    if (typeof DOE.requestPermission === 'function') {
      // iOS: permission must be requested from a user gesture.
      DOE.requestPermission().then(
        (res) => {
          if (res === 'granted') attach();
        },
        () => void 0
      );
    } else if ('ondeviceorientation' in window) {
      attach();
    }
  }
}
