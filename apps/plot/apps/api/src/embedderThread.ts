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
 * **Memory is bounded by length, not by count.** These graphs hold every
 * layer's attention as a full batch × heads × length² matrix, so what a call
 * costs grows with the square of its longest text: measured on 2026-10-16 with
 * KURE-v1 (`/usr/bin/time -l`, peak footprint of one process whose model alone
 * takes about 2.1GB), 64 Korean texts of 600–2,250 characters peaked at 13.2GB
 * in calls of 32 and 6.1GB in calls of 8, and one text of 4,096 tokens alone at
 * 5.4GB, where 32 × 384, 8 × 768, 2 × 1,536 and 1 × 2,048 tokens all stayed
 * between 3.5 and 3.9GB. So a text is read up to `MAX_TOKENS` (the models take
 * 8,192, which no caller needs to find what it is about — the longest are a
 * work's search text of 2,000 characters and the newest messages a memory
 * search asks with), and a message's texts are sent in calls whose count ×
 * longest² stays within `ATTENTION_BUDGET` (`attentionBatches`), shortest
 * first, at most `MAX_BATCH` a call; one text past the budget goes alone. The
 * vectors come back in the order asked.
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

/** The most tokens of a text a model reads; the rest of a longer one is left out of its vector. */
export const MAX_TOKENS = 2_048;
/** Count × longest² one call may hold: 32 texts of 384 tokens, 2 of 1,536, 1 of 2,048. */
export const ATTENTION_BUDGET = 32 * 384 * 384;
/** The most texts one call takes, however short. */
export const MAX_BATCH = 32;

/**
 * The calls a message's texts are embedded in, as indexes into them: shortest
 * first, each call as many as keep count × its longest² within `budget` (and
 * at most `maxBatch`), a text over the budget on its own.
 */
export function attentionBatches(lengths: readonly number[], budget = ATTENTION_BUDGET, maxBatch = MAX_BATCH): number[][] {
  const order = lengths.map((_, index) => index).sort((a, b) => lengths[a]! - lengths[b]! || a - b);
  const calls: number[][] = [];
  let call: number[] = [];
  for (const index of order) {
    const longest = lengths[index]!;
    if (call.length > 0 && (call.length >= maxBatch || (call.length + 1) * longest * longest > budget)) {
      calls.push(call);
      call = [];
    }
    call.push(index);
  }
  if (call.length > 0) calls.push(call);
  return calls;
}

const { cacheDir, threads } = (workerData ?? {}) as { cacheDir: string; threads?: number };

if (parentPort) {
  // The weights are downloaded before a model is asked for (`downloadMissing` in
  // embedder.ts, or `embedder:fetch`), into the directory the cache reads as
  // well — so a missing file is an error, not a download.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = cacheDir;
  env.cacheDir = cacheDir;
}

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
    }).then((extractor) => {
      // The tokenizer truncates to this whenever it is asked to truncate, the pipeline's own call included.
      extractor.tokenizer.model_max_length = Math.min(extractor.tokenizer.model_max_length ?? MAX_TOKENS, MAX_TOKENS);
      return extractor;
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

async function embedCall(extractor: FeatureExtractionPipeline, model: ThreadModel, texts: string[]): Promise<Tensor> {
  if (model.pooling !== 'model') return extractor(texts, { pooling: model.pooling, normalize: model.normalize });
  const inputs = extractor.tokenizer(texts, { padding: true, truncation: true });
  const { sentence_embedding: pooled } = (await extractor.model(inputs)) as { sentence_embedding: Tensor };
  return model.normalize ? pooled.normalize(2, -1) : pooled;
}

/** One vector per text, in their order, from calls `attentionBatches` sizes. */
async function embed(extractor: FeatureExtractionPipeline, model: ThreadModel, texts: string[]): Promise<Float32Array<ArrayBuffer>[]> {
  const lengths = texts.map((text) => Math.min(extractor.tokenizer.encode(text).length, MAX_TOKENS));
  const vectors: Float32Array<ArrayBuffer>[] = new Array(texts.length);
  for (const call of attentionBatches(lengths)) {
    const output = await embedCall(extractor, model, call.map((index) => texts[index]!));
    const data = output.data as Float32Array;
    const size = data.length / call.length;
    call.forEach((index, at) => (vectors[index] = data.slice(at * size, (at + 1) * size)));
  }
  return vectors;
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
    const vectors = await embed(extractor, model, texts);
    parentPort!.postMessage({ id, vectors }, vectors.map((vector) => vector.buffer));
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

parentPort?.on('message', (message: { id: number; model: ThreadModel; texts: string[] } | { unload: string }) => {
  queue = queue.then(() => ('unload' in message ? unload(message.unload) : answer(message.id, message.model, message.texts)));
});
