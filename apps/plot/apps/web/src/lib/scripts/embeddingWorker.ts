/**
 * The worker that runs RisuAI's default embedding model for the chat's scripts:
 * `similarity.ts` says what is asked of it and `embedding.ts` starts it. It is
 * its own bundle, with transformers.js and onnxruntime-web in it, fetched only
 * when a script first asks for a search.
 *
 * RisuAI's `runEmbedding` (`process/transformers.ts`) as it runs `MiniLM`:
 * `Xenova/all-MiniLM-L6-v2` with `dtype: 'q8'` on the `wasm` device, one
 * pipeline call per batch with mean pooling and normalization, each text's
 * vector its slice of the output. The pipeline is made on the first batch and
 * kept; one that failed to load is tried again on the next.
 *
 * The model comes from the Hugging Face hub (RisuAI asks its own mirror of the
 * same files first) and is kept in the browser's Cache Storage. onnxruntime is
 * ours: transformers.js would otherwise import its glue code from jsDelivr,
 * and this worker is same-origin — code from a CDN running here could call our
 * API as the reader. Without `wasmPaths` onnxruntime uses the glue bundled
 * into this chunk and the WebAssembly the build ships beside it.
 */

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = undefined;

interface EmbedScope {
  onmessage: ((event: MessageEvent<{ id: number; texts: string[] }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as EmbedScope;

let extractor: Promise<FeatureExtractionPipeline> | null = null;

function load(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline<'feature-extraction'>('feature-extraction', MODEL, { dtype: 'q8', device: 'wasm' }).catch(
    (error: unknown) => {
      extractor = null;
      throw error;
    },
  );
  return extractor;
}

scope.onmessage = async ({ data: { id, texts } }) => {
  try {
    const output = await (await load())(texts, { pooling: 'mean', normalize: true });
    const data = output.data as Float32Array;
    const size = data.length / texts.length;
    const vectors = texts.map((_, at) => data.slice(at * size, (at + 1) * size));
    scope.postMessage({ id, vectors }, vectors.map((vector) => vector.buffer));
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
