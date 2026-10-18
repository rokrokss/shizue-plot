/**
 * Files of a Hugging Face repo, downloaded into a folder on this computer: the
 * server embedder's weights (`embedder.ts`), which the app downloads by itself
 * in the background once it serves, and `embedder:fetch` ahead of time. One
 * pinned file from elsewhere goes the same way (`downloadPinned`): cloudflared
 * for the phone's tunnel (`cloudflared.ts`).
 *
 * - **A file in place is whole.** Each goes to `<file>.part` first and is
 *   renamed into place only once all its bytes are there — as many as the
 *   server said, and the SHA-256 pinned for it, where one is. A part that does
 *   not match its pin is deleted, and the download fails with
 *   `DownloadMismatch`.
 * - **A pinned file resumes.** An earlier try's `.part` is read for its hash
 *   and the rest asked for by a range; a server that sends the whole instead
 *   is read from the start. A file without a pin starts over each time, since
 *   the repo's `main` may have moved between the tries.
 * - **What is already in place is kept**, once its hash is checked where one
 *   is pinned: a file that does not match is downloaded again.
 * - A response that sends nothing for a minute is given up, as the caller's
 *   abort gives it up; either leaves the `.part` for the next try. An answer a
 *   retry will not change (4xx but 408 and 429) throws `DownloadRefused`.
 *
 * It reads through `node:https`, following Hugging Face's redirect to its CDN
 * itself, rather than `fetch`: measured on 2026-10-19 on the owner's computer,
 * the same file came through `fetch` at 0.28 MB/s and through `https.get` at
 * 2.2–2.4 MB/s, as fast as curl — KURE-v1 in 40 minutes against 5.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { basename, dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HUGGING_FACE = 'https://huggingface.co';
/** How long a response may send nothing before it is given up. */
const IDLE_MS = 60_000;
/** Hugging Face sends a file on once, to its CDN; a few more are allowed. */
const MAX_REDIRECTS = 5;
/** Files from this size on — the weights, not the tokenizer — say how far they have come, every tenth. */
const REPORTED_SIZE = 100_000_000;

export interface HubFile {
  /** Its path in the repo, and under the folder. */
  path: string;
  /** Its SHA-256, when one is pinned. */
  sha256?: string;
}

export interface HubDownload {
  repo: string;
  /** A commit, or a branch such as `main`. */
  revision: string;
  /** Where the files go, each at its path. */
  dir: string;
  /** In the order they are downloaded. */
  files: readonly HubFile[];
}

export interface DownloadOptions {
  signal?: AbortSignal;
  /** Where the progress lines go; nowhere unless given. */
  log?: (line: string) => void;
  /** The server, Hugging Face's unless a test stands one in. */
  hub?: string;
  idleMs?: number;
  /** How many bytes of the file are in its part so far, and of how many when the server said. */
  onProgress?: (received: number, total: number | undefined) => void;
}

/** A file whose bytes are not the ones pinned for it; its part is deleted. */
export class DownloadMismatch extends Error {}
/** An answer that trying again will not change: the file is not there, or not for us. */
export class DownloadRefused extends Error {}

