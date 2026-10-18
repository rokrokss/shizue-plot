/**
 * The server's text embedder: sentence-embedding models run on this machine's
 * CPU, in worker threads, for anything on the server that searches by meaning —
 * the memory's similar summaries first (`memory.ts`), and next the lorebook,
 * message retrieval, facts and work search. The browser runs its own models for
 * the card scripts' search (web `lib/scripts/embeddingModels.ts`).
 *
 * **The API the rest of the server calls** (`deps.embedder`, absent when off):
 *
 *   embedder.modelFor(plot.language)                → 'KURE-v1' | 'bge-m3' | … | null
 *   await embedder.embed(texts, { plotLanguage: plot.language, kind, timeoutMs })
 *                                                   → { model, vectors }
 *
 * - **The model is the plot's.** `EMBEDDER_ROUTING` says how a plot gets it:
 *   `single` (the default) the one model `EMBEDDER_MODEL` names — KURE-v1
 *   (`nlpai-lab/KURE-v1`, bge-m3 fine-tuned on Korean) unless set — for every
 *   plot, and `by-language` by its content language (`plots.language`): `ko`
 *   with KURE-v1, every other language with bge-m3. It is used for
 *   every vector of the plot's chats and lore, and for the queries compared
 *   with them. `model` in the answer is the `EMBEDDING_MODELS` key, which each
 *   vector is stored with; only vectors of one model are ever compared. A
 *   vector of another model (an older default, another routing, a plot whose
 *   language changed) is stale: the caller embeds its text again, lazily,
 *   rather than migrating it.
 * - **`modelFor` is null** when the plot's model cannot run here — its weights
 *   are not here, said once at boot, or not yet: `weightsFor` tells which. The
 *   server does not put another model in its place: the caller skips (stores
 *   nothing) or falls back.
 * - **`embed` throws** on any failure — no model for the language, a load that
 *   failed (not retried for a minute), the deadline (`timeoutMs`, default 30 s;
 *   the thread keeps going) — and the caller falls back: the memory's similar
 *   share goes to recent and random summaries. A generation never waits on it
 *   for longer than its deadline. `kind` puts the model's query or document
 *   prefix before each text (none for KURE-v1 and bge-m3). Texts go to the
 *   thread 32 at a time and come back one vector per text, in order. While the
 *   embedder cannot be had at all it throws `EmbedderUnavailable`, which the
 *   caller logs as one short line (`embedErrorForLog`).
 * - **Weights are downloaded in the background, never on a request.** Once the
 *   app serves, it calls `downloadMissing`, which downloads the weights its
 *   routed models lack from Hugging Face into the cache (`EMBEDDER_CACHE_DIR`,
 *   else `<data folder>/models`), one model after another, and each model is
 *   used from the moment its weights are whole (`hubDownload.ts`). KURE-v1's are
 *   our int8 conversion (ARCHITECTURE §7.3) at a pinned commit of the owner's
 *   repo, each LFS file checked against its SHA-256; the rest come from their
 *   repos' `main`. `embedder:fetch` downloads them ahead of time. The thread
 *   itself never touches the network: remote loading is off there.
 * - **Lazy, one thread, unloaded when idle.** The thread starts with the first
 *   request and loads each model on its first batch; batches of every model
 *   take turns, one at a time. A model left ten minutes without a request is
 *   unloaded, and the last one to go ends the thread; the next request loads it
 *   again. Measured 2026-10-15 (ARCHITECTURE §12): KURE-v1 or bge-m3 loaded
 *   costs the process about 2 GB (macOS phys_footprint), both about 3.9 GB.
 *
 * For tests and development, `EMBEDDER_ROUTING=single` with
 * `EMBEDDER_MODEL=multiMiniLM` runs a light model, and `EMBEDDER=off` none.
 * `EMBEDDER_THREADS` caps each model's onnxruntime threads.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ContentLanguage } from '@shizue/db';
import { dataDirOf } from './env.js';
import { downloadFromHub, DownloadMismatch, DownloadRefused, megabytes, type DownloadOptions, type HubFile } from './hubDownload.js';

export interface EmbeddingModelSpec {
  /**
   * Its weights' directory under the cache — `onnx/model_quantized.onnx` and
   * the tokenizer beside it, laid out as on Hugging Face — and the Hugging Face
   * repo they are downloaded from, at its `main`, unless `hub` names another.
   */
  repo: string;
  /**
   * Where its files are downloaded from instead: another repo at a pinned
   * commit, with the SHA-256 of each file Hugging Face keeps one for (its LFS
   * files), which the download is checked against.
   */
  hub?: { repo: string; revision: string; sha256: Readonly<Record<string, string>> };
  /** Its graph keeps the weights in a file beside it, `<weights>_data`, as its config tells transformers.js. */
  externalData?: true;
  /** Length of its vectors. */
  dims: number;
  /**
   * How the token vectors become one: their mean, the first ([CLS]) one, the
   * last one (a decoder's, left-padded), or the graph's own `sentence_embedding`
   * (`model`: pooling and projection are inside the ONNX graph).
   */
  pooling: 'mean' | 'cls' | 'last_token' | 'model';
  normalize: boolean;
  /** Put before a search's query, and before each text searched. */
  queryPrefix: string;
  documentPrefix: string;
  /** transformers.js weight variant: `q8` is the repo's `onnx/model_quantized.onnx`, `q4` its `onnx/model_q4.onnx`. */
  dtype: 'q8' | 'q4' | 'fp32';
  /** The weights' license, as their model card states it. */
  license: string;
}

