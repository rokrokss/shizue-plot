/**
 * The page's embedding search (`similarity.ts`) over the page's one embedding
 * worker (`embeddingWorker.ts`), shared by the trigger runs and the Lua sandbox
 * so they share the model and the cache. The cache is kept here on the page, in
 * IndexedDB, where `addText` reads and writes it: the worker only ever embeds
 * the batch it is handed.
 *
 * Each search names the model the reader picked (`embeddingModels.ts`) and runs
 * on it to the end. Each model gets a search of its own, so its memory holds
 * only its own vectors, over the one store, whose keys name the model.
 *
 * Only ever imported dynamically, on a chat whose scripts first ask for a
 * search: the bundler makes the worker its own chunk, and nothing of
 * transformers.js is in any page's bundle.
 */

import { EMBEDDING_MODELS, type EmbeddingModel } from './embeddingModels';
import { createSimilaritySearch, indexedDbStore, workerEmbedder, type EmbedWorker, type SimilaritySearch } from './similarity';

const embedder = workerEmbedder(
  () => new Worker(new URL('./embeddingWorker.ts', import.meta.url), { type: 'module' }) as unknown as EmbedWorker,
);
const store = indexedDbStore();
const searches = new Map<EmbeddingModel, SimilaritySearch>();

/** `texts`, closest to `source` first, on `model`. */
export function searchSimilar(model: EmbeddingModel, source: string, texts: readonly string[]): Promise<string[]> {
  let search = searches.get(model);
  if (!search) {
    search = createSimilaritySearch(embedder.embedWith(EMBEDDING_MODELS[model].repo), { model, store });
    searches.set(model, search);
  }
  return search(source, texts);
}

/** Whether `model` is loaded in this page; before that, a search waits on its load, the first time its download. */
export const embedderReady = (model: EmbeddingModel): boolean => embedder.ready(EMBEDDING_MODELS[model].repo);
