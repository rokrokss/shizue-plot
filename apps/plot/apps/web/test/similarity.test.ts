/**
 * The embedding search against RisuAI's own code: `HypaProcesser` from its
 * `process/memory/hypamemory.ts`, copied below with only its storage and its
 * embedder swapped for stand-ins — a Map for localforage, and the same fake
 * embedder for both. The fake is deterministic and, like the real model, gives
 * a text a slightly different vector in a different batch, so a difference in
 * how the texts are batched or cached shows up as a difference in order. Ours
 * keeps its vectors in `fake-indexeddb` where a test reloads the page.
 */
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSimilaritySearch,
  indexedDbStore,
  workerEmbedder,
  type Embed,
  type EmbedWorker,
  type VectorStore,
} from '../src/lib/scripts/similarity';

/* ------------------------------------------------ RisuAI's, as it is there */

type VectorArray = number[] | Float32Array;
type memoryVector = { embedding: number[] | Float32Array; content: string; alreadySaved?: boolean };

const chunkArray = <T,>(arr: T[], chunkSize: number) =>
  arr.reduce((chunks, elem, index) => {
    const chunkIndex = Math.floor(index / chunkSize);
    const chunk = chunks[chunkIndex] || [];
    chunks[chunkIndex] = chunk.concat([elem]);
    return chunks;
  }, [] as T[][]);

function similarity(a: VectorArray, b: VectorArray) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

/** localforage's `getItem`/`setItem`, over a Map that outlives the processer as the database does. */
class Forage {
  items = new Map<string, memoryVector>();
  async getItem(key: string): Promise<memoryVector | null> {
    const item = this.items.get(key);
    return item ? { ...item } : null;
  }
  async setItem(key: string, value: memoryVector): Promise<void> {
    this.items.set(key, { ...value });
  }
}

class HypaProcesser {
  vectors: memoryVector[] = [];
  model = 'MiniLM';
  constructor(
    private forage: Forage,
    private runEmbedding: (texts: string[]) => Promise<Float32Array[]>,
  ) {}

  async embedDocuments(texts: string[]): Promise<VectorArray[]> {
    const subPrompts = chunkArray(texts, 50);
    const embeddings: VectorArray[] = [];
    for (let i = 0; i < subPrompts.length; i += 1) {
      const input = subPrompts[i]!;
      const data = await this.getEmbeds(input);
      embeddings.push(...data);
    }
    return embeddings;
  }

  async getEmbeds(input: string[] | string): Promise<VectorArray[]> {
    const inputs: string[] = Array.isArray(input) ? input : [input];
    return await this.runEmbedding(inputs);
  }

  async addText(texts: string[]) {
    const suffix = '';
    for (let i = 0; i < texts.length; i++) {
      const itm: memoryVector | null = await this.forage.getItem(texts[i] + '|' + this.model + suffix);
      if (itm) {
        itm.alreadySaved = true;
        this.vectors.push(itm);
      }
    }
    texts = texts.filter((v) => {
      for (let i = 0; i < this.vectors.length; i++) {
        if (this.vectors[i]!.content === v) {
          return false;
        }
      }
      return true;
    });
    if (texts.length === 0) {
      return;
    }
    const vectors = await this.embedDocuments(texts);
    const memoryVectors: memoryVector[] = vectors.map((embedding, idx) => ({
      content: texts[idx]!,
      embedding,
    }));
    for (let i = 0; i < memoryVectors.length; i++) {
      const vec = memoryVectors[i]!;
      if (!vec.alreadySaved) {
        await this.forage.setItem(texts[i] + '|' + this.model + suffix, vec);
      }
    }
    this.vectors = memoryVectors.concat(this.vectors);
  }

  async similaritySearch(query: string) {
    const results = this.similaritySearchVectorWithScore((await this.getEmbeds(query))[0]!);
    return results.map((result) => result[0]);
  }

