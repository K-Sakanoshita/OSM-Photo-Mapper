/**
 * Reference Responses API proxy (issue #12 blocker 2) — Cloudflare
 * Worker transport layer.
 *
 * What it does, per POST request:
 *   1. CORS (preflight + response headers) — the PWA is a separate
 *      origin and must call the worker cross-origin;
 *   2. authenticate the browser with `Authorization: Bearer <token>`
 *      against the operator's PROXY_TOKEN (constant-time compare);
 *   3. rate-limit per token (TokenBucketRateLimiter);
 *   4. validate the Responses API body (model allow-list, image size
 *      and count caps, output-token sanity) and clamp
 *      max_output_tokens to the spend cap;
 *   5. forward to OpenAI with the server-side OPENAI_API_KEY and
 *      pipe the response back, appending CORS headers.
 *
 * The OpenAI key is a Worker SECRET: it is never in source, never in
 * the browser, and never in any response body. All error responses are
 * small JSON objects that never echo request content or keys.
 *
 * Frontend contract (matches src/analysis/openai-analyzer.ts proxy
 * mode): POST to `https://<worker>.workers.dev/v1/responses` with
 * `content-type: application/json`, optional `authorization: Bearer
 * <proxy token>`, Responses API JSON body; the worker replies with the
 * OpenAI Responses JSON (or an error JSON).
 */
import {
  clampOutputTokens,
  parseProxyConfig,
  TokenBucketRateLimiter,
  validateResponsesRequest
} from './limits';

interface Env {
  /** SECRET: the operator's OpenAI API key. `wrangler secret put`. */
  OPENAI_API_KEY: string;
  /** SECRET: token the browser presents. `wrangler secret put`. */
  PROXY_TOKEN: string;
  /** var: comma-separated model allow-list (default gpt-4o-mini). */
  ALLOWED_MODELS?: string;
  /** var: max chars per image payload. */
  MAX_IMAGE_CHARS?: string;
  /** var: max images per request. */
  MAX_IMAGES_PER_REQUEST?: string;
  /** var: spend cap for max_output_tokens. */
  MAX_OUTPUT_TOKENS?: string;
  /** var: sustained requests per minute per token. */
  REQUESTS_PER_MINUTE?: string;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization'
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return json({ error: { code: 'method-not-allowed', message: 'Only POST is supported.' } }, 405, CORS);
    }
    // Canonical path (the frontend is configured with it); we also
    // accept POST / so the endpoint can be the bare worker origin.
    if (url.pathname !== '/v1/responses' && url.pathname !== '/') {
      return json({ error: { code: 'not-found', message: 'POST /v1/responses.' } }, 404, CORS);
    }

    // 1. Authenticate the browser (constant-time token compare).
    const presented = bearerToken(request.headers.get('authorization'));
    if (!presented || !timingSafeEqual(presented, env.PROXY_TOKEN ?? '')) {
      return json({ error: { code: 'unauthorized', message: 'Missing or invalid proxy token.' } }, 401, CORS);
    }

    // 2. Rate limit per token.
    const cfg = parseProxyConfig(env);
    const limiter = new TokenBucketRateLimiter(cfg.requestsPerMinute);
    // NOTE: the bucket is per-isolate (Workers isolates are ephemeral).
    // It bounds bursts from a single browser; the spend caps below
    // bound total cost. Sufficient for the single-operator MVP.
    if (!limiter.tryConsume(presented)) {
      return json(
        { error: { code: 'rate-limited', message: 'Too many requests. Slow down and retry in a moment.' } },
        429,
        CORS
      );
    }

    // 3. Parse + validate the body.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: { code: 'bad-request', message: 'Body must be valid JSON.' } }, 400, CORS);
    }
    const verdict = validateResponsesRequest(body, cfg);
    if (!verdict.ok) {
      const status = verdict.code === 'model-not-allowed' ? 400 : 413;
      return json({ error: { code: verdict.code, message: verdict.message } }, status, CORS);
    }
    const fwdBody = clampOutputTokens(body, cfg);

    // 4. Forward to OpenAI (server-side key; original model/instructions).
    let upstream: Response;
    try {
      upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify(fwdBody)
      });
    } catch {
      return json(
        { error: { code: 'upstream-unreachable', message: 'Could not reach the upstream API. Retry later.' } },
        502,
        CORS
      );
    }

    // 5. Pipe the response back with CORS. Non-2xx upstream bodies are
    //    returned as-is (they carry OpenAI's own error JSON) so the
    //    client's existing error handling works unchanged.
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    headers.delete('connection');
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};

/* ------------------------------------------------------------------ */

function json(value: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...cors, 'content-type': 'application/json' }
  });
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Constant-time string comparison (prevents timing side-channel on the
 * proxy token). Uses the Workers runtime's timingSafeEqual when present
 * and falls back to a manual XOR accumulator otherwise. Both sides are
 * UTF-8 bytes; length differences are reported through the same
 * constant-time path (compared against a mask) to avoid leaking length.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  const subtle = globalThis.crypto?.subtle as
    | { timingSafeEqual?: (x: BufferSource, y: BufferSource) => boolean }
    | undefined;
  if (subtle?.timingSafeEqual && ba.byteLength === bb.byteLength) {
    return subtle.timingSafeEqual(ba, bb);
  }
  // Fallback: XOR over the max length; missing bytes count as 0, but we
  // still walk the full length (constant work for given lengths).
  const n = Math.max(ba.byteLength, bb.byteLength);
  let diff = ba.byteLength !== bb.byteLength ? 1 : 0;
  for (let i = 0; i < n; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
