import { migrateDb, openDb, type OpenedDb } from '@shizue/db';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { rollBackRestore, swapInPendingRestore, type SwappedRestore } from './backup.js';
import { dbDirOf } from './env.js';

/** Another process holds the app's folder: the app is already running, or a command is. */
export class DataDirBusy extends Error {}

/**
 * The app's database, opened by the one process that may. PGlite takes a single
 * handle on its directory, so a second process on the same folder — a second
 * start, a maintenance command while the app runs — would corrupt it. The folder's
 * `app.lock` holds the pid of the process that has it; a lock whose process is gone
 * is taken over. Closing gives the folder back.
 *
 * A restore waiting for this start (`backup.ts`) is swapped in first, with the
 * folder locked and nothing in it open; should the restored database not open,
 * the folder from before is put back and opened instead.
 */
export async function openAppDb(dataDir: string): Promise<OpenedDb> {
  let release = lockDataDir(dataDir);
  let swapped: SwappedRestore | null = null;
  try {
    swapped = swapInPendingRestore(dataDir);
  } catch (error) {
    release();
    throw error;
  }
  // The lock went with the folder from before; this one is the restored folder's.
  if (swapped) release = lockDataDir(dataDir);
  try {
    const opened = await openDb(dbDirOf(dataDir));
    try {
      await migrateDb(opened.db);
    } catch (error) {
      await opened.close();
      throw error;
    }
    return {
      ...opened,
      close: async () => {
        try {
          await opened.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    if (!swapped) throw error;
    console.error('[shizue] the restored database did not open', error);
    rollBackRestore(dataDir, swapped);
    return openAppDb(dataDir);
  }
}

function lockDataDir(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'app.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        rmSync(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
        throw new DataDirBusy(`shizue is already using ${dataDir} (pid ${pid}); stop it first.`);
      }
      // Left by a process that is gone: the folder is free.
      rmSync(path, { force: true });
    }
  }
  throw new DataDirBusy(`could not lock ${dataDir}`);
}

/**
 * Whether a process with this pid exists; one this user may not signal exists too
 * — so a pid reused by another user's process keeps the folder locked until that
 * process ends or the lock file is removed by hand.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
