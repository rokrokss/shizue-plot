import type { RegistryCatalog } from './types.js';
import { validateCatalog } from './validate.js';

/** How long one file of the registry may take, and the most a catalog may weigh. */
const FETCH_TIMEOUT_MS = 30_000;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024;

export type RegistryFetch =
  | { status: 'unchanged'; hash: string }
  | { status: 'updated'; hash: string; catalog: RegistryCatalog; dropped: string[] };

/**
 * PocketRisu's `syncRemoteRegistry` (`src/ts/preset/registry/remote.ts`):
 * `index.json` under the registry's address names the catalog's content hash;
 * the same hash as the catalog in hand is nothing to fetch. Otherwise
 * `catalog.json?h=<hash>` is fetched and must carry that hash (a CDN still
 * spreading the new files answers the old one). The catalog is untrusted:
 * `validateCatalog` checks every part of it, and a response past its size or
 * time is refused. Throws an `Error` that says what went wrong; the caller
 * keeps what it had.
 */
export async function fetchRegistry(baseUrl: string, knownHash: string | undefined, fetcher: typeof fetch = fetch): Promise<RegistryFetch> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const index = await fetchJson(fetcher, `${base}index.json`, MAX_INDEX_BYTES, 'index');
  if (typeof index !== 'object' || index === null || (index as { schemaVersion?: unknown }).schemaVersion !== 4) {
    throw new Error('the registry index is not schema v4');
  }
  const hash = (index as { hash?: unknown }).hash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('the registry index has no content hash');
  if (hash === knownHash) return { status: 'unchanged', hash };
  const raw = await fetchJson(fetcher, `${base}catalog.json?h=${encodeURIComponent(hash)}`, MAX_CATALOG_BYTES, 'catalog');
  let checked: ReturnType<typeof validateCatalog>;
  try {
    checked = validateCatalog(raw);
  } catch (error) {
    throw new Error(`the registry catalog is not one this app reads: ${error instanceof Error ? error.message : 'invalid'}`);
  }
  if (checked.catalog.hash !== hash) throw new Error('the registry index and catalog disagree; try again shortly');
  return { status: 'updated', hash, catalog: checked.catalog, dropped: checked.dropped };
}

async function fetchJson(fetcher: typeof fetch, url: string, maxBytes: number, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`the registry ${what} could not be fetched: ${error instanceof Error ? error.message : 'network error'}`);
  }
  if (!response.ok) throw new Error(`the registry ${what} answered HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new Error(`the registry ${what} is too large`);
  const text = await readCapped(response, maxBytes, what);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`the registry ${what} is not JSON`);
  }
}

/** A body's text, refused past `maxBytes` however the server framed it. */
async function readCapped(response: Response, maxBytes: number, what: string): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`the registry ${what} is too large`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
