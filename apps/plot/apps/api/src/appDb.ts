import { migrateDb, openDb, type OpenedDb } from '@shizue/db';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { dbDirOf } from './env.js';

/** Another process holds the app's folder: the app is already running, or a command is. */
export class DataDirBusy extends Error {}

/**
 * The app's database, opened by the one process that may. PGlite takes a single
 * handle on its directory, so a second process on the same folder — a second
 * start, a maintenance command while the app runs — would corrupt it. The folder's
 * `app.lock` holds the pid of the process that has it; a lock whose process is gone
 * is taken over. Closing gives the folder back.
 */
export async function openAppDb(dataDir: string): Promise<OpenedDb> {
  const release = lockDataDir(dataDir);
  try {
    const opened = await openDb(dbDirOf(dataDir));
    await migrateDb(opened.db);
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
    throw error;
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
