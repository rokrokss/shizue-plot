/**
 * The Hugging Face download of `embedder:fetch` (`fetchEmbedder.ts`):
 * transformers.js has no public way to fetch a model's files but to load it, so
 * this thread loads it once — remote loading on, into the cache the server
 * reads — lets it go and answers. The script then ends the thread. It is a
 * thread and not the script's main thread because onnxruntime must not run a
 * session there: the server's embedder thread would take its tensor
 * constructor over from it, and the run crashed now and then (see the script).
 *
 * Erasable TypeScript only: under tsx Node loads this file itself, stripping the
 * types, rather than through the compiler.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { env, pipeline } from '@huggingface/transformers';

const { cacheDir, repo, dtype } = workerData as { cacheDir: string; repo: string; dtype: 'q8' | 'q4' | 'fp32' };

env.allowRemoteModels = true;
env.allowLocalModels = true;
env.localModelPath = cacheDir;
env.cacheDir = cacheDir;

try {
  const extractor = await pipeline('feature-extraction', repo, { dtype, device: 'cpu' });
  await extractor.dispose();
  parentPort!.postMessage({});
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
