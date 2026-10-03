import { describe, expect, it } from 'vitest';
import type { AnalysisContext } from '../src/analysis/analyzer';
import type { OpenAIVisionConfig } from '../src/analysis/openai-analyzer';
import { OpenAIVisionAnalyzer } from '../src/analysis/openai-analyzer';
import type { Photo } from '../src/types';

/* ------------------------------------------------------------------ */
/* Helpers (Responses API shapes — issue #12)                         */
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

/** Stub fetch returning a Responses API JSON response whose first
 *  message item carries `text` (the JSON observations payload). */
function stubFetch(payload: string, status = 200) {
  return (async (url: string, init?: RequestInit) => {
    lastUrl = url;
    lastInit = init;
    return new Response(payload, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/** A completed Responses response wrapping the observations array. */
function responsesWith(observations: unknown): string {
  return JSON.stringify({
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify(observations) }]
      }
    ]
  });
}

function analyzer(fetchImpl = stubFetch(responsesWith([])), over: Record<string, unknown> = {}) {
  return new OpenAIVisionAnalyzer({ mode: 'direct', apiKey: 'sk-test', fetchImpl, ...over } as OpenAIVisionConfig);
}

const BOX = { x: 0.2, y: 0.3, w: 0.4, h: 0.3 };

/** The input message of a Responses API request body. */
function inputMessage(body: { input: unknown[] }): { content: Record<string, unknown>[] } {
  return body.input[0] as { content: Record<string, unknown>[] };
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe('OpenAIVisionAnalyzer (issues #2 + #12: Responses API, dual transport)', () => {
  it('parses a valid schema response into validated VisualObservations', async () => {
    const res = await analyzer(stubFetch(responsesWith([
      {
        featureType: 'bench',
        bbox: BOX,
        attributes: { color: 'red' },
        ocrText: 'Park bench',
        ocrConfidence: 0.7,
        detectionConfidence: 0.85
      }
    ]))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res).toHaveLength(1);
    expect(res[0].featureType).toBe('bench');
    expect(res[0].bbox).toEqual(BOX);
    expect(res[0].attributes).toEqual({ color: 'red' });
    expect(res[0].ocrText).toBe('Park bench');
    expect(res[0].ocrConfidence).toBe(0.7);
    expect(res[0].detectionConfidence).toBe(0.85);
  });

  it('sends the Responses API request: key, image, vocabulary, json_schema text.format', async () => {
    await analyzer().analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    // Direct mode hits the OpenAI Responses API endpoint.
    expect(lastUrl).toBe('https://api.openai.com/v1/responses');
    const headers = lastInit!.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(lastInit!.body as string) as {
      model: string;
      instructions: string;
      input: unknown[];
      text: { format: { type: string; name: string; schema: unknown; strict?: unknown } };
    };
    expect(body.model).toBe('gpt-4o-mini');
    // Closed vocabulary + rules travel via top-level `instructions`.
    expect(body.instructions).toContain('- bench (Bench)');
    expect(body.instructions).toContain('- toilets (Public toilets)');
    expect(body.instructions).toContain('unknown');
    // The image + prompt travel as input message items.
    const msg = inputMessage(body);
    expect(msg.content[0]).toEqual({
      type: 'input_image',
      image_url: 'data:image/jpeg;base64,TESTDATA',
      detail: 'high'
    });
    expect(msg.content[1].type).toBe('input_text');
    expect(typeof msg.content[1].text).toBe('string');
    // Structured output: text.format json_schema — NO `strict` flag
    // (strict mode rejects the nullable fields; the client-side
    // validator is the real guarantee).
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.name).toBe('observations');
    expect(body.text.format.strict).toBeUndefined();
    expect((body.text.format.schema as { type: string }).type).toBe('array');
  });

  it('resolves to an empty array when the API answers "no objects"', async () => {
    const res = await analyzer().analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res).toEqual([]);
  });

  it('keeps unknown objects as "unknown" (never forced into a class)', async () => {
    const res = await analyzer(stubFetch(responsesWith([
      { featureType: 'flying_saucer', bbox: BOX, attributes: {}, detectionConfidence: 0.9 }
    ]))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res).toHaveLength(1);
    expect(res[0].featureType).toBe('unknown');
  });

  it('drops non-string attribute values (raw evidence stays clean)', async () => {
    const res = await analyzer(stubFetch(responsesWith([
      { featureType: 'bench', bbox: BOX, attributes: { color: 'red', size: 42 }, detectionConfidence: 0.9 }
    ]))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res[0].attributes).toEqual({ color: 'red' });
  });

  it('rejects on malformed JSON text', async () => {
    const payload = JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'text', text: 'not json' }] }]
    });
    await expect(
      analyzer(stubFetch(payload)).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('malformed JSON');
  });

  it('rejects when the API returns no text output', async () => {
    await expect(
      analyzer(stubFetch(JSON.stringify({ status: 'completed', output: [] }))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('no text output');
  });

  it('rejects on a refusal item (per-photo failure, batch continues)', async () => {
    const payload = JSON.stringify({
      status: 'completed',
      output: [{ type: 'refusal', refusal: 'Content policy violation' }]
    });
    await expect(
      analyzer(stubFetch(payload)).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('refused');
  });

  it('rejects when the run itself failed', async () => {
    const payload = JSON.stringify({
      status: 'failed',
      error: { message: 'Content policy' }
    });
    await expect(
      analyzer(stubFetch(payload)).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('run failed');
  });

  it('rejects on API/network errors with status and detail', async () => {
    await expect(
      analyzer(stubFetch(JSON.stringify({ error: { message: 'Rate limit reached' } }), 429))
        .analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('OpenAI API error 429');
  });

  it('never includes the API key in error messages', async () => {
    const a = analyzer(stubFetch(JSON.stringify({ error: { message: 'bad key' } }), 401));
    await expect(
      a.analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('OpenAI API error 401');
    // The key must not leak into the thrown message.
    let err: unknown;
    try {
      await a.analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('sk-test');
  });

  it('rejects when the photo has no image data (fetch never called)', async () => {
    const noImage = makePhoto('p1', { image: undefined });
    const fetchImpl = (async () => {
      throw new Error('fetch should not be called');
    }) as unknown as typeof fetch;
    await expect(analyzer(fetchImpl).analyzePhoto(noImage, makeContext(noImage))).rejects.toThrow('no image data');
  });

  it('honours the configured model', async () => {
    const a = analyzer(undefined, { model: 'gpt-4o' });
    await a.analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    const body = JSON.parse(lastInit!.body as string);
    expect(body.model).toBe('gpt-4o');
  });
});

/* ------------------------------------------------------------------ */
/* Config validation (issue #12)                                      */
/* ------------------------------------------------------------------ */

describe('OpenAIVisionAnalyzer configuration (issue #12)', () => {
  it('requires an API key in direct mode (the app never ships a secret)', () => {
    expect(() => new OpenAIVisionAnalyzer({ mode: 'direct', apiKey: '   ' })).toThrow('API key is required');
  });

  it('defaults to direct mode when no mode is given', () => {
    const a = new OpenAIVisionAnalyzer({ apiKey: 'sk-test' });
    expect(a.name).toBe('openai');
  });

  it('requires a proxy endpoint in proxy mode', () => {
    expect(() => new OpenAIVisionAnalyzer({ mode: 'proxy' })).toThrow('Proxy endpoint is required');
    expect(() => new OpenAIVisionAnalyzer({ mode: 'proxy', endpoint: '  ' })).toThrow('Proxy endpoint is required');
  });
});

/* ------------------------------------------------------------------ */
/* Proxy transport (issue #12: the recommended production path)       */
/* ------------------------------------------------------------------ */

describe('proxy transport (issue #12)', () => {
  function proxyAnalyzer(over: Record<string, unknown> = {}) {
    return new OpenAIVisionAnalyzer({
      mode: 'proxy',
      endpoint: 'https://proxy.example/responses',
      proxyAuth: 'tok-123',
      fetchImpl: stubFetch(responsesWith([])),
      ...over
    } as OpenAIVisionConfig);
  }

  it('posts to the proxy endpoint with the proxy token', async () => {
    await proxyAnalyzer().analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(lastUrl).toBe('https://proxy.example/responses');
    const headers = lastInit!.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok-123');
    // The OpenAI key is NOT involved at all in proxy mode.
    expect(JSON.stringify(lastInit)).not.toContain('sk-test');
  });

  it('sends the same Responses API body as direct mode', async () => {
    await proxyAnalyzer().analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    const body = JSON.parse(lastInit!.body as string) as {
      instructions: string;
      input: unknown[];
      text: { format: { type: string; name: string; strict?: unknown } };
    };
    expect(body.instructions).toContain('- bench (Bench)');
    const msg = inputMessage(body);
    expect(msg.content[0].type).toBe('input_image');
    expect(msg.content[0].image_url).toBe('data:image/jpeg;base64,TESTDATA');
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.strict).toBeUndefined();
  });

  it('omits the Authorization header when no proxy token is set', async () => {
    await new OpenAIVisionAnalyzer({
      mode: 'proxy',
      endpoint: 'https://proxy.example/responses',
      fetchImpl: stubFetch(responsesWith([]))
    } as OpenAIVisionConfig).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    const headers = lastInit!.headers as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });
});
