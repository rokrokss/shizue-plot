/**
 * Writes the Korean lore aliases (`loreAliases.ts`) of works made before the
 * alias pass existed: every plot whose language is not Korean, whose book has
 * (next to) no Korean keys and which has a keyed entry without its row — on its
 * creator's auxiliary model, as the API does after an edit. Against
 * DATABASE_URL — apps/plot/.env's unless the environment says otherwise — with
 * BETTER_AUTH_SECRET, which opens the creators' ChatGPT sign-ins.
 *
 *   pnpm --filter @shizue/api fix:lore-aliases                 dry run: lists the plots and the calls each needs
 *   pnpm --filter @shizue/api fix:lore-aliases --apply         writes them, one plot at a time
 *   pnpm --filter @shizue/api fix:lore-aliases --plot <id> …   one plot only
 *
 * Run again, it asks for nothing it already has. A plot whose creator has no
 * auxiliary model (signed out of ChatGPT) is listed and skipped: its first
 * Korean reader's chat starts the pass on theirs.
 */
import { aliasBatches, LORE_ALIAS_LANGUAGE } from '@shizue/core';
import { createDb, loreEntryAliases, plots } from '@shizue/db';
import { and, asc, eq, ne } from 'drizzle-orm';
import { createChatGPTAccounts } from '../chatgptAccounts.js';
import { loadRootEnv, readConfig } from '../env.js';
import { createSessionStore } from '../hostedAuth.js';
import { aliasableEntries, aliasHash, aliasPlotLore, loadWorkLore, loreAliasesEnabled } from '../loreAliases.js';

loadRootEnv();

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const at = args.indexOf('--plot');
const only = at >= 0 ? args[at + 1] : undefined;
const rest = at >= 0 ? args.filter((_, index) => index !== at && index !== at + 1) : args;
const unknown = rest.filter((arg) => arg !== '--apply' && arg !== '--dry-run');
if (unknown.length > 0 || (at >= 0 && !only) || (rest.includes('--apply') && rest.includes('--dry-run'))) {
  console.error('usage: fix:lore-aliases [--dry-run | --apply] [--plot <id>]   (a dry run is the default)');
  process.exit(2);
}
const apply = rest.includes('--apply');

const config = readConfig();
if (!loreAliasesEnabled(config.env)) {
  console.error('LORE_ALIASES=off: the aliases are turned off, so there is nothing to write.');
  process.exit(2);
}
// Which database, without the credentials the URL carries.
const target = new URL(config.databaseUrl);
console.log(`${apply ? 'Applying to' : 'Dry run against'} ${target.host}${target.pathname}`);

const { db, close } = createDb(config.databaseUrl);
const accounts = createChatGPTAccounts(db, { secret: config.authSecret, callbackPort: config.chatgptCallbackPort });
const deps = {
  db,
  env: config.env,
  chatgpt: { accounts, sessions: createSessionStore(db, { secure: new URL(config.authUrl).protocol === 'https:' }) },
};
try {
  const rows = await db
    .select({ id: plots.id, name: plots.name, ownerId: plots.ownerId })
    .from(plots)
    .where(ne(plots.language, LORE_ALIAS_LANGUAGE))
    .orderBy(asc(plots.createdAt));
  let due = 0;
  let calls = 0;
  for (const plot of rows) {
    if (only && plot.id !== only) continue;
    const work = await loadWorkLore(deps, plot.id);
    if (!work) continue;
    const aliasable = aliasableEntries(work.language, work.entries);
    if (aliasable.length === 0) continue;
    const stored = await db
      .select({ hash: loreEntryAliases.sourceHash })
      .from(loreEntryAliases)
      .where(and(eq(loreEntryAliases.plotId, plot.id), eq(loreEntryAliases.language, LORE_ALIAS_LANGUAGE)));
    const done = new Set(stored.map((row) => row.hash));
    const pending = [...new Map(aliasable.map((entry) => [aliasHash(entry), entry])).entries()].filter(
      ([hash]) => !done.has(hash),
    );
    if (pending.length === 0) continue;
    due += 1;
    const batches = aliasBatches(pending.map(([, entry]) => entry)).length;
    calls += batches;
    const label = `${plot.id} ${JSON.stringify(plot.name)}: ${pending.length} of ${aliasable.length} keyed entries without aliases`;
    if (!apply) {
      console.log(`${label}, ${batches} call${batches === 1 ? '' : 's'}`);
      continue;
    }
    const result = await aliasPlotLore(deps, plot.id, { userId: plot.ownerId, subModel: null });
    console.log(
      `${label} — wrote ${result.written} (${result.aliases} aliases) in ${result.calls} calls` +
        (result.skipped ? `, stopped: ${result.skipped}` : ''),
    );
  }
  console.log(`${due} plots${apply ? '' : `, about ${calls} calls`}.`);
  if (!apply) console.log('Nothing was written. Run again with --apply to write it.');
} finally {
  await close();
}
