/**
 * The models a reader can pick for the card scripts' embedding search, as
 * RisuAI's `hypaModel` setting picks one: the local models of its `localModels`
 * (`process/memory/hypamemory.ts`) that run on wasm and fetch in a browser tab,
 * under RisuAI's names, which are also the second half of the vector cache's key.
 * Left out: its API models (openai, voyage, a custom URL), which need a key the
 * reader has no place for here; its `…GPU` twins, the same weights on WebGPU,
 * which the worker does not run; and `bgem3`/`bgeM3Ko`, 570 MB each.
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
 * Each model's Hugging Face repo, the name RisuAI's settings show it under, and
 * what the first search fetches, in MB: the q8 weights and the tokenizer.
 */
export const EMBEDDING_MODELS = {
  multiMiniLM: { repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', label: 'Multilingual MiniLM L12 v2', megabytes: 135 },
  MiniLM: { repo: 'Xenova/all-MiniLM-L6-v2', label: 'MiniLM L6 v2', megabytes: 24 },
  bgeSmallEn: { repo: 'Xenova/bge-small-en-v1.5', label: 'BGE Small English', megabytes: 35 },
  nomic: { repo: 'nomic-ai/nomic-embed-text-v1.5', label: 'Nomic Embed Text v1.5', megabytes: 138 },
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
