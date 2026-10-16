/**
 * One embedder for several instances (`embedderRemote.ts`): the listener in
 * front of an embedder, and the client the instances use, over real loopback
 * connections. The embedder behind the listener is a stand-in — no weights.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ContentLanguage } from '@shizue/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedOptions, Embedder, Embedding } from '../src/embedder.js';
import {
  createRemoteEmbedder,
  embedderListenConfig,
  PIECE_CHARS,
  piecesOf,
  serveEmbedder,
  type EmbedderListener,
  type RemoteEmbedderOptions,
} from '../src/embedderRemote.js';

/** Answers each text with [its length, 1 for a query]; holds every call back while `held`. */
class FakeEmbedder implements Embedder {
  readonly calls: { texts: string[]; kind: string }[] = [];
  readonly warmed: ContentLanguage[] = [];
  held = false;
  model: string | null = 'multiMiniLM';
  private readonly waiting: (() => void)[] = [];
  modelFor(): string | null {
    return this.model;
  }
  async embed(texts: readonly string[], { kind = 'document' }: EmbedOptions): Promise<Embedding> {
    this.calls.push({ texts: [...texts], kind });
    if (this.held) await new Promise<void>((resolve) => this.waiting.push(resolve));
    return { model: 'multiMiniLM', vectors: texts.map((text) => [text.length, kind === 'query' ? 1 : 0]) };
  }
  /** Lets the oldest held call answer. */
  release(): void {
    this.waiting.shift()?.();
  }
  warm(language: ContentLanguage): void {
    this.warmed.push(language);
  }
  async close(): Promise<void> {}
}

let fake: FakeEmbedder;
let listeners: EmbedderListener[];
let clients: Embedder[];

async function serve(token?: string, port = 0): Promise<{ listener: EmbedderListener; url: string }> {
  const listener = serveEmbedder(fake, { port, host: '127.0.0.1', ...(token ? { token } : {}) });
  listeners.push(listener);
  await once(listener.server, 'listening');
  return { listener, url: `http://127.0.0.1:${(listener.server.address() as AddressInfo).port}` };
}

function client(url: string, env: Record<string, string> = {}, options: RemoteEmbedderOptions = {}): Embedder {
  const embedder = createRemoteEmbedder({ EMBEDDER_URL: url, EMBEDDER_ROUTING: 'single', EMBEDDER_MODEL: 'multiMiniLM', ...env }, options)!;
  clients.push(embedder);
  return embedder;
}

const document = (chars: number, mark = 'x'): string => mark.repeat(chars);

beforeEach(() => {
  fake = new FakeEmbedder();
  listeners = [];
  clients = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  fake.held = false;
  for (let at = 0; at < 100; at += 1) fake.release();
  for (const embedder of clients) await embedder.close();
  for (const listener of listeners) await listener.close();
  vi.restoreAllMocks();
});

