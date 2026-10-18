/**
 * Rewrites the display scripts of plots imported before RisuAI's `<order N>` was
 * read the right way round, and leaves every plot its creator has changed since
 * (`displayOrder.ts`). Against the app's folder (SHIZUE_DATA_DIR), never while
 * the app runs.
 *
 *   pnpm --filter @shizue/api fix:display-order            dry run: prints what it would change
 *   pnpm --filter @shizue/api fix:display-order --apply    writes it
 */

import { openAppDb } from '../appDb.js';
import { dataDirOf, loadRootEnv } from '../env.js';
import { repairDisplayOrder } from './displayOrder.js';

loadRootEnv();

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const unknown = args.filter((arg) => arg !== '--apply' && arg !== '--dry-run');
if (unknown.length > 0 || (args.includes('--apply') && args.includes('--dry-run'))) {
  console.error('usage: fix:display-order [--dry-run | --apply]   (a dry run is the default)');
  process.exit(2);
}
const apply = args.includes('--apply');

// The app's folder (SHIZUE_DATA_DIR): never while the app runs — its lock refuses a second process.
const dataDir = dataDirOf(process.env);
console.log(`${apply ? 'Applying to' : 'Dry run against'} ${dataDir}`);

const { db, close } = await openAppDb(dataDir);
try {
  await repairDisplayOrder(db, { apply });
  if (!apply) console.log('Nothing was written. Run again with --apply to write it.');
} finally {
  await close();
}
