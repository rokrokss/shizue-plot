/**
 * A backup of the whole app folder, and its restore (ARCHITECTURE §4 앱 폴더,
 * §10 백업·복원).
 *
 * A backup is one tar file, written as a stream while the app runs:
 *
 *   shizue-backup.json      what it is — the format, when, the migrations the
 *                           database had, every table's row count, the dump's
 *                           size and SHA-256
 *   db.tar.gz               the database: PGlite's own dump of its folder
 *                           (`dumpDataDir`), taken in a transaction, so no write
 *                           lands between the counts and the dump
 *   files/…                 every file of `files/`, but the parts of uploads in
 *                           flight (`.uploads/`) and files still being written
 *   shizue-backup-end.json  how many files, how many bytes, and a SHA-256 over
 *                           each file's path and bytes
 *
 * Left out: the install's `secret`, which seals the API keys and the ChatGPT
 * tokens (§7.1), so a backup in the wrong hands opens none of them — and so a
 * restore on another computer asks for them again; the embedding model's
 * weights (`models/`), which download again; `app.lock`.
 *
 * A restore never touches the folder the app runs on. It reads the file as it
 * arrives into a new folder beside it (`<folder>.restore-<time>`), refusing
 * anything that is not a whole backup this build can open — and then the new
 * folder is deleted, nothing else changed: the tar's headers, the manifest, the
 * dump's hash and its own tar (`PG_VERSION`, `base/`, `global/`) before PGlite
 * sees it, every file's path inside `files/`, the trailer's count and hash. The
 * database is opened there from the dump, its row counts checked against the
 * manifest's, and migrated as a start migrates it. The install's own `secret`
 * is copied in, so what the backup sealed on this computer still opens. The
 * folder is marked complete, and a note in the running folder names it
 * (`restore-pending.json`); the next start swaps the two (`swapInPendingRestore`)
 * and keeps the old folder beside the new one (`<folder>.before-restore-<time>`).
 */
import { knownMigrations, migrateDb, openDb, type OpenedDb } from '@shizue/db';
import { Hono } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  openAsBlob,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { chmod, copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { AppDeps, AppEnv } from './deps.js';
import { ApiError, badRequest, notFound } from './errors.js';
import { requireLocal } from './session.js';
import { END_OF_ARCHIVE, entryHeader, padding, readTar, TarError, type TarEntry } from './tar.js';
import { attachmentDisposition } from './util.js';

/** The app's folder, as a backup reads it and a restore writes beside it. */
export interface AppFolder {
  /** `SHIZUE_DATA_DIR`. */
  dataDir: string;
  /** Its `files/` — the store's root (`env.ts` `filesDirOf`). */
  filesDir: string;
  /** PGlite itself, for its dump. */
  client: OpenedDb['client'];
}

export const BACKUP_FORMAT = 'shizue-backup';
export const BACKUP_VERSION = 1;
const MANIFEST = 'shizue-backup.json';
const DB_DUMP = 'db.tar.gz';
const FILES = 'files/';
const TRAILER = 'shizue-backup-end.json';
/** The note in the running folder naming the restored folder the next start swaps in. */
const PENDING = 'restore-pending.json';
/** Written last into a restored folder: it is complete. */
const STAGED = 'restore.json';
/** Left in the folder a restore swapped in: when, and where the folder from before is. */
const RESTORED = 'restored.json';
/** The largest manifest or trailer a restore reads. */
const MAX_JSON_BYTES = 1024 * 1024;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  /** What `drizzle.__drizzle_migrations` held: the migrations the database had. */
  migrations: { hash: string; createdAt: number }[];
  /** Every table of the app's schema and its rows. */
  tables: Record<string, number>;
  db: { size: number; sha256: string };
  /** Never in a backup; said so the file says it. */
  secret: 'not_included';
}

interface BackupTrailer {
  files: number;
  bytes: number;
  sha256: string;
}

/** Folders a backup or a restore is running on; one at a time each. */
const running = new Set<string>();

function claim(key: string): () => void {
  if (running.has(key)) throw new ApiError(409, 'backup_busy', 'A backup or a restore is already running');
  running.add(key);
  return () => running.delete(key);
}

const quoteIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Every table of the app's schema and its rows, read on `query` — a transaction's, for a backup. */
async function tableCounts(query: (sql: string) => Promise<{ rows: unknown[] }>): Promise<Record<string, number>> {
  const tables = (await query(`select tablename from pg_tables where schemaname = 'public' order by tablename`))
    .rows as { tablename: string }[];
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) {
    const [row] = (await query(`select count(*)::int as n from ${quoteIdentifier(tablename)}`)).rows as { n: number }[];
    counts[tablename] = row?.n ?? 0;
  }
  return counts;
}

