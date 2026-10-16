/**
 * An in-memory stand-in for the API's file imports (`/api/file-imports`,
 * apps/api/src/fileImports.ts) and for the store its part addresses point at:
 * a start answers the part size — or 429 `import_busy` while another import
 * has not ended, as the server counts one a reader — `…/parts` the addresses
 * and what is stored,
 * a part's PUT is kept only at its exact size, `…/complete` refuses while a
 * part is missing and hands the joined file to `job`, and the polls answer
 * what the job made — after `processingPolls` polls that say it is still
 * storing pictures. `fetch` serves the JSON routes and `put` the parts, the two
 * halves of `FileImportTransport`.
 */
import { vi } from 'vitest';

type Status = 'uploading' | 'queued' | 'processing' | 'done' | 'failed' | 'abandoned';

export interface FakeImport {
  id: string;
  /** The request that started it: target, fileName, size and what rode beside the file. */
  body: Record<string, unknown>;
  partSize: number;
  parts: number;
  stored: Map<number, Uint8Array>;
  status: Status;
  error?: { status: number; code: string; message: string };
  result?: unknown;
  /** What the job made of it, given out once the polls still processing are spent. */
  outcome?: JobOutcome;
  pending: number;
}

/** What the server's job made of an upload: the old route's answer, or the failure it gave. */
export type JobOutcome = { result: unknown } | { error: { status: number; code: string; message?: string } };

