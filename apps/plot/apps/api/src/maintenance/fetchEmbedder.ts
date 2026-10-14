/**
 * Downloads the server embedder's weights (`embedder.ts`) into
 * `EMBEDDER_CACHE_DIR` — the deploy/setup step, since the server never fetches
 * them itself. Then loads them the way the server will, offline, and embeds a
 * line to prove it, printing the model, its size on disk and the vector length.
 *
 *   pnpm --filter @shizue/api embedder:fetch
 *
 * Reads `apps/plot/.env` like the server; `EMBEDDER_MODEL` picks the model.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { createLocalEmbedder, embedderConfig, weightsPath } from '../embedder.js';
import { loadRootEnv } from '../env.js';

loadRootEnv();
const config = embedderConfig(process.env);
if ('off' in config) {
  console.error(`embedder is off: ${config.off}`);
  process.exit(1);
}

env.allowRemoteModels = true;
env.allowLocalModels = true;
env.localModelPath = config.cacheDir;
env.cacheDir = config.cacheDir;

console.log(`fetching ${config.model} (${config.spec.repo}, ${config.spec.dtype}) into ${config.cacheDir}`);
const extractor = await pipeline('feature-extraction', config.spec.repo, { dtype: config.spec.dtype, device: 'cpu' });
await extractor.dispose();

const size = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (sum, entry) => sum + (entry.isDirectory() ? size(join(dir, entry.name)) : statSync(join(dir, entry.name)).size),
    0,
  );
console.log(`weights at ${weightsPath(config)} — ${Math.round(size(join(config.cacheDir, config.spec.repo)) / 1e6)} MB`);

// Now as the server runs it: from the thread, with the network off.
const embedder = createLocalEmbedder(process.env);
if (!embedder) process.exit(1);
const [vector] = await embedder.embed(['지난 이야기를 기억한다.'], { kind: 'query' });
console.log(`offline check: ${vector?.length} dimensions (expected ${config.spec.dims})`);
// The thread is ended rather than left to the exit, which onnxruntime does not survive.
await embedder.close();
process.exitCode = vector?.length === config.spec.dims ? 0 : 1;
