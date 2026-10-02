import type { Photo } from '../types';
import type { AnalysisContext, ImageObservationAnalyzer, VisualObservation } from './analyzer';
import { UNKNOWN_FEATURE_TYPE, validateVisualObservations } from './analyzer';

/**
 * BYOK (bring-your-own-key) OpenAI vision analyzer (issue #2).
 *
 * Calls the OpenAI Chat Completions API directly from the browser
 * (api.openai.com permits CORS for chat completions) with the photo
 * image and a JSON-schema-constrained response (json_schema,
 * strict: false — strict mode would reject the nullable fields; the
 * strict safety guarantee is the client-side
 * validateVisualObservations, which is defense in depth either way).
 * The API key is the USER's key: it is kept in memory by default and
 * only written to persistent storage if the user explicitly opts in
 * (see main.ts). This app never ships an application-owner API secret.
 *
 * The provider returns VISUAL EVIDENCE only — every item is strictly
 * validated (validateVisualObservations) before being handed to the
 * shared SurveyAnalysisPipeline, which owns all OSM tag policy,
 * grouping, position estimation and candidate building.
 *
 * Failure policy: any API/network/parse failure REJECTS for this photo
 * only; the pipeline records a per-photo error and the batch continues.
 */

export interface OpenAIVisionConfig {
  /** The user's own OpenAI API key. */
  apiKey: string;
  /** Chat model with vision support. Default: 'gpt-4o-mini'. */
  model?: string;
  /** API endpoint. Default: https://api.openai.com/v1/chat/completions */
  endpoint?: string;
  /** Injectable fetch (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional extra system-prompt suffix (advanced users). */
  extraInstructions?: string;
}

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
/** Response timeout so one stuck request cannot hang the batch. */
const REQUEST_TIMEOUT_MS = 60_000;

export class OpenAIVisionAnalyzer implements ImageObservationAnalyzer {
  readonly name = 'openai';
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extraInstructions?: string;

  constructor(private readonly cfg: OpenAIVisionConfig) {
    if (!cfg.apiKey || cfg.apiKey.trim() === '') {
      throw new Error('OpenAI API key is required (BYOK)');
    }
    this.model = cfg.model?.trim() || DEFAULT_MODEL;
    this.endpoint = cfg.endpoint?.trim() || DEFAULT_ENDPOINT;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.extraInstructions = cfg.extraInstructions;
  }

  async analyzePhoto(photo: Photo, context: AnalysisContext): Promise<VisualObservation[]> {
    if (!photo.image) {
      throw new Error('Photo has no image data to analyze');
    }

    const body = this.buildRequest(photo, context);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`OpenAI API error ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('OpenAI API returned no content');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('OpenAI API returned malformed JSON');
    }

    // Strict schema validation: unusable items are dropped, OCR stays
    // untrusted evidence. The closed vocabulary is known here (it is in
    // the prompt), so any class id outside it is normalized to
    // 'unknown' — an unrecognized object is never forced into a
    // supported class. (The pipeline re-checks as defense in depth.)
    const known = new Set(context.featureClasses.map((c) => c.id));
    return validateVisualObservations(parsed).map((o) =>
      o.featureType !== UNKNOWN_FEATURE_TYPE && !known.has(o.featureType)
        ? { ...o, featureType: UNKNOWN_FEATURE_TYPE }
        : o
    );
  }

  /** Build the chat-completions request body. */
  private buildRequest(photo: Photo, context: AnalysisContext) {
    const classList = context.featureClasses
      .map((c) => `  - ${c.id} (${c.label})`)
      .join('\n');

    const system = [
      'You detect map-mappable physical features in street-level photos for OpenStreetMap.',
      '',
      'Supported feature classes (closed vocabulary):',
      classList,
      '',
      'Rules:',
      `- Report each supported object you can clearly identify. If an object is not clearly one of the listed classes, use featureType "${UNKNOWN_FEATURE_TYPE}".`,
      '- Never invent objects. Zero objects is a correct answer (return an empty array).',
      '- bbox: normalized 0..1 image coordinates {x, y, w, h} of the object.',
      '- attributes: only properties you can SEE in the image (e.g. color, material). Do not guess.',
      '- ocrText: visible text near/on the object, verbatim, if legible. It is untrusted evidence, not a confirmed name.',
      '- detectionConfidence: honest 0..1 confidence the detection and class are correct.',
      '- distanceEstimate: rough distance in meters if you can judge it from perspective/size cues; distanceUncertaintyM: its uncertainty. Omit both if you cannot judge.',
      `- Do NOT use ocrText or attributes to decide the class id; class must match the closed vocabulary.`,
      ...(this.extraInstructions ? ['', this.extraInstructions] : [])
    ].join('\n');

    return {
      model: this.model,
      temperature: 0,
      // strict: false — strict mode forbids type arrays and
      // schema-valued additionalProperties, so the (deliberately
      // nullable) schema would be rejected with a 400. The schema still
      // constrains the decoding; the REAL safety guarantee is the
      // strict client-side validation (validateVisualObservations).
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'observations',
          strict: false,
          schema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                featureType: { type: 'string' },
                bbox: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    w: { type: 'number' },
                    h: { type: 'number' }
                  },
                  required: ['x', 'y', 'w', 'h'],
                  additionalProperties: false
                },
                attributes: {
                  type: 'object',
                  additionalProperties: { type: 'string' }
                },
                ocrText: { type: ['string', 'null'] },
                ocrConfidence: { type: ['number', 'null'] },
                detectionConfidence: { type: 'number' },
                distanceEstimate: { type: ['number', 'null'] },
                distanceUncertaintyM: { type: ['number', 'null'] },
                identityEvidence: { type: ['string', 'null'] }
              },
              required: ['featureType', 'bbox', 'attributes', 'detectionConfidence'],
              additionalProperties: false
            }
          }
        }
      },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: photo.image, detail: 'high' }
            },
            {
              type: 'text',
              text: 'Detect the map-mappable features in this photo according to the rules. Respond with the JSON array of observations.'
            }
          ]
        }
      ]
    };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return '';
  }
}
