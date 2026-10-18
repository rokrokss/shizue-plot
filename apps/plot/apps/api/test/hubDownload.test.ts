/**
 * The Hugging Face download of the embedder's weights (`hubDownload.ts`),
 * against a stand-in for Hugging Face on loopback that sends each file on to a
 * "CDN" address, as huggingface.co does: whole files only, pins, resuming,
 * refusals, stalls and aborts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { downloadFromHub, DownloadMismatch, DownloadRefused, type HubDownload } from '../src/hubDownload.js';
import { modelFiles, EMBEDDING_MODELS, type EmbeddingModelSpec } from '../src/embedder.js';

interface Served {
  body: Buffer;
  /** Sends the whole file whatever range is asked. */
  ignoreRange?: boolean;
  /** Answers this status instead. */
  status?: number;
  /** Sends this many bytes, then nothing more (the connection stays open). */
  stallAfter?: number;
}

const REPO = 'someone/model-onnx';
const REVISION = '0123456789abcdef0123456789abcdef01234567';
const files = new Map<string, Served>();
const requests: { path: string; range: string | undefined }[] = [];
let server: Server;
let hub: string;
let dir: string;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const serve = (path: string, served: Served): void => void files.set(`${REPO}/${REVISION}/${path}`, served);
const download = (list: HubDownload['files'], options: Parameters<typeof downloadFromHub>[1] = {}) =>
  downloadFromHub({ repo: REPO, revision: REVISION, dir, files: list }, { hub, ...options });

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://hub').pathname;
    const resolved = /^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(path);
    if (resolved) {
      res.writeHead(302, { location: `/cdn/${resolved[1]}/${resolved[2]}/${resolved[3]}` }).end();
      return;
    }
    const key = path.replace(/^\/cdn\//, '');
    requests.push({ path: key.slice(`${REPO}/${REVISION}/`.length), range: req.headers.range });
    const served = files.get(key);
    if (!served || served.status) {
      res.writeHead(served?.status ?? 404).end();
      return;
    }
    const { body } = served;
    const asked = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = asked && !served.ignoreRange ? Number(asked[1]) : 0;
    if (start >= body.length && start > 0) {
      res.writeHead(416, { 'content-range': `bytes */${body.length}` }).end();
      return;
    }
    res.writeHead(start > 0 ? 206 : 200, {
      'content-length': body.length - start,
      ...(start > 0 ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    });
    if (served.stallAfter !== undefined) res.write(body.subarray(start, start + served.stallAfter));
    else res.end(body.subarray(start));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-download-'));
  files.clear();
  requests.length = 0;
});
afterEach(() => {
  server.closeAllConnections();
  rmSync(dir, { recursive: true, force: true });
});

