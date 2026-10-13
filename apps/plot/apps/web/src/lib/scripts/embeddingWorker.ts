/**
 * The worker that runs the reader's embedding model for the chat's scripts:
 * `similarity.ts` says what is asked of it and `embedding.ts` starts it. It is
 * its own bundle, with transformers.js and onnxruntime-web in it, fetched only
 * when a script first asks for a search.
 *
 * RisuAI's `runEmbedding` (`process/transformers.ts`) as it runs a local model
 * on the CPU: the repo each batch names (`embeddingModels.ts`) with
 * `dtype: 'q8'` on the `wasm` device, one pipeline call per batch with mean
 * pooling and normalization, each text's vector its slice of the output. The
 * pipeline is made on the first batch and kept; one that failed to load is
 * tried again on the next. A batch that names another model disposes it and
 * makes that one's, as RisuAI does when `hypaModel` changes, so the worker
 * holds one model at a time. Batches run one after another, so none is ever
 * cut off by that switch.
 *
 * The model comes from the Hugging Face hub (RisuAI asks its own mirror of the
 * same files first) and is kept in the browser's Cache Storage. onnxruntime is
 * ours: transformers.js would otherwise import its glue code from jsDelivr,
 * and this worker is same-origin — code from a CDN running here could call our
 * API as the reader. Without `wasmPaths` onnxruntime uses the glue bundled
 * into this chunk and the WebAssembly the build ships beside it.
 */

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = undefined;

interface EmbedScope {
  onmessage: ((event: MessageEvent<{ id: number; model: string; texts: string[] }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as EmbedScope;

let loaded: { model: string; extractor: FeatureExtractionPipeline } | null = null;
/** The batch before this one, settled: each waits on it. */
let queue: Promise<void> = Promise.resolve();

/** Only ever one at a time, behind `queue`. A load that fails leaves nothing loaded. */
async function load(model: string): Promise<FeatureExtractionPipeline> {
  if (loaded?.model === model) return loaded.extractor;
  if (loaded) {
    const { extractor } = loaded;
    loaded = null;
    await extractor.dispose();
  }
  const extractor = await pipeline<'feature-extraction'>('feature-extraction', model, { dtype: 'q8', device: 'wasm' });
  loaded = { model, extractor };
  return extractor;
}

async function answer(id: number, model: string, texts: string[]): Promise<void> {
  try {
    const output = await (await load(model))(texts, { pooling: 'mean', normalize: true });
    const data = output.data as Float32Array;
    const size = data.length / texts.length;
    const vectors = texts.map((_, at) => data.slice(at * size, (at + 1) * size));
    scope.postMessage({ id, vectors }, vectors.map((vector) => vector.buffer));
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

scope.onmessage = ({ data: { id, model, texts } }) => {
  queue = queue.then(() => answer(id, model, texts));
};