/**
 * The models the server can run, each as its model card says to run it.
 * KURE-v1 and bge-m3 are the ones plots use (`LANGUAGE_MODELS`); bge-m3's dense
 * vector is its [CLS] token's, and so is KURE-v1's (its `1_Pooling/config.json`,
 * then a Normalize module). `multiMiniLM` is the browser's default and the light
 * one for development. The rest were benchmarked against them (ARCHITECTURE
 * §7.3): e5, `bgeM3Ko` (as RisuAI names it), Qwen3-Embedding (the last token,
 * left-padded, and an instruction before a query), EmbeddingGemma (its graph
 * pools and projects; `task: …`/`title: …` prompts) and arctic-embed (CLS,
 * `query: `).
 */
export const EMBEDDING_MODELS = {
  'KURE-v1': {
    repo: 'nlpai-lab/KURE-v1',
    // Its repo has PyTorch weights alone: these are our int8 conversion of them
    // (ARCHITECTURE §7.3), as the owner published it, kept under the original's
    // name in the cache.
    hub: {
      repo: 'rokrokss/KURE-v1-onnx',
      revision: '7da86b48a3618513e041d6084a5cff2ea20a88d0',
      sha256: {
        'onnx/model_quantized.onnx': '3530a7640919b643a1cdf07894dbb2481a4edaf5acd0e439b8b860026f87b494',
        'tokenizer.json': 'fb3c3b93c46fd5a8634e262e1b7de7da11a18b527aa2282b312952b692781dfd',
      },
    },
    dims: 1024,
    pooling: 'cls',
    normalize: true,
    queryPrefix: '',
    documentPrefix: '',
    dtype: 'q8',
    license: 'MIT',
  },
  'bge-m3': {
    repo: 'Xenova/bge-m3',
    dims: 1024,
    pooling: 'cls',
    normalize: true,
    queryPrefix: '',
    documentPrefix: '',
    dtype: 'q8',
    license: 'MIT',
  },
  multiMiniLM: {
    repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    dims: 384,
    pooling: 'mean',
    normalize: true,
    queryPrefix: '',
    documentPrefix: '',
    dtype: 'q8',
    license: 'Apache-2.0',
  },
  'multilingual-e5-small': {
    repo: 'Xenova/multilingual-e5-small',
    dims: 384,
    pooling: 'mean',
    normalize: true,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    dtype: 'q8',
    license: 'MIT',
  },
  'multilingual-e5-base': {
    repo: 'Xenova/multilingual-e5-base',
    dims: 768,
    pooling: 'mean',
    normalize: true,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    dtype: 'q8',
    license: 'MIT',
  },
  bgeM3Ko: {
    repo: 'HyperBlaze/BGE-m3-ko',
    dims: 1024,
    pooling: 'cls',
    normalize: true,
    queryPrefix: '',
    documentPrefix: '',
    dtype: 'q8',
    license: 'Apache-2.0',
  },
  'Qwen3-Embedding-0.6B': {
    repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    dims: 1024,
    pooling: 'last_token',
    normalize: true,
    // Qwen's format, `Instruct: {task}\nQuery:{query}`, with a task of our own as its card advises.
    queryPrefix: 'Instruct: Given a line from a role-play chat, retrieve the earlier story passages it refers to\nQuery:',
    documentPrefix: '',
    dtype: 'q8',
    license: 'Apache-2.0',
  },
  'EmbeddingGemma-300M': {
    repo: 'onnx-community/embeddinggemma-300m-ONNX',
    dims: 768,
    pooling: 'model',
    normalize: true,
    queryPrefix: 'task: search result | query: ',
    documentPrefix: 'title: none | text: ',
    // Its card: no fp16 activations. q4 (weights only, MatMulNBits) ranked better than
    // q8 and loads in a third of the memory (ARCHITECTURE §7.3).
    dtype: 'q4',
    externalData: true,
    license: 'Gemma Terms of Use',
  },
  'arctic-embed-l-v2.0': {
    repo: 'Snowflake/snowflake-arctic-embed-l-v2.0',
    dims: 1024,
    pooling: 'cls',
    normalize: true,
    queryPrefix: 'query: ',
    documentPrefix: '',
    dtype: 'q8',
    license: 'Apache-2.0',
  },
} as const satisfies Record<string, EmbeddingModelSpec>;

