import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, two levels up from packages/db. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// drizzle-kit runs with packages/db as its cwd, so the repo-root .env that holds
// DATABASE_URL is never loaded for it. Existing vars win, so an inline
// `DATABASE_URL=… pnpm db:migrate` still sends the migration where it says.
config({ path: resolve(REPO_ROOT, '.env'), quiet: true });

const url = process.env.DATABASE_URL;
// No fallback on purpose. A hardcoded localhost default would let an unset
// variable silently migrate whatever happens to be on 15433 instead of saying
// so — and a CI job with no .env would hit it first.
if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Put it in the repo-root .env, or name the target for one run: ' +
      'DATABASE_URL=postgres://plot:plot@localhost:15433/plot_test pnpm db:migrate',
  );
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
});
