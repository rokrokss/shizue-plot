/**
 * The server's text embedder: a sentence-embedding model run on this machine's
 * CPU, in a worker thread, for anything on the server that searches by meaning —
 * the memory's similar summaries first (`memory.ts`). The browser runs the same
 * weights for the card scripts' search (web `lib/scripts/embeddingWorker.ts`).
 *
 * - **The model is configuration.** `EMBEDDER_MODEL` names an entry of
 *   `EMBEDDING_MODELS` (default `multiMiniLM`), which says where its weights
 *   are and how it is run: pooling, normalization, the prefixes it wants on a
 *   query and on a text searched (e5's `query: `/`passage: `), its size. Every
 *   vector is stored with the model's id, and only vectors of one model are
 *   compared: a different model re-embeds rather than migrates.
 * - **Weights are fetched on setup, never on a request.** `pnpm --filter
 *   @shizue/api embedder:fetch` downloads them into `EMBEDDER_CACHE_DIR`
 *   (default `apps/plot/data/embedder`); at run time remote loading is off. A
 *   model whose files are not there leaves the server without an embedder,
 *   said once at boot — every caller then falls back, nothing fails.
 * - **Lazy, one thread.** The thread starts with the first request (or
 *   `warm()`), loads the model once and answers one batch at a time. It holds
 *   the model for the life of the process: multiMiniLM q8 adds about 750 MB of
 *   resident memory — measured 2026-10-14, ~170 MB of it the tokenizer's
 *   250k-word vocabulary on the thread's heap, the rest onnxruntime and the
 *   weights (ARCHITECTURE §12). A thread that dies is replaced on the next
 *   call; a model that fails to load is not retried for a minute.
 *
 * `embed` throws on any failure — no model, a load that failed, a deadline —
 * and the caller falls back: the memory's similar share goes to recent and
 * random summaries. A generation never waits on it for longer than its deadline.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export interface EmbeddingModelSpec {
  /** The Hugging Face repo of its ONNX weights. */
  repo: string;
  /** Length of its vectors. */
  dims: number;
  /** How the token vectors become one: their mean, or the first ([CLS]) one. */
  pooling: 'mean' | 'cls';
  normalize: boolean;
  /** Put before a search's query, and before each text searched. */
  queryPrefix: string;
  documentPrefix: string;
  /** transformers.js weight variant; `q8` is the repo's `onnx/model_quantized.onnx`. */
  dtype: 'q8' | 'fp32';
}

/**
 * The models the server can run. `multiMiniLM` is the browser's default too
 * (web `embeddingModels.ts`): RisuAI's `MiniLM` breaks Hangul into jamo. The
 * others are the candidates for Korean retrieval, as RisuAI names them where it
 * offers them (`bgeM3Ko`); bge-m3's dense vector is its [CLS] token's.
 */
export const EMBEDDING_MODELS = {
  multiMiniLM: {
    repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    dims: 384,
    pooling: 'mean',
    normalize: true,
    queryPrefix: '',
    documentPrefix: '',
    dtype: 'q8',
  },
  'multilingual-e5-small': {
    repo: 'Xenova/multilingual-e5-small',
    dims: 384,
    pooling: 'mean',
    normalize: true,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    dtype: 'q8',
  },
  'multilingual-e5-base': {
    repo: 'Xenova/multilingual-e5-base',
    dims: 768,
    pooling: 'mean',
    normalize: true,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    dtype: 'q8',
  },
  'bge-m3': {
    repo: 'Xenova/bge-m3',
    dims: 1024,
    pooling: 'cls',
    normalize: true,
    queryPrefix: '',
    documentPrefix: '',
    dtype: 'q8',
  },
  bgeM3Ko: {
    repo: 'HyperBlaze/BGE-m3-ko',
    dims: 1024,
    pooling: 'cls',
    normalize: true,
    queryPrefix: '',
    documentPrefix: '',
    dtype: 'q8',
  },
} as const satisfies Record<string, EmbeddingModelSpec>;

export type EmbeddingModelId = keyof typeof EMBEDDING_MODELS;
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModelId = 'multiMiniLM';

export interface EmbedOptions {
  /** A search's query, or a text to be searched (the default); the model's prefix follows. */
  kind?: 'query' | 'document';
  /** How long the whole call may take; past it the call throws (the thread keeps going). */
  timeoutMs?: number;
}

export interface Embedder {
  /** The model's id in `EMBEDDING_MODELS`, which every vector it makes is stored with. */
  readonly model: string;
  readonly dims: number;
  /** One vector per text, in order. Throws when it cannot. */
  embed(texts: readonly string[], options?: EmbedOptions): Promise<number[][]>;
  /** Loads the model now rather than on the first call; failures surface on that call. */
  warm(): void;
  /** Ends the thread and the model with it; the next call starts them again. */
  close(): Promise<void>;
}

/** Texts per message to the thread: RisuAI embeds 50 at a time; less keeps one batch's padding short. */
const BATCH = 32;
const DEFAULT_TIMEOUT_MS = 30_000;
/** How long a model that failed to load is left before the next try. */
const LOAD_RETRY_MS = 60_000;

