import type { ChatMessage, ChatRequest, SamplingValues } from './types.js';

/** The sampling values a model preset may set, in the order the editor shows them. */
export const MODEL_PARAMETERS = [
  'temperature',
  'topP',
  'topK',
  'minP',
  'topA',
  'repetitionPenalty',
  'frequencyPenalty',
  'presencePenalty',
  'reasoningEffort',
  'thinkingTokens',
  'verbosity',
] as const satisfies readonly (keyof SamplingValues)[];
export type ModelParameter = (typeof MODEL_PARAMETERS)[number];

/** RisuAI's reasoning-effort words (`getEffort`), from off to the most. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const VERBOSITIES = ['low', 'medium', 'high'] as const;

/**
 * What a model preset sends with every request on it (`model_presets.params`):
 * its sampling values, and RisuAI's other per-model settings — the reply's cap
 * (`maxResponse`), stop strings, and the additional parameters (`header::` lines
 * and body keys). A value left out is not sent.
 */
export interface ModelParams extends SamplingValues {
  /** The reply's cap on this preset, in place of the caller's. */
  maxTokens?: number;
  /** Stop strings on top of the caller's. */
  stop?: string[];
  /** Headers on every request; the credential's own header is set after them, so they never replace it. */
  extraHeaders?: Record<string, string>;
  /** Body fields set over what the adapter built, as RisuAI's additional parameters are. */
  extraBody?: Record<string, unknown>;
}

/**
 * What a preset's model can take (`model_presets.capabilities`). `systemPrompt`,
 * `alternateRoles` and `startWithUser` are RisuAI's flags `hasFullSystemPrompt` /
 * `hasFirstSystemPrompt`, `requiresAlternateRole` and `mustStartWithUserInput`,
 * which a local model's chat template may need (`reformat`).
 */
export interface ModelCapabilities {
  /** Whether a turn's pictures are sent. Absent: a ChatGPT model's catalog says; any other, no. */
  vision?: boolean;
  /** Where system turns may stand: anywhere (the default), only at the start, or nowhere (sent as the user's). */
  systemPrompt?: 'full' | 'first' | 'none';
  /** Turns of one role in a row are joined into one. */
  alternateRoles?: boolean;
  /** A conversation that opens on anything but the user's turn gets an empty one first. */
  startWithUser?: boolean;
}

/** Which model preset a chat runs on (`chats.model_binding`) and the app's default (`user.model_binding`). */
export interface ModelBinding {
  /** The chat's own model; absent or null follows the default. */
  main?: string | null;
  /** The auxiliary (sub) model for the side work; absent or null follows the default, and then the main. */
  sub?: string | null;
}

/** Where each sampling value goes in a format's body: RisuAI's `applyParameters` list and rename map in one. */
export type ParameterPlaces = Partial<Record<ModelParameter, string>>;

/** `body` with `value` at the dotted `path`, making the objects on the way (RisuAI's `setObjectValue`). */
export function setPath(body: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let at = body;
  for (const key of keys.slice(0, -1)) {
    const next = at[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) at[key] = {};
    at = at[key] as Record<string, unknown>;
  }
  at[keys.at(-1)!] = value;
}

/**
 * RisuAI's `applyParameters`: each value the request carries that the format
 * takes, at its place. A value the format does not take is not sent, nor is one
 * the request leaves out — the provider's default stands.
 */
export function applyParameters(body: Record<string, unknown>, req: SamplingValues, places: ParameterPlaces): Record<string, unknown> {
  for (const parameter of MODEL_PARAMETERS) {
    const place = places[parameter];
    const value = req[parameter];
    if (!place || value === undefined) continue;
    setPath(body, place, value);
  }
  return body;
}

/** RisuAI's additional parameters: the preset's body fields over the built body, its headers beside the format's. */
export function applyExtras(body: Record<string, unknown>, headers: Record<string, string>, params: ModelParams): void {
  for (const [key, value] of Object.entries(params.extraBody ?? {})) setPath(body, key, value);
  for (const [name, value] of Object.entries(params.extraHeaders ?? {})) headers[name] = value;
}

/**
 * The request a preset's values make of the caller's: its sampling values over
 * the request's, its cap in place of the caller's, its stop strings beside the
 * caller's. A preset is the model and its values, so every call on it — a reply,
 * a summary, a card's script — goes with them.
 */
export function withPresetParams(req: ChatRequest, params: ModelParams): ChatRequest {
  const sampling: SamplingValues = {};
  for (const parameter of MODEL_PARAMETERS) {
    if (params[parameter] !== undefined) (sampling as Record<string, unknown>)[parameter] = params[parameter];
  }
  const stop = [...(req.stop ?? []), ...(params.stop ?? [])];
  return {
    ...req,
    ...sampling,
    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
    ...(stop.length > 0 ? { stop } : {}),
  };
}

/**
 * RisuAI's `reformater` for a model whose chat template is strict: system turns
 * moved to the front or sent as the user's (`system: …`), turns of one role in a
 * row joined, and an empty user turn ahead of a conversation that does not start
 * with one. Without any of the flags the messages go as they are.
 */
