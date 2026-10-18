/**
 * Lifts the display scripts, stylesheets and default variables that companions
 * imported before 355e738 left on their cards onto their works, as their own,
 * and leaves every work changed since (`memberScripts.ts`). Against the app's
 * folder (SHIZUE_DATA_DIR), never while the app runs. Run `fix:display-order`
 * first.
 *
 *   pnpm --filter @shizue/api fix:member-scripts            dry run: prints what it would change
 *   pnpm --filter @shizue/api fix:member-scripts --apply    writes it
 */

import { openAppDb } from '../appDb.js';
import { dataDirOf, loadRootEnv } from '../env.js';
import { repairMemberScripts } from './memberScripts.js';

loadRootEnv();

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const unknown = args.filter((arg) => arg !== '--apply' && arg !== '--dry-run');
if (unknown.length > 0 || (args.includes('--apply') && args.includes('--dry-run'))) {
  console.error('usage: fix:member-scripts [--dry-run | --apply]   (a dry run is the default)');
  process.exit(2);
}
const apply = args.includes('--apply');

// The app's folder (SHIZUE_DATA_DIR): never while the app runs — its lock refuses a second process.
const dataDir = dataDirOf(process.env);
console.log(`${apply ? 'Applying to' : 'Dry run against'} ${dataDir}`);

const { db, close } = await openAppDb(dataDir);
try {
  await repairMemberScripts(db, { apply });
  if (!apply) console.log('Nothing was written. Run again with --apply to write it.');
} finally {
  await close();
}