/** `apps/plot`, which the default cache directory is relative to (as `UPLOAD_DIR` is). */
const PLOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const THREAD_URL = new URL(
  `./embedderThread${new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'}`,
  import.meta.url,
);

export interface EmbedderConfig {
  model: EmbeddingModelId;
  spec: EmbeddingModelSpec;
  cacheDir: string;
}

/**
 * What `EMBEDDER_MODEL` and `EMBEDDER_CACHE_DIR` say, or null with the reason
 * when the server is to run without one (`EMBEDDER=off`, an unknown model).
 */
export function embedderConfig(env: NodeJS.ProcessEnv): EmbedderConfig | { off: string } {
  if (env['EMBEDDER'] === 'off') return { off: 'EMBEDDER=off' };
  const model = (env['EMBEDDER_MODEL']?.trim() || DEFAULT_EMBEDDING_MODEL) as EmbeddingModelId;
  const spec: EmbeddingModelSpec | undefined = EMBEDDING_MODELS[model];
  if (!spec) return { off: `unknown EMBEDDER_MODEL "${model}" (one of ${Object.keys(EMBEDDING_MODELS).join(', ')})` };
  return { model, spec, cacheDir: resolve(PLOT_ROOT, env['EMBEDDER_CACHE_DIR']?.trim() || './data/embedder') };
}

/** Where the model's weights must be for it to run offline. */
export function weightsPath(config: EmbedderConfig): string {
  return join(config.cacheDir, config.spec.repo, 'onnx', config.spec.dtype === 'q8' ? 'model_quantized.onnx' : 'model.onnx');
}

/**
 * The embedder `env` configures, or undefined — with a line in the log — when
 * it is off or its weights were never fetched.
 */
export function createLocalEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder | undefined {
  const config = embedderConfig(env);
  if ('off' in config) {
    console.warn(`[embedder] off: ${config.off}; memory falls back to recent and random summaries`);
    return undefined;
  }
  if (!existsSync(weightsPath(config))) {
    console.warn(
      `[embedder] no weights for ${config.model} under ${config.cacheDir}; run \`pnpm --filter @shizue/api embedder:fetch\`. ` +
        'Until then memory falls back to recent and random summaries.',
    );
    return undefined;
  }
  return new ThreadEmbedder(config);
}

interface Pending {
  resolve: (vectors: number[][]) => void;
  reject: (error: Error) => void;
}

class ThreadEmbedder implements Embedder {
  readonly model: string;
  readonly dims: number;
  private readonly config: EmbedderConfig;
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  /** Until when a failed load is not retried. */
  private failedUntil = 0;
  private lastError: Error | null = null;

  constructor(config: EmbedderConfig) {
    this.config = config;
    this.model = config.model;
    this.dims = config.spec.dims;
  }

  warm(): void {
    if (Date.now() < this.failedUntil) return;
    this.thread().postMessage({ id: -1, texts: [] });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }

  async embed(texts: readonly string[], { kind = 'document', timeoutMs = DEFAULT_TIMEOUT_MS }: EmbedOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (Date.now() < this.failedUntil) throw this.lastError ?? new Error('embedder unavailable');
    const prefix = kind === 'query' ? this.config.spec.queryPrefix : this.config.spec.documentPrefix;
    const prefixed = texts.map((text) => prefix + text);
    const batches: string[][] = [];
    for (let at = 0; at < prefixed.length; at += BATCH) batches.push(prefixed.slice(at, at + BATCH));

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`embedding took longer than ${timeoutMs} ms`)), timeoutMs);
      timer.unref();
    });
    try {
      const results = await Promise.race([Promise.all(batches.map((batch) => this.request(batch))), deadline]);
      return results.flat();
    } finally {
      clearTimeout(timer);
    }
  }

  private request(texts: string[]): Promise<number[][]> {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.thread().postMessage({ id, texts });
    });
  }

  private thread(): Worker {
    if (this.worker) return this.worker;
    const { spec, cacheDir } = this.config;
    const worker = new Worker(THREAD_URL, {
      workerData: { cacheDir, repo: spec.repo, dtype: spec.dtype, pooling: spec.pooling, normalize: spec.normalize },
    });
    // An idle embedder must never keep the process (or a test run) alive.
    worker.unref();
    worker.on('message', (message: { id: number; vectors?: Float32Array[]; error?: string; loadFailed?: boolean }) => {
      if (message.loadFailed) {
        this.lastError = new Error(`embedder could not load ${this.model}: ${message.error}`);
        this.failedUntil = Date.now() + LOAD_RETRY_MS;
        console.error(`[embedder] ${this.lastError.message}`);
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.vectors) pending.resolve(message.vectors.map((vector) => Array.from(vector)));
      else pending.reject(new Error(message.error ?? 'embedding failed'));
    });
    const fail = (error: Error): void => {
      if (this.worker === worker) this.worker = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on('error', (error) => {
      console.error('[embedder] thread failed', error);
      fail(error);
    });
    worker.on('exit', (code) => fail(new Error(`embedder thread exited (${code})`)));
    this.worker = worker;
    return worker;
  }
}