export const megabytes = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`;

/** The files of `download` that are not in place yet, into its folder; answers the bytes it fetched. */
export async function downloadFromHub(download: HubDownload, options: DownloadOptions = {}): Promise<number> {
  const log = options.log ?? (() => undefined);
  let fetched = 0;
  for (const file of download.files) {
    const target = join(download.dir, file.path);
    if (existsSync(target)) {
      if (!file.sha256 || (await sha256Of(target)) === file.sha256) continue;
      log(`${file.path} does not match its SHA-256; downloading it again`);
      await rm(target);
    }
    const hub = options.hub ?? HUGGING_FACE;
    const url = `${hub}/${download.repo}/resolve/${encodeURIComponent(download.revision)}/${file.path}`;
    fetched += await downloadFile(url, target, file, { ...options, log });
  }
  return fetched;
}

/**
 * One pinned file from any address into `target`, under the same rules as a
 * repo's files — the part and its rename, the pin, resuming, the redirects and
 * the idle watch: cloudflared's release asset (`cloudflared.ts`). Answers the
 * bytes it fetched.
 */
export function downloadPinned(url: string, target: string, sha256: string, options: DownloadOptions = {}): Promise<number> {
  return downloadFile(url, target, { path: basename(target), sha256 }, { ...options, log: options.log ?? (() => undefined) });
}

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Where the part a server sent starts, off its `Content-Range`. */
const rangeStart = (response: IncomingMessage): number | undefined => {
  const match = /^bytes (\d+)-/.exec(response.headers['content-range'] ?? '');
  return match ? Number(match[1]) : undefined;
};

function refusalOr(status: number, url: string): Error {
  const message = `${url} answered ${status}`;
  const lasting = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return lasting ? new DownloadRefused(message) : new Error(message);
}

/** The watch on a download's socket: how long it may send nothing, and whether it did. */
interface Idle {
  ms: number;
  stalled: boolean;
}

/** The answer to a GET of `url` after its redirects, its body still to be read. */
function get(url: string, headers: Record<string, string>, signal: AbortSignal | undefined, idle: Idle, hops = 0): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.startsWith('https:') ? httpsGet : httpGet;
    const request = send(url, { headers, ...(signal ? { signal } : {}) }, (response) => {
      const location = response.headers.location;
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (hops >= MAX_REDIRECTS) reject(new Error(`${url} sent the download on more than ${MAX_REDIRECTS} times`));
        else resolve(get(new URL(location, url).toString(), headers, signal, idle, hops + 1));
        return;
      }
      resolve(response);
    });
    // The socket's own watch, waiting for the answer as while reading it.
    request.setTimeout(idle.ms, () => {
      idle.stalled = true;
      request.destroy(new Error(`no data for ${idle.ms / 1000} s`));
    });
    request.on('error', reject);
  });
}

async function downloadFile(
  url: string,
  target: string,
  file: HubFile,
  options: DownloadOptions & { log: (line: string) => void },
): Promise<number> {
  const { log } = options;
  const idle: Idle = { ms: options.idleMs ?? IDLE_MS, stalled: false };
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.part`;
  let hash = createHash('sha256');
  let have = file.sha256 ? ((await stat(part).catch(() => null))?.size ?? 0) : 0;
  if (have > 0) for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);

  try {
    let response = await get(url, have > 0 ? { range: `bytes=${have}-` } : {}, options.signal, idle);
    if (have > 0 && !(response.statusCode === 206 && rangeStart(response) === have)) {
      // The server would not go on from there — a 200 is the whole file, a 416 a part
      // that was already whole: from the start, then.
      response.destroy();
      have = 0;
      hash = createHash('sha256');
      response = await get(url, {}, options.signal, idle);
    }
    const status = response.statusCode ?? 0;
    if (status !== (have > 0 ? 206 : 200)) {
      response.destroy();
      throw refusalOr(status, url);
    }
    const length = Number(response.headers['content-length']);
    const total = Number.isInteger(length) && length > 0 ? have + length : undefined;
    const reported = total !== undefined && total >= REPORTED_SIZE;
    if (reported) {
      log(have > 0 ? `resuming ${file.path} at ${Math.floor((have / total) * 100)}% of ${megabytes(total)}` : `${file.path}, ${megabytes(total)}`);
    }

    let received = have;
    let tenths = reported ? Math.floor((have / total) * 10) : 0;
    const counting = new Transform({
      transform(chunk: Buffer, _, done) {
        hash.update(chunk);
        received += chunk.length;
        options.onProgress?.(received, total);
        if (reported && Math.floor((received / total) * 10) > tenths && received < total) {
          tenths = Math.floor((received / total) * 10);
          log(`${file.path} ${tenths * 10}% of ${megabytes(total)}`);
        }
        done(null, chunk);
      },
    });
    await pipeline(response, counting, createWriteStream(part, { flags: have > 0 ? 'a' : 'w' }));
    if (total !== undefined && received !== total) throw new Error(`${file.path}: ${received} of ${total} bytes arrived`);
    const digest = hash.digest('hex');
    if (file.sha256 && digest !== file.sha256) {
      await rm(part, { force: true });
      throw new DownloadMismatch(`${file.path} is not the file pinned for it (SHA-256 ${digest}); deleted`);
    }
    await rename(part, target);
    return received - have;
  } catch (error) {
    // The watch's own reason, rather than the reset the stream reports for it.
    if (idle.stalled && !options.signal?.aborted) throw new Error(`no data for ${idle.ms / 1000} s`);
    throw error;
  }
}
