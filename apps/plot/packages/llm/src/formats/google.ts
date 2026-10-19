import { errorMessageOf, joinUrl, providerFailure, providerFetch, providerHttpError, redact } from '../http.js';
import { applyParameters, withPresetParams, type ParameterPlaces } from '../params.js';
import { addCallerStops, profileBody, wireModelId } from '../registry/request.js';
import { eventJson, IdleWatch, readSse, StopFilter } from '../stream.js';
import type { ChatMessage, ChatRequest, LLMAdapter, StreamDelta, StreamDone } from '../types.js';
import { dataUrlParts } from './anthropic.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type CatalogConfig, type ModelFormat, type ModelListing, type ProfileConfig } from './format.js';
import { postJson, watched } from './send.js';

/** RisuAI's Gemini parameters and their places in `generationConfig`. */
export const GEMINI_PLACES: ParameterPlaces = {
  temperature: 'generationConfig.temperature',
  topP: 'generationConfig.topP',
  topK: 'generationConfig.topK',
  presencePenalty: 'generationConfig.presencePenalty',
  frequencyPenalty: 'generationConfig.frequencyPenalty',
  thinkingTokens: 'generationConfig.thinkingConfig.thinkingBudget',
  reasoningEffort: 'generationConfig.thinkingConfig.thinkingLevel',
};