describe('where it listens', () => {
  it('is off without EMBEDDER_PORT, on loopback by default, and needs a token anywhere else', () => {
    expect(embedderListenConfig({})).toBeUndefined();
    expect(embedderListenConfig({ EMBEDDER_PORT: '8790' })).toEqual({ port: 8790, host: '127.0.0.1' });
    expect(() => embedderListenConfig({ EMBEDDER_PORT: '8790', EMBEDDER_HOST: '0.0.0.0' })).toThrow(/EMBEDDER_TOKEN/);
    expect(embedderListenConfig({ EMBEDDER_PORT: '8790', EMBEDDER_HOST: '0.0.0.0', EMBEDDER_TOKEN: 's' })).toEqual({
      port: 8790,
      host: '0.0.0.0',
      token: 's',
    });
  });

  it('asks for a token on everything but its health, and refuses one that does not match', async () => {
    const { url } = await serve('secret');
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/models`)).status).toBe(401);
    await expect(client(url).embed(['a'], { plotLanguage: 'ko' })).rejects.toThrow(/401/);
    await expect(client(url, { EMBEDDER_TOKEN: 'wrong' }).embed(['a'], { plotLanguage: 'ko' })).rejects.toThrow(/401/);
    const vectors = await client(url, { EMBEDDER_TOKEN: 'secret' }).embed(['abc'], { plotLanguage: 'ko' });
    expect(vectors).toEqual({ model: 'multiMiniLM', vectors: [[3, 0]] });
  });
});

describe('the client', () => {
  it('is off with EMBEDDER=off, and takes only an http:// address', () => {
    expect(createRemoteEmbedder({ EMBEDDER: 'off', EMBEDDER_URL: 'http://127.0.0.1:1' })).toBeUndefined();
    expect(() => createRemoteEmbedder({ EMBEDDER_URL: 'embedder:8790' })).toThrow(/http:\/\//);
    expect(() => createRemoteEmbedder({ EMBEDDER_URL: 'https://embedder:8790' })).toThrow(/http:\/\//);
  });

  it('embeds through the listener: the plot’s model, its kind, one vector per text in order', async () => {
    const { url } = await serve();
    const embedder = client(url);
    expect(embedder.modelFor('ko')).toBe('multiMiniLM');
    await expect(embedder.embed(['ab', 'c'], { plotLanguage: 'ko', kind: 'query' })).resolves.toEqual({
      model: 'multiMiniLM',
      vectors: [[2, 1], [1, 1]],
    });
    await expect(embedder.embed([], { plotLanguage: 'ko' })).resolves.toEqual({ model: 'multiMiniLM', vectors: [] });
    expect(fake.calls).toEqual([{ texts: ['ab', 'c'], kind: 'query' }]);
    embedder.warm('ja');
    await vi.waitFor(() => expect(fake.warmed).toEqual(['ja']));
  });

  it('throws when the listener embeds with another model, and has none for a language it cannot run', async () => {
    const { url } = await serve();
    await expect(client(url, { EMBEDDER_MODEL: 'bge-m3' }).embed(['a'], { plotLanguage: 'ko' })).rejects.toThrow(
      /EMBEDDER_ROUTING and EMBEDDER_MODEL/,
    );
    fake.model = null;
    const embedder = client(url);
    await vi.waitFor(() => expect(embedder.modelFor('ko')).toBeNull());
    await expect(embedder.embed(['a'], { plotLanguage: 'ko' })).rejects.toThrow(/cannot run multiMiniLM/);
  });

  it('throws at once while the listener is down, asks again after a while, and works once it is back', async () => {
    const { listener, url } = await serve();
    const port = (listener.server.address() as AddressInfo).port;
    const embedder = client(url, {}, { retryMs: 300 });
    await expect(embedder.embed(['a'], { plotLanguage: 'ko' })).resolves.toBeTruthy();
    await listener.close();

    const started = Date.now();
    await expect(embedder.embed(['a'], { plotLanguage: 'ko', timeoutMs: 3_000 })).rejects.toThrow(/cannot reach/);
    expect(Date.now() - started).toBeLessThan(1_000);
    // Back, but not asked yet: every call throws without a connection until the wait is over.
    await serve(undefined, port);
    await expect(embedder.embed(['b'], { plotLanguage: 'ko' })).rejects.toThrow(/unreachable/);
    expect(fake.calls).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(embedder.embed(['b'], { plotLanguage: 'ko' })).resolves.toEqual({ model: 'multiMiniLM', vectors: [[1, 0]] });
  });

  it('throws at its deadline when the listener is slow, and goes on asking it', async () => {
    const { url } = await serve();
    const embedder = client(url);
    fake.held = true;
    const started = Date.now();
    await expect(embedder.embed(['a'], { plotLanguage: 'ko', kind: 'query', timeoutMs: 150 })).rejects.toThrow(/longer than 150 ms/);
    expect(Date.now() - started).toBeLessThan(1_000);
    fake.held = false;
    fake.release();
    await expect(embedder.embed(['b'], { plotLanguage: 'ko', kind: 'query' })).resolves.toEqual({ model: 'multiMiniLM', vectors: [[1, 1]] });
  });
});

describe('the listener’s order', () => {
  it('cuts texts to be stored into pieces of at most PIECE_CHARS characters, a longer one alone', () => {
    expect(piecesOf(['aa', 'bb', 'cc'], 4)).toEqual([['aa', 'bb'], ['cc']]);
    expect(piecesOf(['a', 'bbbbbb', 'c'], 4)).toEqual([['a'], ['bbbbbb'], ['c']]);
    expect(piecesOf([])).toEqual([]);
  });

  it('embeds a document piece by piece and answers its vectors in order', async () => {
    const { url } = await serve();
    const texts = [document(900, 'a'), document(900, 'b'), document(900, 'c'), document(PIECE_CHARS + 1, 'd'), 'e'];
    const { vectors } = await client(url).embed(texts, { plotLanguage: 'ko' });
    expect(vectors.map(([length]) => length)).toEqual(texts.map((text) => text.length));
    expect(fake.calls.map((call) => call.texts.map((text) => text[0]).join(''))).toEqual(['ab', 'c', 'd', 'e']);
  });

  it('puts a query ahead of the pieces a document has left', async () => {
    const { url } = await serve();
    const embedder = client(url);
    fake.held = true;
    const stored = embedder.embed([document(1_500), document(1_500), document(1_500)], { plotLanguage: 'ko' });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const asked = embedder.embed(['q'], { plotLanguage: 'ko', kind: 'query' });
    // Received while the first piece runs; it goes next.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.held = false;
    fake.release();
    await expect(asked).resolves.toEqual({ model: 'multiMiniLM', vectors: [[1, 1]] });
    await expect(stored).resolves.toMatchObject({ vectors: [[1_500, 0], [1_500, 0], [1_500, 0]] });
    expect(fake.calls.map((call) => call.kind)).toEqual(['document', 'query', 'document', 'document']);
  });

  it('drops the pieces of a request whose caller gave up', async () => {
    const { url } = await serve();
    const embedder = client(url);
    fake.held = true;
    await expect(
      embedder.embed([document(1_500), document(1_500), document(1_500)], { plotLanguage: 'ko', timeoutMs: 150 }),
    ).rejects.toThrow(/longer than 150 ms/);
    // The listener hears the connection close before the piece in hand is done.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.held = false;
    fake.release();
    await expect(embedder.embed(['q'], { plotLanguage: 'ko', kind: 'query' })).resolves.toBeTruthy();
    expect(fake.calls.map((call) => call.kind)).toEqual(['document', 'query']);
  });
});
