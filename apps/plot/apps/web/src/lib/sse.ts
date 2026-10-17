import { errorParams, readerHeaders, toApiError } from './api';
import type { Usage } from './types';

type StreamResult =
  | {
      kind: 'done';
      messageId: string;
      usage: Usage;
      /**
       * A reply of a work of several members: its speaker (null for the narrator's)
       * and its round. Absent on every other reply.
       */
      speakerMemberId?: string | null;
      groupTurnId?: string;
    }
  /**
   * The stream was open and the server said it failed (`event: error`). It has
   * already stored the user turn and moved the head onto it, so `regenerate` is
   * the retry path.
   */
  | { kind: 'error'; message: string; code?: string; params?: Record<string, number> }
  /**
   * The stream was open and then ended without a word — the connection dropped,
   * or the server stopped it at shutdown. The server goes on with the reply and
   * stores it (§7.2), so the caller waits for the chat's slot to free and reads it.
   */
  | { kind: 'dropped' }
  | { kind: 'aborted' };

interface SseEvent {
  event: string;
  data: string;
}

/**
 * A response with no stream to read. The code is the page's, not the server's: it
 * is what the reader is told, in their language, instead of the transport's
 * words. A stream that closes before the server said how it ended is `dropped`:
 * the server goes on with that reply.
 */
const INTERRUPTED = 'stream_interrupted';

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
 *  - **Resolves `{kind: 'dropped'}`** when an open stream ends with neither
 *    `done` nor `error`. The reply is still the server's to finish and store.
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
      headers: { ...readerHeaders(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (signal.aborted) return { kind: 'aborted' };
    throw error;
  }
  if (!res.ok) throw await toApiError(res);
  if (!res.body) return { kind: 'error', code: INTERRUPTED, message: 'Empty response stream' };

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let result: StreamResult = { kind: 'dropped' };

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
          result = {
            kind: 'done',
            messageId: typeof data['messageId'] === 'string' ? data['messageId'] : '',
            usage: (data['usage'] as Usage | undefined) ?? { promptTokens: 0, completionTokens: 0 },
            // Only on a group reply, so its absence is the ordinary case.
            ...(typeof data['groupTurnId'] === 'string'
              ? {
                  groupTurnId: data['groupTurnId'],
                  speakerMemberId: typeof data['speakerMemberId'] === 'string' ? data['speakerMemberId'] : null,
                }
              : {}),
          };
        } else if (event.event === 'error') {
          const params = errorParams(data['params']);
          result = {
            kind: 'error',
            ...(typeof data['code'] === 'string' ? { code: data['code'] } : {}),
            ...(params ? { params } : {}),
            message: typeof data['message'] === 'string' ? data['message'] : 'Generation failed',
          };
        }
      }
    }
  } catch (error) {
    // The stream was already open, so this is a transport drop, not a rejected
    // request — the user turn is persisted, and the server goes on with the reply.
    if (signal.aborted) return { kind: 'aborted' };
    return { kind: 'dropped' };
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return signal.aborted ? { kind: 'aborted' } : result;
}
