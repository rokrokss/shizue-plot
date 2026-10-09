/**
 * Finding the sign-in helper extension: every way it can be absent reads as
 * "not installed", and only its own answer reads as installed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_ID, detectExtension } from '../src/lib/chatgptExtension';

type Reply = (response: unknown) => void;
const scope = globalThis as { chrome?: unknown };

function stubRuntime(send: (runtime: { lastError?: unknown }, reply: Reply) => void) {
  const runtime: { lastError?: unknown; sendMessage: ReturnType<typeof vi.fn> } = {
    sendMessage: vi.fn((_id: string, _message: unknown, reply: Reply) => send(runtime, reply)),
  };
  scope.chrome = { runtime };
  return runtime;
}

afterEach(() => {
  delete scope.chrome;
  vi.useRealTimers();
});

describe('detectExtension', () => {
  it('is not installed when the page has no extension runtime', async () => {
    scope.chrome = {};
    expect(await detectExtension()).toBe(false);
  });

  it('is not installed when Chrome reports the extension missing', async () => {
    stubRuntime((runtime, reply) => {
      runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
      reply(undefined);
    });
    expect(await detectExtension()).toBe(false);
  });

  it('is not installed when sending throws', async () => {
    stubRuntime(() => { throw new Error('Invalid extension id'); });
    expect(await detectExtension()).toBe(false);
  });

  it('is installed when the helper answers the ping', async () => {
    const runtime = stubRuntime((_runtime, reply) => setTimeout(() => reply({ ok: true, version: '0.1.0' }), 10));
    expect(await detectExtension()).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledWith(EXTENSION_ID, { type: 'ping' }, expect.any(Function));
  });

  it('gives up when the helper never answers', async () => {
    vi.useFakeTimers();
    stubRuntime(() => {});
    const found = detectExtension(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await found).toBe(false);
  });
});
