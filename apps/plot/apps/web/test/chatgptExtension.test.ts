/**
 * Finding the extension that carries the sign-in — Shizue from the store, or the
 * unpacked helper: every way it can be absent reads as "not installed", and only
 * an answer that carries the sign-in reads as installed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTENSION_IDS,
  HELPER_EXTENSION_ID,
  SHIZUE_EXTENSION_ID,
  detectExtension,
} from '../src/lib/chatgptExtension';

type Reply = (response: unknown) => void;
const scope = globalThis as { chrome?: unknown };

function stubRuntime(send: (runtime: { lastError?: unknown }, reply: Reply, id: string) => void) {
  const runtime: { lastError?: unknown; sendMessage: ReturnType<typeof vi.fn> } = {
    sendMessage: vi.fn((id: string, _message: unknown, reply: Reply) => send(runtime, reply, id)),
  };
  scope.chrome = { runtime };
  return runtime;
}

/** What Chrome does for an ID nobody answers at: `lastError` set for that one callback only. */
const missing = (runtime: { lastError?: unknown }, reply: Reply): void => {
  runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
  reply(undefined);
  runtime.lastError = undefined;
};

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

  it('asks Shizue and the helper alike', async () => {
    const runtime = stubRuntime(missing);
    await detectExtension();
    expect(EXTENSION_IDS).toEqual([SHIZUE_EXTENSION_ID, HELPER_EXTENSION_ID]);
    for (const id of EXTENSION_IDS) {
      expect(runtime.sendMessage).toHaveBeenCalledWith(id, { type: 'ping' }, expect.any(Function));
    }
  });

  it('is installed when the helper answers the ping, Shizue being absent', async () => {
    stubRuntime((runtime, reply, id) =>
      id === HELPER_EXTENSION_ID ? setTimeout(() => reply({ ok: true, version: '0.1.0' }), 10) : missing(runtime, reply),
    );
    expect(await detectExtension()).toBe(true);
  });

  it('is installed when Shizue says it carries the sign-in for this site', async () => {
    stubRuntime((runtime, reply, id) =>
      id === SHIZUE_EXTENSION_ID
        ? reply({ ok: true, version: '0.3.6', features: ['plotSignIn'] })
        : missing(runtime, reply),
    );
    expect(await detectExtension()).toBe(true);
  });

  it('is not installed when Shizue answers without the sign-in feature', async () => {
    stubRuntime((runtime, reply, id) =>
      id === SHIZUE_EXTENSION_ID ? reply({ ok: true, version: '9.0.0', features: [] }) : missing(runtime, reply),
    );
    expect(await detectExtension()).toBe(false);
  });

  it('gives up when the helper never answers', async () => {
    vi.useFakeTimers();
    stubRuntime(() => {});
    const found = detectExtension(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await found).toBe(false);
  });
});
