/**
 * A card or module file into the API, the one way every import screen sends it
 * (ARCHITECTURE §10 파일 임포트): `POST /api/file-imports` starts the import with
 * what rides beside the file, the file goes up in parts — straight to the store
 * on an address the API signs, or to the API itself under the local driver —
 * `…/complete` queues it, and a job on the server reads it while this polls
 * `GET …/:id` for where it is and, at the end, the answer the old single-request
 * route gave. Nothing of the file passes through the web's `/api` rewrite but
 * the local driver's parts.
 *
 * The parts go four at a time through XMLHttpRequest, which reports bytes sent
 * as they go (fetch reports none); one that fails is sent again a few times, an
 * address whose hour is up (S3's 403) is asked for again, and a part the store
 * did not keep (`upload_incomplete`) is found from what the API says it has and
 * sent again. An upload given up — failed for good, aborted, or its tab closed
 * — is deleted on the server, best-effort.
 *
 * A failed import throws an `ApiError` with the code the old route answered
 * (`FileImportError`, which also names the import), so the `errors` catalogue
 * translates it as before. A module that asks for low-level access fails with
 * `low_level_access_unconfirmed` and keeps its file on the server: the reader's
 * yes goes to `confirmImport` on the same import, with no second upload.
 *
 * Every request goes through the injected transport (`fetch`, the part `put`
 * and the waits), so the whole exchange runs in a test without a server.
 */
import { ApiError, toApiError } from './api';

export type FileImportTarget = 'plot' | 'member' | 'plot_module' | 'reader_module';

/** What rides beside the file in the request that starts the import. */
export interface FileImportFields {
  /** member, plot_module: the work it goes into. */
  plotId?: string;
  /** plot, member: the RisuRealm page the card came from. */
  sourceUrl?: string;
  /** member, plot_module: the owner's word for a work that is public. */
  rightsConfirmed?: boolean;
  /** reader_module: the reader's yes to a module's low-level access, given up front. */
  confirmLowLevelAccess?: boolean;
  /** plot, member: a SillyTavern World Info file as text, read before the card is uploaded. */
  worldInfo?: string;
}

/** Where a running import is: reading the file, storing its pictures, fetching what it loads from other hosts. */
export type ImportStage = 'reading' | 'assets' | 'localizing';

/**
 * What the screen says while an import runs: the bytes sent, then what the
 * server is doing — `reading` counts bytes of the file, `assets` the pictures
 * and sounds stored, `localizing` nothing.
 */
export type ImportProgress =
  | { phase: 'uploading'; loaded: number; total: number }
  | { phase: 'processing'; status: 'queued' | 'processing'; stage?: ImportStage; done?: number; total?: number };

/**
 * One part's PUT: resolves with the HTTP status, reporting bytes sent as they
 * go; rejects when the connection fails or the signal aborts it.
 */
export type PartPut = (
  url: string,
  body: Blob,
  options: { onProgress: (loaded: number) => void; signal?: AbortSignal },
) => Promise<number>;

export interface FileImportTransport {
  /** The JSON requests to the API; called unbound. */
  fetch: typeof fetch;
  put: PartPut;
  /** The waits between polls and between a part's tries; rejects when the signal aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface FileImportOptions {
  onProgress?: (progress: ImportProgress) => void;
  signal?: AbortSignal;
  /** Stands in for the browser's own, in part or whole. */
  transport?: Partial<FileImportTransport>;
}

/** An import that ended failed on the server, with the reason it gave and the import it was. */
export class FileImportError extends ApiError {
  constructor(
    readonly importId: string,
    status: number,
    code: string,
    message: string,
  ) {
    super(status, code, message);
    this.name = 'FileImportError';
  }
}

