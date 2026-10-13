/**
 * The page's one embedding search (`similarity.ts`) over the page's one
 * embedding worker (`embeddingWorker.ts`), shared by the trigger runs and the
 * Lua sandbox so they share the model and the cache.
 *
 * Only ever imported dynamically, on a chat whose scripts first ask for a
 * search: the bundler makes the worker its own chunk, and nothing of
 * transformers.js is in any page's bundle.
 */

import { createSimilaritySearch, workerEmbedder, type EmbedWorker } from './similarity';

const embedder = workerEmbedder(
  () => new Worker(new URL('./embeddingWorker.ts', import.meta.url), { type: 'module' }) as unknown as EmbedWorker,
);

export const searchSimilar = createSimilaritySearch(embedder.embed);

/** Whether the model is loaded in this page; before that, a search waits on its download. */
export const embedderReady = (): boolean => embedder.ready();
