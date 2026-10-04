import { load } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';
import * as tf from '@tensorflow/tfjs';
import { BROWSER_VISION_VERSION, browserVisionConfig as config, clipLabels, clipResult, nsfwResult, type BrowserVisionResult } from './policy';
const scope = globalThis as unknown as { postMessage: (data: unknown) => void; onmessage: ((event: MessageEvent<{ image: string }>) => void) | null };
let nsfw: Awaited<ReturnType<typeof load>> | undefined;
let clip: import('@huggingface/transformers').ZeroShotImageClassificationPipeline | undefined;
const progress = (stage: string, percent?: number) => scope.postMessage({ type: 'progress', stage, percent });
scope.onmessage = async ({ data }) => {
  const result: BrowserVisionResult = { version: BROWSER_VISION_VERSION, checkedAt: Date.now(), nsfw: { status: 'error', model: config.nsfw.model }, clip: { status: 'error', model: config.clip.model } };
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(await (await fetch(data.image)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image decoding unavailable');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    try {
      progress('Loading NSFW model');
      if (!nsfw) {
        await tf.setBackend('cpu'); await tf.ready();
        nsfw = await load('MobileNetV2', { modelDefinitions: [MobileNetV2Model] });
      }
      progress('Checking NSFW');
      const predictions = await nsfw.classify(pixels);
      result.nsfw = nsfwResult(predictions.map((p) => ({ label: p.className, score: p.probability })));
    } catch (error) { result.nsfw.error = (error as Error).message; }
    scope.postMessage({ type: 'partial', result });
    try {
      progress('Loading CLIP model');
      const { env, pipeline, RawImage } = await import('@huggingface/transformers');
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;
      if (!clip) clip = await pipeline('zero-shot-image-classification', config.clip.model, {
        device: 'wasm', dtype: 'q8', progress_callback: (event) => {
          if (event.status === 'progress') progress('Loading CLIP model', event.progress);
        }
      });
      progress('Checking OSM purpose');
      const image = new RawImage(pixels.data, pixels.width, pixels.height, 4);
      const predictions = await clip(image, clipLabels.map((c) => c.text), { hypothesis_template: 'This is a photo of {}.' });
      const single = predictions as Array<{ label: string; score: number }>;
      result.clip = clipResult(single.map((p) => ({ label: clipLabels.find((c) => c.text === p.label)?.id ?? p.label, score: p.score })));
    } catch (error) { result.clip.error = (error as Error).message; }
  } catch (error) {
    result.nsfw.error = result.clip.error = (error as Error).message;
  } finally { bitmap?.close(); }
  scope.postMessage({ type: 'result', result });
};
