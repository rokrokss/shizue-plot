/**
 * The server embedder's routing, its thread's lifecycle and failures
 * (`embedder.ts`), with a stand-in for the thread: no weights are loaded here.
 * Weights are "there" when an empty file is where the server looks for them.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalEmbedder,
  embedderConfig,
  EmbedderUnavailable,
  weightsPath,
  type EmbedderWorker,
  type EmbeddingModelId,
  type ThreadData,
  type ThreadMessage,
  type ThreadModel,
  type ThreadReply,
} from '../src/embedder.js';
import { ATTENTION_BUDGET, attentionBatches, MAX_TOKENS } from '../src/embedderThread.js';

/** A thread that answers each text with [its length, its model's repo's length], or as told. */
class FakeThread extends EventEmitter implements EmbedderWorker {
  readonly batches: { model: ThreadModel; texts: string[] }[] = [];
  readonly unloads: string[] = [];
  terminated = false;
  /** Holds every answer back while true. */
  stalled = false;
  failLoad = false;
  constructor(readonly data: ThreadData) {
    super();
  }
  postMessage(message: ThreadMessage): void {
    if ('unload' in message) {
      this.unloads.push(message.unload);
      return;
    }
    const { id, model, texts } = message;
    this.batches.push({ model, texts });
    if (this.stalled) return;
    setImmediate(() => {
      if (this.terminated) return;
      const reply: ThreadReply = this.failLoad
        ? { id, error: 'no such file', loadFailed: true }
        : { id, vectors: texts.map((text) => new Float32Array([text.length, model.repo.length])) };
      this.emit('message', reply);
    });
  }
  unref(): void {}
  async terminate(): Promise<number> {
    this.terminated = true;
    this.emit('exit', 1);
    return 1;
  }
}

let cacheDir: string;
let threads: FakeThread[];
const spawn = (data: ThreadData): FakeThread => {
  const thread = new FakeThread(data);
  threads.push(thread);
  return thread;
};

