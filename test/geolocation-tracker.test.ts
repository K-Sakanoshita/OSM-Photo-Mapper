import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeolocationTracker } from '../src/capture/geolocation-tracker';
import { surveyDb } from '../src/db/survey-db';

vi.mock('../src/db/survey-db', () => ({ surveyDb: { addGpsSample: vi.fn().mockResolvedValue(undefined) } }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function locationProvider() {
  let success!: PositionCallback;
  let failure!: PositionErrorCallback;
  const clearWatch = vi.fn();
  const watchPosition = vi.fn((onPosition: PositionCallback, onError: PositionErrorCallback) => {
    success = onPosition;
    failure = onError;
    return 42;
  });
  vi.stubGlobal('navigator', { geolocation: { watchPosition, clearWatch } });
  return { watchPosition, clearWatch, fix: () => success({
    timestamp: 1000, coords: { latitude: 34, longitude: 135, accuracy: 8, heading: 90, speed: 1 }
  } as GeolocationPosition), error: (code = 1) => failure({ code, message: 'GPS error' } as GeolocationPositionError) };
}

describe('survey GPS recording', () => {
  it('streams and persists movement samples until the survey stops', async () => {
    const provider = locationProvider();
    const onSample = vi.fn();
    const tracker = new GeolocationTracker('survey-1', onSample);
    const started = tracker.start();
    provider.fix();
    await started;
    await tracker.start();
    provider.fix();
    expect(provider.watchPosition).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledTimes(2);
    expect(surveyDb.addGpsSample).toHaveBeenCalledWith('survey-1', expect.objectContaining({
      lat: 34, lon: 135, accuracy: 8, movementHeading: 90
    }));
    tracker.stop();
    expect(provider.clearWatch).toHaveBeenCalledWith(42);
    expect(tracker.isRecording).toBe(false);
  });

  it('reports GPS loss after the first fix so the indicator cannot remain on', async () => {
    const provider = locationProvider();
    const onError = vi.fn();
    const tracker = new GeolocationTracker('survey-1', undefined, onError);
    const started = tracker.start();
    provider.fix();
    await started;
    provider.error();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 1 }));
    expect(tracker.isRecording).toBe(false);
    expect(provider.clearWatch).toHaveBeenCalledWith(42);
  });

  it('reports initial GPS denial without leaving a running watch', async () => {
    const provider = locationProvider();
    const onError = vi.fn();
    const tracker = new GeolocationTracker('survey-1', undefined, onError);
    const started = tracker.start();
    const rejection = expect(started).rejects.toMatchObject({ code: 1 });
    provider.error();
    await rejection;
    expect(onError).toHaveBeenCalledTimes(1);
    expect(tracker.isRecording).toBe(false);
  });

  it('keeps watching after temporary GPS loss and receives recovered positions', async () => {
    const provider = locationProvider();
    const onSample = vi.fn();
    const tracker = new GeolocationTracker('survey-1', onSample, vi.fn());
    const started = tracker.start();
    provider.fix();
    await started;
    provider.error(2);
    expect(tracker.isRecording).toBe(true);
    expect(provider.clearWatch).not.toHaveBeenCalled();
    provider.fix();
    expect(onSample).toHaveBeenCalledTimes(2);
    tracker.stop();
  });
});
