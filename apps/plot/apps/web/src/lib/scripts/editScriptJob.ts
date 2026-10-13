/**
 * One pass of a card's `editinput` or `editoutput` regex scripts, as plain data
 * in and plain data out — what the edit worker (`editScriptWorker.ts`) runs, and
 * what this thread runs where there is no worker (`editScriptRunner.ts`).
 *
 * The pass itself is `runEditScripts` (`@shizue/core/triggers`). What it reads
 * besides the text — the chat variables as the runs before it left them, the
 * reader's global variables, what the evaluator may say of the reader's side —
 * crosses to the worker as a snapshot, since a function cannot: the
 * replacement templates only read variables (RisuAI's `risuChatParser` runs them
 * with `runVar` off), so a snapshot is all they ever see.
 *
 * Imports nothing but `@shizue/core` at run time, so Node can host this file in
 * a worker thread as it is (`test/editScriptThread.test.ts`).
 */

import { runEditScripts, type EditScript, type EditScriptType } from '@shizue/core/triggers';
import type { CbsHostData } from '@shizue/core/cbs';
import { applyVariableDelta, readVariable, type Variables } from '@shizue/core/variables';

/** Everything a pass reads. Structured-cloneable: no function anywhere in it. */
export interface EditJob {
  text: string;
  scripts: readonly EditScript[];
  mode: EditScriptType;
  /** RisuAI's `chatID`: -1 for what the reader is sending. */
  chatIndex: number;
  /** The last message of the same role before this one, for `repeat_back`. */
  previousSameRole?: string;
  variables: Variables;
  globals: Variables;
  data?: Omit<CbsHostData, 'chat' | 'lorebook'>;
}

/** A script the pass skipped — by its place in the job's list — and why. */
export interface EditSkip {
  index: number;
  reason: string;
}

export interface EditJobResult {
  text: string;
  skipped: EditSkip[];
}

/**
 * The pass. `onScript` hears each script's index before it runs, so whoever
 * stops a pass that never comes back knows which script it was in; `random` is
 * the run's, where the caller has one to give (only this thread does).
 */
export function runEditJob(
  job: EditJob,
  hooks: { onScript?: (index: number) => void; random?: () => number } = {},
): EditJobResult {
  // A snapshot that crossed a thread has lost its null prototype; read it as the map it was.
  const variables = applyVariableDelta(job.variables, null);
  const globals = applyVariableDelta(job.globals, null);
  const skipped: EditSkip[] = [];
  const text = runEditScripts(job.text, job.scripts, job.mode, {
    chatIndex: job.chatIndex,
    ...(job.previousSameRole !== undefined ? { previousSameRole: job.previousSameRole } : {}),
    env: {
      variable: (name) => readVariable(variables, name),
      globalVariable: (name) => readVariable(globals, name),
      ...(hooks.random ? { random: hooks.random } : {}),
      ...(job.data ? { data: job.data } : {}),
    },
    onSkip: (script, reason) => skipped.push({ index: job.scripts.indexOf(script), reason }),
    ...(hooks.onScript ? { onScript: hooks.onScript } : {}),
  });
  return { text, skipped };
}

/** What the worker and its parent say to each other. */
export type EditWorkerMessage =
  | { type: 'ready' }
  /** The job `id` is about to run the script at `index`. */
  | { type: 'at'; id: number; index: number }
  | { type: 'done'; id: number; result: EditJobResult }
  /** The pass threw outside any one script; the parent keeps the text as it was. */
  | { type: 'failed'; id: number; error: string };

/** The little of a worker's global this needs. */
export interface EditWorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: EditWorkerMessage): void;
}

/** Answers jobs on `scope`, one at a time, saying where each one is as it goes. */
export function serveEditJobs(scope: EditWorkerScope): void {
  scope.onmessage = (event) => {
    const data = event.data as { type?: unknown; id?: unknown; job?: EditJob } | null;
    if (!data || data.type !== 'edit' || typeof data.id !== 'number' || !data.job) return;
    const id = data.id;
    try {
      const result = runEditJob(data.job, { onScript: (index) => scope.postMessage({ type: 'at', id, index }) });
      scope.postMessage({ type: 'done', id, result });
    } catch (error) {
      scope.postMessage({ type: 'failed', id, error: error instanceof Error ? error.message : String(error) });
    }
  };
  scope.postMessage({ type: 'ready' });
}
