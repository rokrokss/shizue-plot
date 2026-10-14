/**
 * Brings in what plots imported before the import did so load from other hosts
 * (`localizeAssets.ts`): every plot's openings, stylesheets, background and
 * display scripts, and its modules', fetched and rewritten as an import today
 * would. Against DATABASE_URL — apps/plot/.env's unless the environment says
 * otherwise — and the storage the API is configured with (STORAGE_DRIVER,
 * UPLOAD_DIR or the S3 settings), so the files land where the API reads them.
 *
 *   pnpm --filter @shizue/api fix:localize-assets                  dry run: lists what it would fetch
 *   pnpm --filter @shizue/api fix:localize-assets --apply          fetches and writes it
 *   pnpm --filter @shizue/api fix:localize-assets --plot <id> …    one plot only
 *
 * `updated_at` is left alone. Run again, it fetches nothing it already has: an
 * asset named for an address is reused, and a rewritten reference is no longer
 * one to another host.
 */
import { createDb, plots } from '@shizue/db';
import { asc } from 'drizzle-orm';
import { loadRootEnv, readConfig } from '../env.js';
import { createRemoteFetch, localizePlot } from '../localizeAssets.js';
import { createStorage } from '../storage.js';

loadRootEnv();

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const at = args.indexOf('--plot');
const only = at >= 0 ? args[at + 1] : undefined;
const rest = at >= 0 ? args.filter((_, index) => index !== at && index !== at + 1) : args;
const unknown = rest.filter((arg) => arg !== '--apply' && arg !== '--dry-run');
if (unknown.length > 0 || (at >= 0 && !only) || (rest.includes('--apply') && rest.includes('--dry-run'))) {
  console.error('usage: fix:localize-assets [--dry-run | --apply] [--plot <id>]   (a dry run is the default)');
  process.exit(2);
}
const apply = rest.includes('--apply');

const config = readConfig();
// Which database, without the credentials the URL carries.
const target = new URL(config.databaseUrl);
console.log(`${apply ? 'Applying to' : 'Dry run against'} ${target.host}${target.pathname}`);

const { db, close } = createDb(config.databaseUrl);
const storage = createStorage(config.storage);
const remoteFetch = createRemoteFetch({ ownOrigins: [config.authUrl, ...(config.apiOrigin ? [config.apiOrigin] : [])] });
try {
  const rows = await db.select({ id: plots.id, name: plots.name }).from(plots).orderBy(asc(plots.createdAt));
  let touched = 0;
  for (const plot of rows) {
    if (only && plot.id !== only) continue;
    const outcome = await localizePlot({ db, storage, remoteFetch }, plot.id, { plot: true, modules: 'all' }, {
      dryRun: !apply,
      touch: false,
    });
    if (outcome.found.length === 0) continue;
    touched += 1;
    const hosts = [...new Set(outcome.found.map((ref) => ref.address.replace(/^(?:https?:)?\/\/([^/]+).*$/i, '$1')))];
    console.log(
      `${plot.id} ${JSON.stringify(plot.name)}: ${outcome.found.length} references (${hosts.join(', ')})` +
        (apply ? ` — stored ${outcome.stored}, left ${outcome.failed} failed, ${outcome.overLimit} over the caps` : ''),
    );
  }
  console.log(`${touched} plots load from other hosts.`);
  if (!apply) console.log('Nothing was fetched or written. Run again with --apply to do it.');
} finally {
  await close();
}