/** Puts an empty weights file where the server looks for `model`'s. */
function fetched(...models: EmbeddingModelId[]): void {
  for (const model of models) {
    const path = weightsPath(cacheDir, model);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
}

/** Routing by language unless a test says otherwise: most of these tests need two models to tell apart. */
const envWith = (env: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  EMBEDDER_CACHE_DIR: cacheDir,
  EMBEDDER_ROUTING: 'by-language',
  ...env,
});

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'embedder-'));
  threads = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('routing', () => {
  it('runs KURE-v1 for every plot when nothing is set', () => {
    expect(embedderConfig({ EMBEDDER_CACHE_DIR: cacheDir })).toMatchObject({
      routing: 'single',
      routes: { languages: {}, default: 'KURE-v1' },
    });
  });

  it('routes by language with EMBEDDER_ROUTING=by-language: KURE-v1 for Korean, bge-m3 for the rest', async () => {
    fetched('KURE-v1', 'bge-m3');
    const embedder = createLocalEmbedder(envWith(), { spawn })!;
    expect(embedder.modelFor('ko')).toBe('KURE-v1');
    expect(embedder.modelFor('en')).toBe('bge-m3');
    expect(embedder.modelFor('ja')).toBe('bge-m3');

    const ko = await embedder.embed(['고양이'], { plotLanguage: 'ko' });
    const en = await embedder.embed(['a cat', 'two'], { plotLanguage: 'en' });
    expect(ko).toEqual({ model: 'KURE-v1', vectors: [[3, 'nlpai-lab/KURE-v1'.length]] });
    expect(en.model).toBe('bge-m3');
    expect(en.vectors.map((vector) => vector[1])).toEqual(['Xenova/bge-m3'.length, 'Xenova/bge-m3'.length]);
    // One thread for both, each batch saying its model and how to pool it.
    expect(threads).toHaveLength(1);
    expect(threads[0]!.batches.map(({ model }) => [model.repo, model.pooling])).toEqual([
      ['nlpai-lab/KURE-v1', 'cls'],
      ['Xenova/bge-m3', 'cls'],
    ]);
    await embedder.close();
  });

  it('runs one model for every plot with EMBEDDER_ROUTING=single, KURE-v1 unless EMBEDDER_MODEL says otherwise', async () => {
    fetched('KURE-v1', 'bge-m3', 'multiMiniLM');
    const single = createLocalEmbedder(envWith({ EMBEDDER_ROUTING: 'single' }), { spawn })!;
    expect(['ko', 'en', 'ja'].map((language) => single.modelFor(language as 'ko'))).toEqual(['KURE-v1', 'KURE-v1', 'KURE-v1']);
    expect((await single.embed(['고양이'], { plotLanguage: 'en' })).model).toBe('KURE-v1');
    await single.close();

    const light = createLocalEmbedder(envWith({ EMBEDDER_ROUTING: 'single', EMBEDDER_MODEL: 'multiMiniLM' }), { spawn })!;
    expect(light.modelFor('ko')).toBe('multiMiniLM');
    expect(light.modelFor('en')).toBe('multiMiniLM');
    await light.close();
  });

  it('reads EMBEDDER_MODEL with single only, and turns off for what it does not know', () => {
    const byLanguage = embedderConfig(envWith({ EMBEDDER_MODEL: 'multiMiniLM' }));
    expect(byLanguage).toMatchObject({ routing: 'by-language', routes: { languages: { ko: 'KURE-v1' }, default: 'bge-m3' } });
    expect(embedderConfig(envWith({ EMBEDDER_ROUTING: 'single', EMBEDDER_MODEL: 'gpt' }))).toMatchObject({
      off: expect.stringContaining('unknown EMBEDDER_MODEL'),
    });
    expect(embedderConfig(envWith({ EMBEDDER_ROUTING: 'round-robin' }))).toMatchObject({
      off: expect.stringContaining('unknown EMBEDDER_ROUTING'),
    });
    expect(embedderConfig(envWith({ EMBEDDER: 'off' }))).toEqual({ off: 'EMBEDDER=off' });
    expect(createLocalEmbedder(envWith({ EMBEDDER: 'off' }), { spawn })).toBeUndefined();
  });

  it('puts no other model in place of one never fetched: its plots get none, and an embed throws', async () => {
    fetched('bge-m3');
    const embedder = createLocalEmbedder(envWith(), { spawn })!;
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no weights for KURE-v1'));
    expect(embedder.modelFor('ko')).toBeNull();
    expect(embedder.modelFor('en')).toBe('bge-m3');
    await expect(embedder.embed(['고양이'], { plotLanguage: 'ko' })).rejects.toThrow(/KURE-v1 was never fetched/);
    expect(threads).toEqual([]);
    await embedder.close();
  });

  it('caps each model’s onnxruntime threads when EMBEDDER_THREADS says so', async () => {
    fetched('KURE-v1', 'bge-m3');
    const capped = createLocalEmbedder(envWith({ EMBEDDER_THREADS: '2' }), { spawn })!;
    await capped.embed(['하나'], { plotLanguage: 'ko' });
    const free = createLocalEmbedder(envWith({ EMBEDDER_THREADS: 'many' }), { spawn })!;
    await free.embed(['one'], { plotLanguage: 'en' });
    expect(threads.map((thread) => thread.data.threads)).toEqual([2, undefined]);
    await capped.close();
    await free.close();
  });

  it('is off when no model it routes to was fetched', () => {
    fetched('multiMiniLM');
    expect(createLocalEmbedder(envWith(), { spawn })).toBeUndefined();
  });
});

describe('the thread’s calls', () => {
  const budgetHeld = (lengths: number[], calls: number[][]): boolean =>
    calls.every((call) => call.length === 1 || call.length * Math.max(...call.map((index) => lengths[index]!)) ** 2 <= ATTENTION_BUDGET);

  it('takes short texts 32 at a time', () => {
    expect(attentionBatches(Array.from({ length: 70 }, () => 40)).map((call) => call.length)).toEqual([32, 32, 6]);
  });

  it('keeps count × longest² within the budget, shortest first, every text once', () => {
    const lengths = [2_048, 12, 1_536, 384, 1_536, 700, ...Array.from({ length: 40 }, () => 384), 5];
    const calls = attentionBatches(lengths);
    expect(budgetHeld(lengths, calls)).toBe(true);
    expect(calls.flat().sort((a, b) => a - b)).toEqual(lengths.map((_, index) => index));
    const longest = calls.map((call) => Math.max(...call.map((index) => lengths[index]!)));
    expect(longest).toEqual([...longest].sort((a, b) => a - b));
    expect(calls.at(-1)).toEqual([0]);
  });

  it('puts 1,536 tokens two to a call and 2,048 one, as measured', () => {
    expect(attentionBatches([1_536, 1_536, 1_536])).toEqual([[0, 1], [2]]);
    expect(attentionBatches([MAX_TOKENS, MAX_TOKENS])).toEqual([[0], [1]]);
  });

  it('sends a text over the budget alone rather than refusing it', () => {
    expect(attentionBatches([MAX_TOKENS * 2, 10])).toEqual([[1], [0]]);
  });
});