export type EmbeddingModelId = keyof typeof EMBEDDING_MODELS;

/** The model a plot embeds with, by its content language; `default` for any language not listed. */
export interface ModelRoutes {
  languages: Partial<Record<ContentLanguage, EmbeddingModelId>>;
  default: EmbeddingModelId;
}

/** `EMBEDDER_ROUTING=by-language`: KURE-v1 for Korean, bge-m3 for everything else. */
export const LANGUAGE_MODELS: ModelRoutes = { languages: { ko: 'KURE-v1' }, default: 'bge-m3' };
/**
 * `EMBEDDER_ROUTING=single` without an `EMBEDDER_MODEL` — the owner's choice
 * (2026-10-15): KURE-v1 for every plot. Benchmarked against bge-m3 the two were
 * within two hits on every set (ko, en, ja and across them), and one model
 * holds about 2 GB where routing by language holds both (§12).
 */
export const DEFAULT_SINGLE_MODEL: EmbeddingModelId = 'KURE-v1';
export const ROUTINGS = ['by-language', 'single'] as const;
export type Routing = (typeof ROUTINGS)[number];

export interface EmbedOptions {
  /** The content language of the plot the texts belong to (`plots.language`): it picks the model. */
  plotLanguage: ContentLanguage;
  /** A search's query, or a text to be searched (the default); the model's prefix follows. */
  kind?: 'query' | 'document';
  /** How long the whole call may take; past it the call throws (the thread keeps going). */
  timeoutMs?: number;
}

export interface Embedding {
  /** The model's id, which every vector it makes is stored with. */
  model: string;
  /** One vector per text, in order. */
  vectors: number[][];
}

/**
 * What `embed` throws while the embedder cannot be had for a while — a model
 * whose load failed within the last minute. Its message is all there is to it,
 * and the embedder logged the cause once as it began.
 */
export class EmbedderUnavailable extends Error {}

