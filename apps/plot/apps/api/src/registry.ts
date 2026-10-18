import { modelRegistry } from '@shizue/db';
import { bundledCatalog, fetchRegistry, OFFICIAL_REGISTRY_URL, validateCatalog, type RegistryCatalog } from '@shizue/llm';
import { eq } from 'drizzle-orm';
import type { AppDeps } from './deps.js';

/**
 * The model registry this app reads (ARCHITECTURE §7.1): the catalog the last
 * refresh took from the registry's address, kept in `model_registry`, else the
 * one the build carries. A refresh is PocketRisu's sync: the official
 * PocketRisu/pocketrisu-model-registry on GitHub unless `MODEL_REGISTRY_URL`
 * names another https address (or `off`); the tests reach none unless they set
 * one. What it fetches is checked whole (`validateCatalog`) before it is kept.
 */

const ROW = 'official';
/** PocketRisu's `REFETCH_GUARD_MS`: a refresh that is not forced waits this long after the last. */
const REFETCH_GUARD_MS = 5_000;

const testing = (env: NodeJS.ProcessEnv): boolean => (env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test';

/** Where a refresh goes, or null when refreshing is off. */
export function registrySource(env: NodeJS.ProcessEnv): string | null {
  const named = env['MODEL_REGISTRY_URL']?.trim();
  if (named === 'off') return null;
  if (!named) return testing(env) ? null : OFFICIAL_REGISTRY_URL;
  let url: URL;
  try {
    url = new URL(named);
  } catch {
    return null;
  }
  // A test's stand-in answers over plain http on this computer; anywhere else it is https.
  if (url.protocol !== 'https:' && !(testing(env) && url.protocol === 'http:')) return null;
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

let cached: { hash: string; catalog: RegistryCatalog } | undefined;
let lastAttempt = 0;

export interface RegistryState {
  catalog: RegistryCatalog;
  /** `remote` once a refresh kept a catalog, `bundled` until then. */
  origin: 'bundled' | 'remote';
  source: string | null;
  hash: string | null;
  fetchedAt: Date | null;
}

/** The catalog the app reads now, and where it came from. */
export async function registryState(deps: Pick<AppDeps, 'db' | 'env'>): Promise<RegistryState> {
  const [row] = await deps.db.select().from(modelRegistry).where(eq(modelRegistry.id, ROW)).limit(1);
  if (row) {
    if (cached?.hash !== row.contentHash) {
      try {
        cached = { hash: row.contentHash, catalog: validateCatalog(row.catalog).catalog };
      } catch (error) {
        console.warn(`[registry] the kept catalog cannot be read; using the bundled one: ${error instanceof Error ? error.message : 'invalid'}`);
        cached = undefined;
      }
    }
    if (cached) return { catalog: cached.catalog, origin: 'remote', source: row.source, hash: row.contentHash, fetchedAt: row.fetchedAt };
  }
  return { catalog: bundledCatalog(), origin: 'bundled', source: registrySource(deps.env), hash: null, fetchedAt: null };
}

/** The catalog the app reads now. */
export const registryCatalog = async (deps: Pick<AppDeps, 'db' | 'env'>): Promise<RegistryCatalog> => (await registryState(deps)).catalog;

export interface RefreshResult {
  ok: boolean;
  /** A new catalog was kept. */
  changed: boolean;
  /** The catalog was downloaded (the index named another hash, or the refresh was forced). */
  downloaded: boolean;
  /** What went wrong, for the page and the log; the catalog in hand stays. */
  error?: string;
}

/**
 * PocketRisu's `syncRemoteRegistry`: asks the registry's index for its content
 * hash and fetches the catalog only when it differs from the kept one's — or,
 * forced, whatever it is. Without `force`, a refresh within five seconds of the
 * last does nothing. Never throws.
 */
export async function refreshRegistry(deps: Pick<AppDeps, 'db' | 'env' | 'registryFetch'>, force = false): Promise<RefreshResult> {
  const source = registrySource(deps.env);
  if (!source) return { ok: false, changed: false, downloaded: false, error: 'registry refresh is off' };
  if (!force && Date.now() - lastAttempt < REFETCH_GUARD_MS) return { ok: true, changed: false, downloaded: false };
  lastAttempt = Date.now();
  try {
    const [row] = await deps.db.select({ source: modelRegistry.source, hash: modelRegistry.contentHash }).from(modelRegistry).where(eq(modelRegistry.id, ROW)).limit(1);
    const known = !force && row?.source === source ? row.hash : undefined;
    const fetched = await fetchRegistry(source, known, deps.registryFetch ?? fetch);
    if (fetched.status === 'unchanged') return { ok: true, changed: false, downloaded: false };
    if (fetched.dropped.length > 0) console.warn(`[registry] left out ${fetched.dropped.length} entries it cannot read: ${fetched.dropped.slice(0, 10).join(', ')}`);
    const values = { source, contentHash: fetched.hash, catalog: fetched.catalog, fetchedAt: new Date() };
    await deps.db.insert(modelRegistry).values({ id: ROW, ...values }).onConflictDoUpdate({ target: modelRegistry.id, set: values });
    return { ok: true, changed: row?.hash !== fetched.hash, downloaded: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'refresh failed';
    console.warn(`[registry] refresh from ${source} failed: ${message}`);
    return { ok: false, changed: false, downloaded: false, error: message };
  }
}