export function reformat(messages: ChatMessage[], capabilities: ModelCapabilities = {}): ChatMessage[] {
  let out = messages.map((message) => ({ ...message }));
  const mode = capabilities.systemPrompt ?? 'full';
  let leading: ChatMessage | null = null;
  if (mode !== 'full') {
    if (mode === 'first') {
      while (out[0]?.role === 'system') {
        const text = textOf(out[0]);
        leading = leading ? { role: 'system', content: `${textOf(leading)}\n\n${text}` } : { role: 'system', content: text };
        out = out.slice(1);
      }
    }
    out = out.map((message) =>
      message.role === 'system' ? { role: 'user', content: `system: ${textOf(message)}` } : message,
    );
  }
  if (capabilities.alternateRoles) {
    const joined: ChatMessage[] = [];
    for (const message of out) {
      const last = joined.at(-1);
      if (last && last.role === message.role) {
        joined[joined.length - 1] = { role: last.role, content: joinContent(last.content, message.content) };
      } else joined.push(message);
    }
    out = joined;
  }
  if (capabilities.startWithUser && out[0]?.role !== 'user') out.unshift({ role: 'user', content: ' ' });
  return leading ? [leading, ...out] : out;
}

const textOf = (message: ChatMessage): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');

/** Two turns' contents as one, RisuAI's `\n` between their words, pictures kept. */
function joinContent(a: ChatMessage['content'], b: ChatMessage['content']): ChatMessage['content'] {
  if (typeof a === 'string' && typeof b === 'string') return `${a}\n${b}`;
  const parts = (content: ChatMessage['content']) => (typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content);
  return [...parts(a), ...parts(b)];
}

const NUMBER_RANGES: Record<Exclude<ModelParameter, 'reasoningEffort' | 'verbosity'>, [number, number, boolean]> = {
  // [min, max, integer]
  temperature: [0, 2, false],
  topP: [0, 1, false],
  topK: [0, 1000, true],
  minP: [0, 1, false],
  topA: [0, 1, false],
  repetitionPenalty: [0, 2, false],
  frequencyPenalty: [-2, 2, false],
  presencePenalty: [-2, 2, false],
  thinkingTokens: [0, 200_000, true],
};
/** The longest reply cap a preset may set: past every provider's own. */
export const MAX_RESPONSE_TOKENS = 1_000_000;
const MAX_STOPS = 16;
const MAX_STOP_LENGTH = 200;
const MAX_EXTRA_HEADERS = 32;
const MAX_EXTRA_BODY_BYTES = 16 * 1024;
/** A header name as RFC 9110's token, so a stored one is always sendable. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
/** Headers a preset may not set: the transport's own. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection']);

/** A preset's values as the API takes them, or a `TypeError` that says what is wrong. Unknown keys are refused. */
export function parseModelParams(value: unknown): ModelParams {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('params must be an object');
  const input = value as Record<string, unknown>;
  const out: ModelParams = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null) continue;
    if (key in NUMBER_RANGES) {
      const [min, max, integer] = NUMBER_RANGES[key as keyof typeof NUMBER_RANGES];
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max || (integer && !Number.isInteger(raw))) {
        throw new TypeError(`${key} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
      }
      (out as Record<string, unknown>)[key] = raw;
    } else if (key === 'reasoningEffort') {
      if (typeof raw !== 'string' || !/^[a-z]{1,20}$/.test(raw)) throw new TypeError('reasoningEffort must be a lowercase word');
      out.reasoningEffort = raw;
    } else if (key === 'verbosity') {
      if (!VERBOSITIES.includes(raw as never)) throw new TypeError('verbosity must be low, medium or high');
      out.verbosity = raw as string;
    } else if (key === 'maxTokens') {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_RESPONSE_TOKENS) {
        throw new TypeError(`maxTokens must be an integer from 1 to ${MAX_RESPONSE_TOKENS}`);
      }
      out.maxTokens = raw;
    } else if (key === 'stop') {
      if (!Array.isArray(raw) || raw.length > MAX_STOPS || raw.some((stop) => typeof stop !== 'string' || !stop || stop.length > MAX_STOP_LENGTH)) {
        throw new TypeError(`stop must be at most ${MAX_STOPS} strings of 1 to ${MAX_STOP_LENGTH} characters`);
      }
      if (raw.length > 0) out.stop = raw as string[];
    } else if (key === 'extraHeaders') {
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('extraHeaders must be an object');
      const entries = Object.entries(raw as Record<string, unknown>);
      if (entries.length > MAX_EXTRA_HEADERS) throw new TypeError(`extraHeaders holds at most ${MAX_EXTRA_HEADERS} headers`);
      const headers: Record<string, string> = {};
      for (const [name, header] of entries) {
        if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) throw new TypeError(`extraHeaders: ${name} is not a header this may set`);
        if (typeof header !== 'string' || header.length > 4000 || /[\r\n\0]/.test(header)) throw new TypeError(`extraHeaders: ${name} must be a single-line string`);
        headers[name] = header;
      }
      if (entries.length > 0) out.extraHeaders = headers;
    } else if (key === 'extraBody') {
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('extraBody must be an object');
      if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > MAX_EXTRA_BODY_BYTES) {
        throw new TypeError(`extraBody holds at most ${MAX_EXTRA_BODY_BYTES} bytes`);
      }
      if (Object.keys(raw).length > 0) out.extraBody = raw as Record<string, unknown>;
    } else {
      throw new TypeError(`Unknown parameter: ${key}`);
    }
  }
  return out;
}

/** A preset's capabilities as the API takes them, or a `TypeError`. */
export function parseCapabilities(value: unknown): ModelCapabilities {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('capabilities must be an object');
  const out: ModelCapabilities = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === undefined || raw === null) continue;
    if (key === 'vision' || key === 'alternateRoles' || key === 'startWithUser') {
      if (typeof raw !== 'boolean') throw new TypeError(`${key} must be a boolean`);
      out[key] = raw;
    } else if (key === 'systemPrompt') {
      if (raw !== 'full' && raw !== 'first' && raw !== 'none') throw new TypeError('systemPrompt must be full, first or none');
      out.systemPrompt = raw;
    } else throw new TypeError(`Unknown capability: ${key}`);
  }
  return out;
}
