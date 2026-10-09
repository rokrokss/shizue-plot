/**
 * Unit tests for the browser-side SSE reader. The fixtures reproduce exactly
 * what `hono/streaming`'s `streamSSE` writes in apps/api.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import { streamGeneration } from '../src/lib/sse';

/** Serves the given chunks as a response body, split exactly as passed. */
function mockFetch(chunks: string[], init: ResponseInit = {}): void {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, ...init })));
}

const collect = async (): Promise<{ result: Awaited<ReturnType<typeof streamGeneration>>; text: string }> => {
  let text = '';
  const result = await streamGeneration(
    '/api/chats/x/messages',
    { content: 'hi' },
    (delta) => {
      text += delta;
    },
    new AbortController().signal,
  );
  return { result, text };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamGeneration', () => {
  it('collects deltas and resolves with the done payload', async () => {
    mockFetch([
      'event: delta\ndata: {"text":"안녕"}\n\n',
      'event: delta\ndata: {"text":"하세요"}\n\n',
      'event: done\ndata: {"messageId":"m1","usage":{"promptTokens":10,"completionTokens":2}}\n\n',
    ]);

    const { result, text } = await collect();
    expect(text).toBe('안녕하세요');
    expect(result).toEqual({
      kind: 'done',
      messageId: 'm1',
      usage: { promptTokens: 10, completionTokens: 2 },
      unlockedAssetIds: [],
    });
  });

  it('carries what the turn unlocked, where the turn unlocked anything', async () => {
    mockFetch([
      'event: delta\ndata: {"text":"입맞춤"}\n\n',
      'event: done\ndata: {"messageId":"m2","usage":{"promptTokens":1,"completionTokens":1},"unlockedAssetIds":["ast_1","ast_2"]}\n\n',
    ]);

    const { result } = await collect();
    expect(result).toEqual({
      kind: 'done',
      messageId: 'm2',
      usage: { promptTokens: 1, completionTokens: 1 },
      unlockedAssetIds: ['ast_1', 'ast_2'],
    });
  });

  it('reassembles events split across chunk boundaries', async () => {
    mockFetch([
      'event: delta\ndata: {"te',
      'xt":"부분"}\n\nevent: delta\ndata: {"text":" 응답"}\n',
      '\nevent: done\ndata: {"messageId":"m2","usage":{"promptTokens":1,"completionTokens":1}}\n\n',
    ]);

    const { result, text } = await collect();
    expect(text).toBe('부분 응답');
    expect(result.kind).toBe('done');
  });

  // The api writes `event: ping` with an empty body every 15s so an idle proxy
  // does not drop a stream that is still waiting for its first token.
  it('ignores heartbeats between deltas', async () => {
    mockFetch([
      'event: ping\ndata: \n\n',
      'event: delta\ndata: {"text":"기다"}\n\n',
      ': keepalive\n\n',
      'event: ping\ndata: \n\nevent: delta\ndata: {"text":"렸다"}\n\n',
      'event: done\ndata: {"messageId":"m3","usage":{"promptTokens":3,"completionTokens":2}}\n\n',
    ]);

    const { result, text } = await collect();
    expect(text).toBe('기다렸다');
    expect(result).toEqual({
      kind: 'done',
      messageId: 'm3',
      usage: { promptTokens: 3, completionTokens: 2 },
      unlockedAssetIds: [],
    });
  });

  it('reports a stream-level error event', async () => {
    mockFetch([
      'event: delta\ndata: {"text":"부분 응답"}\n\n',
      'event: error\ndata: {"message":"provider exploded"}\n\n',
    ]);

    const { result, text } = await collect();
    expect(text).toBe('부분 응답');
    expect(result).toEqual({ kind: 'error', message: 'provider exploded' });
  });

  it('treats a truncated stream as an error rather than a success', async () => {
    mockFetch(['event: delta\ndata: {"text":"잘린"}\n\n']);

    const { result } = await collect();
    expect(result.kind).toBe('error');
  });

  // The caller distinguishes the two failure modes by whether the promise
  // rejects: a rejection means nothing was persisted, so the typed prompt has
  // to go back into the composer and `regenerate` must not be offered.
  it('resolves as an in-stream error when the transport drops mid-stream', async () => {
    // The delta must be delivered before the failure, so the drop happens on a
    // later pull rather than in the same tick as the enqueue.
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"부분"}\n\n'));
        } else {
          controller.error(new Error('network dropped'));
        }
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const { result, text } = await collect();
    expect(text).toBe('부분');
    expect(result).toEqual({ kind: 'error', message: 'network dropped' });
  });

  it('rejects when the request never opens a stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(collect()).rejects.toThrow('Failed to fetch');
  });

  it('throws an ApiError carrying the code when the request is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'A generation is already running', code: 'generation_in_progress' }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(collect()).rejects.toMatchObject({
      status: 429,
      code: 'generation_in_progress',
    });
    await expect(collect()).rejects.toBeInstanceOf(ApiError);
  });

  it('resolves as aborted when the caller cancels', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }),
    );

    const result = await streamGeneration('/api/chats/x/regenerate', undefined, () => undefined, controller.signal);
    expect(result).toEqual({ kind: 'aborted' });
  });
});