/** Parts in flight at once. */
const PARALLEL_PARTS = 4;
/** Tries after a part's first, waiting twice as long each time from `RETRY_MS`. */
const PART_RETRIES = 3;
const RETRY_MS = 500;
/** Part addresses one `…/parts` asks for; mirrors the API. */
const MAX_PARTS_PER_ASK = 32;
/** Completes tried in all, each after sending what the API says is missing. */
const COMPLETE_ATTEMPTS = 3;
const POLL_MS = 1000;
/** Polls in a row that may fail before the page stops asking; the import goes on regardless. */
const POLL_RETRIES = 3;

/** XMLHttpRequest, for the upload progress fetch does not report. No headers: the store's CORS allows the PUT alone. */
export const xhrPut: PartPut = (url, body, { onProgress, signal }) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = (): void => xhr.abort();
    const finish = (then: () => void) => () => {
      signal?.removeEventListener('abort', abort);
      then();
    };
    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = finish(() => resolve(xhr.status));
    xhr.onerror = finish(() => reject(new TypeError(`The upload to ${url} failed`)));
    xhr.onabort = finish(() => reject(signal?.reason ?? new DOMException('The upload was aborted', 'AbortError')));
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(body);
  });

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });

/** The page's own: the window's fetch (called unbound, as it must be), XHR and timers. */
export const BROWSER_TRANSPORT: FileImportTransport = {
  fetch: (input, init) => fetch(input, init),
  put: xhrPut,
  sleep,
};

interface Context {
  transport: FileImportTransport;
  signal: AbortSignal | undefined;
  onProgress: ((progress: ImportProgress) => void) | undefined;
}

const contextOf = ({ onProgress, signal, transport }: FileImportOptions): Context => ({
  transport: { ...BROWSER_TRANSPORT, ...transport },
  signal,
  onProgress,
});

