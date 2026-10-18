/**
 * Backup and restore of the whole app folder (`backup.ts`): a backup made from
 * a running app, read back into a new folder beside it, and swapped in by the
 * next start (`openAppDb`) — every table count and every file the same — and
 * the files a restore refuses, leaving everything as it was.
 *
 * The running app's database is a PGlite in memory, as every API suite's; its
 * folder (the files, the secret, and where a restore goes) is a temporary one.
 */
import { migrateDb, openDb, type Db, type OpenedDb } from '@shizue/db';
import type { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openAppDb } from '../src/appDb.js';
import { createApp } from '../src/app.js';
import { backupStream } from '../src/backup.js';
import type { AppDeps, AppEnv } from '../src/deps.js';
import { createSessionStore, ensureOwner } from '../src/session.js';
import { createLocalStorage } from '../src/storage.js';
import { END_OF_ARCHIVE, entryHeader, padding } from '../src/tar.js';

let db: Db;
let client: OpenedDb['client'];
let close: () => Promise<void>;
/** Holds the app's folder and whatever a restore puts beside it. */
let root: string;
let dataDir: string;
let app: Hono<AppEnv>;

beforeAll(async () => {
  ({ db, client, close } = await openDb());
  await migrateDb(db);
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await client.exec(`TRUNCATE TABLE messages, chats, characters, plots, personas, "session", "user" RESTART IDENTITY CASCADE`);
  root = await mkdtemp(join(tmpdir(), 'shizue-backup-'));
  dataDir = join(root, 'app');
  await mkdir(join(dataDir, 'files'), { recursive: true });
  const deps: AppDeps = {
    db,
    storage: createLocalStorage(join(dataDir, 'files')),
    appFolder: { dataDir, filesDir: join(dataDir, 'files'), client },
    env: {},
    generating: new Set(),
    generationStreams: new Set(),
    refreshingMemory: new Set(),
    detectingEmotion: new Set(),
    embeddingVectors: new Map(),
    suggesting: new Set(),
  };
  app = createApp(deps);
  await ensureOwner(db);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const send = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method,
      headers: { ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body === undefined ? {} : { body: body as string | Uint8Array<ArrayBuffer> }),
    }),
  );

async function ok(res: Response, status = 200): Promise<any> {
  expect(res.status, await res.clone().text()).toBe(status);
  return res.status === 204 ? null : res.json();
}

/** A work with a member, a chat on it with a turn, a persona, and their files. */
async function seed(): Promise<void> {
  const plot = await ok(await send('/api/plots', 'POST', JSON.stringify({ name: '도서관', intros: ['어서 와.'] })), 201);
  await ok(await send(`/api/plots/${plot.id}/characters`, 'POST', JSON.stringify({ name: '세라' })), 201);
  await ok(await send('/api/personas', 'POST', JSON.stringify({ name: '민수', description: '학생' })), 201);
  const chat = await ok(await send('/api/chats', 'POST', JSON.stringify({ plotId: plot.id })), 201);
  await ok(await send(`/api/chats/${chat.chat.id}/messages`, 'POST', JSON.stringify({ content: '안녕', stopped: true })));
  const files = join(dataDir, 'files');
  await mkdir(join(files, 'avatars'), { recursive: true });
  await mkdir(join(files, 'assets', 'nested'), { recursive: true });
  await writeFile(join(files, 'avatars', `${'a'.repeat(36)}.png`), Buffer.from('png bytes'));
  await writeFile(join(files, 'assets', 'nested', `${'b'.repeat(120)}.webp`), Buffer.alloc(70_000, 7));
  await writeFile(join(files, 'covers.empty'), Buffer.alloc(0));
  // Not the reader's: an upload's parts, and a file still being written.
  await mkdir(join(files, '.uploads', 'x'), { recursive: true });
  await writeFile(join(files, '.uploads', 'x', '1'), 'part');
  await writeFile(join(files, 'avatars', 'half.png.123.tmp'), 'half');
  await writeFile(join(dataDir, 'secret'), 'this-install-secret\n', { mode: 0o600 });
}

async function countsOf(query: (sql: string) => Promise<{ rows: unknown[] }>): Promise<Record<string, number>> {
  const tables = (await query(`select tablename from pg_tables where schemaname = 'public' order by tablename`)).rows as {
    tablename: string;
  }[];
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) {
    counts[tablename] = ((await query(`select count(*)::int as n from "${tablename}"`)).rows[0] as { n: number }).n;
  }
  return counts;
}

