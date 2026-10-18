import { readEventStream, signAws, type AwsKeys } from '../aws.js';
import { providerFailure, providerFetch, providerHttpError, redact } from '../http.js';
import { applyExtras, withPresetParams } from '../params.js';
import { IdleWatch, StopFilter } from '../stream.js';
import type { ChatRequest, LLMAdapter } from '../types.js';
import { anthropic, messagesBody, readAnthropicEvents, type AnthropicEvent } from './anthropic.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type CatalogConfig, type ModelAccess, type ModelFormat, type ModelListing } from './format.js';
import { watched } from './send.js';

type AwsAccess = Extract<ModelAccess, { kind: 'aws' }>;

/**
 * The model id Bedrock is asked with (RisuAI's): a Claude base id
 * (`anthropic.…`) through a cross-region inference profile — `global.` for
 * Claude from Sonnet 4.5 (2025-09-29) on, else the region's geography
 * (`us.`, `eu.`, `apac.`; RisuAI always says `us.`). Any other id — a profile
 * of the owner's choosing, an ARN — goes as it is.
 */
export function bedrockModel(model: string, region: string): string {
  if (!model.startsWith('anthropic.')) return model;
  const date = Number(/(\d{8})/.exec(model)?.[1]);
  const version = /claude-(?:opus-|sonnet-|haiku-)?(\d+)-(\d+)/.exec(model);
  let global = false;
  if (date) global = date >= 20250929;
  else if (version) {
    const major = Number(version[1]);
    const minor = Number(version[2]);
    global = major > 4 || (major === 4 && minor >= 5);
  }
  const geography = region.startsWith('eu-') ? 'eu' : region.startsWith('ap-') ? 'apac' : 'us';
  return `${global ? 'global' : geography}.${model}`;
}

/** The Messages body Bedrock takes for Claude: no `model` or `stream` (the URL says them), and Bedrock's `anthropic_version`. */
export function bedrockBody(req: ChatRequest): Record<string, unknown> {
  const { model: _model, stream: _stream, ...body } = messagesBody(req);
  return { anthropic_version: 'bedrock-2023-05-31', ...body };
}

/** The codes Bedrock's stream exceptions are told as. */
const EXCEPTIONS: Record<string, string> = {
  throttlingException: 'provider_rate_limited',
  validationException: 'provider_bad_request',
  accessDeniedException: 'provider_unauthorized',
  resourceNotFoundException: 'provider_not_found',
};

const invalid = () => providerFailure('provider_invalid_stream', 502);
const interrupted = () => providerFailure('provider_stream_interrupted', 502);

/**
 * Bedrock's event stream as the Messages events it carries: each `chunk`'s
 * `bytes` is one Anthropic event in base64. An `exception` message is the
 * provider's failure, told by its type (`throttlingException`, …).
 */
async function* bedrockEvents(body: ReadableStream<Uint8Array>, watch: IdleWatch): AsyncGenerator<AnthropicEvent> {
  const decoder = new TextDecoder();
  for await (const message of readEventStream(body, watch, { invalid, interrupted })) {
    const kind = message.headers[':message-type'];
    if (kind === 'exception' || kind === 'error') {
      const type = message.headers[':exception-type'] ?? message.headers[':error-code'] ?? '';
      let detail = message.headers[':error-message'] ?? '';
      try {
        detail ||= String((JSON.parse(decoder.decode(message.payload)) as { message?: unknown }).message ?? '');
      } catch {
        // The type says enough.
      }
      throw providerFailure(EXCEPTIONS[type] ?? 'provider_unavailable', 502, redact(`${type}: ${detail}`));
    }
    if (kind !== 'event' || message.headers[':event-type'] !== 'chunk') continue;
    let event: AnthropicEvent;
    try {
      const { bytes } = JSON.parse(decoder.decode(message.payload)) as { bytes?: unknown };
      if (typeof bytes !== 'string') throw invalid();
      event = JSON.parse(Buffer.from(bytes, 'base64').toString('utf8')) as AnthropicEvent;
    } catch {
      throw invalid();
    }
    yield event;
  }
}

const keysOf = (access: AwsAccess): AwsKeys => ({
  accessKeyId: access.accessKeyId,
  secretAccessKey: access.secretAccessKey,
  region: access.region,
  ...(access.sessionToken ? { sessionToken: access.sessionToken } : {}),
});

/**
 * Claude on AWS Bedrock (RisuAI's `AWSBedrockClaude`): the Messages body to
 * `<runtime>/model/<id>/invoke-with-response-stream`, signed with the keys
 * (SigV4, service `bedrock`), its event stream read as the Messages stream
 * (`readAnthropicEvents`). RisuAI asks `invoke` and waits for the whole reply;
 * this streams.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        if (config.access.kind !== 'aws') throw providerFailure('credential_required', 400);
        const access = config.access;
        const body = bedrockBody(req);
        const headers: Record<string, string> = { ...config.headers };
        applyExtras(body, headers, config.params);
        Object.assign(headers, { 'content-type': 'application/json', accept: 'application/vnd.amazon.eventstream', 'x-amzn-bedrock-accept': 'application/json' });
        const url = `${config.baseUrl.replace(/\/+$/, '')}/model/${encodeURIComponent(bedrockModel(req.model, access.region))}/invoke-with-response-stream`;
        const text = JSON.stringify(body);
        watch.arm();
        const response = await providerFetch(config.fetch ?? fetch, url, {
          method: 'POST', signal: watch.signal, headers: signAws({ method: 'POST', url, headers, body: text }, keysOf(access), 'bedrock'), body: text,
        });
        watch.disarm();
        if (!response.ok) throw await providerHttpError(response);
        if (!response.body) throw interrupted();
        return yield* readAnthropicEvents(bedrockEvents(response.body, watch), new StopFilter(req.stop));
      });
    },
  };
}

/** `GET https://bedrock.<region>.amazonaws.com/foundation-models` (signed): Anthropic's text models that stream, which needs the keys too. */
async function listModels(config: CatalogConfig): Promise<ModelListing[]> {
  if (config.access.kind !== 'aws') throw providerFailure('credential_required', 400);
  const url = `https://bedrock.${config.access.region}.amazonaws.com/foundation-models?byProvider=Anthropic&byOutputModality=TEXT`;
  const response = await providerFetch(config.fetch ?? fetch, url, {
    headers: signAws({ method: 'GET', url, headers: { accept: 'application/json' } }, keysOf(config.access), 'bedrock'),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
  const body = (await response.json().catch(() => null)) as { modelSummaries?: unknown } | null;
  if (!body || !Array.isArray(body.modelSummaries)) throw invalid();
  return body.modelSummaries
    .filter((entry): entry is { modelId: string; modelName?: unknown; inputModalities?: unknown; responseStreamingSupported?: unknown } =>
      typeof entry === 'object' && entry !== null && typeof (entry as { modelId?: unknown }).modelId === 'string')
    .filter((entry) => entry.responseStreamingSupported !== false)
    .map((entry) => ({
      id: entry.modelId,
      label: typeof entry.modelName === 'string' && entry.modelName ? entry.modelName : entry.modelId,
      ...(Array.isArray(entry.inputModalities) ? { vision: entry.inputModalities.includes('IMAGE') } : {}),
    }));
}

export const bedrock: ModelFormat = {
  id: 'bedrock',
  places: anthropic.places,
  key: 'required',
  createAdapter,
  listModels,
};
