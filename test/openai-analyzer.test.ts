import { describe, expect, it } from 'vitest';
import type { AnalysisContext } from '../src/analysis/analyzer';
import { OpenAIVisionAnalyzer } from '../src/analysis/openai-analyzer';
import type { Photo } from '../src/types';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function makePhoto(id: string, over: Partial<Photo> = {}): Photo {
  return {
    id,
    surveyId: 's1',
    timestamp: 2_000_000,
    timestampSource: 'exif',
    image: 'data:image/jpeg;base64,TESTDATA',
    ...over
  };
}

function makeContext(photo: Photo): AnalysisContext {
  return {
    surveyId: 's1',
    photo,
    featureClasses: [
      { id: 'bench', label: 'Bench' },
      { id: 'toilets', label: 'Public toilets' }
    ]
  };
}

/** Captured request of the last fetch call. */
let lastUrl: string | undefined;
let lastInit: RequestInit | undefined;

/** Stub fetch returning a JSON chat-completions response whose
 *  choices[0].message.content is `content`. */
function stubFetch(content: string, status = 200) {
  return (async (url: string, init?: RequestInit) => {
    lastUrl = url;
    lastInit = init;
    return new Response(content, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/** The observation array a stub response should carry in `content`. */
function contentWith(observations: unknown): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify(observations) } }]
  });
}

function analyzer(fetchImpl = stubFetch(contentWith([])), over: Record<string, unknown> = {}) {
  return new OpenAIVisionAnalyzer({ apiKey: 'sk-test', fetchImpl, ...over });
}

const BOX = { x: 0.2, y: 0.3, w: 0.4, h: 0.3 };

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe('OpenAIVisionAnalyzer (issue #2: BYOK provider)', () => {
  it('parses a valid schema response into validated VisualObservations', async () => {
    const content = contentWith([
      {
        featureType: 'bench',
        bbox: BOX,
        attributes: { color: 'red' },
        ocrText: 'Park bench',
        ocrConfidence: 0.7,
        detectionConfidence: 0.85
      }
    ]);
    const res = await analyzer(stubFetch(content)).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res).toHaveLength(1);
    expect(res[0].featureType).toBe('bench');
    expect(res[0].bbox).toEqual(BOX);
    expect(res[0].attributes).toEqual({ color: 'red' });
    expect(res[0].ocrText).toBe('Park bench');
    expect(res[0].ocrConfidence).toBe(0.7);
    expect(res[0].detectionConfidence).toBe(0.85);
  });

  it('sends the BYOK key, the image data URL and the closed class vocabulary', async () => {
    await analyzer(stubFetch(contentWith([]))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(lastUrl).toBe('https://api.openai.com/v1/chat/completions');
    const headers = lastInit!.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(lastInit!.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('observations');
    const system = body.messages[0].content as string;
    expect(system).toContain('- bench (Bench)');
    expect(system).toContain('- toilets (Public toilets)');
    expect(system).toContain('unknown');
    const user = body.messages[1].content as { type: string; image_url?: { url: string }; text?: string }[];
    expect(user[0].image_url!.url).toBe('data:image/jpeg;base64,TESTDATA');
    expect(user[1].text).toBeDefined();
  });

  it('resolves to an empty array when the API answers "no objects"', async () => {
    const res = await analyzer(stubFetch(contentWith([]))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res).toEqual([]);
  });

  it('keeps unknown objects as "unknown" (never forced into a class)', async () => {
    const res = await analyzer(stubFetch(contentWith([
      { featureType: 'flying_saucer', bbox: BOX, attributes: {}, detectionConfidence: 0.9 }
    ]))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res).toHaveLength(1);
    expect(res[0].featureType).toBe('unknown');
  });

  it('drops non-string attribute values (raw evidence stays clean)', async () => {
    const res = await analyzer(stubFetch(contentWith([
      { featureType: 'bench', bbox: BOX, attributes: { color: 'red', size: 42 }, detectionConfidence: 0.9 }
    ]))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res[0].attributes).toEqual({ color: 'red' });
  });

  it('rejects on malformed JSON content', async () => {
    await expect(
      analyzer(stubFetch('{"choices":[{"message":{"content":"not json"}}]}')).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('malformed JSON');
  });

  it('rejects when the API returns no content', async () => {
    await expect(
      analyzer(stubFetch('{"choices":[]}')).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('no content');
  });

  it('rejects on API/network errors with status and detail', async () => {
    const content = JSON.stringify({ error: { message: 'Rate limit reached' } });
    await expect(
      analyzer(stubFetch(content, 429)).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('OpenAI API error 429');
  });

  it('rejects when the photo has no image data (fetch never called)', async () => {
    const noImage = makePhoto('p1', { image: undefined });
    const fetchImpl = (async () => {
      throw new Error('fetch should not be called');
    }) as unknown as typeof fetch;
    await expect(analyzer(fetchImpl).analyzePhoto(noImage, makeContext(noImage))).rejects.toThrow('no image data');
  });

  it('requires an API key (BYOK — the app never ships a secret)', () => {
    expect(() => new OpenAIVisionAnalyzer({ apiKey: '   ' })).toThrow('API key is required');
  });

  it('honours the configured model and endpoint', async () => {
    const a = analyzer(stubFetch(contentWith([])), { model: 'gpt-4o', endpoint: 'https://example.test/v1/chat/completions' });
    await a.analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(lastUrl).toBe('https://example.test/v1/chat/completions');
    const body = JSON.parse(lastInit!.body as string);
    expect(body.model).toBe('gpt-4o');
  });
});
