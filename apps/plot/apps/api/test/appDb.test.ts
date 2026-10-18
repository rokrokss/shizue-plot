/**
 * The one-process rule on the app's folder: PGlite takes a single handle on its
 * directory, so a second opener — a second start, a maintenance command while the
 * app runs — is refused rather than let in to corrupt it.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DataDirBusy, openAppDb } from '../src/appDb.js';

const folder = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), 'shizue-appdb-')), 'app');

describe('openAppDb', () => {
  it('opens and migrates the database, and refuses a second opener until the first closes', async () => {
    const dir = await folder();
    const first = await openAppDb(dir);
    try {
      expect(await readFile(join(dir, 'app.lock'), 'utf8')).toBe(String(process.pid));
      const tables = await first.client.query<{ n: number }>(
        `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
      );
      expect(tables.rows[0]!.n).toBeGreaterThan(20);
      await expect(openAppDb(dir)).rejects.toThrow(DataDirBusy);
    } finally {
      await first.close();
    }
    expect(existsSync(join(dir, 'app.lock'))).toBe(false);
    // Given back, it opens again — with what was written before.
    const again = await openAppDb(dir);
    await again.close();
  });

  it('takes over a lock whose process is gone', async () => {
    const dir = await folder();
    await openAppDb(dir).then((opened) => opened.close());
    // No process has this pid: the highest a pid can be on Linux, far past any live one here.
    await writeFile(join(dir, 'app.lock'), '4194304');
    const opened = await openAppDb(dir);
    expect(await readFile(join(dir, 'app.lock'), 'utf8')).toBe(String(process.pid));
    await opened.close();
  });
});