async function appliedMigrations(query: (sql: string) => Promise<{ rows: unknown[] }>): Promise<BackupManifest['migrations']> {
  const rows = (await query(`select hash, created_at from drizzle.__drizzle_migrations order by id`)).rows as {
    hash: string;
    created_at: string | number;
  }[];
  return rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
}

/** The files a backup takes, under `root`, by their path in `files/`: not uploads' parts, not files mid-write. */
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!prefix && entry.name === '.uploads') continue;
      out.push(...(await listFiles(root, path)));
    } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
      out.push(path);
    }
  }
  return out;
}

const jsonEntry = (path: string, value: unknown): Uint8Array[] => {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
  return [entryHeader(path, bytes.length), bytes, padding(bytes.length)];
};

/** The digest the trailer carries, fed each file's path and then its bytes. */
const fileDigest = () => createHash('sha256');

/**
 * The backup, as a stream of the tar's bytes. The database is dumped first, in
 * a transaction — PGlite runs one at a time, so every other query waits the few
 * seconds the dump takes, and the counts and the dump are the same moment.
 * The files are read after, each opened before its header is written: one
 * deleted meanwhile (its work deleted after the dump) is passed over.
 */
export async function* backupStream(folder: AppFolder): AsyncGenerator<Uint8Array> {
  const { client } = folder;
  // Flushes what the database keeps in memory into its files, so the dump starts clean.
  await client.exec('CHECKPOINT');
  let manifest!: BackupManifest;
  let dump!: Uint8Array;
  await client.transaction(async (tx) => {
    const query = (sql: string) => tx.query(sql);
    const tables = await tableCounts(query);
    const migrations = await appliedMigrations(query);
    dump = new Uint8Array(await (await client.dumpDataDir('gzip')).arrayBuffer());
    manifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      migrations,
      tables,
      db: { size: dump.length, sha256: createHash('sha256').update(dump).digest('hex') },
      secret: 'not_included',
    };
  });
  yield* jsonEntry(MANIFEST, manifest);
  yield entryHeader(DB_DUMP, dump.length);
  yield dump;
  yield padding(dump.length);
  dump = new Uint8Array(0);

  const digest = fileDigest();
  let files = 0;
  let bytes = 0;
  for (const path of await listFiles(folder.filesDir)) {
    let handle;
    try {
      handle = await open(join(folder.filesDir, path), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    try {
      const { size, mtimeMs } = await handle.stat();
      yield entryHeader(`${FILES}${path}`, size, 'file', mtimeMs);
      digest.update(`${path}\n`);
      let left = size;
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(size, 1)));
      while (left > 0) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, left));
        if (bytesRead === 0) throw new Error(`${path} got shorter while it was backed up`);
        const piece = Uint8Array.prototype.slice.call(chunk, 0, bytesRead);
        digest.update(piece);
        left -= bytesRead;
        yield piece;
      }
      yield padding(size);
      files += 1;
      bytes += size;
    } finally {
      await handle.close();
    }
  }
  yield* jsonEntry(TRAILER, { files, bytes, sha256: digest.digest('hex') } satisfies BackupTrailer);
  yield END_OF_ARCHIVE;
}

/** The backup's file name: when it was made, to the second, in this computer's terms but no zone. */
function backupFileName(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `shizue-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.tar`;
}

/* ------------------------------------------------------------------ restore */

const invalid = (message: string): ApiError => badRequest('invalid_backup', message);

/** A time for a folder's name: sortable, no colons. */
const folderStamp = (now = new Date()): string => now.toISOString().replace(/[:.]/g, '-');

async function readJsonEntry(entry: TarEntry | undefined, path: string): Promise<Record<string, unknown>> {
  if (!entry || entry.type !== 'file' || entry.path !== path) throw invalid(`The file is not a shizue backup (no ${path})`);
  if (entry.size > MAX_JSON_BYTES) throw invalid(`${path} is too large`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of entry.body) chunks.push(chunk);
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through to the refusal below.
  }
  throw invalid(`${path} is not JSON`);
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isHex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function readManifest(raw: Record<string, unknown>): BackupManifest {
  if (raw['format'] !== BACKUP_FORMAT) throw invalid('The file is not a shizue backup');
  if (raw['version'] !== BACKUP_VERSION) {
    throw badRequest('backup_incompatible', 'This backup was made by another version of shizue');
  }
  const migrations = raw['migrations'];
  const tables = raw['tables'];
  const db = raw['db'] as Record<string, unknown> | undefined;
  if (
    !Array.isArray(migrations) ||
    !migrations.every((m) => m && typeof m === 'object' && isHex((m as Record<string, unknown>)['hash'])) ||
    tables === null ||
    typeof tables !== 'object' ||
    Array.isArray(tables) ||
    !Object.values(tables).every(isCount) ||
    !db ||
    !isCount(db['size']) ||
    !isHex(db['sha256'])
  ) {
    throw invalid('The backup manifest is malformed');
  }
  return raw as unknown as BackupManifest;
}