  private similaritySearchVectorWithScore(query: VectorArray): [string, number][] {
    const memoryVectors = this.vectors;
    const sim = similarity;
    const searches = memoryVectors
      .map((vector, index) => ({
        similarity: sim(query, vector.embedding),
        index,
      }))
      .sort((a, b) => (a.similarity > b.similarity ? -1 : 0));
    const result: [string, number][] = searches.map((search) => [memoryVectors[search.index]!.content, search.similarity]);
    return result;
  }
}

/** RisuAI's trigger: a new processer per call, over the one database. */
function reference(embed: (texts: string[]) => Promise<Float32Array[]>, forage = new Forage()) {
  return async (source: string, texts: string[]) => {
    const processer = new HypaProcesser(forage, embed);
    await processer.addText(texts);
    return processer.similaritySearch(source);
  };
}

/* -------------------------------------------------------------- the fake */

const DIM = 8;

/** A text's direction: from its lowercased letters, so `Hi` and `hi` point the same way. */
function base(text: string): number[] {
  const out = new Array<number>(DIM).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i += 1) out[(lower.charCodeAt(i) * 7 + i) % DIM]! += (lower.charCodeAt(i) % 13) + 1;
  out[0]! += 1;
  const norm = Math.hypot(...out);
  return out.map((value) => value / norm);
}

/**
 * The model, faked: each vector scaled by a factor of its whole batch, as
 * per-batch quantization shifts the real one, then rounded to float32 as the
 * real one is. Records every batch it was asked for.
 */
function fakeModel() {
  const batches: string[][] = [];
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    batches.push([...texts]);
    const company = texts.reduce((sum, text) => sum + text.length, 0) % 7;
    const scale = 1 + company * 1e-6;
    return texts.map((text) => Float32Array.from(base(text).map((value) => value * scale)));
  };
  return { embed, batches };
}

/** Ours and RisuAI's over the same fake, each with its own cache. */
function pair() {
  const ours = fakeModel();
  const theirs = fakeModel();
  return {
    ours: createSimilaritySearch(ours.embed as Embed),
    theirs: reference(theirs.embed),
    batches: { ours: ours.batches, theirs: theirs.batches },
  };
}

/**
 * One browser's storage — a fake IndexedDB for ours, one Forage for RisuAI's —
 * and `load()` to open the page in it again: a new search with an empty memory,
 * on `model` if given, over what earlier loads stored.
 */
function browser() {
  const idb = new IDBFactory();
  const forage = new Forage();
  return {
    idb,
    load(model?: string) {
      const ours = fakeModel();
      const theirs = fakeModel();
      return {
        ours: createSimilaritySearch(ours.embed, { model, store: indexedDbStore(() => idb) }),
        theirs: reference(theirs.embed, forage),
        batches: { ours: ours.batches, theirs: theirs.batches },
      };
    },
  };
}

/** Every key and value in every database of `idb`. */
async function stored(idb: IDBFactory): Promise<{ keys: IDBValidKey[]; values: unknown[] }> {
  const request = <T,>(made: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      made.onsuccess = () => resolve(made.result);
      made.onerror = () => reject(made.error);
    });
  const out = { keys: [] as IDBValidKey[], values: [] as unknown[] };
  for (const { name } of await idb.databases()) {
    const db = await request(idb.open(name!));
    for (const store of db.objectStoreNames) {
      const read = db.transaction(store).objectStore(store);
      out.keys.push(...(await request(read.getAllKeys())));
      out.values.push(...(await request(read.getAll())));
    }
    db.close();
  }
  return out;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/* ------------------------------------------------------------------ tests */

const nativeSort = Array.prototype.sort;
afterEach(() => {
  Array.prototype.sort = nativeSort;
  vi.unstubAllGlobals();
});

