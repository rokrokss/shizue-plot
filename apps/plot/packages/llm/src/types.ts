/** A piece of the model's answer. */
export interface TextDelta {
  type: 'text';
  text: string;
}

/**
 * A piece of the model's thinking, which some providers send beside the answer
 * (`reasoning_content`, Anthropic's `thinking_delta`, Gemini's thought parts).
 * Never part of the reply's text: the field has its own name so a consumer that
 * reads `.text` without looking at the type does not compile.
 */
export interface ReasoningDelta {
  type: 'reasoning';
  reasoning: string;
}

export type StreamDelta = TextDelta | ReasoningDelta;

export interface StreamDone {
  usage: {
    promptTokens: number;
    completionTokens: number;
    /** Of `promptTokens`, those the provider served from its prompt cache; absent where it does not say. */
    cachedPromptTokens?: number;
  };
}

/**
 * One piece of a multimodal turn. A message is either plain text — which is what
 * all but a handful of turns are — or a list of these, and the list is only ever
 * produced by a turn that carries an image.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  /** Anything `fetch` would take: an https URL, or a `data:` URL of the bytes. */
  | { type: 'image'; url: string };

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: MessageContent;
  /**
   * RisuAI's `cachePoint`: the prompt up to this turn is cached. Only an
   * Anthropic profile preset reads it, as PocketRisu's adapter does
   * (`cache_control` on the turn's last block).
   */
  cachePoint?: boolean;
}

/** The words of a turn, whatever shape it arrived in. Images contribute nothing. */
export const contentText = (content: MessageContent): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n');

/**
 * The sampling values a request carries — RisuAI's parameters (`LLMParameter`)
 * by our names. Each format sends only the ones it takes (`ParameterPlaces`);
 * one left out is the provider's default. A model preset's values are laid over
 * a request by its adapter (`withPresetParams`).
 */
export interface SamplingValues {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  topA?: number;
  repetitionPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /** A reasoning-effort word (`REASONING_EFFORTS`, or one a ChatGPT model advertises); absent leaves the model's default. */
  reasoningEffort?: string;
  /** A thinking budget in tokens (Anthropic's `budget_tokens`, Gemini 2.5's `thinkingBudget`). */
  thinkingTokens?: number;
  /** OpenAI's `verbosity`: low, medium or high. */
  verbosity?: string;
}

export interface ChatRequest extends SamplingValues {
  /** Provider-native model name. */
  model: string;
  system: string;
  messages: ChatMessage[];
  /** The reply's token cap, which the prompt's budget reserves too. */
  maxTokens: number;
  /**
   * The provider's prompt cache this request is served from and written to
   * (`prompt_cache_key` and the `session_id` header, `cacheHeaders`): without one
   * nothing is served from the cache. A chat's replies use the chat's id; absent
   * sends none. Only the Responses formats read it.
   */
  cacheKey?: string;
  stop?: string[];
  /**
   * Who speaks, for the formats that write the chat as one text
   * (`stringlize.ts`): RisuAI's character name and `getUserName()`. A chat's
   * reply names them; a side call leaves them out, and those formats say
   * `Assistant` and `User`.
   */
  names?: { char: string; user: string };
  /**
   * The chat's context size in tokens (RisuAI's `maxContext`), which the local
   * servers are told: Kobold's and Horde's `max_context_length`, Ollama's
   * `num_ctx`. Absent, Kobold and Ollama keep their own, and Horde asks for
   * RisuAI's default.
   */
  contextTokens?: number;
  abortSignal?: AbortSignal;
}

export interface LLMAdapter {
  stream(req: ChatRequest): AsyncGenerator<StreamDelta, StreamDone>;
}

/**
 * A model call that failed, with a code the reader's page translates and the
 * HTTP status the API answers with. `detail` is the provider's own message,
 * with anything that looks like a key taken out (`providerHttpError`): for the
 * server's log, never the page.
 */
export class LLMError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
    readonly detail?: string,
  ) {
    super(message);
  }
}
