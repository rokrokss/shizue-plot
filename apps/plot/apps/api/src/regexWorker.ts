/**
 * Runs the cards' prompt scripts — RisuAI's `editprocess`, SillyTavern's
 * prompt-only regex — over a history, off the event loop and against a clock.
 *
 * A creator's pattern is full JavaScript regex: lookbehind, backreferences, the
 * features a linear engine cannot compile (re2js refuses about a third of what
 * RisuAI cards use), so it has to run on the native backtracking engine — and a
 * catastrophic one (`^(a+)+$` against a long line that almost matches) never
 * returns. One `exec` cannot be interrupted from inside, so the scripts run in a
 * small pool of worker threads, and a job that is not back in time has its
 * thread terminated and replaced. The lorebook's keys keep their linear engine
 * (`lorebook.ts`); this is the one place a card's regex runs on the server.
 *
 * The clock is `PROMPT_SCRIPT_DEADLINE_MS` a try. A real card's scripts over a
 * whole history take a few milliseconds, so the budget is far past anything
 * honest, and small beside the seconds the reply itself takes — while a pattern
 * that would hang costs at most that, once. The thread marks the script it is
 * on before each one, so the pool knows which one it had to stop: that script
 * is skipped from then on, in this process, for every chat (it is logged once),
 * and the job is tried again without it. After `MAX_TRIES`, or when no thread
 * comes free in `PROMPT_SCRIPT_QUEUE_MS`, the history goes out as stored.
 * Whatever happens the prompt is built — a script is a rewrite of
 * the turns, never a condition of sending them.
 *
 * The assembler stays pure and synchronous: the caller hands it what this
 * returns as each turn's `promptContent`, and the stored turns never change.
 */
import { Worker } from 'node:worker_threads';
import type { PromptScript, PromptScriptJob } from '@shizue/core/prompt-scripts';

/** How long one try of a job may run before its thread is terminated. */
export const PROMPT_SCRIPT_DEADLINE_MS = 200;

/**
 * Threads kept for the scripts. Two, so one generation's hung script never holds
 * up another's; a job takes milliseconds, so more would mostly sit idle.
 */
const POOL_SIZE = 2;

/** Tries a job gets, each without the script the last one was stopped in. */
const MAX_TRIES = 3;

/**
 * How long a try waits for a thread when both are busy: one job's worst case.
 * Cards whose scripts run out the clock would otherwise hold both threads and
 * queue every other reader's prompt behind them, however long the line grew. A
 * job that waits it out goes as stored, as one that runs out of tries does.
 */
export const PROMPT_SCRIPT_QUEUE_MS = PROMPT_SCRIPT_DEADLINE_MS * MAX_TRIES;

/**
 * A ceiling on the heap of a script thread: a template that multiplies its match
 * builds strings until something stops it, and this is what stops it short of
 * the server's own memory. The per-turn growth cap (`MAX_SCRIPT_GROWTH`) is the
 * gentle limit; this is the hard one, and it ends the thread like the clock does.
 */
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 };

/**
 * Scripts that ran out the clock, by what they are — never run again in this
 * process. Bounded, oldest first out, so a stream of hostile cards cannot grow it.
 */
const quarantined = new Set<string>();
const MAX_QUARANTINED = 1000;

const identityOf = (script: PromptScript): string => JSON.stringify(script);

/** What a script is called in the log: its pattern, cut short. */
const patternOf = (script: PromptScript): string =>
  (script.kind === 'risuai' ? script.in : script.find).slice(0, 120);

function quarantine(script: PromptScript): void {
  const identity = identityOf(script);
  if (quarantined.has(identity)) return;
  if (quarantined.size >= MAX_QUARANTINED) quarantined.delete(quarantined.values().next().value!);
  quarantined.add(identity);
  console.warn(`[api] a ${script.kind} prompt script ran out of time and is skipped from now on: ${patternOf(script)}`);
}

/**
 * The worker entry beside this module: `.ts` where Node runs the sources, `.js`
 * once built. Read off the path, so a loader's query on the module's URL cannot
 * turn one into the other.
 */
const THREAD_URL = new URL(
  `./regexWorkerThread${new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'}`,
  import.meta.url,
);

interface Thread {
  worker: Worker;
  /** The index of the script the job is on, or -1 before the first. */
  progress: Int32Array;
  busy: boolean;
}

/**
 * How a try ended: the texts, the index of the script it was stopped in (-1:
 * none had started), or no thread in time.
 */
type TryResult = { texts: string[] } | { stoppedAt: number } | { queued: true };

let threads: Thread[] = [];
const waiting: ((thread: Thread) => void)[] = [];
let nextId = 0;
let startFailureLogged = false;

