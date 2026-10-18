/**
 * Downloads the server embedder's weights (`embedder.ts`) ahead of time — the
 * app downloads what it lacks by itself, in the background, once it serves —
 * for every model `EMBEDDER_ROUTING` can give a plot: KURE-v1 and bge-m3 by
 * language, or the one model of `single`. They come from Hugging Face as the
 * app has them come (`downloadWeights`): KURE-v1 our conversion at its pinned
 * commit, each LFS file checked against its SHA-256, the rest from their repos'
 * `main`. A file already there is kept, once its pinned hash is checked.
 *
 * Then loads each the way the server will, offline, and embeds a line to prove
 * it, printing the model, its size on disk and the vector length. onnxruntime
 * runs only in the embedder's thread, never on the main thread — as in the
 * server (`embedder.ts`).
 *
 *   pnpm --filter @shizue/api embedder:fetch
 *
 * Reads `apps/plot/.env` like the server, and puts the weights where it reads
 * them: `EMBEDDER_CACHE_DIR`, else `<data folder>/models` (`make dev` sets
 * `EMBEDDER_CACHE_DIR` to `apps/plot/data/embedder`). A model it cannot fetch
 * is said, the others are fetched all the same, and the run ends non-zero.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  createLocalEmbedder,
  downloadWeights,
  EMBEDDING_MODELS,
  embedderConfig,
  routedModels,
  weightsPath,
  type EmbeddingModelId,
  type EmbeddingModelSpec,
} from '../embedder.js';
import { loadRootEnv } from '../env.js';
import { megabytes } from '../hubDownload.js';

loadRootEnv();
const config = embedderConfig(process.env);
if ('off' in config) {
  console.error(`embedder is off: ${config.off}`);
  process.exit(1);
}
const { cacheDir } = config;

const size = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (sum, entry) => sum + (entry.isDirectory() ? size(join(dir, entry.name)) : statSync(join(dir, entry.name)).size),
    0,
  );

async function fetchModel(model: EmbeddingModelId): Promise<void> {
  const spec: EmbeddingModelSpec = EMBEDDING_MODELS[model];
  const from = spec.hub ? `${spec.hub.repo} at ${spec.hub.revision}` : `${spec.repo} at main`;
  console.log(`fetching ${model} (${spec.dtype}) from Hugging Face, ${from}, into ${cacheDir}`);
  const fetched = await downloadWeights(cacheDir, model, { log: (line) => console.log(`  ${line}`) });
  console.log(`weights at ${weightsPath(cacheDir, model)} — ${megabytes(size(join(cacheDir, spec.repo)))}, ${megabytes(fetched)} downloaded now`);

  // Now as the server runs it: from its thread, with the network off.
  const embedder = createLocalEmbedder({ ...process.env, EMBEDDER_ROUTING: 'single', EMBEDDER_MODEL: model });
  if (!embedder) throw new Error(`${model} does not load offline`);
  try {
    const { vectors } = await embedder.embed(['지난 이야기를 기억한다.'], { plotLanguage: 'ko', kind: 'query', timeoutMs: 120_000 });
    console.log(`offline check: ${vectors[0]?.length} dimensions (expected ${spec.dims})`);
    if (vectors[0]?.length !== spec.dims) throw new Error(`${model} answered ${vectors[0]?.length} dimensions`);
  } finally {
    // The thread is ended rather than left to the exit, which onnxruntime does not survive.
    await embedder.close();
  }
}

const failed: string[] = [];
for (const model of routedModels(config.routes)) {
  try {
    await fetchModel(model);
  } catch (error) {
    console.error(`${model} was not fetched: ${error instanceof Error ? error.message : String(error)}`);
    failed.push(model);
  }
}
if (failed.length > 0) console.error(`not fetched: ${failed.join(', ')} — plots they are for search nothing by meaning`);
process.exitCode = failed.length > 0 ? 1 : 0;