/**
 * What a caller that falls back puts after its own words in the log: the reason
 * alone, on the same line, for an unavailable embedder — every call meets it
 * until it is back, a turn's several of them too — and any other failure whole,
 * with its stack.
 */
export const embedErrorForLog = (error: unknown): unknown =>
  error instanceof EmbedderUnavailable ? `(${error.message})` : error;

/** Whether a model's weights are here, still downloading (or waiting to), or neither. */
export type WeightsState = 'ready' | 'downloading' | 'missing';

export interface Embedder {
  /** The model a plot in `plotLanguage` embeds with, or null when it cannot run here. */
  modelFor(plotLanguage: ContentLanguage): string | null;
  /** Where the weights of that model stand: `modelFor` is null unless they are ready. */
  weightsFor(plotLanguage: ContentLanguage): WeightsState;
  /** Embeds `texts` with the plot's model. Throws when it cannot. */
  embed(texts: readonly string[], options: EmbedOptions): Promise<Embedding>;
  /** Loads the plot's model now rather than on the first call; failures surface on that call. */
  warm(plotLanguage: ContentLanguage): void;
  /** Ends every thread and its model; the next call starts them again. */
  close(): Promise<void>;
}

/** Texts per message to the thread: RisuAI embeds 50 at a time; less keeps one batch's padding short. */
const BATCH = 32;
export const DEFAULT_TIMEOUT_MS = 30_000;
/** How long a model that failed to load is left before the next try. */
const LOAD_RETRY_MS = 60_000;
/** How long a model stays loaded without a request. */
export const DEFAULT_IDLE_MS = 10 * 60_000;
/** How many times a model's download is tried while the app runs, and the wait before the second, doubling after. */
const DOWNLOAD_TRIES = 5;
const DOWNLOAD_RETRY_MS = 30_000;

/** `apps/plot`, which a relative `EMBEDDER_CACHE_DIR` is resolved against (as `SHIZUE_DATA_DIR` is). */
const PLOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const THREAD_URL = new URL(
  `./embedderThread${new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'}`,
  import.meta.url,
);

export interface EmbedderConfig {
  routing: Routing;
  routes: ModelRoutes;
  cacheDir: string;
  /** onnxruntime's intra-op threads per model; unset, as many as it likes (the cores). */
  threads?: number;
}

/**
 * What `EMBEDDER`, `EMBEDDER_ROUTING`, `EMBEDDER_MODEL`, `EMBEDDER_CACHE_DIR`
 * and `EMBEDDER_THREADS` say, or the reason the server is to run without an
 * embedder (`EMBEDDER=off`, an unknown routing or model). `EMBEDDER_MODEL` is
 * read with `single` only. The weights are kept in the app's folder unless
 * `EMBEDDER_CACHE_DIR` names another (`make dev` names the checkout's cache).
 */
export function embedderConfig(env: NodeJS.ProcessEnv): EmbedderConfig | { off: string } {
  if (env['EMBEDDER'] === 'off') return { off: 'EMBEDDER=off' };
  const cacheDirSet = env['EMBEDDER_CACHE_DIR']?.trim();
  const cacheDir = cacheDirSet ? resolve(PLOT_ROOT, cacheDirSet) : join(dataDirOf(env), 'models');
  const threads = Number(env['EMBEDDER_THREADS']);
  const base = { cacheDir, ...(Number.isInteger(threads) && threads > 0 ? { threads } : {}) };
  const routing = env['EMBEDDER_ROUTING']?.trim() || 'single';
  if (routing === 'by-language') return { routing, routes: LANGUAGE_MODELS, ...base };
  if (routing !== 'single') return { off: `unknown EMBEDDER_ROUTING "${routing}" (one of ${ROUTINGS.join(', ')})` };
  const model = env['EMBEDDER_MODEL']?.trim() || DEFAULT_SINGLE_MODEL;
  if (!Object.hasOwn(EMBEDDING_MODELS, model)) {
    return { off: `unknown EMBEDDER_MODEL "${model}" (one of ${Object.keys(EMBEDDING_MODELS).join(', ')})` };
  }
  return { routing, routes: { languages: {}, default: model as EmbeddingModelId }, ...base };
}