/**
 * A path inside `files/` as a backup writes it, or null for one a backup never
 * writes: empty, absolute, climbing out, or naming what a folder cannot hold.
 */
function safeFilePath(path: string): string | null {
  if (!path.startsWith(FILES)) return null;
  const rest = path.slice(FILES.length);
  const parts = rest.split('/');
  if (rest === '' || parts.some((part) => part === '' || part === '.' || part === '..' || /[\\\u0000:]/.test(part))) {
    return null;
  }
  return parts.join(sep);
}

/** Writes an entry's body to `path`, answering its SHA-256 where `hash` asks for one. */
async function writeEntry(entry: TarEntry, path: string, digest?: ReturnType<typeof fileDigest>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  async function* tapped(): AsyncGenerator<Uint8Array> {
    for await (const chunk of entry.body) {
      digest?.update(chunk);
      yield chunk;
    }
  }
  await pipeline(Readable.from(tapped()), createWriteStream(path, { flags: 'wx' }));
}

/**
 * What the dump is before PGlite is given it: a gzip that inflates whole into a
 * tar of a Postgres folder. PGlite unpacks a dump it cannot read with an error
 * it does not catch, so nothing reaches it unread.
 */
async function checkDump(path: string): Promise<void> {
  const names = new Set<string>();
  try {
    const inflated = createReadStream(path).pipe(createGunzip());
    for await (const entry of readTar(inflated as AsyncIterable<Uint8Array>)) {
      names.add(entry.path.replace(/^\/+/, '').split('/')[0]!);
    }
  } catch (error) {
    if (error instanceof TarError || (error as NodeJS.ErrnoException).code?.startsWith('Z_')) {
      throw invalid('The backup database is damaged');
    }
    throw error;
  }
  if (!names.has('PG_VERSION') || !names.has('base') || !names.has('global')) {
    throw invalid('The backup database is not a database folder');
  }
}

/** The restore the running folder names for the next start. */
export interface Pending {
  /** The restored folder, beside the running one: its name only. */
  folder: string;
  stagedAt: string;
  backupCreatedAt: string;
}

function readPending(dataDir: string): Pending | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dataDir, PENDING), 'utf8'));
  } catch {
    return null;
  }
  const pending = raw as Partial<Pending> | null;
  const prefix = `${basename(dataDir)}.restore-`;
  if (!pending || typeof pending.folder !== 'string' || !pending.folder.startsWith(prefix) || /[/\\]/.test(pending.folder)) {
    return null;
  }
  return {
    folder: pending.folder,
    stagedAt: String(pending.stagedAt ?? ''),
    backupCreatedAt: String(pending.backupCreatedAt ?? ''),
  };
}

/**
 * Reads a backup into a new folder beside the running one and marks it for the
 * next start; answers what is waiting. On any failure the new folder is
 * deleted and the running one is as it was.
 */
