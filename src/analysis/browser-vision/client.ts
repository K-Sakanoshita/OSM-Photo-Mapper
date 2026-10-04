import { BROWSER_VISION_VERSION, browserVisionConfig as config, type BrowserVisionResult } from './policy';
export class BrowserVision {
  private worker?: Worker;
  private queue: Promise<unknown> = Promise.resolve();
  check(image: string, progress: (stage: string, percent?: number) => void = () => {}): Promise<BrowserVisionResult> {
    const run = this.queue.then(() => this.run(image, progress));
    this.queue = run.catch(() => {});
    return run;
  }
  private run(image: string, progress: (stage: string, percent?: number) => void): Promise<BrowserVisionResult> {
    return new Promise((resolve) => {
      let partial: BrowserVisionResult | undefined;
      const finish = (result: BrowserVisionResult) => { clearTimeout(timer); resolve(result); };
      const fail = (error: string) => {
        this.worker?.terminate(); this.worker = undefined;
        finish({ version: BROWSER_VISION_VERSION, checkedAt: Date.now(),
          nsfw: partial?.nsfw ?? { status: 'error', model: config.nsfw.model, error },
          clip: { status: 'error', model: config.clip.model, error } });
      };
      const timer = setTimeout(() => fail('Local analysis timed out'), 180_000);
      try {
        if (!/^data:image\//i.test(image)) throw new Error('Local checks require an embedded image');
        this.worker ??= new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = ({ data }) => {
          if (data.type === 'progress') progress(data.stage, data.percent);
          else if (data.type === 'partial') partial = data.result;
          else if (data.type === 'result') finish(data.result);
        };
        this.worker.onerror = () => fail('Local model worker failed');
        this.worker.postMessage({ image });
      } catch (error) { fail((error as Error).message); }
    });
  }
}
