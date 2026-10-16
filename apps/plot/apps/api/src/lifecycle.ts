/**
 * What a shutdown waits for, and what a stray failure does to the process
 * (`index.ts`, ARCHITECTURE §12 운영).
 */
import type { BackgroundTaskKind } from './deps.js';
import { backgroundFinished, backgroundStarted } from './metrics.js';

/** The fire-and-forget tasks this process has running (`deps.onBackgroundTask`). */
export interface BackgroundTasks {
  /** `deps.onBackgroundTask`: counts the task and keeps it until it settles. */
  track(task: Promise<void>, kind: BackgroundTaskKind): void;
  /** How many are running now, by kind. */
  inFlight(): Map<BackgroundTaskKind, number>;
  /** Waits until none is running or `deadlineMs` has passed, and answers how many still are. */
  drain(deadlineMs: number): Promise<number>;
}

export function createBackgroundTasks(): BackgroundTasks {
  /** Each task's settling, kept until it has: what `drain` waits on. */
  const running = new Map<Promise<void>, BackgroundTaskKind>();
  return {
    track(task, kind) {
      backgroundStarted.inc({ kind });
      // The tasks swallow and log their own failures before they get here
      // (`memory.ts` and the rest), so `error` is one that broke that rule.
      const settled: Promise<void> = task
        .then(() => 'ok', () => 'error')
        .then((outcome) => {
          running.delete(settled);
          backgroundFinished.inc({ kind, outcome });
        });
      running.set(settled, kind);
    },
    inFlight() {
      const counts = new Map<BackgroundTaskKind, number>();
      for (const kind of running.values()) counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return counts;
    },
    async drain(deadlineMs) {
      const deadline = Date.now() + deadlineMs;
      // Asked again until none is left: a task may start another as it ends (a
      // memory run's vectors, a stopped reply's summary).
      while (running.size > 0) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all(running.keys()),
          new Promise<void>((resolve) => (timer = setTimeout(resolve, left))),
        ]);
        clearTimeout(timer);
      }
      return running.size;
    },
  };
}

/**
 * `unhandledRejection`: logged, and the process goes on — a deliberate
 * departure from Node's default, which ends it. Every reader's open stream lives
 * in this one process (§12), and one promise nobody awaited, in some background
 * path, must not cut all of them. An exception nothing caught still ends the
 * process, through the same graceful shutdown as a signal (`index.ts`).
 */
export function onUnhandledRejection(reason: unknown): void {
  console.error('[api] unhandled promise rejection; the process goes on', reason);
}
