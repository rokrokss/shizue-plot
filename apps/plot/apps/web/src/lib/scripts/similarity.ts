/**
 * RisuAI's embedding search (`HypaProcesser` in its `process/memory/hypamemory.ts`)
 * as `checkSimilarity`, `v2CheckSimilarity` and Lua's `similarity` use it: a new
 * processer for each call, on RisuAI's default model (`MiniLM`), answering the
 * texts best first.
 *
 * The order is RisuAI's to the letter, because a card reads the first text as
 * the closest and RisuAI's own order is quirky:
 *
 * - `addText`: every text is looked up in the cache before anything is
 *   embedded. One with a vector there is taken from it, once for each time it
 *   appears; every other text is embedded, in batches of 50, duplicates and all
 *   — the only dedupe is that a cached text is not embedded again. All the new
 *   vectors are written to the cache (a duplicate's last one wins) before the
 *   query is embedded. The new ones go first, then the cached ones.
 * - The query is embedded on its own, every time, and never cached.
 * - Each text scores the plain dot product with the query (the vectors are
 *   normalized), and the list is sorted with RisuAI's comparator, which answers
 *   "before" for a higher score and "equal" for anything else — never "after".
 *   The native sort is handed that very comparator: what it makes of it is the
 *   engine's, and the reader's browser is the engine RisuAI runs in. (V8's
 *   reads it as a stable sort, best first; a merge sort that takes from the left
 *   run on "equal" can put a lower score first.) In V8, ties keep the order
 *   above.
 *
 * The batches and the cache are part of the answer, not just speed: the model
 * quantizes its activations per batch and pads to the batch's longest text, so
 * the same text in different company moves its score by a few thousandths, and
 * two close texts can trade places on that.
 *
 * So the cache lasts as RisuAI's does: its vectors are kept in the reader's
 * IndexedDB (`indexedDbStore`), and after a reload a text is read back where
 * RisuAI reads it back. RisuAI keys a vector `text|model`; the store is keyed by
 * that string's SHA-256, so what it holds never spells out the chat. The page
 * also keeps in memory what it read or wrote, and asks the store only for the
 * rest. Where the store is unavailable or fails, the memory is the whole
 * cache, for as long as the page lives.
 */

/** One batch through the model: a vector per text, in order. */
export type Embed = (texts: string[]) => Promise<Float32Array[]>;

/** `texts`, closest to `source` first. Throws where the embedder does. */
export type SimilaritySearch = (source: string, texts: readonly string[]) => Promise<string[]>;

/**
 * Where vectors outlive the page, as RisuAI's localforage store: a vector for
 * each key, `undefined` where none is kept. Either call may throw.
 */
export interface VectorStore {
  get(keys: string[]): Promise<(Float32Array | undefined)[]>;
  /** In order, so a key given twice keeps its last vector. */
  set(entries: [key: string, vector: Float32Array][]): Promise<void>;
}

/** RisuAI's `embedDocuments` chunk size. */
const BATCH = 50;

/** RisuAI's name for the model the worker runs (`hypaModel`), the second half of its cache key. */
const MODEL = 'MiniLM';

interface MemoryVector {
  content: string;
  embedding: Float32Array;
}

/** RisuAI's `similarity`: the dot product, summed in its order. */
function similarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!;
  return dot;
}

