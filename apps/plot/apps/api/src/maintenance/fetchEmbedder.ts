/**
 * Puts the server embedder's weights (`embedder.ts`) in `EMBEDDER_CACHE_DIR` —
 * the deploy/setup step, since the server never fetches them itself — for every
 * model `EMBEDDER_ROUTING` can give a plot: KURE-v1 and bge-m3 by language, or
 * the one model of `single`.
 *
 * - A Hugging Face model (bge-m3) comes from Hugging Face, as transformers.js
 *   lays it out: loaded once, remote loading on, in a thread of its own
 *   (`fetchEmbedderThread.ts`) that is then ended.
 * - A store model (KURE-v1, our ONNX conversion) comes from `models/<repo>/` in
 *   the object store `S3_*` names, whatever `STORAGE_DRIVER` says: the files its
 *   `manifest.json` lists, each checked against the manifest's SHA-256. A file
 *   already here with that hash is kept. `embedder:publish` put them there.
 *
 * Then loads each the way the server will, offline, and embeds a line to prove
 * it, printing the model, its size on disk and the vector length.
 *
 * onnxruntime runs only in those threads, one after another, never on the main
 * thread — as in the server. onnxruntime-node 1.21 keeps its tensor constructor
 * in a process-wide static that each thread's first session takes over
 * (`embedder.ts`). When the download ran on the main thread, a run now and then
 * died with SIGSEGV (exit 139), mostly after its checks had passed, V8's heap
 * corrupt in one thread or the other: 4 of 36 `by-language` runs on 2026-10-15,
 * and none of 40 with the download in its thread.
 *
 *   pnpm --filter @shizue/api embedder:fetch
 *
 * Reads `apps/plot/.env` like the server. A model it cannot fetch is said, the
 * others are fetched all the same, and the run ends non-zero.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline as pipe } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Worker } from 'node:worker_threads';
import {
  createLocalEmbedder,
  EMBEDDING_MODELS,
  embedderConfig,
  routedModels,
  storePrefix,
  weightsPath,
  type EmbeddingModelId,
  type EmbeddingModelSpec,
  type StoreManifest,
} from '../embedder.js';
import { loadRootEnv, readS3Config } from '../env.js';
import { createS3Storage } from '../s3.js';
import type { ObjectStorage } from '../storage.js';

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

const sha256Of = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  await pipe(createReadStream(path), hash);
  return hash.digest('hex');
};

let store: ObjectStorage | null = null;

/** The manifest's files, into the cache; a file whose bytes are not the manifest's is not kept. */
async function fetchFromStore(spec: EmbeddingModelSpec): Promise<void> {
  store ??= createS3Storage(readS3Config(process.env));
  const prefix = storePrefix(spec);
  const object = await store.get(`${prefix}manifest.json`);
  if (!object) throw new Error(`no ${prefix}manifest.json in the object store; run embedder:publish first`);
  const manifest = JSON.parse(await new Response(object.body).text()) as StoreManifest;
  const root = join(cacheDir, spec.repo);
  for (const file of manifest.files) {
    const target = resolve(root, file.path);
    if (relative(root, target).startsWith('..')) throw new Error(`${file.path} is outside the model's directory`);
    if (existsSync(target) && statSync(target).size === file.size && (await sha256Of(target)) === file.sha256) {
      console.log(`  ${file.path} is already here`);
      continue;
    }
    const stored = await store.get(prefix + file.path);
    if (!stored) throw new Error(`${prefix}${file.path} is in the manifest but not in the store`);
    await mkdir(dirname(target), { recursive: true });
    const part = `${target}.part`;
    const hash = createHash('sha256');
    const hashing = new Transform({
      transform(chunk: Buffer, _, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipe(Readable.fromWeb(stored.body as WebReadableStream<Uint8Array>), hashing, createWriteStream(part));
    const digest = hash.digest('hex');
    if (digest !== file.sha256 || statSync(part).size !== file.size) {
      await rm(part, { force: true });
      throw new Error(`${file.path} does not match the manifest (sha256 ${digest})`);
    }
    await rename(part, target);
    console.log(`  ${file.path} — ${Math.round(file.size / 1e6)} MB`);
  }
}

/** `.ts` under tsx, `.js` once built — as `embedder.ts` finds its thread. */
const DOWNLOAD_THREAD_URL = new URL(
  `./fetchEmbedderThread${new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'}`,
  import.meta.url,
);

/** The model's files from Hugging Face, into the cache, by loading it once in a thread that is then ended. */
async function fetchFromHub(spec: EmbeddingModelSpec): Promise<void> {
  const thread = new Worker(DOWNLOAD_THREAD_URL, { workerData: { cacheDir, repo: spec.repo, dtype: spec.dtype } });
  try {
    const answer = await new Promise<{ error?: string }>((resolve, reject) => {
      thread.once('message', resolve);
      thread.once('error', reject);
      thread.once('exit', (code) => reject(new Error(`the download thread exited (${code})`)));
    });
    if (answer.error) throw new Error(answer.error);
  } finally {
    await thread.terminate();
  }
}

async function fetchModel(model: EmbeddingModelId): Promise<void> {
  const spec: EmbeddingModelSpec = EMBEDDING_MODELS[model];
  console.log(`fetching ${model} (${spec.repo}, ${spec.dtype}) from ${spec.source === 'store' ? 'the object store' : 'Hugging Face'} into ${cacheDir}`);
  if (spec.source === 'store') await fetchFromStore(spec);
  else await fetchFromHub(spec);
  console.log(`weights at ${weightsPath(cacheDir, model)} — ${Math.round(size(join(cacheDir, spec.repo)) / 1e6)} MB`);

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