/** The model `routes` gives a plot in `language`. */
export const routeOf = (routes: ModelRoutes, language: ContentLanguage): EmbeddingModelId =>
  routes.languages[language] ?? routes.default;

/** Every model `routes` can give a plot, each once. */
export const routedModels = (routes: ModelRoutes): EmbeddingModelId[] => [
  ...new Set([...Object.values(routes.languages), routes.default]),
];

/** Where a model's weights must be for it to run offline. */
export function weightsPath(cacheDir: string, model: EmbeddingModelId): string {
  const spec: EmbeddingModelSpec = EMBEDDING_MODELS[model];
  return join(cacheDir, spec.repo, 'onnx', WEIGHT_FILES[spec.dtype]);
}

/** The ONNX file of each transformers.js weight variant. */
export const WEIGHT_FILES = { q8: 'model_quantized.onnx', q4: 'model_q4.onnx', fp32: 'model.onnx' } as const;

/**
 * The files a model is, as transformers.js reads them — its config, its
 * tokenizer's two and its weights — each with its pinned SHA-256 where it has
 * one. The weights come last, so their file being there means the rest is.
 */
export function modelFiles(spec: EmbeddingModelSpec): HubFile[] {
  const weights = `onnx/${WEIGHT_FILES[spec.dtype]}`;
  const paths = ['config.json', 'tokenizer.json', 'tokenizer_config.json', ...(spec.externalData ? [`${weights}_data`] : []), weights];
  return paths.map((path) => {
    const sha256 = spec.hub?.sha256[path];
    return sha256 ? { path, sha256 } : { path };
  });
}

/** Downloads what is missing of a model's files from Hugging Face into the cache; answers the bytes it fetched. */
export function downloadWeights(cacheDir: string, model: EmbeddingModelId, options: DownloadOptions = {}): Promise<number> {
  const spec: EmbeddingModelSpec = EMBEDDING_MODELS[model];
  return downloadFromHub(
    { repo: spec.hub?.repo ?? spec.repo, revision: spec.hub?.revision ?? 'main', dir: join(cacheDir, spec.repo), files: modelFiles(spec) },
    options,
  );
}

/** Where a model's files are downloaded from, as the log names it. */
const originOf = (spec: EmbeddingModelSpec): string =>
  spec.hub ? `${spec.hub.repo} at ${spec.hub.revision.slice(0, 7)}` : spec.repo;

/**
 * How a model is run, sent with each of its batches: the thread holds every
 * model it was asked for (`embedderThread.ts`).
 */
export interface ThreadModel {
  repo: string;
  dtype: EmbeddingModelSpec['dtype'];
  pooling: EmbeddingModelSpec['pooling'];
  normalize: boolean;
}

/** What the thread is started with. */
export interface ThreadData {
  cacheDir: string;
  threads?: number;
}

/** A batch for a model (no texts: only load it), or a model to let go. */
export type ThreadMessage = { id: number; model: ThreadModel; texts: string[] } | { unload: string };