/** RisuAI's cache key for `text`, hashed: lowercase hex SHA-256 of `text|model`. */
async function keyOf(text: string, model: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${text}|${model}`)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A search over `embed` with its own per-text cache: memory in front of `store`,
 * or memory alone without one. The page keeps one (`embedding.ts`).
 */
export function createSimilaritySearch(
  embed: Embed,
  { model = MODEL, store }: { model?: string; store?: VectorStore } = {},
): SimilaritySearch {
  const memory = new Map<string, Float32Array>();

  /** The cached vector of each text that has one. A store that fails is a store with nothing in it. */
  async function recall(texts: readonly string[]): Promise<Map<string, Float32Array>> {
    const found = new Map<string, Float32Array>();
    const missing: string[] = [];
    for (const text of new Set(texts)) {
      const known = memory.get(text);
      if (known) found.set(text, known);
      else missing.push(text);
    }
    if (store && missing.length > 0) {
      try {
        const stored = await store.get(await Promise.all(missing.map((text) => keyOf(text, model))));
        stored.forEach((vector, at) => {
          if (!vector) return;
          found.set(missing[at]!, vector);
          memory.set(missing[at]!, vector);
        });
      } catch {
        // No IndexedDB here (private mode, blocked storage, no `crypto.subtle`): memory alone.
      }
    }
    return found;
  }

  /** Every new vector into the cache. A store that fails keeps nothing; the memory still does. */
  async function keep(made: MemoryVector[]): Promise<void> {
    for (const vector of made) memory.set(vector.content, vector.embedding);
    if (!store) return;
    try {
      await store.set(
        await Promise.all(made.map(async (vector) => [await keyOf(vector.content, model), vector.embedding] as [string, Float32Array])),
      );
    } catch {
      // As in `recall`.
    }
  }

  return async (source, texts) => {
    // `addText`
    const cached = await recall(texts);
    let vectors: MemoryVector[] = [];
    for (const text of texts) {
      const embedding = cached.get(text);
      if (embedding) vectors.push({ content: text, embedding });
    }
    const fresh = texts.filter((text) => !cached.has(text));
    if (fresh.length > 0) {
      const embedded: Float32Array[] = [];
      for (let at = 0; at < fresh.length; at += BATCH) embedded.push(...(await embed(fresh.slice(at, at + BATCH))));
      const made = embedded.map((embedding, at) => ({ content: fresh[at]!, embedding }));
      await keep(made);
      vectors = made.concat(vectors);
    }
    // `similaritySearch`
    const query = (await embed([source]))[0]!;
    return vectors
      .map((vector, index) => ({ similarity: similarity(query, vector.embedding), index }))
      .sort((a, b) => (a.similarity > b.similarity ? -1 : 0))
      .map((search) => vectors[search.index]!.content);
  };
}

/* ------------------------------------------------------------- the store */

const DATABASE = 'shizue-similarity';
const VECTORS = 'vectors';

/**
 * The store in the reader's IndexedDB: one object store of Float32Arrays,
 * opened on the first search and kept. A database that would not open is
 * tried again on the next search; one that another tab wants to upgrade is
 * let go.
 *
 * Nothing is ever dropped, as in RisuAI: a dropped vector would be embedded
 * again in other company, which is the reorder the store is here to prevent.
 * A text costs its 384 floats, about 1.5 KB.
 */
export function indexedDbStore(factory: () => IDBFactory = () => indexedDB): VectorStore {
  let database: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory().open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(VECTORS);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch((error: unknown) => {
      database = null;
      throw error;
    });
    return database;
  }

  /** `work` inside one transaction, answered once it has committed. */
  async function run<T>(mode: IDBTransactionMode, work: (vectors: IDBObjectStore) => T): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(VECTORS, mode);
      const result = work(transaction.objectStore(VECTORS));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('the transaction aborted'));
    });
  }

  return {
    get: async (keys) => {
      const requests = await run('readonly', (vectors) => keys.map((key) => vectors.get(key)));
      return requests.map(({ result }) => (result instanceof Float32Array ? result : undefined));
    },
    set: (entries) =>
      run('readwrite', (vectors) => {
        for (const [key, vector] of entries) vectors.put(vector, key);
      }),
  };
}

/* ------------------------------------------------------------ the worker */

/** The little of a `Worker` this uses, so a test can stand in for one. */
export interface EmbedWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface WorkerEmbedder {
  embed: Embed;
  /** Whether the model has answered once — until then a batch waits on its download. */
  ready(): boolean;
}

/**
 * `embed` through a worker (`embeddingWorker.ts`), started on the first batch
 * and kept: RisuAI keeps its pipeline loaded too. A worker that crashed fails
 * what it was asked, and the next batch starts another.
 */
export function workerEmbedder(spawn: () => EmbedWorker): WorkerEmbedder {
  let worker: EmbedWorker | null = null;
  let answered = false;
  let seq = 0;
  const waiting = new Map<number, { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void }>();

  function start(): EmbedWorker {
    const made = spawn();
    made.onmessage = ({ data }) => {
      const message = data as { id: number; vectors?: Float32Array[]; error?: string };
      const call = waiting.get(message.id);
      if (!call) return;
      waiting.delete(message.id);
      if (message.vectors) {
        answered = true;
        call.resolve(message.vectors);
      } else {
        call.reject(new Error(message.error ?? 'the embedder failed'));
      }
    };
    made.onerror = () => {
      made.terminate();
      if (worker === made) worker = null;
      const lost = [...waiting.values()];
      waiting.clear();
      for (const call of lost) call.reject(new Error('the embedding worker crashed'));
    };
    return made;
  }

  return {
    embed: (texts) =>
      new Promise((resolve, reject) => {
        worker ??= start();
        seq += 1;
        waiting.set(seq, { resolve, reject });
        worker.postMessage({ id: seq, texts });
      }),
    ready: () => answered,
  };
}
