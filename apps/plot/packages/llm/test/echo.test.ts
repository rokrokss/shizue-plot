import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEchoAdapter } from '../src/echo.js';
import type { ChatRequest, StreamDelta, StreamDone } from '../src/types.js';

async function collect(
  generator: AsyncGenerator<StreamDelta, StreamDone>,
): Promise<{ deltas: string[]; done: StreamDone }> {
  const deltas: string[] = [];
  let next = await generator.next();
  while (!next.done) {
    deltas.push(next.value.text);
    next = await generator.next();
  }
  return { deltas, done: next.value };
}

const request = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'echo',
  system: 'SYSTEM',
  messages: [
    { role: 'user', content: '첫 발화' },
    { role: 'assistant', content: '응답' },
    { role: 'user', content: 'hello brave world' },
    { role: 'system', content: 'POST' },
  ],
  maxTokens: 100,
  ...overrides,
});

describe('echo adapter', () => {
  it('streams the last user message word by word', async () => {
    const { deltas, done } = await collect(createEchoAdapter().stream(request()));
    expect(deltas).toEqual(['hello', ' ', 'brave', ' ', 'world']);
    expect(deltas.join('')).toBe('hello brave world');
    expect(done.usage.completionTokens).toBe('hello brave world'.length);
    expect(done.usage.promptTokens).toBeGreaterThan(0);
  });

  it('stops early when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deltas } = await collect(createEchoAdapter().stream(request({ abortSignal: controller.signal })));
    expect(deltas).toEqual([]);
  });

  it('emits nothing when there is no user message', async () => {
    const { deltas, done } = await collect(
      createEchoAdapter().stream(request({ messages: [{ role: 'assistant', content: 'hi' }] })),
    );
    expect(deltas).toEqual([]);
    expect(done.usage.completionTokens).toBe(0);
  });
});

/** Cancellation must also work while a delayed stream is running. */
describe('echo adapter with a stream delay', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Eight words, so the separators bring it to fifteen chunks. */
  const spaced = request({
    messages: [{ role: 'user', content: 'one two three four five six seven eight' }],
  });

  it('echoes the words of a multimodal turn and ignores its images', async () => {
    const { deltas } = await collect(
      createEchoAdapter().stream(
        request({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'look at this' },
                { type: 'image', url: 'data:image/png;base64,AAA' },
              ],
            },
          ],
        }),
      ),
    );
    expect(deltas.join('')).toBe('look at this');
  });

  it('still stops early when aborted mid-gap', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const deltas: string[] = [];
    const drained = (async () => {
      for await (const delta of createEchoAdapter({ delayMs: 20 }).stream(
        request({ ...spaced, abortSignal: controller.signal }),
      )) {
        deltas.push(delta.text);
        if (deltas.length === 2) controller.abort();
      }
    })();
    await vi.advanceTimersByTimeAsync(5000);
    await drained;

    expect(deltas).toEqual(['one', ' ']);
  });
});
