import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserVision } from '../src/analysis/browser-vision/client';
import { BROWSER_VISION_VERSION, requiresPhotoReview, type BrowserVisionResult } from '../src/analysis/browser-vision/policy';
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  sent: string[] = [];
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: { image: string }) { this.sent.push(message.image); }
  emit(data: unknown) { this.onmessage?.({ data }); }
}
const result = (): BrowserVisionResult => ({ version: BROWSER_VISION_VERSION, checkedAt: 1, nsfw: { status: 'done', model: 'MobileNetV2', verdict: 'clear' }, clip: { status: 'done', model: 'CLIP', purpose: 'poi' } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeWorker.instances = []; });
describe('worker lifecycle for local photo checks', () => {
  it('serializes photos and reuses the model worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new BrowserVision(), progress = vi.fn();
    const first = client.check('data:image/jpeg;base64,first', progress), second = client.check('data:image/jpeg;base64,second');
    await Promise.resolve();
    const worker = FakeWorker.instances[0];
    expect(worker.sent).toEqual(['data:image/jpeg;base64,first']);
    worker.emit({ type: 'progress', stage: 'Checking NSFW' });
    expect(progress).toHaveBeenCalledWith('Checking NSFW', undefined);
    worker.emit({ type: 'result', result: result() });
    await first; await Promise.resolve(); await Promise.resolve();
    expect(worker.sent).toEqual(['data:image/jpeg;base64,first', 'data:image/jpeg;base64,second']);
    worker.emit({ type: 'result', result: result() });
    expect((await second).clip.purpose).toBe('poi');
    expect(FakeWorker.instances).toHaveLength(1);
  });
  it('preserves completed NSFW evidence when CLIP times out and terminates the worker', async () => {
    vi.useFakeTimers(); vi.stubGlobal('Worker', FakeWorker);
    const promise = new BrowserVision().check('data:image/jpeg;base64,test');
    await Promise.resolve();
    const worker = FakeWorker.instances[0];
    worker.emit({ type: 'partial', result: result() });
    await vi.advanceTimersByTimeAsync(180_000);
    const value = await promise;
    expect(value.clip.status).toBe('error');
    expect(value.nsfw.verdict).toBe('clear');
    expect(requiresPhotoReview(value)).toBe(false);
    expect(worker.terminate).toHaveBeenCalled();
  });
  it('rejects remote image URLs without creating a worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const value = await new BrowserVision().check('https://example.com/private.jpg');
    expect(value.nsfw.status).toBe('error');
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it('reports unsupported workers as an error, not a clear NSFW finding', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('unsupported'); } });
    const value = await new BrowserVision().check('data:image/jpeg;base64,test');
    expect(value.nsfw.status).toBe('error');
    expect(requiresPhotoReview(value)).toBe(true);
  });
});