describe('the embedding search', () => {
  it('orders best first, embedding the texts and then the query on its own', async () => {
    const { embed, batches } = fakeModel();
    const search = createSimilaritySearch(embed);
    const texts = ['sword', 'shield', 'sword and shield', 'bread'];
    const order = await search('sword', texts);
    expect(order[0]).toBe('sword');
    expect([...order].sort()).toEqual([...texts].sort());
    expect(batches).toEqual([texts, ['sword']]);
  });

  it('is RisuAI’s order through a fresh cache, a partial one and a full one', async () => {
    const { ours, theirs, batches } = pair();
    const calls: [string, string[]][] = [
      ['검', ['활', '검', '창']],
      ['검', ['창', '도끼', '검', '방패']],
      ['방패', ['방패', '도끼', '활', '검', '창']],
    ];
    for (const [source, texts] of calls) {
      expect(await ours(source, texts)).toEqual(await theirs(source, texts));
    }
    // Only the texts not seen before are embedded, then the query, every time.
    expect(batches.ours).toEqual(batches.theirs);
    expect(batches.ours).toEqual([['활', '검', '창'], ['검'], ['도끼', '방패'], ['검'], ['방패']]);
  });

  it('keeps duplicates, cached or not, and embeds an uncached one twice', async () => {
    const { ours, theirs, batches } = pair();
    for (const texts of [['a', 'b', 'a'], ['a', 'c', 'c', 'a']]) {
      const got = await ours('a', texts);
      expect(got).toEqual(await theirs('a', texts));
      expect(got).toHaveLength(texts.length);
    }
    expect(batches.ours).toEqual([['a', 'b', 'a'], ['a'], ['c', 'c'], ['a']]);
  });

  it('keeps exact ties in RisuAI’s order: new texts first, in their order, then the cached ones', async () => {
    const { ours, theirs } = pair();
    // Case is lost on the way in, so these three point the same way; in one batch they tie exactly.
    const first = await ours('x', ['Hi', 'hi', 'HI']);
    expect(first).toEqual(['Hi', 'hi', 'HI']);
    expect(first).toEqual(await theirs('x', ['Hi', 'hi', 'HI']));
    // `hI` is new, in a batch the fake scales as it did the first: a tie with the cached
    // three, and it comes first among them although it is written last.
    const texts = ['HI', 'hi', 'Hi', 'hI', 'abcd'];
    const second = await ours('hi', texts);
    expect(second).toEqual(await theirs('hi', texts));
    expect(second).toEqual(['hI', 'HI', 'hi', 'Hi', 'abcd']);
  });

  it('decides near ties on the exact float, batch and all', async () => {
    const { ours, theirs } = pair();
    // `ab` and `Ab` point the same way, but were embedded in different company: the
    // later batch scaled `Ab` a millionth higher, and that decides it.
    expect(await ours('q', ['ab', 'zz'])).toEqual(await theirs('q', ['ab', 'zz']));
    expect(await ours('q', ['Ab', 'zzz'])).toEqual(await theirs('q', ['Ab', 'zzz']));
    const mixed = ['ab', 'Ab', 'yy'];
    const got = await ours('ab', mixed);
    expect(got).toEqual(await theirs('ab', mixed));
    expect(got).toEqual(['Ab', 'ab', 'yy']);
  });

  it('embeds in RisuAI’s batches of 50', async () => {
    const { ours, theirs, batches } = pair();
    const texts = Array.from({ length: 120 }, (_, i) => `text ${i}`);
    expect(await ours('text 7', texts)).toEqual(await theirs('text 7', texts));
    expect(batches.ours.map((batch) => batch.length)).toEqual([50, 50, 20, 1]);
    expect(batches.ours).toEqual(batches.theirs);
  });

  it('agrees with RisuAI over random runs that share a cache', async () => {
    const { ours, theirs } = pair();
    let seed = 7;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const pool = ['검', '활', 'ab', 'ba', 'Hi', 'hi', '', 'sword', 'Sword', 'swords', '§', 'x', 'xx'];
    for (let round = 0; round < 200; round += 1) {
      const texts = Array.from({ length: 1 + Math.floor(random() * 8) }, () => pool[Math.floor(random() * pool.length)]!);
      const source = pool[Math.floor(random() * pool.length)]!;
      expect(await ours(source, texts), `round ${round}`).toEqual(await theirs(source, texts));
    }
  });

  it('hands the native sort RisuAI’s comparator itself, so another engine’s sort agrees with RisuAI there too', async () => {
    // A merge sort that takes from the left on "equal", as some engines do: RisuAI's
    // comparator never says "after", so this one can put a lower score first.
    Array.prototype.sort = function <T>(this: T[], compare?: (a: T, b: T) => number): T[] {
      const merge = (items: T[]): T[] => {
        if (items.length < 2) return items;
        const left = merge(items.slice(0, items.length >> 1));
        const right = merge(items.slice(items.length >> 1));
        const out: T[] = [];
        while (left.length && right.length) out.push(compare!(left[0]!, right[0]!) <= 0 ? left.shift()! : right.shift()!);
        return out.concat(left, right);
      };
      const sorted = merge([...this]);
      for (let i = 0; i < sorted.length; i += 1) this[i] = sorted[i]!;
      return this;
    };
    const { ours, theirs } = pair();
    const texts = ['zz', 'ab', 'q', 'ba', 'qq'];
    let got: string[];
    let want: string[];
    try {
      got = await ours('q', texts);
      want = await theirs('q', texts);
    } finally {
      Array.prototype.sort = nativeSort;
    }
    expect(got).toEqual(want);
    // Not best first: the comparator's quirk survives, as it does in RisuAI on that engine.
    expect(got[0]).not.toBe('q');
    // V8's own sort, given the same comparator, does put it first.
    const native = await ours('q', texts);
    expect(native).toEqual(await theirs('q', texts));
    expect(native[0]).toBe('q');
  });
});

