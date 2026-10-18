import { eventJson, IDLE_TIMEOUT_MS, IdleWatch, readSse, StopFilter } from './stream.js';
import { LLMError, type ChatMessage, type ChatRequest, type ContentPart, type LLMAdapter, type StreamDelta, type StreamDone } from './types.js';

export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export class ChatGPTError extends LLMError {}

const MESSAGES: Record<string, string> = {
  chatgpt_login_required: 'Connect ChatGPT in AI settings to continue.',
  chatgpt_unavailable: 'Sign in with ChatGPT is temporarily unavailable. Try again later.',
  invalid_grant: 'Your ChatGPT connection expired. Reconnect in AI settings.',
  subscription_sharing_usage_limit_exceeded: 'Your ChatGPT usage limit has been reached. Try later or check your ChatGPT plan.',
  subscription_sharing_usage_unavailable: 'ChatGPT usage is temporarily unavailable. Try again later.',
  subscription_sharing_user_not_eligible: 'This ChatGPT account is not eligible to share its plan.',
  subscription_sharing_invalid_user: 'Reconnect ChatGPT in AI settings.',
  chatgpt_timeout: 'ChatGPT stopped responding. Try again.',
};
export function providerError(code: unknown, status = 502): ChatGPTError {
  // Provider bodies may contain credentials. Only known-safe code characters leave this module.
  const safeCode = typeof code === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(code) ? code : 'chatgpt_request_failed';
  return new ChatGPTError(safeCode, MESSAGES[safeCode] ?? `ChatGPT request failed (${status}).`, status);
}
export async function requireOK(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = await response.json().catch(() => ({})) as { error?: { code?: string } | string; code?: string; detail?: string };
  const code = typeof body.error === 'string' ? body.error : body.error?.code ?? body.code ?? body.detail;
  throw providerError(code, response.status);
}

/**
 * The provider's answer to an access token it no longer takes, which it can give
 * before the token's recorded expiry (2026-10-16: 401 `token_expired` on the model
 * catalog and on replies alike, the stored token fresh by its `expiresAt`).
 */
const REJECTED_ACCESS = ['token_expired'];
const accessRejected = (error: unknown): boolean =>
  error instanceof ChatGPTError && error.status === 401 && REJECTED_ACCESS.includes(error.code);

/**
 * `call` with the account's access token and, when the provider turns that token
 * down, once more with the one `access(rejected)` gives back: refreshed, or
 * another request's already rotated (§4.1). A second refusal goes out as it came.
 */
export async function withAccessToken<T>(
  access: (rejected?: string) => Promise<string>,
  call: (token: string) => Promise<T>,
): Promise<T> {
  const token = await access();
  try {
    return await call(token);
  } catch (error) {
    if (!accessRejected(error)) throw error;
    return call(await access(token));
  }
}

/**
 * `messages` with the run of system turns after the last user or assistant turn
 * as one turn, their contents joined by a blank line, pictures kept in place —
 * and nothing else joined: a system turn before or between the conversation's
 * turns stays where it is, and a run after nothing but system turns is left
 * alone. The provider keeps a request but its last message for the next request
 * that begins with all of it (ARCHITECTURE §7.3 프롬프트 캐시 측정), and a chat
 * reply's own instructions — the directions, the recall turn, the post-history,
 * what goes after everything — follow its newest turn: as one last message,
 * the next turn's request begins with all of what this one leaves. A request
 * that ends on a turn of the conversation, a continue's partial, joins nothing.
 */
export function withTrailingSystemJoined(messages: ChatMessage[]): ChatMessage[] {
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role === 'system') start -= 1;
  if (start === 0 || messages.length - start < 2) return messages;
  const parts: ContentPart[] = [];
  messages.slice(start).forEach((message, at) => {
    const own: ContentPart[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    own.forEach((part, index) => {
      const last = parts.at(-1);
      if (at > 0 && index === 0 && part.type === 'text' && last?.type === 'text') {
        parts[parts.length - 1] = { type: 'text', text: `${last.text}\n\n${part.text}` };
      } else parts.push(part);
    });
  });
  const joined: ContentPart[] | string =
    parts.length === 1 && parts[0]!.type === 'text' ? parts[0]!.text : parts;
  return [...messages.slice(0, start), { role: 'system', content: joined }];
}

/**
 * System instructions stay in their original positions as developer messages,
 * those after the last user or assistant turn as one (`withTrailingSystemJoined`).
 */
export function responseBody(req: ChatRequest): Record<string, unknown> {
  return {
    model: req.model, store: false, stream: true,
    // Only the effort is asked for: a reasoning summary is never requested,
    // because it can paraphrase the creator's hidden prompt back to the reader.
    ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort } } : {}),
    // The prompt cache's key, as Codex sends its conversation id (`cacheHeaders`).
    ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
    // No system text is no instructions, rather than an empty one.
    ...(req.system ? { instructions: req.system } : {}),
    input: withTrailingSystemJoined(req.messages).map((message) => ({
      role: message.role === 'system' ? 'developer' : message.role,
      content: typeof message.content === 'string' ? message.content : message.content.map((part) =>
        part.type === 'image'
          ? { type: 'input_image', image_url: part.url }
          : { type: 'input_text', text: part.text }),
    })),
  };
}

