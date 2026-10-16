import { LLMError, type ChatMessage, type ChatRequest, type ContentPart, type LLMAdapter, type StreamDone } from './types.js';

export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export class ChatGPTError extends LLMError {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); }
}

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
 * What Codex sends beside `prompt_cache_key`: its conversation id as both session
 * headers. On a reader's ChatGPT sign-in (2026-10-16) the provider served nothing
 * from its prompt cache without them, the key or not — the same 24k-token request
 * twice, 3 s or 20 s apart, came back with no cached token — and with them the
 * second came back 24,576 of 24,805 tokens cached. What it served was an earlier
 * request but its last message, to a request that began with all of that: one that
 * went on from the request before it (24,192 of 24,693), or a later turn of a chat
 * whose turns put their own instructions in the last message
 * (`withTrailingSystemJoined`, 24,192 of 25,113); a request
 * that parted from the earlier one before its last message got nothing, however
 * much they shared (ARCHITECTURE §7.3 프롬프트 캐시 측정). The endpoint refuses
 * `prompt_cache_retention` (400).
 */
export function cacheHeaders(req: Pick<ChatRequest, 'cacheKey'>): Record<string, string> {
  return req.cacheKey ? { session_id: req.cacheKey, conversation_id: req.cacheKey } : {};
}

/**
 * How long the stream may send nothing before the reply is given up on: Codex's
 * own stream idle timeout for the same endpoint. No reasoning summary is asked
 * for, so a reasoning model sends nothing while it thinks, and this is also the
 * longest silent think a reply survives. A stream that keeps sending is never
 * cut, however long it runs.
 */
export const CHATGPT_IDLE_TIMEOUT_MS = 300_000;

/**
 * Success requires response.completed, including when an error follows text deltas.
 * A token the provider turns down is answered before the stream opens, so the one
 * retry (`withAccessToken`) never repeats anything the caller was given.
 */
export function createChatGPTAdapter(access: (rejected?: string) => Promise<string>, fetcher: typeof fetch = fetch): LLMAdapter {
  return {
    async *stream(req) {
      const idle = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Armed only while waiting on the upstream: a delta the caller is slow to
      // take is not the stream going quiet.
      const arm = (): void => { timer = setTimeout(() => idle.abort(), CHATGPT_IDLE_TIMEOUT_MS); };
      const signal = req.abortSignal ? AbortSignal.any([req.abortSignal, idle.signal]) : idle.signal;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      // Do not send unsupported stop/max_output_tokens/temperature fields. Keep the
      // role-play stop boundary locally, but consume through the terminal event.
      let text = '';
      let stopped = false;
      const stops = (req.stop ?? []).filter(Boolean);
      const tailSize = Math.max(0, ...stops.map((stop) => stop.length - 1));
      try {
        arm();
        const response = await withAccessToken(access, async (token) => requireOK(await fetcher(`${CHATGPT_RESOURCE}/responses`, {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...cacheHeaders(req) },
          body: JSON.stringify(responseBody(req)),
        })));
        clearTimeout(timer);
        if (!response.body) throw providerError('chatgpt_empty_stream');
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        while (true) {
          arm();
          const { done, value } = await reader.read();
          clearTimeout(timer);
          pending += decoder.decode(value, { stream: !done });
          pending = pending.replace(/\r\n/g, '\n');
          let boundary: number;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const block = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') continue;
            let event: {
              type: string; delta?: string; code?: string;
              response?: {
                error?: { code?: string };
                usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
              };
            };
            try { event = JSON.parse(data) as typeof event; }
            catch { throw providerError('chatgpt_invalid_stream'); }
            if (event.type === 'response.output_text.delta' && !stopped && typeof event.delta === 'string') {
              text += event.delta;
              const indices = stops.map((stop) => text.indexOf(stop)).filter((at) => at >= 0);
              const at = indices.length ? Math.min(...indices) : -1;
              if (at >= 0) {
                if (at) yield { type: 'text', text: text.slice(0, at) };
                text = ''; stopped = true;
              } else if (text.length > tailSize) {
                yield { type: 'text', text: text.slice(0, text.length - tailSize) };
                text = text.slice(text.length - tailSize);
              }
            }
            if (event.type === 'error' || event.type === 'response.failed') throw providerError(event.response?.error?.code ?? event.code);
            if (event.type === 'response.incomplete') throw providerError('chatgpt_response_incomplete');
            if (event.type === 'response.completed') {
              if (text && !stopped) yield { type: 'text', text };
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
          if (pending.length > 8 * 1024 * 1024) throw providerError('chatgpt_invalid_stream');
          if (done) throw providerError('chatgpt_stream_interrupted');
        }
      } catch (error) {
        // The caller's own abort goes out as it came, which is how it tells a
        // disconnect from a failure; a stream gone quiet is a failure of its own.
        if (idle.signal.aborted && !req.abortSignal?.aborted) throw providerError('chatgpt_timeout', 504);
        throw error;
      } finally {
        clearTimeout(timer);
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
    },
  };
}
