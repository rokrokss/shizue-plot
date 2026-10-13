/**
 * RisuAI's embedding search (`HypaProcesser` in its `process/memory/hypamemory.ts`)
 * as `checkSimilarity`, `v2CheckSimilarity` and Lua's `similarity` use it: a new
 * processer for each call, on RisuAI's default model (`MiniLM`), answering the
 * texts best first.
 *
 * The order is RisuAI's to the letter, because a card reads the first text as
 * the closest and RisuAI's own order is quirky:
 *
 * - `addText`: a text with a vector in the cache is taken from there, once for
 *   each time it appears; every other text is embedded, in batches of 50,
 *   duplicates and all — the only dedupe is that a cached text is not embedded
 *   again. The new ones go first, then the cached ones.
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
 * The cache lives as long as the page. RisuAI's is IndexedDB and lasts; after a
 * reload ours starts empty, so a text RisuAI would read back is embedded again,
 * in this call's batch and placed with the new ones. A card that searches the
 * same list every time embeds the same batch again and gets RisuAI's vectors;
 * one whose list changes can see texts within a few thousandths reorder.
 */

/** One batch through the model: a vector per text, in order. */
export type Embed = (texts: string[]) => Promise<ArrayLike<number>[]>;

/** `texts`, closest to `source` first. Throws where the embedder does. */
export type SimilaritySearch = (source: string, texts: readonly string[]) => Promise<string[]>;

/** RisuAI's `embedDocuments` chunk size. */
const BATCH = 50;

interface MemoryVector {
  content: string;
  embedding: ArrayLike<number>;
}

/** RisuAI's `similarity`: the dot product, summed in its order. */
function similarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!;
  return dot;
}

/** A search over `embed` with its own per-text cache. The page keeps one (`embedding.ts`). */
export function createSimilaritySearch(embed: Embed): SimilaritySearch {
  const cache = new Map<string, ArrayLike<number>>();
  return async (source, texts) => {
    // `addText`
    let vectors: MemoryVector[] = [];
    for (const text of texts) {
      const cached = cache.get(text);
      if (cached) vectors.push({ content: text, embedding: cached });
    }
    const fresh = texts.filter((text) => !vectors.some((vector) => vector.content === text));
    if (fresh.length > 0) {
      const embedded: ArrayLike<number>[] = [];
      for (let at = 0; at < fresh.length; at += BATCH) embedded.push(...(await embed(fresh.slice(at, at + BATCH))));
      const made = embedded.map((embedding, at) => ({ content: fresh[at]!, embedding }));
      for (const vector of made) cache.set(vector.content, vector.embedding);
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
