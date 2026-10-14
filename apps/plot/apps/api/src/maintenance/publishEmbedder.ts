/**
 * Uploads a store model's weights — a model whose `EMBEDDING_MODELS` entry says
 * `source: 'store'`, KURE-v1 — to `models/<repo>/` in the object store `S3_*`
 * names, with the `manifest.json` that `embedder:fetch` reads: each file's path,
 * size and SHA-256. The files go first and the manifest last, so a fetch never
 * reads a manifest whose files are not there yet.
 *
 *   pnpm --filter @shizue/api embedder:publish KURE-v1 <dir>
 *
 * `<dir>` is laid out as the cache is: `onnx/model_quantized.onnx`, with the
 * tokenizer's and the model's config files beside `onnx/`. ARCHITECTURE §7.3
 * says how KURE-v1's are made (`scripts/kure_onnx.py`). Run once per conversion,
 * not per deploy.
 */
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { EMBEDDING_MODELS, storePrefix, WEIGHT_FILES, type EmbeddingModelSpec, type StoreManifest } from '../embedder.js';
import { loadRootEnv, readS3Config } from '../env.js';
import { createS3Storage } from '../s3.js';

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );

loadRootEnv();
const [model, dir] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!model || !dir) {
  console.error('usage: embedder:publish <model> <dir>');
  process.exit(1);
}
const spec: EmbeddingModelSpec | undefined = Object.hasOwn(EMBEDDING_MODELS, model)
  ? (EMBEDDING_MODELS as Record<string, EmbeddingModelSpec>)[model]
  : undefined;
if (spec?.source !== 'store') {
  console.error(spec ? `${model} comes from Hugging Face, not from the store` : `unknown model "${model}"`);
  process.exit(1);
}
const root = resolve(dir);
const weights = join(root, 'onnx', WEIGHT_FILES[spec.dtype]);
if (!statSync(weights, { throwIfNoEntry: false })?.isFile()) {
  console.error(`no ${relative(root, weights)} in ${root}`);
  process.exit(1);
}

const store = createS3Storage(readS3Config(process.env));
const prefix = storePrefix(spec);
const manifest: StoreManifest = { files: [] };
for (const path of filesUnder(root).filter((path) => relative(root, path) !== 'manifest.json')) {
  const bytes = await readFile(path);
  const file = {
    path: relative(root, path).split(sep).join('/'),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  await store.put(prefix + file.path, bytes, file.path.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  manifest.files.push(file);
  console.log(`${prefix}${file.path} — ${Math.round(file.size / 1e6)} MB, sha256 ${file.sha256}`);
}
await store.put(`${prefix}manifest.json`, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`), 'application/json');
console.log(`${prefix}manifest.json — ${manifest.files.length} files`);