function spawn(): Thread {
  const progress = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(THREAD_URL, {
    workerData: { progress: progress.buffer },
    resourceLimits: RESOURCE_LIMITS,
  });
  // An idle pool must never keep the process (or a test run) alive.
  worker.unref();
  const thread: Thread = { worker, progress, busy: false };
  threads.push(thread);
  return thread;
}

/** Ends a thread that ran out the clock or broke, and makes room for a fresh one. */
function retire(thread: Thread): void {
  threads = threads.filter((other) => other !== thread);
  void thread.worker.terminate();
  // Whoever is waiting gets a fresh thread rather than the dead one.
  const next = waiting.shift();
  if (next) {
    const fresh = spawn();
    fresh.busy = true;
    next(fresh);
  }
}

/** A thread for a try; null when none came free within `waitMs`. */
function acquire(waitMs: number): Promise<Thread | null> {
  const idle = threads.find((thread) => !thread.busy);
  const thread = idle ?? (threads.length < POOL_SIZE ? spawn() : undefined);
  if (thread) {
    thread.busy = true;
    return Promise.resolve(thread);
  }
  return new Promise((resolve) => {
    const take = (thread: Thread): void => {
      clearTimeout(timer);
      resolve(thread);
    };
    // Out of the line, so the thread that frees up next goes to someone still waiting.
    const timer = setTimeout(() => {
      const at = waiting.indexOf(take);
      if (at !== -1) waiting.splice(at, 1);
      resolve(null);
    }, waitMs);
    waiting.push(take);
  });
}

function release(thread: Thread): void {
  const next = waiting.shift();
  if (next) next(thread);
  else thread.busy = false;
}

function tryOnce(job: PromptScriptJob, deadlineMs: number, queueMs: number): Promise<TryResult> {
  return acquire(queueMs).then(
    (thread) =>
      thread === null ? { queued: true } : new Promise<TryResult>((resolve) => {
        const id = (nextId += 1);
        Atomics.store(thread.progress, 0, -1);
        let settled = false;
        const finish = (result: TryResult, healthy: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          thread.worker.off('message', onMessage);
          thread.worker.off('error', onError);
          thread.worker.off('exit', onExit);
          if (healthy) release(thread);
          else retire(thread);
          resolve(result);
        };
        const stopped = (): TryResult => ({ stoppedAt: Atomics.load(thread.progress, 0) });
        const onMessage = (message: { id: number; texts: string[] }): void => {
          if (message.id === id) finish({ texts: message.texts }, true);
        };
        const onError = (error: Error): void => {
          // Out of memory mid-job is said each time; a thread that cannot start
          // fails every job the same way, and is said once.
          const started = Atomics.load(thread.progress, 0) >= 0;
          if (started || !startFailureLogged) console.error('[api] prompt script thread failed', error);
          if (!started) startFailureLogged = true;
          finish(stopped(), false);
        };
        const onExit = (): void => finish(stopped(), false);
        const timer = setTimeout(() => finish(stopped(), false), deadlineMs);
        thread.worker.on('message', onMessage);
        thread.worker.on('error', onError);
        thread.worker.on('exit', onExit);
        thread.worker.postMessage({ id, job });
      }),
  );
}

/**
 * The texts the job's turns are sent as, in its order. Scripts that ran out the
 * clock before are left out; one that runs out now is left out from now on and
 * the job tried again without it. Turns come back as stored when no script is
 * left to run, when `MAX_TRIES` were not enough, or when no thread came free.
 */
export async function runPromptScriptJob(
  job: PromptScriptJob,
  { deadlineMs = PROMPT_SCRIPT_DEADLINE_MS, queueMs = PROMPT_SCRIPT_QUEUE_MS }: { deadlineMs?: number; queueMs?: number } = {},
): Promise<string[]> {
  const stored = job.messages.map((message) => message.text);
  let scripts = job.scripts.filter((script) => !quarantined.has(identityOf(script)));
  for (let tries = 0; tries < MAX_TRIES && scripts.length > 0 && job.messages.length > 0; tries += 1) {
    const result = await tryOnce({ ...job, scripts }, deadlineMs, queueMs);
    if ('texts' in result) return result.texts;
    if ('queued' in result) {
      console.warn(`[api] prompt scripts were not run: no script thread came free in ${queueMs} ms`);
      break;
    }
    const culprit = scripts[result.stoppedAt];
    // Stopped before any script started: nothing to blame, so nothing to retry without.
    if (!culprit) break;
    quarantine(culprit);
    scripts = scripts.filter((script) => script !== culprit);
  }
  return stored;
}