describe('downloading from Hugging Face', () => {
  it('puts each file in place whole, through the address it is sent on to, checking the pinned ones', async () => {
    const config = Buffer.from('{"model_type":"xlm-roberta"}');
    const weights = randomBytes(300_000);
    serve('config.json', { body: config });
    serve('onnx/model_quantized.onnx', { body: weights });
    const fetched = await download([{ path: 'config.json' }, { path: 'onnx/model_quantized.onnx', sha256: sha256(weights) }]);
    expect(fetched).toBe(config.length + weights.length);
    expect(readFileSync(join(dir, 'config.json'))).toEqual(config);
    expect(readFileSync(join(dir, 'onnx/model_quantized.onnx'))).toEqual(weights);
    expect(existsSync(join(dir, 'onnx/model_quantized.onnx.part'))).toBe(false);
    expect(requests.map((request) => request.path)).toEqual(['config.json', 'onnx/model_quantized.onnx']);
  });

  it('deletes a file unlike its pin and fails, leaving nothing in its place', async () => {
    serve('onnx/model_quantized.onnx', { body: randomBytes(1_000) });
    await expect(download([{ path: 'onnx/model_quantized.onnx', sha256: sha256(Buffer.from('another file')) }])).rejects.toBeInstanceOf(
      DownloadMismatch,
    );
    expect(existsSync(join(dir, 'onnx/model_quantized.onnx'))).toBe(false);
    expect(existsSync(join(dir, 'onnx/model_quantized.onnx.part'))).toBe(false);
  });

  it('resumes a pinned file from its part by a range, and starts over where the server sends it whole', async () => {
    const weights = randomBytes(200_000);
    const part = join(dir, 'onnx/model_quantized.onnx.part');
    mkdirSync(dirname(part), { recursive: true });
    writeFileSync(part, weights.subarray(0, 80_000));
    serve('onnx/model_quantized.onnx', { body: weights });
    const pinned = [{ path: 'onnx/model_quantized.onnx', sha256: sha256(weights) }];
    expect(await download(pinned)).toBe(120_000);
    expect(requests).toEqual([{ path: 'onnx/model_quantized.onnx', range: 'bytes=80000-' }]);
    expect(readFileSync(join(dir, 'onnx/model_quantized.onnx'))).toEqual(weights);

    rmSync(join(dir, 'onnx/model_quantized.onnx'));
    writeFileSync(part, weights.subarray(0, 50_000));
    serve('onnx/model_quantized.onnx', { body: weights, ignoreRange: true });
    requests.length = 0;
    expect(await download(pinned)).toBe(200_000);
    expect(requests.map((request) => request.range)).toEqual(['bytes=50000-', undefined]);
    expect(readFileSync(join(dir, 'onnx/model_quantized.onnx'))).toEqual(weights);
  });

  it('starts a file without a pin over rather than resume it, since its repo may have moved', async () => {
    const tokenizer = randomBytes(5_000);
    writeFileSync(join(dir, 'tokenizer.json.part'), randomBytes(3_000));
    serve('tokenizer.json', { body: tokenizer });
    await download([{ path: 'tokenizer.json' }]);
    expect(requests).toEqual([{ path: 'tokenizer.json', range: undefined }]);
    expect(readFileSync(join(dir, 'tokenizer.json'))).toEqual(tokenizer);
  });

  it('keeps what is in place, but downloads again a pinned file that does not match', async () => {
    const tokenizer = Buffer.from('{"tokenizer":true}');
    serve('tokenizer.json', { body: tokenizer });
    serve('config.json', { body: Buffer.from('{}') });
    writeFileSync(join(dir, 'config.json'), '{"kept":true}');
    writeFileSync(join(dir, 'tokenizer.json'), 'damaged');
    await download([{ path: 'config.json' }, { path: 'tokenizer.json', sha256: sha256(tokenizer) }]);
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{"kept":true}');
    expect(readFileSync(join(dir, 'tokenizer.json'))).toEqual(tokenizer);
    expect(requests.map((request) => request.path)).toEqual(['tokenizer.json']);
  });

  it('refuses for good on a missing file, and fails to try again later on a server error', async () => {
    await expect(download([{ path: 'config.json' }])).rejects.toBeInstanceOf(DownloadRefused);
    serve('config.json', { body: Buffer.from('{}'), status: 503 });
    const failure = await download([{ path: 'config.json' }]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(DownloadRefused);
    expect(String(failure)).toContain('503');
  });

  it('gives up a response that stops sending, and stops on the caller’s abort, keeping the part for the next try', async () => {
    const weights = randomBytes(100_000);
    serve('onnx/model_quantized.onnx', { body: weights, stallAfter: 10_000 });
    const pinned = [{ path: 'onnx/model_quantized.onnx', sha256: sha256(weights) }];
    await expect(download(pinned, { idleMs: 150 })).rejects.toThrow(/no data for 0.15 s/);
    expect(existsSync(join(dir, 'onnx/model_quantized.onnx.part'))).toBe(true);
    expect(existsSync(join(dir, 'onnx/model_quantized.onnx'))).toBe(false);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(download(pinned, { signal: controller.signal })).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(existsSync(join(dir, 'onnx/model_quantized.onnx.part'))).toBe(true);
    expect(existsSync(join(dir, 'onnx/model_quantized.onnx'))).toBe(false);
  });
});

describe('a model’s files', () => {
  it('are its config, its tokenizer’s two and its weights last, with KURE-v1’s pins', () => {
    expect(modelFiles(EMBEDDING_MODELS['KURE-v1'])).toEqual([
      { path: 'config.json' },
      { path: 'tokenizer.json', sha256: 'fb3c3b93c46fd5a8634e262e1b7de7da11a18b527aa2282b312952b692781dfd' },
      { path: 'tokenizer_config.json' },
      { path: 'onnx/model_quantized.onnx', sha256: '3530a7640919b643a1cdf07894dbb2481a4edaf5acd0e439b8b860026f87b494' },
    ]);
    const gemma: EmbeddingModelSpec = EMBEDDING_MODELS['EmbeddingGemma-300M'];
    expect(modelFiles(gemma).map((file) => file.path).slice(-2)).toEqual(['onnx/model_q4.onnx_data', 'onnx/model_q4.onnx']);
  });
});
