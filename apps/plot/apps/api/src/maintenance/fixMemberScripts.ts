/**
 * Lifts the display scripts, stylesheets and default variables that companions
 * imported before 355e738 left on their cards onto their works, as their own,
 * and leaves every work changed since (`memberScripts.ts`). Against
 * DATABASE_URL — apps/plot/.env's unless the environment says otherwise. Run
 * `fix:display-order` first.
 *
 *   pnpm --filter @shizue/api fix:member-scripts            dry run: prints what it would change
 *   pnpm --filter @shizue/api fix:member-scripts --apply    writes it
 */

import { createDb } from '@shizue/db';
import { loadRootEnv } from '../env.js';
import { repairMemberScripts } from './memberScripts.js';

loadRootEnv();

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const unknown = args.filter((arg) => arg !== '--apply' && arg !== '--dry-run');
if (unknown.length > 0 || (args.includes('--apply') && args.includes('--dry-run'))) {
  console.error('usage: fix:member-scripts [--dry-run | --apply]   (a dry run is the default)');
  process.exit(2);
}
const apply = args.includes('--apply');

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}
// Which database, without the credentials the URL carries.
const target = new URL(url);
console.log(`${apply ? 'Applying to' : 'Dry run against'} ${target.host}${target.pathname}`);

const { db, close } = createDb(url);
try {
  await repairMemberScripts(db, { apply });
  if (!apply) console.log('Nothing was written. Run again with --apply to write it.');
} finally {
  await close();
}
