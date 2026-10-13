/**
 * Where a card's `editinput` and `editoutput` regex scripts run: a worker the
 * page can end, against a clock.
 *
 * A card's pattern is full JavaScript regex on the native backtracking engine,
 * and a catastrophic one (`(a+)+$` against a long reply that almost matches)
 * never returns. One `exec` cannot be interrupted from inside, so on this thread
 * it took the tab with it — and `finishMark` could only give the reply up after
 * the reader reloaded. This is the server's prompt-script pool (`regexWorker.ts`
 * in the API) in a browser: the pass runs in a worker, a pass that is not back
 * in time has its worker terminated and replaced, the script it was in is set
 * aside for the rest of the page's life (said once), and the pass is tried again
 * without it. After `MAX_TRIES`, or when no worker will start, the text goes on
 * as it was, as the server sends a history as stored.
 *
 * One worker, not the server's two: passes come one at a time here — a send's,
 * then a reply's — behind the page's own lock on the chat. The worker tells its
 * parent which script it is starting (`at`); a browser page has no
 * `SharedArrayBuffer` without cross-origin isolation, and a message posted
 * before a pass hangs is still delivered.
 *
 * The clock, `EDIT_SCRIPT_DEADLINE_MS`, starts once the worker says it is up, so
 * loading its bundle on a slow phone is never mistaken for a hung pattern.
 */

import type { EditScript } from '@shizue/core/triggers';
import { runEditJob, type EditJob, type EditWorkerMessage } from './editScriptJob';

/**
 * How long one try of a pass may run, from when it reaches a running worker.
 *
 * The server gives a prompt script 200ms on a warm thread of a machine it
 * knows. A reader's phone is several times slower, and a pass stopped here is
 * not merely late: its script is set aside and the reply is stored without it.
 * So the same second the display planner allows (`displayPlanner.ts`) — a real
 * card's pass over a long reply takes a few milliseconds on a laptop, hundreds
 * of times inside this — and what a hung pattern costs is the reply finishing a
 * second late, once, with the page responsive throughout, since the next pass
 * runs without that script.
 */
export const EDIT_SCRIPT_DEADLINE_MS = 1000;

/** Tries a pass gets, each without the script the last one was stopped in. */
const MAX_TRIES = 3;

/** Scripts that ran out the clock, by what they are — never run again on this page. Bounded, oldest out first. */
const quarantined = new Set<string>();
const MAX_QUARANTINED = 1000;

const identityOf = (script: EditScript): string => JSON.stringify(script);

export interface EditOutcome {
  text: string;
  /** Scripts the pass skipped as RisuAI skips them — a pattern that does not compile — and why. */
  skipped: { script: EditScript; reason: string }[];
  /** What the clock did: a script set aside, a pass given up. For the runtime's log. */
  notices: string[];
}

export type EditScriptRunner = (job: EditJob) => Promise<EditOutcome>;

/** The little of a `Worker` this uses, so a test can stand in for one. */
export interface EditWorker {
  postMessage: (message: unknown) => void;
  terminate: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** How one try ended: the pass, the script it was stopped in (-1: none had started), or no worker to run it. */
type TryResult =
  | { kind: 'done'; text: string; skipped: { index: number; reason: string }[] }
  | { kind: 'stopped'; at: number }
  | { kind: 'unavailable'; reason: string };

interface Pending {
  id: number;
  job: EditJob;
  settle: (result: TryResult) => void;
}

const outcomeOf = (job: EditJob, result: Extract<TryResult, { kind: 'done' }>, notices: string[]): EditOutcome => ({
  text: result.text,
  skipped: result.skipped.flatMap(({ index, reason }) => {
    const script = job.scripts[index];
    return script ? [{ script, reason }] : [];
  }),
  notices,
});

export function createEditScriptRunner(
  spawn: () => EditWorker,
  { deadlineMs = EDIT_SCRIPT_DEADLINE_MS }: { deadlineMs?: number } = {},
): EditScriptRunner & { stop: () => void } {
  let worker: EditWorker | null = null;
  let ready = false;
  let active: (Pending & { at: number }) | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;
  const queue: Pending[] = [];

  function stop(): void {
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    worker?.terminate();
    worker = null;
    ready = false;
  }

  function finish(result: TryResult): void {
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    const done = active;
    active = null;
    done?.settle(result);
    pump();
  }

  /** A worker that cannot start is no hung pattern: everything waiting goes on without the scripts. */
  function drain(reason: string): void {
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    const waiting = [...(active ? [active] : []), ...queue.splice(0)];
    active = null;
    for (const pending of waiting) pending.settle({ kind: 'unavailable', reason });
  }

  function onMessage(data: unknown): void {
    const message = data as EditWorkerMessage | null;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      ready = true;
      pump();
      return;
    }
    // Anything about a job that is not the live one is from a worker given up on.
    if (!active || message.id !== active.id) return;
    if (message.type === 'at') active.at = message.index;
    else if (message.type === 'done') finish({ kind: 'done', text: message.result.text, skipped: message.result.skipped });
    else if (message.type === 'failed') finish({ kind: 'unavailable', reason: message.error });
  }