/**
 * What goes beside `prompt_cache_key`: the same id as the `session_id` header,
 * which Codex sends its conversation id as. On a reader's ChatGPT sign-in
 * (2026-10-16) the provider served nothing from its prompt cache without it, the
 * key or not — the same 24k-token request twice, 3 s or 20 s apart, came back with
 * no cached token — and with it (and `conversation_id`, then sent too) the second
 * came back 24,576 of 24,805 tokens cached. `conversation_id` is no longer sent:
 * Codex dropped it in 2026-01 as an exact copy of `session_id`, and `session_id`
 * alone served a chat's next turn 200 s later 23,936 of 24,750 tokens, as both
 * had. Codex's newer hyphenated `session-id`/`thread-id` are untested here. What
 * it served was an earlier
 * request but its last message, to a request that began with all of that: one that
 * went on from the request before it (24,192 of 24,693), or a later turn of a chat
 * whose turns put their own instructions in the last message
 * (`withTrailingSystemJoined`, 24,192 of 25,113); a request
 * that parted from the earlier one before its last message got nothing, however
 * much they shared (ARCHITECTURE §7.3 프롬프트 캐시 측정). The endpoint refuses
 * `prompt_cache_retention` (400).
 */
export function cacheHeaders(req: Pick<ChatRequest, 'cacheKey'>): Record<string, string> {
  return req.cacheKey ? { session_id: req.cacheKey } : {};
}

/**
 * How long the stream may send nothing before the reply is given up on: Codex's
 * own stream idle timeout for the same endpoint. No reasoning summary is asked
 * for, so a reasoning model sends nothing while it thinks, and this is also the
 * longest silent think a reply survives. A stream that keeps sending is never
 * cut, however long it runs.
 */
export const CHATGPT_IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MS;

/** How a Responses stream's failures are told: the ChatGPT connection's codes, or a key's. */
export interface ResponsesFailures {
  /** An `error` or `response.failed` event, with the code it named. */
  failed(code: string | undefined): LLMError;
  /** A `response.incomplete`: an error (the plan), or null to end the reply there (a key's capped reply). */
  incomplete(): LLMError | null;
  invalid(): LLMError;
  interrupted(): LLMError;
}

/**
 * A Responses API stream, read to its terminal event: the text deltas as they
 * pass the stop strings, and the usage `response.completed` reports. Success
 * requires that event, including when an error follows text deltas.
 */
export async function* readResponsesStream(
  response: Response,
  req: ChatRequest,
  watch: IdleWatch,
  failures: ResponsesFailures,
): AsyncGenerator<StreamDelta, StreamDone> {
  if (!response.body) throw failures.interrupted();
  const stop = new StopFilter(req.stop);
  for await (const block of readSse(response.body, watch, { invalid: failures.invalid })) {
    if (!block.data || block.data === '[DONE]') continue;
    const event = eventJson<{
      type: string; delta?: string; code?: string;
      response?: {
        error?: { code?: string };
        usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
      };
    }>(block.data, failures.invalid);
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      const out = stop.push(event.delta);
      if (out) yield { type: 'text', text: out };
    }
    if (event.type === 'error' || event.type === 'response.failed') throw failures.failed(event.response?.error?.code ?? event.code);
    if (event.type === 'response.incomplete') {
      const error = failures.incomplete();
      if (error) throw error;
    }
    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const rest = stop.flush();
      if (rest) yield { type: 'text', text: rest };
      const usage = event.response?.usage;
      // The prompt cache's share, where the response says it (`input_tokens_details.cached_tokens`).
      const cached = usage?.input_tokens_details?.cached_tokens;
      return {
        usage: {
          promptTokens: usage?.input_tokens ?? 0,
          completionTokens: usage?.output_tokens ?? 0,
          ...(typeof cached === 'number' ? { cachedPromptTokens: cached } : {}),
        },
      } satisfies StreamDone;
    }
  }
  throw failures.interrupted();
}

/** The ChatGPT connection's failures, each a code the reader's page knows. */
const CHATGPT_FAILURES: ResponsesFailures = {
  failed: (code) => providerError(code),
  incomplete: () => providerError('chatgpt_response_incomplete'),
  invalid: () => providerError('chatgpt_invalid_stream'),
  interrupted: () => providerError('chatgpt_stream_interrupted'),
};

/**
 * The owner's ChatGPT plan through the Responses API: no temperature, top_p or
 * max_output_tokens (the endpoint refuses them), the system text as
 * instructions, `store: false`, and the prompt cache's key and header. A token
 * the provider turns down is answered before the stream opens, so the one retry
 * (`withAccessToken`) never repeats anything the caller was given.
 */
export function createChatGPTAdapter(access: (rejected?: string) => Promise<string>, fetcher: typeof fetch = fetch): LLMAdapter {
  return {
    async *stream(req) {
      const watch = new IdleWatch(req.abortSignal, CHATGPT_IDLE_TIMEOUT_MS);
      try {
        watch.arm();
        // Do not send unsupported stop/max_output_tokens/temperature fields. Keep the
        // role-play stop boundary locally, but consume through the terminal event.
        const response = await withAccessToken(access, async (token) => requireOK(await fetcher(`${CHATGPT_RESOURCE}/responses`, {
          method: 'POST', signal: watch.signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...cacheHeaders(req) },
          body: JSON.stringify(responseBody(req)),
        })));
        watch.disarm();
        if (!response.body) throw providerError('chatgpt_empty_stream');
        return yield* readResponsesStream(response, req, watch, CHATGPT_FAILURES);
      } catch (error) {
        // The caller's own abort goes out as it came, which is how it tells a
        // disconnect from a failure; a stream gone quiet is a failure of its own.
        if (watch.timedOut) throw providerError('chatgpt_timeout', 504);
        throw error;
      } finally {
        watch.disarm();
      }
    },
  };
}
