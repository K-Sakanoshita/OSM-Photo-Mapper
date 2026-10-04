import { describe, expect, it, vi } from 'vitest';
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
      { id: 'toilets', label: 'Public toilets' },
      {
        id: 'playground',
        label: 'Playground equipment',
        visualAttributes: [{ key: 'playground', allowedValues: ['slide', 'swing', 'roundabout', 'sandbox', 'other'] }],
        visualHint: 'A swing frame with multiple seats is one swing.'
      }
    ]
  };
}

/** Captured request of the last fetch call. */
let lastUrl: string | undefined;
let lastInit: RequestInit | undefined;

/** Stub fetch returning a Responses API JSON response whose first
 *  message item carries `output_text` (the JSON observations payload). */
function stubFetch(payload: string, status = 200) {
  return (async (url: string, init?: RequestInit) => {
    lastUrl = url;
    lastInit = init;
    return new Response(payload, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/** A completed Responses response wrapping the observations array.
 *  Structured on the documented raw-response shape
 *  (developers.openai.com, structured outputs): generated text arrives
 *  as `message.content[].type === "output_text"` — NOT "text".
 *  (issue #14) */
function responsesWith(observations: unknown): string {
  return JSON.stringify({
    id: 'resp_test',
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify({ observations }) }]
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
        attributes: [{ key: 'color', value: 'red' }],
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

  it('preserves separate boxes and visual attributes for multiple objects, including the same class', async () => {
    const firstBox = { x: 0.1, y: 0.2, w: 0.3, h: 0.5 };
    const secondBox = { x: 0.6, y: 0.3, w: 0.2, h: 0.4 };
    const res = await analyzer(stubFetch(responsesWith([
      { featureType: 'playground', bbox: firstBox, attributes: [{ key: 'playground', value: 'swing' }], detectionConfidence: 0.99 },
      { featureType: 'playground', bbox: secondBox, attributes: [{ key: 'playground', value: 'slide' }], detectionConfidence: 0.88 }
    ]))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res).toHaveLength(2);
    expect(res.map((item) => item.bbox)).toEqual([firstBox, secondBox]);
    expect(res.map((item) => item.attributes.playground)).toEqual(['swing', 'slide']);
  });

  it('resolves playground + swing locally without a second API request', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return new Response(responsesWith([
        { featureType: 'playground', bbox: BOX, attributes: [{ key: 'visualType', value: 'swing' }], detectionConfidence: 0.99 }
      ]), { status: 200 });
    }) as typeof fetch;
    const result = await analyzer(fetchImpl).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(bodies).toHaveLength(1);
    expect(result).toEqual([expect.objectContaining({ featureType: 'playground', attributes: { playground: 'swing' } })]);
    expect(JSON.stringify(bodies[0])).not.toContain('playground_swing');
  });

  it('resolves the observed equipment=swing set without a second API request', async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      return new Response(responsesWith([
        { featureType: 'playground', bbox: BOX, attributes: [
          { key: 'equipment', value: 'swing set' },
          { key: 'material', value: 'metal frame and chains' },
          { key: 'seats', value: '2' }
        ], detectionConfidence: 0.99 }
      ]), { status: 200 });
    }) as typeof fetch;
    const result = await analyzer(fetchImpl).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(requests).toBe(1);
    expect(result).toEqual([expect.objectContaining({ featureType: 'playground', attributes: {
      playground: 'swing', material: 'metal frame and chains', seats: '2'
    } })]);
  });

  it('continues an unresolved shop with text-only subtype choices and the previous response ID', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return new Response(bodies.length === 1
        ? responsesWith([{ featureType: 'shop', bbox: BOX, attributes: [{ key: 'visualType', value: 'storefront' }], detectionConfidence: 0.85 }])
        : responsesWith([{ featureType: 'shop_bakery', bbox: { x: 0.205, y: 0.305, w: 0.39, h: 0.29 }, attributes: [], detectionConfidence: 0.85 }]), { status: 200 });
    }) as typeof fetch;
    const result = await analyzer(fetchImpl).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(bodies).toHaveLength(2);
    expect(bodies[1].previous_response_id).toBe('resp_test');
    expect(JSON.stringify(bodies[1])).not.toContain('input_image');
    expect(JSON.stringify(bodies[1])).toContain('shop_bakery');
    expect(JSON.stringify(bodies[1])).not.toContain('playground_swing');
    expect(result[0].featureType).toBe('shop_bakery');
  });

  it('matches two unresolved objects to their own boxes even if refinement returns reversed order', async () => {
    const left = { x: 0.05, y: 0.2, w: 0.3, h: 0.5 };
    const right = { x: 0.6, y: 0.2, w: 0.3, h: 0.5 };
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      return new Response(requests === 1
        ? responsesWith([
          { featureType: 'shop', bbox: left, attributes: [{ key: 'visualType', value: 'storefront' }], detectionConfidence: 0.9 },
          { featureType: 'shop', bbox: right, attributes: [{ key: 'visualType', value: 'storefront' }], detectionConfidence: 0.9 }
        ])
        : responsesWith([
          { featureType: 'shop_bakery', bbox: right, attributes: [], detectionConfidence: 0.9 },
          { featureType: 'shop_convenience', bbox: left, attributes: [], detectionConfidence: 0.9 }
        ]), { status: 200 });
    }) as typeof fetch;
    const result = await analyzer(fetchImpl).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(requests).toBe(2);
    expect(result.map((item) => item.featureType)).toEqual(['shop_convenience', 'shop_bakery']);
    expect(result.map((item) => item.bbox)).toEqual([left, right]);
  });

  it('keeps unresolved first-pass evidence without an automatic tag when refinement fails', async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      return new Response(requests === 1
        ? responsesWith([{ featureType: 'playground', bbox: BOX, attributes: [{ key: 'visualType', value: 'unfamiliar device' }], detectionConfidence: 0.8 }])
        : JSON.stringify({ error: { message: 'temporary failure' } }), { status: requests === 1 ? 200 : 502 });
    }) as typeof fetch;
    const result = await analyzer(fetchImpl).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(requests).toBe(2);
    expect(result[0].featureType).toBe('unknown');
    expect(result[0].attributes).toMatchObject({ visualCategory: 'playground', visualType: 'unfamiliar device' });
  });

  it('does not auto-map contradictory or low-confidence subtype evidence', async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      return new Response(requests === 1
        ? responsesWith([{ featureType: 'playground', bbox: BOX, attributes: [
          { key: 'visualType', value: 'swing' }, { key: 'playground', value: 'slide' }
        ], detectionConfidence: 0.95 }])
        : responsesWith([{ featureType: 'playground_swing', bbox: BOX, attributes: [], detectionConfidence: 0.5 }]), { status: 200 });
    }) as typeof fetch;
    const result = await analyzer(fetchImpl).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(requests).toBe(2);
    expect(result[0].featureType).toBe('unknown');
    expect(result[0].attributes).toMatchObject({ visualCategory: 'playground', visualType: 'swing', playground: 'slide' });
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
    expect(body.model).toBe('gpt-6-luna');
    // The first pass sees only broad groups, never the subtype catalog.
    expect(body.instructions).toContain('- playground (Playground equipment and facilities)');
    expect(body.instructions).toContain('- shop (Retail shops)');
    expect(body.instructions).not.toContain('playground_swing');
    expect(body.instructions).not.toContain('shop_bakery');
    expect(body.store).toBe(true);
    expect(body.instructions).toContain('foreground, background, edges, and partly occluded objects');
    expect(body.instructions).toContain('multiple objects in the same category');
    expect(body.instructions).toContain('visualType');
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
    // Structured output: the API requires a closed root object and every
    // property required, with null for optional values.
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.name).toBe('observations');
    expect(body.text.format.strict).toBe(true);
    const schema = body.text.format.schema as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: { observations: { items: {
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, unknown> & { attributes: { items: { additionalProperties: boolean; required: string[] } } };
      } } };
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['observations']);
    expect(schema.additionalProperties).toBe(false);
    const item = schema.properties.observations.items;
    expect(item.required).toEqual(Object.keys(item.properties));
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.attributes.items.required).toEqual(['key', 'value']);
    expect(item.properties.attributes.items.additionalProperties).toBe(false);
  });

  it('resolves to an empty array when the API answers "no objects"', async () => {
    const res = await analyzer().analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res).toEqual([]);
  });

  it('normalizes nullable evidence fields and attribute pairs from strict output', async () => {
    const res = await analyzer(stubFetch(responsesWith([{
      featureType: 'bench', bbox: BOX,
      attributes: [{ key: 'color', value: 'green' }],
      ocrText: null, ocrConfidence: null,
      detectionConfidence: 0.8,
      distanceEstimate: null, distanceUncertaintyM: null,
      identityEvidence: null
    }]))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res).toEqual([expect.objectContaining({ featureType: 'bench', attributes: { color: 'green' } })]);
    expect(res[0].ocrText).toBeUndefined();
    expect(res[0].distanceEstimate).toBeUndefined();
  });

  it('keeps unknown objects as "unknown" (never forced into a class)', async () => {
    const res = await analyzer(stubFetch(responsesWith([
      { featureType: 'flying_saucer', bbox: BOX, attributes: [], detectionConfidence: 0.9 }
    ]))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res).toHaveLength(1);
    expect(res[0].featureType).toBe('unknown');
  });

  it('drops non-string attribute values (raw evidence stays clean)', async () => {
    const res = await analyzer(stubFetch(responsesWith([
      { featureType: 'bench', bbox: BOX, attributes: [{ key: 'color', value: 'red' }, { key: 'size', value: 42 }], detectionConfidence: 0.9 }
    ]))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    expect(res[0].attributes).toEqual({ color: 'red' });
  });

  it('rejects on malformed JSON text (output_text item)', async () => {
    const payload = JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }]
    });
    await expect(
      analyzer(stubFetch(payload)).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('malformed JSON');
  });

  it('ignores the wrong content-item type "text" (regression guard, issue #14)', async () => {
    // If the parser ever reverts to expecting type "text", this payload
    // contains no output_text item and must fail with "no text output".
    const payload = JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'text', text: '[]' }] }]
    });
    await expect(
      analyzer(stubFetch(payload)).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('no text output');
  });

  it('rejects when the API returns no text output', async () => {
    await expect(
      analyzer(stubFetch(JSON.stringify({ status: 'completed', output: [] }))).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('no text output');
  });

  it('rejects on a top-level refusal output item (per-photo failure)', async () => {
    const payload = JSON.stringify({
      status: 'completed',
      output: [{ type: 'refusal', refusal: 'Content policy violation' }]
    });
    await expect(
      analyzer(stubFetch(payload)).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('refused');
  });

  it('rejects on a refusal inside message content (issue #14)', async () => {
    // Refusals arrive as message-content items, not only top-level
    // output items: { "type": "refusal", "refusal": "..." }.
    const payload = JSON.stringify({
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Content policy' }] }
      ]
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

  it('rejects a cancelled run', async () => {
    const payload = JSON.stringify({ status: 'cancelled', error: { message: 'cancelled' } });
    await expect(
      analyzer(stubFetch(payload)).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('run cancelled');
  });

  it('rejects an incomplete run with its reason (partial output never parsed, issue #14)', async () => {
    const payload = JSON.stringify({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      // A partial output_text item must NOT be parsed even if present.
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[{"featureType":"bench"' }]
      }
    ]
    });
    await expect(
      analyzer(stubFetch(payload)).analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))
    ).rejects.toThrow('incomplete (max_output_tokens)');
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
    expect(body).not.toHaveProperty('temperature');
  });

  it.each(['gpt-6-luna', 'gpt-6.1-sol'])('omits unsupported sampling parameters for %s', async (model) => {
    const a = analyzer(undefined, { model });
    await a.analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')));
    const body = JSON.parse(lastInit!.body as string);
    expect(body.model).toBe(model);
    expect(body).not.toHaveProperty('temperature');
    expect(body.text.format.type).toBe('json_schema');
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
  it('calls the default browser fetch with the global receiver', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    const browserLikeFetch = function (this: unknown): Promise<Response> {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      called = true;
      return Promise.resolve(new Response(responsesWith([]), { status: 200 }));
    } as typeof fetch;
    vi.stubGlobal('fetch', browserLikeFetch);
    try {
      const a = new OpenAIVisionAnalyzer({ mode: 'proxy', endpoint: 'https://proxy.example/responses' });
      await expect(a.analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1')))).resolves.toEqual([]);
      expect(called).toBe(true);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });
  function proxyAnalyzer(over: Record<string, unknown> = {}) {
    return new OpenAIVisionAnalyzer({
      mode: 'proxy',
      endpoint: 'https://proxy.example/responses',
      proxyAuth: 'tok-123',
      fetchImpl: stubFetch(responsesWith([])),
      ...over
    } as OpenAIVisionConfig);
  }

  it('redacts a proxy token echoed in an API error', async () => {
    const a = proxyAnalyzer({ fetchImpl: stubFetch('proxy rejected tok-123', 401) });
    await expect(a.analyzePhoto(makePhoto('p1'), makeContext(makePhoto('p1'))))
      .rejects.toThrow('proxy rejected [redacted]');
  });

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
    expect(body.instructions).toContain('- street_furniture (Street furniture and small outdoor objects)');
    const msg = inputMessage(body);
    expect(msg.content[0].type).toBe('input_image');
    expect(msg.content[0].image_url).toBe('data:image/jpeg;base64,TESTDATA');
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.strict).toBe(true);
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

describe('explicit object comparison', () => {
  const items = ['a', 'b'].map((id) => ({ photo: makePhoto(id), observation: { id, photoId: id, surveyId: 's1', featureType: 'unknown', bbox: { x: .2, y: .3, w: .4, h: .5 }, tagSuggestions: {}, tagConfidence: .9 } }));
  const response = (verdict: string) => JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ verdict, reason: 'Unique inscription matches' }) }] }] });
  it('sends both marked objects and parses a verdict without modifying observations', async () => {
    const instance = analyzer(stubFetch(response('same')));
    expect(await instance.compareObjects(items)).toEqual({ verdict: 'same', reason: 'Unique inscription matches' });
    const body = JSON.parse(lastInit!.body as string);
    expect(body.input[0].content.filter((c: { type: string }) => c.type === 'input_image')).toHaveLength(2);
    expect(body.instructions).toContain('NOT proof');
    expect(items[0].observation.featureType).toBe('unknown');
  });
  it('keeps uncertain and different verdicts distinct', async () => {
    for (const verdict of ['uncertain', 'different']) expect((await analyzer(stubFetch(response(verdict))).compareObjects(items)).verdict).toBe(verdict);
  });
  it('rejects invalid verdicts', async () => {
    await expect(analyzer(stubFetch(response('merge immediately'))).compareObjects(items)).rejects.toThrow('Invalid identity');
  });
});