/** Every file under `dir`, by its path there, and its bytes. */
async function filesOf(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path)] = (await readFile(path)).toString('base64');
  }
  return out;
}

async function backupBytes(): Promise<Uint8Array> {
  const res = await send('/api/backup');
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/x-tar');
  expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="shizue-backup-\d{4}-\d{2}-\d{2}-\d{6}\.tar"/);
  return new Uint8Array(await res.arrayBuffer());
}

const restore = (bytes: Uint8Array, headers: Record<string, string> = {}): Promise<Response> =>
  send('/api/backup/restore', 'PUT', bytes, { 'content-type': 'application/x-tar', ...headers });

/** The folders beside the app's: what a restore made. */
const beside = async (): Promise<string[]> => (await readdir(root)).filter((name) => name !== 'app').sort();

/** That a refused restore left nothing: no folder beside the app's, no note in it. */
async function expectNothingChanged(): Promise<void> {
  expect(await beside()).toEqual([]);
  expect(existsSync(join(dataDir, 'restore-pending.json'))).toBe(false);
  expect((await ok(await send('/api/backup/restore'))).pending).toBeNull();
}

describe('a backup restored', () => {
  it('comes back on the next start with every table count and file the same, the folder from before kept', async () => {
    await seed();
    const counts = await countsOf((sql) => client.query(sql));
    expect(counts['messages']).toBeGreaterThan(0);
    const files = await filesOf(join(dataDir, 'files'));
    const kept = Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith('.uploads') && !path.endsWith('.tmp')));

    const bytes = await backupBytes();
    // Never the secret, and the file says so.
    expect(Buffer.from(bytes).includes(Buffer.from('this-install-secret'))).toBe(false);
    expect(Buffer.from(bytes).toString('latin1')).toContain('"secret": "not_included"');

    const staged = await ok(await restore(bytes));
    expect(staged.pending).toEqual({ stagedAt: expect.any(String), backupCreatedAt: expect.any(String) });
    expect((await ok(await send('/api/backup/restore'))).pending).toEqual(staged.pending);
    const [folder] = await beside();
    expect(folder).toMatch(/^app\.restore-/);
    // The running folder is untouched but for the note naming the new one.
    expect(await filesOf(join(dataDir, 'files'))).toEqual(files);
    expect((await stat(join(root, folder!, 'secret'))).mode & 0o777).toBe(0o600);

    // The data changes after the backup, then the app stops and starts again.
    await ok(await send('/api/personas', 'POST', JSON.stringify({ name: '나중', description: '' })), 201);
    const started = await openAppDb(dataDir);
    try {
      expect(await countsOf((sql) => started.client.query(sql))).toEqual(counts);
    } finally {
      await started.close();
    }
    expect(await filesOf(join(dataDir, 'files'))).toEqual(kept);
    // This install's secret came along, so what the backup sealed here still opens.
    expect(await readFile(join(dataDir, 'secret'), 'utf8')).toBe('this-install-secret\n');
    const after = await beside();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/^app\.before-restore-/);
    // The folder from before is as it was, but for the note: its files are all there.
    expect(await filesOf(join(root, after[0]!, 'files'))).toEqual(files);
    expect(existsSync(join(root, after[0]!, 'restore-pending.json'))).toBe(false);
    expect(JSON.parse(await readFile(join(dataDir, 'restored.json'), 'utf8'))).toMatchObject({ previous: after[0] });
  });

  it('puts the folder from before back when the restored database does not open', async () => {
    await seed();
    await ok(await restore(await backupBytes()));
    const [folder] = await beside();
    await writeFile(join(root, folder!, 'db', 'PG_VERSION'), 'not a version');
    const started = await openAppDb(dataDir);
    await started.close();
    // Back on the running folder, its files there; the restored one aside, named for it.
    expect(await readFile(join(dataDir, 'secret'), 'utf8')).toBe('this-install-secret\n');
    expect(existsSync(join(dataDir, 'files', 'avatars', `${'a'.repeat(36)}.png`))).toBe(true);
    const after = await beside();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/^app\.restore-failed-/);
  });

  it('gives up a restore waiting for the start, and replaces one with the next', async () => {
    await seed();
    const bytes = await backupBytes();
    await ok(await restore(bytes));
    const [first] = await beside();
    await ok(await restore(bytes));
    const [second] = await beside();
    expect(second).not.toBe(first);
    expect(await beside()).toHaveLength(1);
    await ok(await send('/api/backup/restore', 'DELETE'), 204);
    await expectNothingChanged();
  });
});

