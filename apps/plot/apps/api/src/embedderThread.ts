/**
 * The thread the server's embedder runs in (`embedder.ts`): one model, loaded
 * on the first message from the weights already on disk — never from the
 * network — and kept. Batches are answered one at a time, each with a vector
 * per text (pooled and normalized as the model's entry says).
 *
 * Erasable TypeScript only: in development and under the tests Node loads this
 * file itself, stripping the types, rather than through the compiler.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

const { cacheDir, repo, dtype, pooling, normalize } = workerData as {
  cacheDir: string;
  repo: string;
  dtype: 'q8' | 'fp32';
  pooling: 'mean' | 'cls';
  normalize: boolean;
};

// The weights are fetched on setup (`embedder:fetch`), into the directory the
// cache reads as well — so a missing file is an error, not a download.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = cacheDir;
env.cacheDir = cacheDir;

let loading: Promise<FeatureExtractionPipeline> | null = null;
/** The batch before this one, settled: each waits on it. */
let queue: Promise<void> = Promise.resolve();

function load(): Promise<FeatureExtractionPipeline> {
  loading ??= pipeline<'feature-extraction'>('feature-extraction', repo, { dtype, device: 'cpu' }).catch(
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

async function answer(id: number, texts: string[]): Promise<void> {
  let extractor: FeatureExtractionPipeline;
  try {
    extractor = await load();
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error), loadFailed: true });
    return;
  }
  if (texts.length === 0) return;
  try {
    const output = await extractor(texts, { pooling, normalize });
    const data = output.data as Float32Array;
    const size = data.length / texts.length;
    const vectors = texts.map((_, at) => data.slice(at * size, (at + 1) * size));
    parentPort!.postMessage({ id, vectors }, vectors.map((vector) => vector.buffer));
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

parentPort!.on('message', ({ id, texts }: { id: number; texts: string[] }) => {
  queue = queue.then(() => answer(id, texts));
});
