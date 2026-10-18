import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` only diffs the schema against the snapshots in
// `drizzle/meta`, so it needs no database. Migrations are applied by the app
// itself at every start (`migrateDb`), never by drizzle-kit: PGlite takes one
// process per folder, and the app is that process.
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
});
