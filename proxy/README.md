# Reference Responses API proxy (issue #12)

A minimal, self-hostable proxy that keeps the **OpenAI API key out of the
browser**. The PWA's proxy mode (`Settings → Analysis → Mode: Proxy`)
sends Requests-API calls here; this worker authenticates the browser,
applies spend/rate limits, and forwards to OpenAI with the server-side
key.

## Why

Issue #12: the key must not be a long-lived secret readable from browser
JavaScript or persisted to browser storage. Direct (BYOK-in-browser)
mode is therefore **hard-disabled in production builds**
(`import.meta.env.PROD` guard in `src/analysis/openai-analyzer.ts`);
this proxy is the supported production path.

## Layout

| File | Role |
| --- | --- |
| `worker.ts` | Cloudflare Worker: CORS, bearer-token auth (constant-time), rate limit, validation, forward, response piping. |
| `limits.ts` | Pure validation/limiting logic (model allow-list, image size/count caps, output-token clamp, token-bucket rate limiter). Runtime-agnostic and fully unit-tested (`test/proxy-limits.test.ts`). |
| `wrangler.toml` | Deployment config. Plain caps in `[vars]`; keys are **secrets**. |

## Deploy (5 minutes)

```bash
cd proxy
npx wrangler login
npx wrangler secret put OPENAI_API_KEY   # the operator's OpenAI key
npx wrangler secret put PROXY_TOKEN      # any random string (e.g. `openssl rand -hex 16`)
npx wrangler deploy
```

Configure the app:

- **Mode:** Proxy
- **Endpoint:** `https://<your-worker>.workers.dev/v1/responses`
- **Proxy token:** the value you set for `PROXY_TOKEN`
- **Model:** must be in `ALLOWED_MODELS` (default `gpt-4o-mini`)

## Security properties

1. **The OpenAI key is a Worker secret** — never in source, never in the
   browser, never in any response body. Error responses are small JSON
   objects that never echo request content or keys.
2. **Browser auth** — the worker requires `Authorization: Bearer
   <PROXY_TOKEN>` and compares it in constant time (timing-safe).
   Anyone without the token gets a bare `401 unauthorized`.
3. **Spend caps** — model allow-list, max image payload size, max images
   per request, and a hard clamp on `max_output_tokens`
   (`MAX_OUTPUT_TOKENS`, default 2000).
4. **Rate limit** — per-token token bucket
   (`REQUESTS_PER_MINUTE`, default 10). Note: Workers isolates are
   ephemeral, so this bounds bursts per isolate — the right level for
   the single-operator MVP; the spend caps bound total cost.

## Tuning

All caps are plain `[vars]` in `wrangler.toml` (see the file). Typical
adjustments: allow more models (`ALLOWED_MODELS = "gpt-4o-mini,gpt-4o"`),
raise `REQUESTS_PER_MINUTE` for larger batches, raise
`MAX_OUTPUT_TOKENS` if your schema grows.

## Compatibility note

The worker speaks the **Responses API** (`POST /v1/responses`) and pipes
OpenAI's response through unchanged — the same parser
(`parseResponsesResult` in `src/analysis/openai-analyzer.ts`) handles
the result. Any other Responses-API-compatible gateway (e.g. a self-
hosted one) works too: the frontend only needs an endpoint, a bearer
token, and the documented JSON contract.
