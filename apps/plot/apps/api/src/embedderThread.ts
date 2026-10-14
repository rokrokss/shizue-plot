/**
 * The thread the server embedder's models run in (`embedder.ts`): each model
 * loaded on its first batch from the weights already on disk — never from the
 * network — and kept until the embedder lets it go (`unload`, after it idled)
 * or ends the thread. Batches are answered one at a time, whatever their model,
 * each with a vector per text (pooled and normalized as the model's entry says);
 * a batch without texts only loads its model. A model whose graph pools by
 * itself (`pooling: 'model'`, EmbeddingGemma's mean and dense layers) answers
 * its `sentence_embedding` output, which the pipeline does not read.
 *
 * Erasable TypeScript only: in development and under the tests Node loads this
 * file itself, stripping the types, rather than through the compiler.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { env, pipeline, type FeatureExtractionPipeline, type Tensor } from '@huggingface/transformers';

interface ThreadModel {
  repo: string;
  dtype: 'q8' | 'q4' | 'fp32';
  pooling: 'mean' | 'cls' | 'last_token' | 'model';
  normalize: boolean;
}

const { cacheDir, threads } = workerData as { cacheDir: string; threads?: number };

// The weights are fetched on setup (`embedder:fetch`), into the directory the
// cache reads as well — so a missing file is an error, not a download.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = cacheDir;
env.cacheDir = cacheDir;

const loaded = new Map<string, Promise<FeatureExtractionPipeline>>();
/** The message before this one, settled: each waits on it. */
let queue: Promise<void> = Promise.resolve();

function load({ repo, dtype }: ThreadModel): Promise<FeatureExtractionPipeline> {
  let loading = loaded.get(repo);
  if (!loading) {
    loading = pipeline<'feature-extraction'>('feature-extraction', repo, {
      dtype,
      device: 'cpu',
      ...(threads ? { session_options: { intraOpNumThreads: threads } } : {}),
    });
    loaded.set(repo, loading);
    loading.catch(() => loaded.delete(repo));
  }
  return loading;
}

async function unload(repo: string): Promise<void> {
  const loading = loaded.get(repo);
  loaded.delete(repo);
  const extractor = await loading?.catch(() => null);
  await extractor?.dispose();
}

async function embed(extractor: FeatureExtractionPipeline, model: ThreadModel, texts: string[]): Promise<Tensor> {
  if (model.pooling !== 'model') return extractor(texts, { pooling: model.pooling, normalize: model.normalize });
  const inputs = extractor.tokenizer(texts, { padding: true, truncation: true });
  const { sentence_embedding: pooled } = (await extractor.model(inputs)) as { sentence_embedding: Tensor };
  return model.normalize ? pooled.normalize(2, -1) : pooled;
}

async function answer(id: number, model: ThreadModel, texts: string[]): Promise<void> {
  let extractor: FeatureExtractionPipeline;
  try {
    extractor = await load(model);
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error), loadFailed: true });
    return;
  }
  if (texts.length === 0) {
    parentPort!.postMessage({ id, vectors: [] });
    return;
  }
  try {
    const output = await embed(extractor, model, texts);
    const data = output.data as Float32Array;
    const size = data.length / texts.length;
    const vectors = texts.map((_, at) => data.slice(at * size, (at + 1) * size));
    parentPort!.postMessage({ id, vectors }, vectors.map((vector) => vector.buffer));
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

parentPort!.on('message', (message: { id: number; model: ThreadModel; texts: string[] } | { unload: string }) => {
  queue = queue.then(() => ('unload' in message ? unload(message.unload) : answer(message.id, message.model, message.texts)));
});