describe('a file a restore refuses', () => {
  it('refuses a foreign file, a cut one and a damaged one, with nothing changed', async () => {
    await seed();
    const bytes = await backupBytes();
    // A picture.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(2000).fill(1)]);
    expect((await ok(await restore(png), 400)).code).toBe('invalid_backup');
    await expectNothingChanged();
    // Cut short.
    expect((await ok(await restore(bytes.slice(0, Math.floor(bytes.length / 2))), 400)).code).toBe('invalid_backup');
    await expectNothingChanged();
    // One byte of the database changed.
    const damaged = bytes.slice();
    damaged[4096] = damaged[4096]! ^ 0xff;
    expect((await ok(await restore(damaged), 400)).code).toBe('invalid_backup');
    await expectNothingChanged();
    // One byte of a file changed: the trailer's hash says so.
    const fileByte = Buffer.from(bytes).lastIndexOf(Buffer.from('png bytes'));
    const tampered = bytes.slice();
    tampered[fileByte] = 0x50;
    expect((await ok(await restore(tampered), 400)).code).toBe('invalid_backup');
    await expectNothingChanged();
  });

  it('refuses a backup with a path out of files/, or one from a database this build does not know', async () => {
    const backup = async (patch: (entries: { path: string; bytes: Uint8Array }[]) => void): Promise<Uint8Array> => {
      const parts: Uint8Array[] = [];
      for await (const chunk of backupStream({ dataDir, filesDir: join(dataDir, 'files'), client })) parts.push(chunk);
      // Re-read the archive into its entries, change them, and write it again.
      const whole = Buffer.concat(parts);
      const entries: { path: string; bytes: Uint8Array }[] = [];
      let at = 0;
      while (at < whole.length && whole[at] !== 0) {
        const name = whole.subarray(at, at + 100).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(whole.subarray(at + 124, at + 136).toString('utf8'), 8);
        entries.push({ path: name, bytes: whole.subarray(at + 512, at + 512 + size) });
        at += 512 + size + padding(size).length;
      }
      patch(entries);
      const out: Uint8Array[] = [];
      for (const entry of entries) out.push(entryHeader(entry.path, entry.bytes.length), entry.bytes, padding(entry.bytes.length));
      out.push(END_OF_ARCHIVE);
      return Buffer.concat(out);
    };
    await writeFile(join(dataDir, 'files', 'one.txt'), 'one');

    const escaping = await backup((entries) => {
      entries.find((entry) => entry.path === 'files/one.txt')!.path = 'files/../../escape.txt';
    });
    expect((await ok(await restore(escaping), 400)).code).toBe('invalid_backup');
    expect(existsSync(join(root, 'escape.txt'))).toBe(false);
    await expectNothingChanged();

    const newer = await backup((entries) => {
      const manifest = entries[0]!;
      const parsed = JSON.parse(Buffer.from(manifest.bytes).toString('utf8'));
      parsed.migrations.push({ hash: 'f'.repeat(64), createdAt: Date.now() });
      manifest.bytes = Buffer.from(JSON.stringify(parsed));
    });
    expect((await ok(await restore(newer), 400)).code).toBe('backup_incompatible');
    await expectNothingChanged();
  });

  it('refuses a restore from a phone, and lets it read what waits', async () => {
    await seed();
    const bytes = await backupBytes();
    const sessions = createSessionStore(db, { secure: false });
    const phone = (await sessions.create(await ensureOwner(db), new Request('https://mac.example.ts.net:8444/'))).split(';')[0]!;
    const tunnel = {
      host: 'localhost:8787',
      'x-forwarded-host': 'mac.example.ts.net:8444',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '100.101.102.103',
      cookie: phone,
    };
    const fromPhone = (method: string, body?: Uint8Array) =>
      Promise.resolve(app.request('/api/backup/restore', { method, headers: tunnel, ...(body ? { body } : {}) }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } }));
    for (const [method, body] of [['PUT', bytes], ['DELETE', undefined]] as const) {
      const refused = await fromPhone(method, body);
      expect(refused.status, method).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'local_only' });
    }
    await expectNothingChanged();
    expect(await (await fromPhone('GET')).json()).toEqual({ local: false, pending: null, restored: null });
  });
});