/** The part of a `Worker` the embedder uses, so the tests can stand one in. */
export interface EmbedderWorker {
  postMessage(message: ThreadMessage): void;
  on(event: 'message', listener: (message: ThreadReply) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  unref(): void;
  terminate(): Promise<number>;
}

export interface ThreadReply {
  id: number;
  vectors?: Float32Array[];
  error?: string;
  loadFailed?: boolean;
}

export interface EmbedderOptions {
  /** How long a model stays loaded without a request; `DEFAULT_IDLE_MS` by default. */
  idleMs?: number;
  /** Starts the thread; a real worker thread by default. */
  spawn?: (data: ThreadData) => EmbedderWorker;
  /** Downloads a model's weights into the cache, answering the bytes fetched; `downloadWeights` by default. */
  download?: (model: EmbeddingModelId, signal: AbortSignal) => Promise<number>;
  /** The wait before a failed download is tried again, doubling after each; `DOWNLOAD_RETRY_MS` by default. */
  retryMs?: number;
}

/** The embedder the app runs, which downloads the weights it lacks once asked to. */
export interface LocalEmbedder extends Embedder {
  /**
   * Downloads the weights the routed models lack, in the background, one model
   * after another — called once the app serves, never on a request. A model is
   * used from the moment its weights are whole. A failure that may pass (the
   * network, the server) is tried again a few times, resuming where it can; one
   * that will not (a file unlike its pin, a refusal), and the last try, wait
   * for the next start.
   */
  downloadMissing(): void;
}

/**
 * The embedder `env` configures, or undefined — with a line in the log — when
 * it is off. A model whose weights are not here yet is said once here, and
 * `modelFor` is null for its plots until `downloadMissing` has them.
 */
export function createLocalEmbedder(
  env: NodeJS.ProcessEnv = process.env,
  options: EmbedderOptions = {},
): LocalEmbedder | undefined {
  const config = embedderConfig(env);
  if ('off' in config) {
    console.warn(`[embedder] off: ${config.off}; memory falls back to recent and random summaries`);
    return undefined;
  }
  if (config.routing === 'by-language' && env['EMBEDDER_MODEL']?.trim()) {
    console.warn('[embedder] EMBEDDER_MODEL is read with EMBEDDER_ROUTING=single only; routing by language');
  }
  const available = new Set<EmbeddingModelId>();
  for (const model of routedModels(config.routes)) {
    if (existsSync(weightsPath(config.cacheDir, model))) available.add(model);
    else {
      console.warn(
        `[embedder] no weights for ${model} under ${config.cacheDir} yet. Until they are downloaded, the plots it is ` +
          'for search nothing by meaning: memory falls back to recent and random summaries.',
      );
    }
  }
  return new ServerEmbedder(config, available, options);
}

/** One model's standing in the thread. */
interface ModelState {
  /** Asked for since its last unload: the thread holds it, or is loading it. */
  loaded: boolean;
  /** Its batches the thread has not answered yet. */
  inFlight: number;
  idleTimer: NodeJS.Timeout | undefined;
  /** Until when a failed load is not retried. */
  failedUntil: number;
  lastError: EmbedderUnavailable | null;
}

interface Pending {
  model: EmbeddingModelId;
  resolve: (vectors: number[][]) => void;
  reject: (error: Error) => void;
}

const spawnThread = (data: ThreadData): EmbedderWorker => new Worker(THREAD_URL, { workerData: data });

/**
 * Every model runs in one thread, one batch at a time. Not a thread each:
 * onnxruntime-node keeps its tensor constructor in a process-wide static that
 * the last thread to load the addon owns, so a second thread running a session
 * crashes the process (2026-10-15, onnxruntime-node 1.21). A model unloads after
 * `idleMs` without a request; the last one to go takes the thread with it.
 */
class ServerEmbedder implements LocalEmbedder {
  private worker: EmbedderWorker | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly states = new Map<EmbeddingModelId, ModelState>();
  private nextId = 0;
  private readonly idleMs: number;
  private readonly spawn: (data: ThreadData) => EmbedderWorker;
  private readonly download: (model: EmbeddingModelId, signal: AbortSignal) => Promise<number>;
  private readonly retryMs: number;
  /** The models whose weights are whole here; a download adds to them. */
  private readonly available: Set<EmbeddingModelId>;
  /** The models a download is under way or waiting for. */
  private readonly fetching = new Set<EmbeddingModelId>();
  private downloads: { controller: AbortController; done: Promise<void> } | null = null;

  constructor(
    private readonly config: EmbedderConfig,
    available: ReadonlySet<EmbeddingModelId>,
    options: EmbedderOptions,
  ) {
    this.available = new Set(available);
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.spawn = options.spawn ?? spawnThread;
    this.retryMs = options.retryMs ?? DOWNLOAD_RETRY_MS;
    this.download =
      options.download ??
      ((model, signal) => downloadWeights(config.cacheDir, model, { signal, log: (line) => console.log(`[embedder] ${model}: ${line}`) }));
  }