/** RisuAI's `uncensoredCatagory`: every category the API filters on, at BLOCK_NONE. */
export const GEMINI_SAFETY = [
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

const textOf = (content: ChatMessage['content']): string =>
  typeof content === 'string' ? content : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');

/**
 * RisuAI's `requestGoogleCloudVertex` turns: the system text and the system
 * turns ahead of the conversation as `systemInstruction`; a system turn inside
 * it on the user's side (`system:…`, after the user turn before it where there
 * is one); the assistant as `model`; turns of one role in a row as one, their
 * texts joined by a blank line. A picture goes as `inlineData` when it is a
 * `data:` URL; the API fetches no other address, so one that is not is left out.
 */
export function geminiContents(req: Pick<ChatRequest, 'system' | 'messages'>): { system: string; contents: Content[] } {
  const system: string[] = req.system ? [req.system] : [];
  const contents: Content[] = [];
  const partsOf = (content: ChatMessage['content']): Part[] => {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    return content.flatMap((part): Part[] => {
      if (part.type === 'text') return part.text ? [{ text: part.text }] : [];
      const bytes = dataUrlParts(part.url);
      return bytes ? [{ inlineData: { mimeType: bytes.mediaType, data: bytes.data } }] : [];
    });
  };
  for (const message of req.messages) {
    if (message.role === 'system') {
      if (contents.length === 0) {
        system.push(textOf(message.content));
        continue;
      }
      const last = contents.at(-1)!;
      const first = last.parts[0];
      if (last.role === 'user' && first && 'text' in first) {
        last.parts[0] = { text: `${first.text}\nsystem:${textOf(message.content)}` };
      } else contents.push({ role: 'user', parts: [{ text: `system:${textOf(message.content)}` }] });
      continue;
    }
    const parts = partsOf(message.content);
    if (parts.length > 0) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  // One role in a row is one turn.
  const merged: Content[] = [];
  for (const content of contents) {
    const last = merged.at(-1);
    if (!last || last.role !== content.role) {
      merged.push({ role: content.role, parts: [...content.parts] });
      continue;
    }
    const tail = last.parts.at(-1);
    const [head, ...rest] = content.parts;
    if (tail && 'text' in tail && head && 'text' in head) {
      last.parts[last.parts.length - 1] = { text: `${tail.text}\n\n${head.text}` };
      last.parts.push(...rest);
    } else last.parts.push(...content.parts);
  }
  if (merged[0]?.role !== 'user') merged.unshift({ role: 'user', parts: [{ text: 'Start' }] });
  return { system: system.join('\n\n').trim(), contents: merged };
}

/** Gemini's thinking levels; RisuAI's other efforts land on the nearest. */
const THINKING_LEVELS: Record<string, string> = { none: 'minimal', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' };

/**
 * The `generateContent` body: the turns, `systemInstruction`, BLOCK_NONE on
 * every category as RisuAI sends, and in `generationConfig` the cap, the stop
 * strings (five at most) and the values. A thinking budget (2.5) or level (3)
 * asks for the thoughts too, which come back as parts marked `thought`.
 */
export function generateContentBody(req: ChatRequest): Record<string, unknown> {
  const { system, contents } = geminiContents(req);
  const stop = (req.stop ?? []).filter((value) => value.trim()).slice(0, 5);
  const level = req.reasoningEffort ? THINKING_LEVELS[req.reasoningEffort] ?? req.reasoningEffort : undefined;
  const body = applyParameters(
    {
      contents,
      safetySettings: GEMINI_SAFETY,
      generationConfig: { maxOutputTokens: req.maxTokens, ...(stop.length ? { stopSequences: stop } : {}) },
    },
    { ...req, ...(level ? { reasoningEffort: level } : {}), ...(req.topK === 0 ? { topK: undefined } : {}) },
    GEMINI_PLACES,
  );
  const thinking = (body['generationConfig'] as { thinkingConfig?: Record<string, unknown> }).thinkingConfig;
  if (thinking) {
    // A model takes one or the other (2.5 the budget, 3 the level); the budget, being the more exact, wins.
    if (thinking['thinkingBudget'] !== undefined) delete thinking['thinkingLevel'];
    thinking['includeThoughts'] = true;
  }
  if (system) body['systemInstruction'] = { parts: [{ text: system }] };
  return body;
}

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  error?: unknown;
}

/** A model id as the path takes it: without the `models/` its listing gives it. */
export const modelPath = (model: string): string => encodeURIComponent(model.replace(/^models\//, ''));
const invalid = () => providerFailure('provider_invalid_stream', 502);
/** The finish reasons that mean the provider would not answer. */
const REFUSED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

/**
 * A `streamGenerateContent?alt=sse` body (AI Studio's and Vertex's): the text
 * parts are the reply and the parts marked `thought` its thinking. The stream
 * has no end marker: it is done at its end once a candidate gave a finish
 * reason. A prompt the provider blocked, or a reply it stopped for safety
 * before writing anything, is `provider_refused`.
 */
export async function* readGeminiStream(response: Response, watch: IdleWatch, stop: StopFilter): AsyncGenerator<StreamDelta, StreamDone> {
  if (!response.body) throw providerFailure('provider_stream_interrupted', 502);
  let usage: StreamDone['usage'] = { promptTokens: 0, completionTokens: 0 };
  let finish: string | undefined;
  let wrote = false;
  for await (const block of readSse(response.body, watch, { invalid })) {
    const chunk = eventJson<GeminiChunk>(block.data, invalid);
    if (chunk.error) throw providerFailure('provider_unavailable', 502, redact(errorMessageOf(chunk)));
    if (chunk.promptFeedback?.blockReason) throw providerFailure('provider_refused', 502, chunk.promptFeedback.blockReason);
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text !== 'string' || !part.text) continue;
      if (part.thought) {
        if (!stop.done) yield { type: 'reasoning', reasoning: part.text };
      } else {
        wrote = true;
        const out = stop.push(part.text);
        if (out) yield { type: 'text', text: out };
      }
    }
    if (candidate?.finishReason) finish = candidate.finishReason;
    if (chunk.usageMetadata) {
      const meta = chunk.usageMetadata;
      usage = {
        promptTokens: meta.promptTokenCount ?? 0,
        completionTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
        ...(typeof meta.cachedContentTokenCount === 'number' ? { cachedPromptTokens: meta.cachedContentTokenCount } : {}),
      };
    }
  }
  if (!finish) throw providerFailure('provider_stream_interrupted', 502);
  if (!wrote && REFUSED.has(finish)) throw providerFailure('provider_refused', 502, finish);
  const rest = stop.flush();
  if (rest) yield { type: 'text', text: rest };
  return { usage, finishReason: finish };
}

/**
 * A profile preset's `generateContent` request, PocketRisu's `prepareGeminiBody`
 * (`src/ts/preset/adapter/googleGemini.ts`): the profile's body (its defaults
 * and fields — no safety settings and no thinking unless the preset sets them),
 * the caller's stop strings in its stop field, no `model` (the URL names it),
 * then the turns and `systemInstruction` as this format writes them, and no
 * tools. The model is the preset's (`wireModelId`), never a body field's.
 */
export function profileGenerateContent(config: Pick<AdapterConfig, 'baseUrl' | 'params'> & { profile: ProfileConfig }, req: ChatRequest): { url: string; body: Record<string, unknown> } {
  const { snapshot, values } = config.profile;
  const body = profileBody(snapshot, values, config.params.extraBody);
  addCallerStops(body, snapshot, values, req.stop, 5);
  const model = wireModelId(snapshot, values);
  delete body['model'];
  const { system, contents } = geminiContents(req);
  body['contents'] = contents;
  if (system) body['systemInstruction'] = { parts: [{ text: system }] };
  else delete body['systemInstruction'];
  delete body['tools'];
  delete body['toolConfig'];
  return { url: joinUrl(config.baseUrl, `/models/${modelPath(model)}:streamGenerateContent?alt=sse`), body };
}

/**
 * Google AI Studio's Gemini: `:streamGenerateContent?alt=sse` with the key in
 * `x-goog-api-key` (not the URL, where it would sit in every log), read by
 * `readGeminiStream`. A profile preset's request is the profile's
 * (`profileGenerateContent`), with its additional headers and the SSE `Accept`.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const profile = config.profile;
      const req = profile ? request : withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const auth: Record<string, string> = config.access.kind === 'key' ? { 'x-goog-api-key': config.access.apiKey } : {};
        if (profile) {
          const { url, body } = profileGenerateContent({ ...config, profile }, req);
          const headers = { ...config.headers, ...config.params.extraHeaders, Accept: 'text/event-stream' };
          const response = await postJson({ ...config, params: {} }, url, body, headers, auth, watch);
          return yield* readGeminiStream(response, watch, new StopFilter(req.stop));
        }
        const url = joinUrl(config.baseUrl, `/models/${modelPath(req.model)}:streamGenerateContent?alt=sse`);
        const response = await postJson(config, url, generateContentBody(req), { ...config.headers }, auth, watch);
        return yield* readGeminiStream(response, watch, new StopFilter(req.stop));
      });
    },
  };
}

/** `GET <base>/models`: the models that generate content, by the id the path takes. */
async function listModels(config: CatalogConfig): Promise<ModelListing[]> {
  const headers: Record<string, string> = { ...config.headers };
  if (config.access.kind === 'key') headers['x-goog-api-key'] = config.access.apiKey;
  const response = await providerFetch(config.fetch ?? fetch, joinUrl(config.baseUrl, '/models?pageSize=1000'), {
    headers, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
  const body = (await response.json().catch(() => null)) as { models?: unknown } | null;
  if (!body || !Array.isArray(body.models)) throw invalid();
  return body.models
    .filter((entry): entry is { name: string; displayName?: unknown; supportedGenerationMethods?: unknown } =>
      typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string')
    .filter((entry) => Array.isArray(entry.supportedGenerationMethods) && entry.supportedGenerationMethods.includes('generateContent'))
    .map((entry) => {
      const id = entry.name.replace(/^models\//, '');
      return {
        id,
        label: typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : id,
        vision: id.startsWith('gemini'),
      };
    });
}

export const google: ModelFormat = {
  id: 'google',
  places: GEMINI_PLACES,
  key: 'required',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  createAdapter,
  listModels,
};
