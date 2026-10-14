/**
 * The models a reader can pick for the card scripts' embedding search, as
 * RisuAI's `hypaModel` setting picks one: the local models of its `localModels`
 * (`process/memory/hypamemory.ts`) that run on wasm and fetch in a browser tab,
 * under RisuAI's names, which are also the second half of the vector cache's key.
 * Left out: its API models (openai, voyage, a custom URL), which need a key the
 * reader has no place for here; and its `…GPU` twins, the same weights on
 * WebGPU, which the worker does not run. `bgem3` and `bgeM3Ko` are offered as
 * `heavy`: 587 MB each to download, and well over a gigabyte of the tab's
 * memory once loaded. The worker runs them as RisuAI does, with mean pooling
 * like every other model, where bge-m3's own dense vector is its [CLS] token's
 * (the server's embedder pools them so).
 *
 * The default is not RisuAI's. Its `MiniLM` breaks Hangul into jamo and unknown
 * tokens, and much of the kanji into unknown tokens: it put the right text first
 * in 2 of 6 Korean cases and 1 of 6 Japanese ones. `multiMiniLM` did in 5 of
 * each, for about five times the download.
 *
 * The pick is kept in this browser, as RisuAI keeps it per install and as the
 * theme and the custom-UI switch are kept here: the weights (Cache Storage) and
 * the vectors (IndexedDB) it chooses between are this browser's too.
 */

/**
 * Each model's Hugging Face repo, the name RisuAI's settings show it under,
 * what the first search fetches, in MB: the q8 weights and the tokenizer — and
 * whether the setting warns that it is heavy.
 */
export const EMBEDDING_MODELS = {
  multiMiniLM: { repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', label: 'Multilingual MiniLM L12 v2', megabytes: 135, heavy: false },
  MiniLM: { repo: 'Xenova/all-MiniLM-L6-v2', label: 'MiniLM L6 v2', megabytes: 24, heavy: false },
  bgeSmallEn: { repo: 'Xenova/bge-small-en-v1.5', label: 'BGE Small English', megabytes: 35, heavy: false },
  nomic: { repo: 'nomic-ai/nomic-embed-text-v1.5', label: 'Nomic Embed Text v1.5', megabytes: 138, heavy: false },
  bgem3: { repo: 'Xenova/bge-m3', label: 'BGE Medium 3', megabytes: 587, heavy: true },
  bgeM3Ko: { repo: 'HyperBlaze/BGE-m3-ko', label: 'BGE Medium 3 Korean', megabytes: 587, heavy: true },
} as const;

export type EmbeddingModel = keyof typeof EMBEDDING_MODELS;

/** In the order the setting offers them. */
export const embeddingModels = Object.keys(EMBEDDING_MODELS) as EmbeddingModel[];

export const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = 'multiMiniLM';

const STORAGE_KEY = 'shizue.embeddingModel';

/** The reader's pick, or the default where there is none or it is no longer offered. */
export function readEmbeddingModel(): EmbeddingModel {
  if (typeof window === 'undefined') return DEFAULT_EMBEDDING_MODEL;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return embeddingModels.find((model) => model === stored) ?? DEFAULT_EMBEDDING_MODEL;
  } catch {
    return DEFAULT_EMBEDDING_MODEL;
  }
}

export function writeEmbeddingModel(model: EmbeddingModel): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, model);
  } catch {
    // Blocked site data: nothing is kept, and a read answers the default, as the search will.
  }
}