  modelFor(plotLanguage: ContentLanguage): EmbeddingModelId | null {
    const model = routeOf(this.config.routes, plotLanguage);
    return this.available.has(model) ? model : null;
  }

  weightsFor(plotLanguage: ContentLanguage): WeightsState {
    const model = routeOf(this.config.routes, plotLanguage);
    return this.available.has(model) ? 'ready' : this.fetching.has(model) ? 'downloading' : 'missing';
  }

  downloadMissing(): void {
    if (this.downloads) return;
    const missing = routedModels(this.config.routes).filter((model) => !this.available.has(model));
    if (missing.length === 0) return;
    for (const model of missing) this.fetching.add(model);
    const controller = new AbortController();
    const done = (async () => {
      for (const model of missing) {
        if (!controller.signal.aborted) await this.downloadModel(model, controller.signal);
        this.fetching.delete(model);
      }
    })();
    this.downloads = { controller, done };
  }

  /** One model's weights, tried again on a failure that may pass; never throws. */
  private async downloadModel(model: EmbeddingModelId, signal: AbortSignal): Promise<void> {
    const spec: EmbeddingModelSpec = EMBEDDING_MODELS[model];
    console.log(`[embedder] downloading ${model} from Hugging Face (${originOf(spec)}) into ${this.config.cacheDir}, in the background`);
    const started = Date.now();
    const stopped = (): void => console.log(`[embedder] ${model}'s download stopped with the app; the next start takes it up again`);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const bytes = await this.download(model, signal);
        this.available.add(model);
        console.log(`[embedder] ${model} is ready (${megabytes(bytes)} in ${Math.round((Date.now() - started) / 1000)} s): its plots search by meaning from now on`);
        return;
      } catch (error) {
        if (signal.aborted) return stopped();
        const reason = error instanceof Error ? error.message : String(error);
        if (attempt >= DOWNLOAD_TRIES || error instanceof DownloadMismatch || error instanceof DownloadRefused) {
          console.error(
            `[embedder] ${model} was not downloaded: ${reason}. The next start tries again; ` +
              'until then its plots search nothing by meaning: memory falls back to recent and random summaries.',
          );
          return;
        }
        const wait = this.retryMs * 2 ** (attempt - 1);
        console.warn(`[embedder] ${model}'s download stopped: ${reason}; trying again in ${Math.round(wait / 1000)} s`);
        const waited = await sleep(wait, undefined, { signal, ref: false }).then(
          () => true,
          () => false,
        );
        if (!waited) return stopped();
      }
    }
  }

  async embed(
    texts: readonly string[],
    { plotLanguage, kind = 'document', timeoutMs = DEFAULT_TIMEOUT_MS }: EmbedOptions,
  ): Promise<Embedding> {
    const model = this.modelFor(plotLanguage);
    if (!model) throw new Error(`no embedding model for ${plotLanguage}: ${routeOf(this.config.routes, plotLanguage)} has no weights here yet`);
    if (texts.length === 0) return { model, vectors: [] };
    const state = this.state(model);
    if (Date.now() < state.failedUntil) throw state.lastError ?? new EmbedderUnavailable('embedder unavailable');
    const spec: EmbeddingModelSpec = EMBEDDING_MODELS[model];
    const prefix = kind === 'query' ? spec.queryPrefix : spec.documentPrefix;
    const prefixed = texts.map((text) => prefix + text);
    const batches: string[][] = [];
    for (let at = 0; at < prefixed.length; at += BATCH) batches.push(prefixed.slice(at, at + BATCH));

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`embedding took longer than ${timeoutMs} ms`)), timeoutMs);
      timer.unref();
    });
    try {
      const results = await Promise.race([Promise.all(batches.map((batch) => this.request(model, batch))), deadline]);
      return { model, vectors: results.flat() };
    } finally {
      clearTimeout(timer);
    }
  }

  warm(plotLanguage: ContentLanguage): void {
    const model = this.modelFor(plotLanguage);
    if (!model || Date.now() < this.state(model).failedUntil) return;
    // No texts: the thread loads the model and answers that it did.
    this.request(model, []).catch(() => undefined);
  }

  async close(): Promise<void> {
    // A download stops where it is: its part is kept for the next start to resume.
    const downloads = this.downloads;
    this.downloads = null;
    downloads?.controller.abort();
    await downloads?.done;
    for (const state of this.states.values()) this.reset(state);
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(new Error('embedder closed'));
    this.pending.clear();
    if (worker) await worker.terminate();
  }

  private state(model: EmbeddingModelId): ModelState {
    let state = this.states.get(model);
    if (!state) {
      state = { loaded: false, inFlight: 0, idleTimer: undefined, failedUntil: 0, lastError: null };
      this.states.set(model, state);
    }
    return state;
  }

  private reset(state: ModelState): void {
    clearTimeout(state.idleTimer);
    state.loaded = false;
    state.inFlight = 0;
  }

  private request(model: EmbeddingModelId, texts: string[]): Promise<number[][]> {
    const id = (this.nextId += 1);
    const state = this.state(model);
    clearTimeout(state.idleTimer);
    state.loaded = true;
    state.inFlight += 1;
    const spec: EmbeddingModelSpec = EMBEDDING_MODELS[model];
    return new Promise((resolve, reject) => {
      this.pending.set(id, { model, resolve, reject });
      this.thread().postMessage({
        id,
        model: { repo: spec.repo, dtype: spec.dtype, pooling: spec.pooling, normalize: spec.normalize },
        texts,
      });
    });
  }

  /** Unloads the model once nothing has been asked of it for `idleMs`; every request puts it off. */
  private idleSoon(model: EmbeddingModelId): void {
    const state = this.state(model);
    clearTimeout(state.idleTimer);
    if (!state.loaded || state.inFlight > 0 || !this.worker) return;
    state.idleTimer = setTimeout(() => {
      if (!state.loaded || state.inFlight > 0 || !this.worker) return;
      state.loaded = false;
      console.log(`[embedder] ${model} unloaded after ${Math.round(this.idleMs / 60_000)} min idle`);
      if (!this.endIfUnused()) this.worker.postMessage({ unload: EMBEDDING_MODELS[model].repo });
    }, this.idleMs);
    state.idleTimer.unref();
  }

  /** Ends the thread, and its heap with it, when it holds no model and owes no answer. */
  private endIfUnused(): boolean {
    const worker = this.worker;
    if (!worker || this.pending.size > 0 || [...this.states.values()].some((state) => state.loaded)) return false;
    // Cleared first: a request from here on starts a thread of its own.
    this.worker = null;
    void worker.terminate();
    return true;
  }

  private thread(): EmbedderWorker {
    if (this.worker) return this.worker;
    const worker = this.spawn({ cacheDir: this.config.cacheDir, ...(this.config.threads ? { threads: this.config.threads } : {}) });
    // An idle embedder must never keep the process (or a test run) alive.
    worker.unref();
    worker.on('message', (message) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      const state = this.state(pending.model);
      state.inFlight -= 1;
      if (message.loadFailed) {
        state.lastError = new EmbedderUnavailable(`embedder could not load ${pending.model}: ${message.error}`);
        state.failedUntil = Date.now() + LOAD_RETRY_MS;
        state.loaded = false;
        console.error(`[embedder] ${state.lastError.message}`);
      }
      if (message.vectors) pending.resolve(message.vectors.map((vector) => Array.from(vector)));
      else pending.reject(new Error(message.error ?? 'embedding failed'));
      if (state.loaded) this.idleSoon(pending.model);
      else this.endIfUnused();
    });
    const fail = (error: Error): void => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const state of this.states.values()) this.reset(state);
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
