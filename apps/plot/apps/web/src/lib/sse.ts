import { timeZoneHeaders, toApiError } from './api';
import type { Usage } from './types';

type StreamResult =
  | {
      kind: 'done';
      messageId: string;
      usage: Usage;
      /** Plot assets this turn opened; empty on every turn that opened none. */
      unlockedAssetIds: string[];
    }
  /**
   * The stream was open and then failed: either `event: error` or a transport
   * drop. The server has already stored the user turn and moved the head onto
   * it, so `regenerate` is the retry path.
   */
  | { kind: 'error'; message: string; code?: string }
  | { kind: 'aborted' };

interface SseEvent {
  event: string;
  data: string;
}

/**
 * One `\n\n`-terminated block as an event, or null when it carries no data — a
 * `:` comment line, or a heartbeat with an empty body. The server sends
 * `event: ping` every 15s so idle proxies keep a slow first token alive, and the
 * loop below simply has no branch for an event it does not know.
 */
function parseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}

function readJson(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * POSTs to a generation endpoint and consumes the SSE stream.
 *
 * The two failure modes are deliberately distinct, because they differ in what
 * the server has persisted:
 *  - **Rejects** when the response never became a stream (401, 404, 429, a
 *    fetch-level network error). Nothing was stored; the caller still owns the
 *    user's input and must not retry through `regenerate`.
 *  - **Resolves `{kind: 'error'}`** once the stream was open. The user turn is
 *    stored and the head sits on it, so `regenerate` is the retry.
 */
export async function streamGeneration(
  path: string,
  body: unknown | undefined,
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<StreamResult> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      signal,
      // Every generation expands the clock macros in the reader's zone.
      headers: { ...timeZoneHeaders(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (signal.aborted) return { kind: 'aborted' };
    throw error;
  }
  if (!res.ok) throw await toApiError(res);
  if (!res.body) return { kind: 'error', message: 'Empty response stream' };

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let result: StreamResult = { kind: 'error', message: 'The stream ended unexpectedly' };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += chunk.value;

      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const event = parseBlock(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf('\n\n');
        if (!event) continue;

        const data = readJson(event.data);
        if (event.event === 'delta') {
          if (typeof data['text'] === 'string') onDelta(data['text']);
        } else if (event.event === 'done') {
          const unlocked = data['unlockedAssetIds'];
          result = {
            kind: 'done',
            messageId: typeof data['messageId'] === 'string' ? data['messageId'] : '',
            usage: (data['usage'] as Usage | undefined) ?? { promptTokens: 0, completionTokens: 0 },
            // Only sent by a turn that opened something, so its absence is the
            // ordinary case rather than a payload to complain about.
            unlockedAssetIds: Array.isArray(unlocked) ? (unlocked as string[]) : [],
          };
        } else if (event.event === 'error') {
          result = {
            kind: 'error',
            ...(typeof data['code'] === 'string' ? { code: data['code'] } : {}),
            message: typeof data['message'] === 'string' ? data['message'] : 'Generation failed',
          };
        }
      }
    }
  } catch (error) {
    // The stream was already open, so this is a transport drop, not a rejected
    // request — the user turn is persisted either way.
    if (signal.aborted) return { kind: 'aborted' };
    return { kind: 'error', message: error instanceof Error ? error.message : 'The stream was interrupted' };
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return signal.aborted ? { kind: 'aborted' } : result;
}
