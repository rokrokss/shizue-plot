/**
 * Moves a shizue that ran on Postgres (before 2026-10-18) into the app's own
 * folder: every row of every table, the files of the old local driver's folder,
 * and the old secret, so that the ChatGPT connection sealed with it still opens
 * and OpenAI sees the same host. Once, into a folder that has no database yet;
 * the source is only read.
 *
 *   pnpm --filter @shizue/api import:postgres -- --from <postgres url> [--to <dir>] [--uploads <dir>]
 *
 * `--to` defaults to the app's folder (SHIZUE_DATA_DIR) and `--uploads` to the
 * old `UPLOAD_DIR`. Files an old install kept in an S3 bucket are not read here
 * any more: move such an install with an earlier build (901599a or before),
 * whose `--s3` copies the bucket too. The old secret is `BETTER_AUTH_SECRET`, or
 * the old default when it was never set. Postgres must be at the same migration
 * as this build: migrate it with the old checkout first.
 */
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import { openAppDb } from '../appDb.js';
import { dataDirOf, filesDirOf, loadRootEnv } from '../env.js';

loadRootEnv();

/** The secret the API used when `BETTER_AUTH_SECRET` was unset, before each install had its own. */
const OLD_DEFAULT_SECRET = 'dev-secret-change-me';
/** Rows sent to PGlite in one statement. */
const BATCH = 500;

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const valueOf = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const from = valueOf('--from') ?? process.env['DATABASE_URL'];
const to = resolve(valueOf('--to') ?? dataDirOf(process.env));
const uploadsArg = valueOf('--uploads') ?? process.env['UPLOAD_DIR'];
if (!from) {
  console.error('usage: import:postgres --from <postgres url> [--to <dir>] [--uploads <dir>]');
  process.exit(2);
}

// Only an empty folder: a database or files already there would mix with the copy.
if (existsSync(to) && readdirSync(to).length > 0) {
  console.error(`${to} is not empty; this only fills an empty folder.`);
  process.exit(1);
}

// The secret first: the app must never start on this folder with a new one.
await mkdir(to, { recursive: true });
const secret = process.env['BETTER_AUTH_SECRET']?.trim() || OLD_DEFAULT_SECRET;
await writeFile(join(to, 'secret'), `${secret}\n`, { mode: 0o600, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'EEXIST') throw error;
  console.warn(`[import] ${join(to, 'secret')} exists and is kept: a ChatGPT connection sealed with another secret will not open.`);
});

const source = postgres(from, { max: 1, onnotice: () => undefined });
const target = await openAppDb(to);
try {
  const migrations = async (count: () => Promise<number>): Promise<number> => count().catch(() => -1);
  const sourceVersion = await migrations(async () => Number((await source`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]!['n']));
  const targetVersion = await migrations(
    async () => (await target.client.query<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0]!.n,
  );
  if (sourceVersion !== targetVersion) {
    throw new Error(`the source is at migration ${sourceVersion}, this build at ${targetVersion}: migrate the source with the old checkout first.`);
  }

  const tables = (
    await target.client.query<{ name: string }>(
      `select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    )
  ).rows.map((row) => row.name);
  // PGlite is a single superuser session: with the foreign-key triggers off for it,
  // the tables go in any order and the rows reference each other as they did.
  await target.client.exec(`set session_replication_role = replica`);
  for (const table of tables) {
    const columns = (
      await target.client.query<{ name: string }>(
        `select column_name as name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`,
        [table],
      )
    ).rows.map((row) => `"${row.name}"`);
    const list = columns.join(', ');
    let copied = 0;
    // Each row as JSON text and back through the column types' own input: dates,
    // jsonb, arrays, vectors and tsvectors all arrive as they were.
    for await (const rows of source.unsafe(`select row_to_json(t)::text as j from "${table}" t`).cursor(BATCH)) {
      const json = `[${rows.map((row) => row['j'] as string).join(',')}]`;
      await target.client.query(`insert into "${table}" (${list}) select ${list} from json_populate_recordset(null::"${table}", $1::json)`, [json]);
      copied += rows.length;
    }
    const [counted] = await source.unsafe(`select count(*)::int as n from "${table}"`);
    if (Number(counted!['n']) !== copied) throw new Error(`${table}: copied ${copied} of ${counted!['n']} rows`);
    if (copied > 0) console.log(`[import] ${table}: ${copied}`);
  }
  await target.client.exec(`set session_replication_role = origin`);

  const files = filesDirOf(to);
  await mkdir(files, { recursive: true });
  if (uploadsArg) {
    // The old local driver's folder, relative to apps/plot as the old config read it.
    const uploads = resolve(dirname(new URL(import.meta.url).pathname), '../../../..', uploadsArg);
    if (await stat(uploads).then((info) => info.isDirectory(), () => false)) {
      await cp(uploads, files, { recursive: true, force: false, errorOnExist: false });
      console.log(`[import] files from ${uploads}`);
    } else {
      console.log(`[import] no folder at ${uploads}; skipped`);
    }
  }
  console.log(`[import] done: ${to}`);
} finally {
  await target.close();
  await source.end();
}