  function pump(): void {
    if (active || queue.length === 0) return;
    if (!worker) {
      const started = spawn();
      worker = started;
      started.onmessage = (event) => {
        if (worker === started) onMessage(event.data);
      };
      started.onerror = () => {
        if (worker !== started) return;
        const running = active;
        const wasUp = ready;
        stop();
        // Mid-pass (out of memory, say) it is the script it was in; before it ever
        // came up, there is no worker to be had.
        if (running && wasUp) finish({ kind: 'stopped', at: running.at });
        else drain('the edit worker could not start');
      };
      return;
    }
    if (!ready) return;

    const next = { ...queue.shift()!, at: -1 };
    active = next;
    try {
      worker.postMessage({ type: 'edit', id: next.id, job: next.job });
    } catch (error) {
      // Something in the job that cannot cross: nothing ran.
      finish({ kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    deadline = setTimeout(() => {
      // The only thing that stops a pattern that will not stop. The next try gets
      // a worker of its own.
      const at = active?.at ?? -1;
      stop();
      finish({ kind: 'stopped', at });
    }, deadlineMs);
  }

  function tryOnce(job: EditJob): Promise<TryResult> {
    return new Promise((settle) => {
      queue.push({ id: nextId++, job, settle });
      pump();
    });
  }

  async function run(job: EditJob): Promise<EditOutcome> {
    const notices: string[] = [];
    let scripts = job.scripts.filter((script) => !quarantined.has(identityOf(script)));
    for (let tries = 0; tries < MAX_TRIES; tries += 1) {
      if (!scripts.some((script) => script.type === job.mode && script.in !== '')) {
        return { text: job.text, skipped: [], notices };
      }
      const attempt = { ...job, scripts };
      const result = await tryOnce(attempt);
      if (result.kind === 'done') return outcomeOf(attempt, result, notices);
      if (result.kind === 'unavailable') {
        notices.push(`the ${job.mode} scripts could not run (${result.reason}); the text is kept as it was`);
        return { text: job.text, skipped: [], notices };
      }
      const culprit = scripts[result.at];
      // Stopped before any script started: nothing to blame, so nothing to retry without.
      if (!culprit) break;
      if (!quarantined.has(identityOf(culprit))) {
        if (quarantined.size >= MAX_QUARANTINED) quarantined.delete(quarantined.values().next().value!);
        quarantined.add(identityOf(culprit));
        notices.push(`an ${job.mode} script ran out of time and is skipped from now on: ${culprit.in.slice(0, 120)}`);
      }
      scripts = scripts.filter((script) => script !== culprit);
    }
    notices.push(`the ${job.mode} scripts ran out of time; the text is kept as it was`);
    return { text: job.text, skipped: [], notices };
  }

  return Object.assign(run, { stop });
}

/**
 * The pass on this thread, for a realm with no workers — the unit tests, which
 * have no catastrophic patterns to fear. `random` is the run's.
 */
export function inlineEditRunner(random?: () => number): EditScriptRunner {
  return async (job) => {
    const result = runEditJob(job, random ? { random } : {});
    return outcomeOf(job, { kind: 'done', ...result }, []);
  };
}

/** A real worker; the bundler makes `editScriptWorker.ts` its own chunk. */
const spawnWorker = (): EditWorker =>
  new Worker(new URL('./editScriptWorker.ts', import.meta.url), { type: 'module' }) as unknown as EditWorker;

let shared: EditScriptRunner | null = null;

/** The page's runner: one worker for every chat it opens, started on the first pass. */
export function editScriptRunner(): EditScriptRunner {
  shared ??= createEditScriptRunner(spawnWorker);
  return shared;
}