export interface FakeFileImportOptions {
  /** Small, so a test's few bytes come in several parts. */
  partSize?: number;
  /** Where parts go: this API's own route (the local driver), or a signed address on the store. */
  addresses?: 'api' | 'store';
  /** The import job, given the joined file and the request that started it. */
  job: (upload: { id: string; body: Record<string, unknown>; bytes: Uint8Array; text: string }) => JobOutcome | Promise<JobOutcome>;
  /** Polls that answer `processing` before the job's answer. */
  processingPolls?: number;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refusal = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  json(status, { error: code, code, ...extra });

export function fakeFileImports({ partSize = 4, addresses = 'api', job, processingPolls = 0 }: FakeFileImportOptions) {
  const imports = new Map<string, FakeImport>();
  /** Every part PUT that reached the store, in order. */
  const puts: { id: string; part: number; url: string; size: number }[] = [];
  /** How many times each import's addresses were asked for, which names the address (`?v=`). */
  const asks = new Map<string, number>();
  let next = 0;

  const sizeOfPart = (row: FakeImport, part: number): number =>
    part < row.parts ? row.partSize : (row.body['size'] as number) - (row.parts - 1) * row.partSize;
  const stored = (row: FakeImport): number[] =>
    [...row.stored.entries()].filter(([part, bytes]) => bytes.length === sizeOfPart(row, part)).map(([part]) => part);

  async function run(row: FakeImport): Promise<void> {
    const bytes = new Uint8Array((row.body['size'] as number) || 0);
    for (const [part, chunk] of row.stored) bytes.set(chunk, (part - 1) * row.partSize);
    row.status = 'queued';
    row.pending = processingPolls;
    row.outcome = await job({ id: row.id, body: row.body, bytes, text: new TextDecoder().decode(bytes) });
  }

  function view(row: FakeImport): Record<string, unknown> {
    return {
      id: row.id,
      target: row.body['target'],
      status: row.status,
      fileName: row.body['fileName'],
      size: row.body['size'],
      partSize: row.partSize,
      parts: row.parts,
      ...(row.status === 'failed' && row.error ? { error: row.error } : {}),
      ...(row.status === 'done' ? { result: row.result } : {}),
    };
  }

  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    init.signal?.throwIfAborted();
    const method = init.method ?? 'GET';
    const path = String(input);
    const body = (): Record<string, unknown> => JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;

    if (method === 'POST' && path === '/api/file-imports') {
      const started = body();
      const size = started['size'] as number;
      if (size === 0) return refusal(400, 'invalid_card');
      const unfinished: Status[] = ['uploading', 'queued', 'processing'];
      if ([...imports.values()].some((each) => unfinished.includes(each.status))) return refusal(429, 'import_busy');
      const id = `import-${(next += 1)}`;
      const row: FakeImport = {
        id,
        body: started,
        partSize,
        parts: Math.max(1, Math.ceil(size / partSize)),
        stored: new Map(),
        status: 'uploading',
        pending: 0,
      };
      imports.set(id, row);
      return json(201, { id, status: 'uploading', partSize, parts: row.parts });
    }
    const match = /^\/api\/file-imports\/([^/]+)(?:\/(parts|complete|confirm))?$/.exec(path);
    const row = match ? imports.get(match[1]!) : undefined;
    if (!match || !row) return refusal(404, 'not_found');
    const action = `${method} ${match[2] ?? ''}`;

    if (action === 'POST parts') {
      if (row.status !== 'uploading') return refusal(409, 'import_state');
      const asked = (asks.get(row.id) ?? 0) + 1;
      asks.set(row.id, asked);
      const urls: Record<string, string> = {};
      for (const part of body()['numbers'] as number[]) {
        urls[part] =
          addresses === 'api'
            ? `/api/file-imports/${row.id}/parts/${part}`
            : `https://store.test/${row.id}/${part}?v=${asked}`;
      }
      return json(200, { urls, uploaded: stored(row) });
    }
    if (action === 'POST complete') {
      if (row.status === 'queued' || row.status === 'processing' || row.status === 'done') {
        return json(202, { id: row.id, status: row.status });
      }
      if (row.status !== 'uploading') return refusal(409, 'import_state');
      const missing = row.parts - stored(row).length;
      if (missing > 0) return refusal(409, 'upload_incomplete', { params: { missing } });
      await run(row);
      return json(202, { id: row.id, status: 'queued' });
    }
    if (action === 'GET ') {
      if (row.outcome && row.pending > 0) {
        row.pending -= 1;
        row.status = 'processing';
        return json(200, { ...view(row), stage: 'assets', progress: { done: 1, total: 2 } });
      }
      if (row.outcome) {
        const outcome = row.outcome;
        delete row.outcome;
        if ('result' in outcome) {
          row.status = 'done';
          row.result = outcome.result;
          row.stored.clear();
        } else {
          row.status = 'failed';
          row.error = { message: outcome.error.code, ...outcome.error };
          // A module waiting on the reader's yes keeps its file for it.
          if (outcome.error.code !== 'low_level_access_unconfirmed') row.stored.clear();
        }
      }
      return json(200, view(row));
    }
    if (action === 'POST confirm') {
      if (body()['confirmLowLevelAccess'] !== true) return refusal(400, 'invalid_request');
      if (row.status !== 'failed' || row.error?.code !== 'low_level_access_unconfirmed' || row.stored.size === 0) {
        return refusal(409, 'import_state');
      }
      row.body = { ...row.body, confirmLowLevelAccess: true };
      delete row.error;
      await run(row);
      return json(202, { id: row.id, status: 'queued' });
    }
    if (action === 'DELETE ') {
      if (row.outcome || row.status === 'queued' || row.status === 'processing') return refusal(409, 'import_state');
      if (row.status === 'uploading') row.status = 'abandoned';
      row.stored.clear();
      return new Response(null, { status: 204 });
    }
    return refusal(404, 'not_found');
  });

  /** A part's PUT, to either kind of address: kept only at its exact size, as S3 and the local driver keep it. */
  const put = vi.fn(
    async (url: string, blob: Blob, { onProgress, signal }: { onProgress: (loaded: number) => void; signal?: AbortSignal }) => {
      signal?.throwIfAborted();
      const match =
        /^\/api\/file-imports\/([^/]+)\/parts\/(\d+)$/.exec(url) ?? /^https:\/\/store\.test\/([^/]+)\/(\d+)\?v=\d+$/.exec(url);
      const row = match ? imports.get(match[1]!) : undefined;
      if (!match || !row) return 404;
      if (row.status !== 'uploading') return addresses === 'api' ? 409 : 404;
      const part = Number(match[2]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length !== sizeOfPart(row, part)) return 400;
      onProgress(Math.floor(bytes.length / 2));
      row.stored.set(part, bytes);
      puts.push({ id: row.id, part, url, size: bytes.length });
      onProgress(bytes.length);
      return addresses === 'api' ? 204 : 200;
    },
  );

  return { fetch, put, imports, puts };
}

export type FakeFileImports = ReturnType<typeof fakeFileImports>;
