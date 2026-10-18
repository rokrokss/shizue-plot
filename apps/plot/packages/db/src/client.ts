import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema/index.js';

export type Db = PgliteDatabase<typeof schema>;

/** The migrations drizzle-kit writes, beside both `src/` and the built `dist/`. */
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

export interface OpenedDb {
  db: Db;
  /** PGlite itself, for what drizzle does not say: a TRUNCATE in the tests, a raw dump. */
  client: PGlite;
  close(): Promise<void>;
}

/**
 * The app's database: PGlite, Postgres compiled to WebAssembly, with pgvector —
 * kept in `dataDir` on disk, or in memory without one (the tests). PGlite has one
 * connection and runs every query on it in turn, so a process opens it once: a
 * second handle on the same directory would corrupt it, and code inside a
 * transaction must use the transaction, never `db`, or it waits on itself.
 */
export async function openDb(dataDir?: string): Promise<OpenedDb> {
  const client = await PGlite.create(dataDir ?? 'memory://', { extensions: { vector } });
  // PGlite takes the host's zone; the app's SQL has always run in UTC, as its server did.
  await client.exec(`set time zone 'UTC'`);
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}

/** Brings the database to the newest migration in `drizzle/`, as the app does at every start. */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