export async function stageRestore(folder: AppFolder, body: AsyncIterable<Uint8Array>): Promise<Pending> {
  const { dataDir } = folder;
  const parent = dirname(dataDir);
  const name = `${basename(dataDir)}.restore-${folderStamp()}-${randomBytes(3).toString('hex')}`;
  const staging = join(parent, name);
  await mkdir(staging);
  try {
    const entries = readTar(body);
    const next = async (): Promise<TarEntry | undefined> => (await entries.next()).value ?? undefined;
    let manifest: BackupManifest;
    try {
      manifest = readManifest(await readJsonEntry(await next(), MANIFEST));
      const known = new Set(knownMigrations().map((migration) => migration.hash));
      if (!manifest.migrations.every((migration) => known.has(migration.hash))) {
        throw badRequest(
          'backup_incompatible',
          'This backup has database changes this version of shizue does not know; restore it with the version that made it, or a newer one',
        );
      }

      const dumpEntry = await next();
      if (!dumpEntry || dumpEntry.type !== 'file' || dumpEntry.path !== DB_DUMP || dumpEntry.size !== manifest.db.size) {
        throw invalid('The backup has no database');
      }
      const dumpPath = join(staging, DB_DUMP);
      const dumpHash = createHash('sha256');
      await writeEntry(dumpEntry, dumpPath, dumpHash);
      if (dumpHash.digest('hex') !== manifest.db.sha256) throw invalid('The backup database is damaged');

      const digest = fileDigest();
      let files = 0;
      let bytes = 0;
      let trailer: Record<string, unknown> | undefined;
      for (;;) {
        const entry = await next();
        if (!entry) throw invalid('The backup ends before its end');
        if (entry.path === TRAILER) {
          trailer = await readJsonEntry(entry, TRAILER);
          break;
        }
        const relative = safeFilePath(entry.path);
        if (!relative) throw invalid(`The backup holds a file outside files/: ${entry.path.slice(0, 200)}`);
        if (entry.type === 'dir') {
          await mkdir(join(staging, 'files', relative), { recursive: true });
          continue;
        }
        digest.update(`${relative.split(sep).join('/')}\n`);
        await writeEntry(entry, join(staging, 'files', relative), digest);
        files += 1;
        bytes += entry.size;
      }
      if ((await entries.next()).done !== true) throw invalid('The backup goes on after its end');
      if (trailer['files'] !== files || trailer['bytes'] !== bytes || trailer['sha256'] !== digest.digest('hex')) {
        throw invalid('The backup files are damaged');
      }
      await checkDump(dumpPath);

      // The database, opened from the dump in the new folder: the counts are the
      // manifest's, then it is migrated as a start would.
      const opened = await openDb(join(staging, 'db'), {
        loadDataDir: await openAsBlob(dumpPath, { type: 'application/x-gzip' }),
      }).catch(() => {
        throw invalid('The backup database does not open');
      });
      try {
        const counts = await tableCounts((sql) => opened.client.query(sql));
        for (const [table, rows] of Object.entries(manifest.tables)) {
          if (counts[table] !== rows) throw invalid(`The backup database is damaged (${table})`);
        }
        await migrateDb(opened.db);
      } finally {
        await opened.close();
      }
      await rm(dumpPath, { force: true });
    } catch (error) {
      if (error instanceof TarError) throw invalid(error.message);
      throw error;
    }

    // What the backup sealed on this computer opens again: the install's secret goes along.
    if (existsSync(join(dataDir, 'secret'))) {
      await copyFile(join(dataDir, 'secret'), join(staging, 'secret'));
      await chmod(join(staging, 'secret'), 0o600);
    }
    const pending: Pending = { folder: name, stagedAt: new Date().toISOString(), backupCreatedAt: manifest.createdAt };
    await writeFile(join(staging, STAGED), JSON.stringify(pending, null, 2));
    // A restore staged before this one is replaced by it.
    const earlier = readPending(dataDir);
    await mkdir(dataDir, { recursive: true });
    const temporary = join(dataDir, `${PENDING}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temporary, JSON.stringify(pending, null, 2));
    await rename(temporary, join(dataDir, PENDING));
    if (earlier && earlier.folder !== name) await rm(join(parent, earlier.folder), { recursive: true, force: true });
    return pending;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Gives up the restore waiting for the next start, and the folder it made. */
export async function cancelRestore(dataDir: string): Promise<boolean> {
  const pending = readPending(dataDir);
  await rm(join(dataDir, PENDING), { force: true });
  if (!pending) return false;
  await rm(join(dirname(dataDir), pending.folder), { recursive: true, force: true });
  return true;
}

/** A swap the start made: where the folder from before went. */
export interface SwappedRestore {
  previous: string;
}

/**
 * At start, with the running folder locked and nothing open in it: puts a
 * restored folder in its place where one waits (`restore-pending.json`), and
 * answers where the folder from before went — kept beside it, named for when.
 * The embedding model's weights, which no backup holds, move across. A note
 * whose folder is gone or incomplete is dropped and nothing moves. Should the
 * second rename fail, the first is undone.
 */
export function swapInPendingRestore(dataDir: string): SwappedRestore | null {
  const marker = join(dataDir, PENDING);
  if (!existsSync(marker)) return null;
  const pending = readPending(dataDir);
  const staged = pending ? join(dirname(dataDir), pending.folder) : null;
  if (!pending || !staged || !existsSync(join(staged, STAGED))) {
    console.warn('[shizue] a restore was waiting, but its folder is gone or incomplete; starting on the current folder');
    rmSync(marker, { force: true });
    return null;
  }
  const previous = join(dirname(dataDir), `${basename(dataDir)}.before-restore-${folderStamp()}`);
  renameSync(dataDir, previous);
  try {
    renameSync(staged, dataDir);
  } catch (error) {
    renameSync(previous, dataDir);
    throw error;
  }
  if (existsSync(join(previous, 'models')) && !existsSync(join(dataDir, 'models'))) {
    renameSync(join(previous, 'models'), join(dataDir, 'models'));
  }
  rmSync(join(previous, PENDING), { force: true });
  // The lock this start holds went with the folder; the start locks the new one.
  rmSync(join(previous, 'app.lock'), { force: true });
  rmSync(join(dataDir, STAGED), { force: true });
  writeFileSync(
    join(dataDir, RESTORED),
    JSON.stringify(
      { restoredAt: new Date().toISOString(), backupCreatedAt: pending.backupCreatedAt, previous: basename(previous) },
      null,
      2,
    ),
  );
  console.log(`[shizue] restored the backup of ${pending.backupCreatedAt}; the folder from before is kept at ${previous}`);
  return { previous };
}

/**
 * Undoes a swap whose folder would not open: the restored folder steps aside
 * (`<folder>.restore-failed-<time>`), and the folder from before is put back.
 */
export function rollBackRestore(dataDir: string, swapped: SwappedRestore): void {
  const failed = join(dirname(dataDir), `${basename(dataDir)}.restore-failed-${folderStamp()}`);
  renameSync(dataDir, failed);
  if (existsSync(join(failed, 'models')) && !existsSync(join(swapped.previous, 'models'))) {
    renameSync(join(failed, 'models'), join(swapped.previous, 'models'));
  }
  renameSync(swapped.previous, dataDir);
  console.error(`[shizue] the restored folder did not open; back on the folder from before. The restored one is at ${failed}`);
}

/** What `GET /api/backup/restore` says: whether this is the computer, what waits, what was restored. */
async function restoreStatus(dataDir: string, local: boolean) {
  const pending = readPending(dataDir);
  let restored: { restoredAt: string; backupCreatedAt: string; previous: string } | null = null;
  try {
    const raw = JSON.parse(await readFile(join(dataDir, RESTORED), 'utf8')) as Record<string, unknown>;
    const previous = typeof raw['previous'] === 'string' ? join(dirname(dataDir), basename(raw['previous'])) : '';
    if (previous && (await stat(previous).catch(() => null))) {
      restored = { restoredAt: String(raw['restoredAt']), backupCreatedAt: String(raw['backupCreatedAt']), previous };
    }
  } catch {
    // Never restored, or the note is unreadable: nothing to say.
  }
  return {
    local,
    pending: pending ? { stagedAt: pending.stagedAt, backupCreatedAt: pending.backupCreatedAt } : null,
    restored,
  };
}

/**
 * `/api/backup`: `GET` the backup, as a download; `GET /restore` what a restore
 * has waiting; `PUT /restore` a backup's bytes as the body, read into a new
 * folder for the next start; `DELETE /restore` gives that up. A restore is this
 * computer's alone (`requireLocal`). Without the folder (tests that do not back
 * up) every one is 404.
 */
export function backupRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const folder = (): AppFolder => {
    if (!deps.appFolder) throw notFound();
    return deps.appFolder;
  };

  app.get('/', async () => {
    const target = folder();
    const release = claim(`backup:${target.dataDir}`);
    const source = backupStream(target);
    // The dump is taken before the response starts, so a failure there is an error, not a cut-off download.
    let first: IteratorResult<Uint8Array>;
    try {
      first = await source.next();
    } catch (error) {
      release();
      throw error;
    }
    async function* rest(): AsyncGenerator<Uint8Array> {
      try {
        if (!first.done) yield first.value;
        yield* source;
      } finally {
        release();
      }
    }
    return new Response(ReadableStream.from(rest()), {
      headers: {
        'content-type': 'application/x-tar',
        'content-disposition': attachmentDisposition(backupFileName()),
        'cache-control': 'no-store',
      },
    });
  });

  app.get('/restore', async (c) => c.json(await restoreStatus(folder().dataDir, c.get('local'))));

  app.put('/restore', requireLocal, async (c) => {
    const target = folder();
    const body = c.req.raw.body;
    if (!body) throw invalid('The request carries no file');
    const release = claim(`restore:${target.dataDir}`);
    try {
      const pending = await stageRestore(target, body as AsyncIterable<Uint8Array>);
      return c.json({ pending: { stagedAt: pending.stagedAt, backupCreatedAt: pending.backupCreatedAt } });
    } finally {
      release();
    }
  });

  app.delete('/restore', requireLocal, async (c) => {
    await cancelRestore(folder().dataDir);
    return c.body(null, 204);
  });

  return app;
}