async function call<T>(ctx: Context, method: string, path: string, body?: unknown): Promise<T> {
  const res = await ctx.transport.fetch(path, {
    method,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const uploadFailed = (status: number, message: string): ApiError => new ApiError(status, 'upload_failed', message);

/** A part's status worth another try: a dropped connection, an expired address, a busy or failing server. */
const retriable = (status: number): boolean =>
  status === 0 || status === 403 || status === 408 || status === 429 || status >= 500;

interface Upload {
  id: string;
  file: File;
  partSize: number;
  parts: number;
  /** Bytes of each part the store has taken, or that are on their way. */
  sent: Map<number, number>;
  /** The whole percent last said, which is said again only once it moves. */
  shown: number;
}

const sizeOfPart = (up: Upload, part: number): number =>
  part < up.parts ? up.partSize : up.file.size - (up.parts - 1) * up.partSize;

/**
 * Notes a part's bytes sent and says the total — only when its whole percent
 * moves, so the thousands of progress events of a large file do not redraw the
 * page that shows them thousands of times.
 */
function reportSent(ctx: Context, up: Upload, part: number, bytes: number): void {
  up.sent.set(part, bytes);
  let loaded = 0;
  for (const value of up.sent.values()) loaded += value;
  loaded = Math.min(loaded, up.file.size);
  const percent = up.file.size > 0 ? Math.floor((loaded / up.file.size) * 100) : 100;
  if (percent === up.shown) return;
  up.shown = percent;
  ctx.onProgress?.({ phase: 'uploading', loaded, total: up.file.size });
}

interface PartAddresses {
  urls: Record<string, string>;
  uploaded: number[];
}

const askParts = (ctx: Context, id: string, numbers: number[]): Promise<PartAddresses> =>
  call<PartAddresses>(ctx, 'POST', `/api/file-imports/${id}/parts`, { numbers });

/** One part to the address it was given, tried again on a failure worth it and given a new address once its hour is up. */
async function sendPart(ctx: Context, up: Upload, part: number, address: string): Promise<void> {
  const size = sizeOfPart(up, part);
  // No type: a Blob sliced without one is sent with no Content-Type, which the store's CORS would refuse.
  const body = up.file.slice((part - 1) * up.partSize, (part - 1) * up.partSize + size);
  let url = address;
  for (let attempt = 0; ; attempt += 1) {
    let status = 0;
    try {
      status = await ctx.transport.put(url, body, {
        onProgress: (loaded) => reportSent(ctx, up, part, Math.min(loaded, size)),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (caught) {
      if (ctx.signal?.aborted) throw caught;
      // The connection dropped: tried again like a failing server.
    }
    if (status >= 200 && status < 300) {
      reportSent(ctx, up, part, size);
      return;
    }
    reportSent(ctx, up, part, 0);
    if (!retriable(status) || attempt >= PART_RETRIES) {
      throw uploadFailed(status, `Part ${part} of ${up.file.name} could not be uploaded (${status || 'no connection'})`);
    }
    await ctx.transport.sleep(RETRY_MS * 2 ** attempt, ctx.signal);
    if (status === 403) {
      const again = await askParts(ctx, up.id, [part]);
      if (again.uploaded.includes(part)) {
        reportSent(ctx, up, part, size);
        return;
      }
      url = again.urls[part] ?? url;
    }
  }
}

/** Runs `work` over `items`, `limit` at a time; the first failure stops the rest (through `stop`) and is thrown. */
async function inParallel<T>(items: T[], limit: number, stop: AbortController, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (caught) {
        if (!failed) {
          failed = true;
          failure = caught;
          stop.abort(caught);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
}

/** The parts the API does not have yet among `numbers`, sent; what it already has counts as sent. */
async function sendParts(ctx: Context, up: Upload, numbers: number[], stop: AbortController): Promise<void> {
  for (let at = 0; at < numbers.length; at += MAX_PARTS_PER_ASK) {
    const { urls, uploaded } = await askParts(ctx, up.id, numbers.slice(at, at + MAX_PARTS_PER_ASK));
    const have = new Set(uploaded);
    const todo: number[] = [];
    for (const part of numbers.slice(at, at + MAX_PARTS_PER_ASK)) {
      if (have.has(part)) reportSent(ctx, up, part, sizeOfPart(up, part));
      else todo.push(part);
    }
    await inParallel(todo, PARALLEL_PARTS, stop, (part) => {
      const url = urls[part];
      if (!url) throw uploadFailed(0, `No address for part ${part}`);
      return sendPart(ctx, up, part, url);
    });
  }
}

/** Every part sent and the upload completed; a part the store did not keep is sent again, a bounded number of times. */
async function upload(ctx: Context, up: Upload): Promise<void> {
  // The parts' own signal, so one failing for good stops the others in flight.
  const stop = new AbortController();
  const outer = ctx.signal;
  const forward = (): void => stop.abort(outer?.reason);
  if (outer?.aborted) forward();
  outer?.addEventListener('abort', forward, { once: true });
  const parts: Context = { ...ctx, signal: stop.signal };
  try {
    reportSent(parts, up, 1, 0);
    const all = Array.from({ length: up.parts }, (_, index) => index + 1);
    for (let attempt = 1; ; attempt += 1) {
      await sendParts(parts, up, all, stop);
      try {
        await call(parts, 'POST', `/api/file-imports/${up.id}/complete`, {});
        return;
      } catch (caught) {
        if (!(caught instanceof ApiError && caught.code === 'upload_incomplete')) throw caught;
        if (attempt >= COMPLETE_ATTEMPTS) throw uploadFailed(0, `${up.file.name} did not arrive whole: ${caught.message}`);
      }
    }
  } finally {
    outer?.removeEventListener('abort', forward);
  }
}

interface ImportState {
  status: 'uploading' | 'queued' | 'processing' | 'done' | 'failed' | 'abandoned';
  stage?: ImportStage;
  progress?: { done: number; total: number };
  error?: { status: number; code: string; message: string };
  result?: unknown;
}

/** Polls an import until it ends: its answer once done, a `FileImportError` once failed. */
async function settle<T>(ctx: Context, id: string): Promise<T> {
  ctx.onProgress?.({ phase: 'processing', status: 'queued' });
  let misses = 0;
  for (let first = true; ; first = false) {
    if (!first) await ctx.transport.sleep(POLL_MS, ctx.signal);
    let state: ImportState;
    try {
      state = await call<ImportState>(ctx, 'GET', `/api/file-imports/${id}`);
      misses = 0;
    } catch (caught) {
      // A poll that did not get through is not a failed import, which goes on on the server.
      const lost = !(caught instanceof ApiError) || caught.status >= 500;
      if (ctx.signal?.aborted || !lost) throw caught;
      misses += 1;
      if (misses > POLL_RETRIES) throw caught;
      continue;
    }
    if (state.status === 'done') {
      if (state.result == null) throw new ApiError(404, 'not_found', 'What the import made is gone');
      return state.result as T;
    }
    if (state.status === 'failed') {
      const error = state.error ?? { status: 500, code: 'internal_error', message: 'The import failed' };
      throw new FileImportError(id, error.status, error.code, error.message);
    }
    if (state.status === 'abandoned') throw new ApiError(409, 'import_state', 'The import was given up');
    ctx.onProgress?.({
      phase: 'processing',
      status: state.status === 'processing' ? 'processing' : 'queued',
      ...(state.stage ? { stage: state.stage } : {}),
      ...(state.progress ? { done: state.progress.done, total: state.progress.total } : {}),
    });
  }
}

/**
 * Imports `file` as `target` and answers what the import made — the body the
 * old route answered with 201. Throws `ApiError`: the start's refusal, an
 * upload that failed for good (`upload_failed`), or the import's failure
 * (`FileImportError`).
 */
export async function importFile<T>(
  target: FileImportTarget,
  file: File,
  fields: FileImportFields = {},
  options: FileImportOptions = {},
): Promise<T> {
  const ctx = contextOf(options);
  const started = await call<{ id: string; partSize: number; parts: number }>(ctx, 'POST', '/api/file-imports', {
    target,
    fileName: file.name,
    size: file.size,
    ...fields,
  });
  try {
    const { id, partSize, parts } = started;
    // A tab closed while the parts go up gives the import up on its way out, so
    // the reader's next one is not refused as busy until the server's sweep
    // finds this one idle. Once the file is up the import goes on without the page.
    const leave = (): void => {
      void Promise.resolve(ctx.transport.fetch(`/api/file-imports/${id}`, { method: 'DELETE', keepalive: true })).catch(
        () => undefined,
      );
    };
    const page = typeof window === 'undefined' ? undefined : window;
    page?.addEventListener('pagehide', leave);
    try {
      await upload(ctx, { id, file, partSize, parts, sent: new Map(), shown: -1 });
    } finally {
      page?.removeEventListener('pagehide', leave);
    }
    return await settle<T>(ctx, started.id);
  } catch (caught) {
    // An import that failed has ended on the server already — and one waiting on the reader's yes keeps its file for it.
    if (!(caught instanceof FileImportError)) await abandonImport(started.id, options.transport);
    throw caught;
  }
}

/**
 * The reader's yes to a module's low-level access, on the import that failed
 * for want of it (`FileImportError.importId`): queued again with the file it
 * already has, and polled to its answer.
 */
export async function confirmImport<T>(id: string, options: FileImportOptions = {}): Promise<T> {
  const ctx = contextOf(options);
  await call(ctx, 'POST', `/api/file-imports/${id}/confirm`, { confirmLowLevelAccess: true });
  return settle<T>(ctx, id);
}

/** Gives an import up — an upload in flight, or a failed one's kept file. Best-effort: one being read is let finish. */
export async function abandonImport(id: string, transport?: Partial<FileImportTransport>): Promise<void> {
  try {
    await call(contextOf({ ...(transport ? { transport } : {}) }), 'DELETE', `/api/file-imports/${id}`);
  } catch {
    // Left to the server's sweep.
  }
}