describe('the stored vectors', () => {
  it('are read back after a reload, so a near tie falls as it does in RisuAI', async () => {
    const { load } = browser();
    const first = load();
    // `ab` and `Ab` point the same way; the second batch scales `Ab` a millionth higher.
    expect(await first.ours('q', ['ab', 'zz'])).toEqual(await first.theirs('q', ['ab', 'zz']));
    expect(await first.ours('q', ['Ab', 'zzz'])).toEqual(await first.theirs('q', ['Ab', 'zzz']));
    const second = load();
    const mixed = ['ab', 'Ab', 'yy'];
    const got = await second.ours('ab', mixed);
    expect(got).toEqual(await second.theirs('ab', mixed));
    expect(got).toEqual(['Ab', 'ab', 'yy']);
    expect(second.batches.ours).toEqual([['yy'], ['ab']]);
    // A page that forgot them embeds all three in one batch, where the two tie exactly.
    expect(await createSimilaritySearch(fakeModel().embed)('ab', mixed)).toEqual(['ab', 'Ab', 'yy']);
  });

  it('agree with RisuAI on a list of cached and new texts, duplicates and all, in the next session', async () => {
    const { load } = browser();
    const first = load();
    const earlier: [string, string[]][] = [
      ['검', ['활', '검', '창']],
      ['a', ['a', 'b', 'a']],
    ];
    for (const [source, texts] of earlier) expect(await first.ours(source, texts)).toEqual(await first.theirs(source, texts));
    const second = load();
    const texts = ['창', '도끼', '검', '도끼', 'b', '방패', 'a', '창'];
    const got = await second.ours('검', texts);
    expect(got).toEqual(await second.theirs('검', texts));
    expect(got).toHaveLength(texts.length);
    // Only what no session embedded before, in one batch and twice where it appears twice.
    expect(second.batches.ours).toEqual(second.batches.theirs);
    expect(second.batches.ours).toEqual([['도끼', '도끼', '방패'], ['검']]);
  });

  it('agree with RisuAI over random runs with reloads between them', async () => {
    const { load } = browser();
    let seed = 11;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const pool = ['검', '활', 'ab', 'Ab', 'ba', 'Hi', 'hi', '', 'sword', 'Sword', '§', 'x', 'xx'];
    let page = load();
    for (let round = 0; round < 120; round += 1) {
      if (round % 15 === 14) page = load();
      const texts = Array.from({ length: 1 + Math.floor(random() * 8) }, () => pool[Math.floor(random() * pool.length)]!);
      const source = pool[Math.floor(random() * pool.length)]!;
      expect(await page.ours(source, texts), `round ${round}`).toEqual(await page.theirs(source, texts));
    }
  });

  it('are keyed by the SHA-256 of text and the model’s RisuAI name, so another model embeds again', async () => {
    const { idb, load } = browser();
    // Unnamed, a search is on the default: the multilingual model, not RisuAI's.
    await load().ours('sword', ['sword', 'shield']);
    const other = load('MiniLM');
    await other.ours('sword', ['sword', 'shield']);
    expect(other.batches.ours).toEqual([['sword', 'shield'], ['sword']]);
    const again = load('multiMiniLM');
    await again.ours('sword', ['sword', 'shield']);
    expect(again.batches.ours).toEqual([['sword']]);
    const { keys, values } = await stored(idb);
    expect([...keys].sort()).toEqual(
      ['sword|multiMiniLM', 'shield|multiMiniLM', 'sword|MiniLM', 'shield|MiniLM'].map(sha256).sort(),
    );
    expect(values.every((value) => value instanceof Float32Array && value.length === DIM)).toBe(true);
  });

  const failing: [string, () => VectorStore][] = [
    ['there is no IndexedDB', () => indexedDbStore()],
    [
      'the database will not open',
      () =>
        indexedDbStore(() => ({
          open: () => {
            const request = { error: new DOMException('denied', 'UnknownError') } as unknown as IDBOpenDBRequest;
            setTimeout(() => request.onerror?.(new Event('error')));
            return request;
          },
        }) as unknown as IDBFactory),
    ],
    [
      'reads and writes throw',
      () => ({
        get: () => Promise.reject(new DOMException('gone', 'InvalidStateError')),
        set: () => Promise.reject(new DOMException('full', 'QuotaExceededError')),
      }),
    ],
    [
      'there is no crypto.subtle',
      () => {
        vi.stubGlobal('crypto', {});
        return indexedDbStore(() => new IDBFactory());
      },
    ],
  ];

  it.each(failing)('fall back to the page’s memory when %s', async (_, store) => {
    const ours = fakeModel();
    const theirs = fakeModel();
    const search = createSimilaritySearch(ours.embed, { store: store() });
    const risu = reference(theirs.embed);
    for (const texts of [['검', '활'], ['활', '창', '검']]) expect(await search('검', texts)).toEqual(await risu('검', texts));
    expect(ours.batches).toEqual([['검', '활'], ['검'], ['창'], ['검']]);
  });
});