describe('the thread', () => {
  it('sends 32 texts at a time and answers in order', async () => {
    fetched('KURE-v1', 'bge-m3');
    const embedder = createLocalEmbedder(envWith(), { spawn })!;
    const texts = Array.from({ length: 70 }, (_, index) => 'x'.repeat(index + 1));
    const { vectors } = await embedder.embed(texts, { plotLanguage: 'ko', kind: 'query' });
    expect(threads[0]!.batches.map(({ texts }) => texts.length)).toEqual([32, 32, 6]);
    expect(vectors.map((vector) => vector[0])).toEqual(texts.map((text) => text.length));
    await embedder.close();
  });

  it('unloads a model after the idle period, the last one with the thread, and loads it again on the next request', async () => {
    fetched('KURE-v1', 'bge-m3');
    const embedder = createLocalEmbedder(envWith(), { spawn, idleMs: 40 })!;
    await embedder.embed(['하나'], { plotLanguage: 'ko' });
    await embedder.embed(['one'], { plotLanguage: 'en' });

    // Kept busy, KURE-v1 stays; bge-m3, left alone, goes — the thread stays for KURE-v1.
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await embedder.embed(['둘'], { plotLanguage: 'ko' });
    }
    expect(threads[0]!.unloads).toEqual(['Xenova/bge-m3']);
    expect(threads[0]!.terminated).toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('bge-m3 unloaded'));

    // KURE-v1 left alone too: the thread ends with it.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(threads[0]!.terminated).toBe(true);
    expect(threads[0]!.unloads).toEqual(['Xenova/bge-m3']);
    expect((await embedder.embed(['셋'], { plotLanguage: 'ko' })).model).toBe('KURE-v1');
    expect(threads).toHaveLength(2);
    expect(threads[1]!.batches.map(({ model }) => model.repo)).toEqual(['nlpai-lab/KURE-v1']);
    await embedder.close();
  });

  it('loads a model ahead on warm(), and lets it idle out like any other', async () => {
    fetched('KURE-v1', 'bge-m3');
    const embedder = createLocalEmbedder(envWith(), { spawn, idleMs: 20 })!;
    embedder.warm('ko');
    expect(threads[0]!.batches).toEqual([{ model: expect.objectContaining({ repo: 'nlpai-lab/KURE-v1' }), texts: [] }]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(threads[0]!.terminated).toBe(true);
    await embedder.close();
  });

  it('is not unloaded while a request is waiting on it', async () => {
    fetched('KURE-v1', 'bge-m3');
    const embedder = createLocalEmbedder(envWith(), { spawn, idleMs: 10 })!;
    await embedder.embed(['하나'], { plotLanguage: 'ko' });
    threads[0]!.stalled = true;
    const waiting = embedder.embed(['둘'], { plotLanguage: 'ko', timeoutMs: 60 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(threads[0]!.terminated).toBe(false);
    await expect(waiting).rejects.toThrow(/longer than 60 ms/);
    await embedder.close();
  });

  it('throws past the deadline, and when the model cannot load — not trying again for a minute', async () => {
    fetched('KURE-v1', 'bge-m3');
    const embedder = createLocalEmbedder(envWith(), { spawn: (data) => Object.assign(spawn(data), { stalled: true }) })!;
    await expect(embedder.embed(['하나'], { plotLanguage: 'ko', timeoutMs: 20 })).rejects.toThrow(/longer than 20 ms/);

    const failing = createLocalEmbedder(envWith(), {
      spawn: (data) => Object.assign(spawn(data), { failLoad: true }),
    })!;
    await expect(failing.embed(['one'], { plotLanguage: 'en' })).rejects.toThrow('no such file');
    await expect(failing.embed(['two'], { plotLanguage: 'en' })).rejects.toThrow(/could not load bge-m3/);
    await expect(failing.embed(['two'], { plotLanguage: 'en' })).rejects.toBeInstanceOf(EmbedderUnavailable);
    // Only the first reached the thread; the model of the other language is untouched.
    expect(threads.at(-1)!.batches.map(({ texts }) => texts)).toEqual([['one']]);
    expect(failing.modelFor('ko')).toBe('KURE-v1');
    await embedder.close();
    await failing.close();
  });
});
