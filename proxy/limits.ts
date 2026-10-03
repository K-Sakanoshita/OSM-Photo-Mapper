/**
 * Pure, runtime-agnostic validation and limiting logic for the reference
 * Responses API proxy (issue #12 blocker 2).
 *
 * Kept free of any Cloudflare/Worker types so it is fully unit-testable
 * with plain vitest. The Worker (worker.ts) is a thin transport layer on
 * top of this module: auth -> rate limit -> validate -> forward.
 *
 * Security goals (issue #12):
 *  - the OpenAI key never appears in the browser or in any client-facing
 *    response;
 *  - the browser authenticates against the proxy with its own token
 *    (constant-time comparison in the worker);
 *  - requests are constrained: model allow-list, bounded image size,
 *    bounded image count, bounded output tokens (spend cap), and a
 *    per-client rate limit.
 */

export interface ProxyConfig {
  /** Models the proxy will forward. Anything else is rejected. */
  allowedModels: string[];
  /** Maximum length (characters) of one image data-URL / base64 payload.
   *  4,500,000 chars ~= 3.4 MB binary — plenty for a phone photo that
   *  has already been downscaled client-side. */
  maxImageChars: number;
  /** Maximum number of input images per request. The app sends exactly
   *  one photo per request; the cap bounds abuse. */
  maxImagesPerRequest: number;
  /** Hard cap for max_output_tokens (spend control). When set, larger
   *  values in the incoming request are clamped down. */
  maxOutputTokens?: number;
  /** Sustained requests per minute per client token. */
  requestsPerMinute: number;
}

export type ProxyVerdict =
  | { ok: true }
  | { ok: false; code: string; message: string };

/** Build a ProxyConfig from raw env values (Worker `env` or tests). */
export function parseProxyConfig(env: Record<string, string | undefined>): ProxyConfig {
  const allowedModels = (env.ALLOWED_MODELS ?? 'gpt-4o-mini')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    allowedModels,
    maxImageChars: intFromEnv(env.MAX_IMAGE_CHARS, 4_500_000),
    maxImagesPerRequest: intFromEnv(env.MAX_IMAGES_PER_REQUEST, 1),
    maxOutputTokens: optIntFromEnv(env.MAX_OUTPUT_TOKENS),
    requestsPerMinute: intFromEnv(env.REQUESTS_PER_MINUTE, 10)
  };
}

function intFromEnv(v: string | undefined, fallback: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function optIntFromEnv(v: string | undefined): number | undefined {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Validate a parsed Responses API request body against the proxy config.
 *
 * Checks, in order:
 *  1. body is a plain object with a string `model`;
 *  2. model is in the allow-list (`model-not-allowed`);
 *  3. at most `maxImagesPerRequest` input images (`too-many-images`);
 *  4. each image payload is at most `maxImageChars` characters
 *     (`image-too-large`);
 *  5. `max_output_tokens`, when present, is a positive number
 *     (`bad-output-tokens`).
 *
 * Input images are recognized as input items of type `input_image`
 * (Responses API) carrying an `image_url` string (data URL or remote
 * URL), and — for resilience — any item with a string `image_url` field.
 */
export function validateResponsesRequest(body: unknown, cfg: ProxyConfig): ProxyVerdict {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('bad-request', 'Request body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  const model = b.model;
  if (typeof model !== 'string' || model.length === 0) {
    return fail('bad-request', 'Request body must include a string "model".');
  }
  if (!cfg.allowedModels.includes(model)) {
    return fail(
      'model-not-allowed',
      `Model "${model}" is not allowed by this proxy. Allowed: ${cfg.allowedModels.join(', ')}.`
    );
  }

  const images = collectImages(b.input);
  if (images.length > cfg.maxImagesPerRequest) {
    return fail(
      'too-many-images',
      `Request carries ${images.length} images; this proxy accepts at most ${cfg.maxImagesPerRequest} per request.`
    );
  }
  for (const len of images) {
    if (len > cfg.maxImageChars) {
      return fail(
        'image-too-large',
        `An image payload is ${len} characters; the limit is ${cfg.maxImageChars}. Downscale the photo client-side before analysis.`
      );
    }
  }

  if (b.max_output_tokens != null) {
    if (typeof b.max_output_tokens !== 'number' || !Number.isFinite(b.max_output_tokens) || b.max_output_tokens <= 0) {
      return fail('bad-output-tokens', '"max_output_tokens" must be a positive number when present.');
    }
  }

  return { ok: true };
}

/**
 * Return a (possibly new) request body with `max_output_tokens` clamped
 * to the configured spend cap. Returns the original body unchanged when
 * no clamp is needed.
 */
export function clampOutputTokens(body: unknown, cfg: ProxyConfig): unknown {
  if (cfg.maxOutputTokens == null) return body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const t = b.max_output_tokens;
  if (typeof t === 'number' && t > cfg.maxOutputTokens) {
    return { ...b, max_output_tokens: cfg.maxOutputTokens };
  }
  return body;
}

/** Lengths (chars) of all image payloads found in a Responses `input`. */
function collectImages(input: unknown): number[] {
  const out: number[] = [];
  if (typeof input === 'string') return out;
  if (!Array.isArray(input)) return out;
  for (const item of input) {
    if (typeof item !== 'object' || item === null) continue;
    const it = item as Record<string, unknown>;
    const url = it.image_url;
    if (typeof url === 'string' && url.length > 0) {
      out.push(url.length);
    } else if (typeof url === 'object' && url !== null) {
      // Chat-completions style { url: string } — accepted for resilience.
      const u = (url as Record<string, unknown>).url;
      if (typeof u === 'string' && u.length > 0) out.push(u.length);
    }
  }
  return out;
}

function fail(code: string, message: string): ProxyVerdict {
  return { ok: false, code, message };
}

/* ------------------------------------------------------------------ */
/* Rate limiting (token bucket, per client token)                     */
/* ------------------------------------------------------------------ */

/**
 * In-memory token-bucket rate limiter, keyed per client (the proxy
 * token). Pure and testable: the clock is injectable.
 *
 * Note (documented in the README): Workers isolates are ephemeral, so
 * this limits bursts PER ISOLATE. That is the correct level for this
 * MVP — each human operator runs one browser, and the hard spend caps
 * (model allow-list, token clamp, image caps) backstop sustained abuse.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  /**
   * @param requestsPerMinute sustained rate per key.
   * @param nowMs injectable clock (ms); defaults to Date.now.
   */
  constructor(requestsPerMinute: number, private readonly nowMs: () => number = Date.now) {
    this.capacity = Math.max(1, requestsPerMinute);
    this.refillPerMs = this.capacity / 60_000;
  }

  /** Try to consume one request for `key`. False when the bucket is dry. */
  tryConsume(key: string): boolean {
    const t = this.nowMs();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + (t - b.last) * this.refillPerMs);
      b.last = t;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Number of tracked keys (tests/diagnostics). */
  get size(): number {
    return this.buckets.size;
  }
}