describe('the embedding worker’s client', () => {
  type Posted = { id: number; model: string; texts: string[] };

  function fakeWorker() {
    const spawned: (EmbedWorker & { posted: Posted[]; terminated: boolean })[] = [];
    const spawn = (): EmbedWorker => {
      const worker = {
        posted: [] as Posted[],
        terminated: false,
        onmessage: null as EmbedWorker['onmessage'],
        onerror: null as EmbedWorker['onerror'],
        postMessage(message: unknown) {
          worker.posted.push(message as Posted);
        },
        terminate() {
          worker.terminated = true;
        },
      };
      spawned.push(worker);
      return worker;
    };
    return { spawn, spawned };
  }

  const SMALL = 'Xenova/all-MiniLM-L6-v2';
  const MULTI = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

  it('starts one worker on the first batch, matches answers to asks, and is ready once one came back', async () => {
    const { spawn, spawned } = fakeWorker();
    const embedder = workerEmbedder(spawn);
    expect(spawned).toHaveLength(0);
    const first = embedder.embedWith(MULTI)(['a']);
    const second = embedder.embedWith(MULTI)(['b', 'c']);
    expect(spawned).toHaveLength(1);
    const worker = spawned[0]!;
    expect(worker.posted).toEqual([
      { id: 1, model: MULTI, texts: ['a'] },
      { id: 2, model: MULTI, texts: ['b', 'c'] },
    ]);
    expect(embedder.ready(MULTI)).toBe(false);
    worker.onmessage!({ data: { id: 2, vectors: [Float32Array.of(2), Float32Array.of(3)] } });
    worker.onmessage!({ data: { id: 1, error: 'offline' } });
    expect(await second).toEqual([Float32Array.of(2), Float32Array.of(3)]);
    await expect(first).rejects.toThrow('offline');
    expect(embedder.ready(MULTI)).toBe(true);
  });

  it('names each batch’s model to the one worker, and is ready only for the model it last answered with', async () => {
    const { spawn, spawned } = fakeWorker();
    const embedder = workerEmbedder(spawn);
    const small = embedder.embedWith(SMALL)(['a']);
    spawned[0]!.onmessage!({ data: { id: 1, vectors: [Float32Array.of(1)] } });
    await small;
    expect(embedder.ready(SMALL)).toBe(true);
    // The reader switched: the next search waits on the other model's load, so the page says so.
    expect(embedder.ready(MULTI)).toBe(false);
    const multi = embedder.embedWith(MULTI)(['b']);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.posted.at(-1)).toEqual({ id: 2, model: MULTI, texts: ['b'] });
    spawned[0]!.onmessage!({ data: { id: 2, vectors: [Float32Array.of(2)] } });
    await multi;
    // The worker let the first one go to load this one.
    expect([embedder.ready(SMALL), embedder.ready(MULTI)]).toEqual([false, true]);
    // A failure on the loaded model keeps it; a switch that failed to load leaves nothing loaded.
    const kept = embedder.embedWith(MULTI)(['c']);
    spawned[0]!.onmessage!({ data: { id: 3, error: 'out of memory' } });
    await expect(kept).rejects.toThrow('out of memory');
    expect(embedder.ready(MULTI)).toBe(true);
    const failed = embedder.embedWith(SMALL)(['d']);
    spawned[0]!.onmessage!({ data: { id: 4, error: 'could not fetch the model' } });
    await expect(failed).rejects.toThrow('could not fetch the model');
    expect([embedder.ready(SMALL), embedder.ready(MULTI)]).toEqual([false, false]);
  });

  it('fails what a crashed worker held, and starts another for the next batch, which loads its model again', async () => {
    const { spawn, spawned } = fakeWorker();
    const embedder = workerEmbedder(spawn);
    const done = embedder.embedWith(MULTI)(['a']);
    spawned[0]!.onmessage!({ data: { id: 1, vectors: [Float32Array.of(1)] } });
    await done;
    const lost = embedder.embedWith(MULTI)(['b']);
    spawned[0]!.onerror!(new Event('error'));
    await expect(lost).rejects.toThrow('the embedding worker crashed');
    expect(spawned[0]!.terminated).toBe(true);
    expect(embedder.ready(MULTI)).toBe(false);
    void embedder.embedWith(MULTI)(['c']);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.posted).toEqual([{ id: 3, model: MULTI, texts: ['c'] }]);
  });

  it('fails the search where the embedder fails, as RisuAI’s throws', async () => {
    const search = createSimilaritySearch(async () => {
      throw new Error('could not fetch the model');
    });
    await expect(search('q', ['a'])).rejects.toThrow('could not fetch the model');
  });
});
