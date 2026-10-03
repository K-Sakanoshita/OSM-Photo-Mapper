import { describe, expect, it } from 'vitest';
import {
  clampOutputTokens,
  parseProxyConfig,
  TokenBucketRateLimiter,
  validateResponsesRequest
} from '../proxy/limits';
import type { ProxyConfig } from '../proxy/limits';

const CFG: ProxyConfig = {
  allowedModels: ['gpt-4o-mini'],
  maxImageChars: 1000,
  maxImagesPerRequest: 1,
  maxOutputTokens: 2000,
  requestsPerMinute: 6
};

/** A valid minimal Responses API vision request body. */
const validBody = (over: Record<string, unknown> = {}) => ({
  model: 'gpt-4o-mini',
  instructions: 'test',
  input: [
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,' + 'A'.repeat(100) }
  ],
  max_output_tokens: 500,
  text: { format: { type: 'json_schema', name: 'x', schema: {} } },
  ...over
});

describe('proxy/limits (issue #12 blocker 2: reference Responses API proxy)', () => {
  describe('validateResponsesRequest', () => {
    it('accepts a well-formed request', () => {
      expect(validateResponsesRequest(validBody(), CFG).ok).toBe(true);
    });

    it('rejects non-object bodies', () => {
      expect(validateResponsesRequest(null, CFG)).toMatchObject({ ok: false, code: 'bad-request' });
      expect(validateResponsesRequest('str', CFG)).toMatchObject({ ok: false, code: 'bad-request' });
      expect(validateResponsesRequest([1, 2], CFG)).toMatchObject({ ok: false, code: 'bad-request' });
    });

    it('rejects missing/non-string model', () => {
      expect(validateResponsesRequest(validBody({ model: undefined }), CFG)).toMatchObject({ ok: false, code: 'bad-request' });
      expect(validateResponsesRequest(validBody({ model: 42 }), CFG)).toMatchObject({ ok: false, code: 'bad-request' });
    });

    it('rejects models outside the allow-list (spend control)', () => {
      const v = validateResponsesRequest(validBody({ model: 'gpt-4o' }), CFG);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.code).toBe('model-not-allowed');
        expect(v.message).toContain('gpt-4o-mini');
      }
    });

    it('rejects too many images per request', () => {
      const img = (c: string) => ({ type: 'input_image', image_url: 'data:image/jpeg;base64,' + c });
      const v = validateResponsesRequest(
        validBody({ input: [img('A'.repeat(10)), img('B'.repeat(10))] }),
        CFG
      );
      expect(v).toMatchObject({ ok: false, code: 'too-many-images' });
    });

    it('rejects oversized image payloads', () => {
      const v = validateResponsesRequest(
        validBody({ input: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,' + 'A'.repeat(1200) }] }),
        CFG
      );
      expect(v).toMatchObject({ ok: false, code: 'image-too-large' });
    });

    it('rejects malformed max_output_tokens', () => {
      expect(validateResponsesRequest(validBody({ max_output_tokens: -5 }), CFG)).toMatchObject({
        ok: false,
        code: 'bad-output-tokens'
      });
      expect(validateResponsesRequest(validBody({ max_output_tokens: 'x' }), CFG)).toMatchObject({
        ok: false,
        code: 'bad-output-tokens'
      });
    });

    it('accepts requests without images (text-only) and without max_output_tokens', () => {
      expect(
        validateResponsesRequest(
          { model: 'gpt-4o-mini', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
          CFG
        ).ok
      ).toBe(true);
    });
  });

  describe('clampOutputTokens', () => {
    it('clamps max_output_tokens down to the spend cap', () => {
      const body = validBody({ max_output_tokens: 5000 });
      const out = clampOutputTokens(body, CFG) as Record<string, unknown>;
      expect(out.max_output_tokens).toBe(2000);
      // The rest of the body is preserved (same references).
      expect(out.model).toBe('gpt-4o-mini');
      expect(out.input).toBe(body.input);
      expect(out.instructions).toBe(body.instructions);
    });

    it('leaves smaller values (and the original object) unchanged', () => {
      const body = validBody({ max_output_tokens: 500 });
      expect(clampOutputTokens(body, CFG)).toBe(body);
    });

    it('does nothing when the config has no cap', () => {
      const body = validBody({ max_output_tokens: 10_000 });
      expect(clampOutputTokens(body, { ...CFG, maxOutputTokens: undefined })).toBe(body);
    });
  });

  describe('parseProxyConfig', () => {
    it('applies documented defaults for missing/invalid vars', () => {
      const cfg = parseProxyConfig({});
      expect(cfg.allowedModels).toEqual(['gpt-4o-mini']);
      expect(cfg.maxImageChars).toBe(4_500_000);
      expect(cfg.maxImagesPerRequest).toBe(1);
      expect(cfg.maxOutputTokens).toBeUndefined();
      expect(cfg.requestsPerMinute).toBe(10);
    });

    it('parses env vars, splits model lists, and falls back on garbage', () => {
      const cfg = parseProxyConfig({
        ALLOWED_MODELS: 'gpt-4o-mini, gpt-4o ,,gpt-5',
        MAX_IMAGE_CHARS: '2500000',
        MAX_IMAGES_PER_REQUEST: '3',
        MAX_OUTPUT_TOKENS: '1500',
        REQUESTS_PER_MINUTE: '30'
      });
      expect(cfg.allowedModels).toEqual(['gpt-4o-mini', 'gpt-4o', 'gpt-5']);
      expect(cfg.maxImageChars).toBe(2_500_000);
      expect(cfg.maxImagesPerRequest).toBe(3);
      expect(cfg.maxOutputTokens).toBe(1500);
      expect(cfg.requestsPerMinute).toBe(30);

      const bad = parseProxyConfig({ MAX_IMAGE_CHARS: 'oops', REQUESTS_PER_MINUTE: '0' });
      expect(bad.maxImageChars).toBe(4_500_000);
      expect(bad.requestsPerMinute).toBe(10);
    });
  });

  describe('TokenBucketRateLimiter', () => {
    it('allows bursts up to capacity, then refills over time', () => {
      let t = 0;
      const rl = new TokenBucketRateLimiter(6, () => t); // 6/min -> 1 per 10s
      // Burst: all 6 immediate requests pass.
      for (let i = 0; i < 6; i++) expect(rl.tryConsume('k')).toBe(true);
      // 7th immediately after: bucket dry.
      expect(rl.tryConsume('k')).toBe(false);
      // After ~10 s, one token has refilled (small margin for fp).
      t += 10_010;
      expect(rl.tryConsume('k')).toBe(true);
      expect(rl.tryConsume('k')).toBe(false);
      // After a full minute, the bucket is full again.
      t += 60_000;
      for (let i = 0; i < 6; i++) expect(rl.tryConsume('k')).toBe(true);
    });

    it('tracks keys independently', () => {
      let t = 0;
      const rl = new TokenBucketRateLimiter(1, () => t);
      expect(rl.tryConsume('a')).toBe(true);
      expect(rl.tryConsume('a')).toBe(false);
      expect(rl.tryConsume('b')).toBe(true); // different client unaffected
      expect(rl.size).toBe(2);
    });
  });
});
