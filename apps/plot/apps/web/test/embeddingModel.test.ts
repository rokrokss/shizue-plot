/**
 * The reader's embedding model: the pick this browser keeps, and the page's
 * search on it — which repo the worker is asked for, and which name the stored
 * vectors are kept under. The worker is a stand-in that answers every batch.
 */
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_MODELS,
  embeddingModels,
  readEmbeddingModel,
  writeEmbeddingModel,
} from '../src/lib/scripts/embeddingModels';

afterEach(() => vi.unstubAllGlobals());

describe('the embedding model setting', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });
  });

  it('offers RisuAI’s local wasm models under RisuAI’s names, the multilingual one first and by default', () => {
    expect(embeddingModels).toEqual(['multiMiniLM', 'MiniLM', 'bgeSmallEn', 'nomic', 'bgem3', 'bgeM3Ko']);
    expect(DEFAULT_EMBEDDING_MODEL).toBe('multiMiniLM');
    expect(EMBEDDING_MODELS.multiMiniLM.repo).toBe('Xenova/paraphrase-multilingual-MiniLM-L12-v2');
    expect(EMBEDDING_MODELS.MiniLM.repo).toBe('Xenova/all-MiniLM-L6-v2');
    // RisuAI's bge-m3 pair, offered as heavy.
    expect(EMBEDDING_MODELS.bgem3).toMatchObject({ repo: 'Xenova/bge-m3', heavy: true });
    expect(EMBEDDING_MODELS.bgeM3Ko).toMatchObject({ repo: 'HyperBlaze/BGE-m3-ko', heavy: true });
    expect(embeddingModels.filter((model) => EMBEDDING_MODELS[model].heavy)).toEqual(['bgem3', 'bgeM3Ko']);
    expect(readEmbeddingModel()).toBe('multiMiniLM');
  });

  it('keeps the reader’s pick in this browser', () => {
    writeEmbeddingModel('MiniLM');
    expect(store.get('shizue.embeddingModel')).toBe('MiniLM');
    expect(readEmbeddingModel()).toBe('MiniLM');
    writeEmbeddingModel('nomic');
    expect(readEmbeddingModel()).toBe('nomic');
  });

  it.each([
    ['a RisuAI model not offered here', 'custom'],
    ['a RisuAI API model', 'openai3small'],
    ['a GPU twin', 'MiniLMGPU'],
    ['a name off the prototype', 'toString'],
    ['nothing', ''],
  ])('falls back to the default for %s', (_, stored) => {
    store.set('shizue.embeddingModel', stored);
    expect(readEmbeddingModel()).toBe('multiMiniLM');
  });

  it('falls back to the default where storage is blocked or there is no window', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
        setItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
      },
    });
    expect(() => writeEmbeddingModel('MiniLM')).not.toThrow();
    expect(readEmbeddingModel()).toBe('multiMiniLM');
    vi.stubGlobal('window', undefined);
    expect(readEmbeddingModel()).toBe('multiMiniLM');
  });
});

describe('the page’s search on the picked model', () => {
  /** Every batch the stand-in worker was handed. */
  let posted: { model: string; texts: string[] }[];
  let idb: IDBFactory;

  beforeEach(() => {
    posted = [];
    idb = new IDBFactory();
    vi.stubGlobal('indexedDB', idb);
    vi.stubGlobal(
      'Worker',
      class {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        postMessage({ id, model, texts }: { id: number; model: string; texts: string[] }) {
          posted.push({ model, texts });
          const vectors = texts.map((text) => Float32Array.of(text.length, 1));
          setTimeout(() => this.onmessage?.({ data: { id, vectors } }));
        }
        terminate() {}
      },
    );
    vi.resetModules();
  });

  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

  /** Every key the page's store holds. */
  async function storedKeys(): Promise<string[]> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.open('shizue-similarity');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      const request = db.transaction('vectors').objectStore('vectors').getAllKeys();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return (keys as string[]).sort();
  }

  it('asks the worker for the picked model’s repo, keeps its vectors under its RisuAI name, and is ready for it alone', async () => {
    const { searchSimilar, embedderReady } = await import('../src/lib/scripts/embedding');
    expect(embedderReady('MiniLM')).toBe(false);
    await searchSimilar('MiniLM', 'sword', ['sword', 'shield']);
    expect(posted).toEqual([
      { model: 'Xenova/all-MiniLM-L6-v2', texts: ['sword', 'shield'] },
      { model: 'Xenova/all-MiniLM-L6-v2', texts: ['sword'] },
    ]);
    expect(embedderReady('MiniLM')).toBe(true);
    // A switch: the next search waits on a load, and the page shows its notice.
    expect(embedderReady('multiMiniLM')).toBe(false);

    posted = [];
    await searchSimilar('multiMiniLM', 'sword', ['sword', 'shield']);
    // The other model's vectors are not this one's: both texts are embedded again.
    expect(posted).toEqual([
      { model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', texts: ['sword', 'shield'] },
      { model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', texts: ['sword'] },
    ]);
    expect([embedderReady('MiniLM'), embedderReady('multiMiniLM')]).toEqual([false, true]);
    expect(await storedKeys()).toEqual(
      ['sword|MiniLM', 'shield|MiniLM', 'sword|multiMiniLM', 'shield|multiMiniLM'].map(sha256).sort(),
    );

    // Back on the first: its vectors are still its own, and only the query is embedded.
    posted = [];
    await searchSimilar('MiniLM', 'sword', ['sword', 'shield']);
    expect(posted).toEqual([{ model: 'Xenova/all-MiniLM-L6-v2', texts: ['sword'] }]);
  });
});
