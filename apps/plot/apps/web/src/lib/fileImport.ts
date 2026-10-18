/**
 * A card or module file into the API, the one way every import screen sends it
 * (ARCHITECTURE §10 파일 임포트): `POST /api/file-imports` starts the import with
 * what rides beside the file, the file goes up in parts — straight to the store
 * on an address the API signs, or to the API itself under the local driver —
 * `…/complete` queues it, and a job on the server reads it while this polls
 * `GET …/:id` for where it is and, at the end, the answer the old single-request
 * route gave.
 *
 * The parts go four at a time through XMLHttpRequest, which reports bytes sent
 * as they go (fetch reports none); one that fails is sent again a few times, an
 * address whose hour is up (S3's 403) is asked for again, and a part the store
 * did not keep (`upload_incomplete`) is found from what the API says it has and
 * sent again. An upload given up — failed for good, or aborted — is deleted on
 * the server, best-effort.
 *
 * A page that goes away before its import ends — reloaded, its tab closed —
 * leaves the import on the server, and this browser remembers it
 * (`localStorage`): the reader who picks the same file again for the same place
 * goes on from the parts the store already has, or, once the file is up, is
 * shown where the server is with it and what it came to, with nothing sent
 * again; one who picks another file gives the remembered upload up first.
 * Another tab of this browser importing right now holds the import lock, and
 * its import is left alone.
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
  /**
   * Runs an import holding this browser's import lock, told whether it got it —
   * not when another tab is uploading under it. The lock goes with the page.
   */
  lock: <T>(work: (held: boolean) => Promise<T>) => Promise<T>;
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

/** The Web Locks name an import runs under, and the `localStorage` key of the upload this browser remembers. */
const IMPORT_KEY = 'shizue.fileImport';

/** The page's own: the window's fetch (called unbound, as it must be), XHR, timers and Web Locks. */
export const BROWSER_TRANSPORT: FileImportTransport = {
  fetch: (input, init) => fetch(input, init),
  put: xhrPut,
  sleep,
  // A browser without Web Locks (an http origin) runs every import as the only one.
  lock: async (work) =>
    typeof navigator === 'undefined' || !navigator.locks
      ? work(true)
      : await navigator.locks.request(IMPORT_KEY, { ifAvailable: true }, (held) => work(held !== null)),
};

/** The import this browser started and has not seen end, and the file and place it was for. */
interface Remembered {
  id: string;
  target: FileImportTarget;
  plotId: string | null;
  name: string;
  size: number;
  lastModified: number;
}

function recall(): Remembered | undefined {
  try {
    const stored = typeof window === 'undefined' ? null : window.localStorage.getItem(IMPORT_KEY);
    return stored ? (JSON.parse(stored) as Remembered) : undefined;
  } catch {
    return undefined;
  }
}

function remember(remembered: Remembered): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(IMPORT_KEY, JSON.stringify(remembered));
  } catch {
    // Storage refused: this upload is not resumed after a reload, and the server's sweep has it.
  }
}

/** Forgets the remembered upload, if it is `id`. */
function forget(id: string): void {
  try {
    if (recall()?.id === id) window.localStorage.removeItem(IMPORT_KEY);
  } catch {
    // Storage refused: what it holds is checked against the server before use.
  }
}

/** The file and place an import is for, which a remembered upload must match to be resumed. */
type Picked = Omit<Remembered, 'id'>;

const pickedOf = (target: FileImportTarget, file: File, fields: FileImportFields): Picked => ({
  target,
  plotId: fields.plotId ?? null,
  name: file.name,
  size: file.size,
  lastModified: file.lastModified,
});

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
 * Says the bytes sent — only when their whole percent moves, so the thousands
 * of progress events of a large file do not redraw the page that shows them
 * thousands of times.
 */
function showSent(ctx: Context, up: Upload): void {
  let loaded = 0;
  for (const value of up.sent.values()) loaded += value;
  loaded = Math.min(loaded, up.file.size);
  const percent = up.file.size > 0 ? Math.floor((loaded / up.file.size) * 100) : 100;
  if (percent === up.shown) return;
  up.shown = percent;
  ctx.onProgress?.({ phase: 'uploading', loaded, total: up.file.size });
}

/** Notes a part's bytes sent and says the total. */
function reportSent(ctx: Context, up: Upload, part: number, bytes: number): void {
  up.sent.set(part, bytes);
  showSent(ctx, up);
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
    // Every part the store has, not only these: an upload resumed after a reload starts from all of it.
    for (const part of uploaded) up.sent.set(part, sizeOfPart(up, part));
    showSent(ctx, up);
    const have = new Set(uploaded);
    const todo = numbers.slice(at, at + MAX_PARTS_PER_ASK).filter((part) => !have.has(part));
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
    // Seen to its end: the next pick of the file is a new import.
    if (state.status === 'done' || state.status === 'failed' || state.status === 'abandoned') forget(id);
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

interface Started {
  id: string;
  partSize: number;
  parts: number;
}

/**
 * The import this browser remembers, if it is of `file` for the same place
 * and there is still something to show for it — a page that went away before
 * its import ended. One of another file is given up.
 */
async function remembered(ctx: Context, picked: Picked): Promise<(ImportState & Started) | undefined> {
  const kept = recall();
  if (!kept) return undefined;
  if (!(Object.keys(picked) as (keyof Picked)[]).every((key) => kept[key] === picked[key])) {
    await abandonImport(kept.id, ctx.transport);
    return undefined;
  }
  let state: ImportState & Started;
  try {
    state = await call(ctx, 'GET', `/api/file-imports/${kept.id}`);
  } catch (caught) {
    if (!(caught instanceof ApiError && caught.status === 404)) throw caught;
    forget(kept.id);
    return undefined;
  }
  // Given up since, or what it made is gone: imported again.
  if (state.status === 'abandoned' || (state.status === 'done' && state.result == null)) {
    forget(kept.id);
    return undefined;
  }
  return state;
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
  return ctx.transport.lock(async (alone) => {
    // Another tab importing holds the lock: its import is not this page's to take up or give up.
    const picked = pickedOf(target, file, fields);
    const kept = alone ? await remembered(ctx, picked) : undefined;
    // Its file is up: the server is reading it, or has.
    if (kept && kept.status !== 'uploading') return settle<T>(ctx, kept.id);
    const started =
      kept ?? (await call<Started>(ctx, 'POST', '/api/file-imports', { target, fileName: file.name, size: file.size, ...fields }));
    if (alone && !kept) remember({ id: started.id, ...picked });
    try {
      await upload(ctx, { id: started.id, file, partSize: started.partSize, parts: started.parts, sent: new Map(), shown: -1 });
    } catch (caught) {
      await abandonImport(started.id, options.transport);
      throw caught;
    }
    return settle<T>(ctx, started.id);
  });
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

/**
 * Gives an import up — an upload in flight, or a failed one's kept file.
 * Best-effort: one being read is let finish. Forgotten once the server has
 * given it up; one it could not be told of is given up again by the next
 * import, and one being read is waited on by the next pick of its file.
 */
export async function abandonImport(id: string, transport?: Partial<FileImportTransport>): Promise<void> {
  try {
    await call(contextOf({ ...(transport ? { transport } : {}) }), 'DELETE', `/api/file-imports/${id}`);
  } catch (caught) {
    // Otherwise left to the server's sweep.
    if (!(caught instanceof ApiError) || caught.status === 409) return;
  }
  forget(id);
}
