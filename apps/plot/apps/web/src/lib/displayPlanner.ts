/**
 * Where a display script's regular expressions actually run.
 *
 * The patterns come from the card, the card came from a stranger, and the reader
 * opened it. A regular expression is the one piece of this system that cannot be
 * interrupted: the transform's own wall clock is checked between matches and never
 * gets a turn if a single `exec` backtracks for a minute, and the authoring-time
 * screen in `@shizue/core/display-script` says only that a pattern has none of a few
 * known-bad shapes — `hp=\d+ a+a+a+a+a+a+a+a+a+a+b` has no parenthesised group for
 * it to look at and still doubles its running time for every two characters the
 * model adds to the line it scans.
 *
 * So the matching runs in a worker, and a worker can be terminated. This is the
 * same answer Layer 2 arrived at for creator components, for the same reason: the
 * fix for code that will not stop is a thread you can end, not a rule you hope it
 * obeys.
 *
 * What that costs, and what it does not:
 *
 *   - Only the *matching* moved. Rendering a match still happens on this thread,
 *     because it ends in DOMPurify and a worker has no DOM. That half is bounded
 *     by construction — the template engine and the sanitizer both run on fixed
 *     patterns over bounded input.
 *   - A plan depends on the message text, the scripts and the previous message,
 *     none of which change once a message has finished streaming. So it is fetched
 *     once per message and the live bindings still render synchronously on top of
 *     it: a `{{setvar}}` that moves a gauge redraws with no round trip.
 *   - A message that is still streaming is not planned at all. Half a status block
 *     is not a status block, and re-matching a growing string on every token would
 *     be both wrong and wasteful.
 *   - Requests are answered one at a time. It makes a plan that never comes back
 *     unambiguous — the request that was in flight is the one that hung — and the
 *     work per message is microseconds when nothing is wrong.
 */

import { PLAN_LIMITS, planDisplayScripts, type DisplayPlan } from './displayScripts';
import type { DisplayScript } from './types';

/**
 * How long a plan may take before the worker is treated as hung.
 *
 * Twenty times the transform's own 50ms budget. Well clear of any honest plan —
 * the cooperative deadline stops those long before this one is reached, even on a
 * thread sharing a core with a busy page — and short enough that a pattern which
 * never returns costs a background thread a second rather than the rest of the
 * session. The reader never waits on it: the message is already on screen as prose
 * while the plan is outstanding.
 */
const PLAN_DEADLINE_MS = 1000;

export interface PlanRequest {
  content: string;
  scripts: readonly DisplayScript[];
  previousSameRole: string;
}

/** The little of a `Worker` this uses, so a test can stand in for one. */
export interface PlannerWorker {
  postMessage: (message: unknown) => void;
  terminate: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface DisplayPlanner {
  /** Null when the message should be drawn as prose — including when it hung. */
  plan: (request: PlanRequest) => Promise<DisplayPlan | null>;
  /** Ends the worker. The next request starts a new one. */
  stop: () => void;
}

/* -------------------------------------------------------------- the worker */

/* eslint-disable */
/**
 * The worker's whole program. Stringified, so it may reference nothing but its
 * arguments — `plan` is `planDisplayScripts` arriving the same way.
 */
function displayPlannerRuntime(
  scope: any,
  plan: typeof planDisplayScripts,
  limits: typeof PLAN_LIMITS,
): void {
  'use strict';
  scope.onmessage = function (event: any): void {
    const data = event && event.data;
    if (!data || data.type !== 'plan') return;
    let result: unknown = null;
    try {
      result = plan(
        String(data.content),
        data.scripts || [],
        String(data.previousSameRole || ''),
        limits,
        Date.now,
      );
    } catch (error) {
      // A pattern that threw leaves the message as prose, like a blown cap.
      result = null;
    }
    scope.postMessage({ type: 'plan', id: data.id, plan: result });
  };
  scope.postMessage({ type: 'ready' });
}
/* eslint-enable */

/**
 * The worker as the blob receives it. `scope` names the global the runtime binds
 * to: `self` in a real worker, and a stand-in when a test drives the same source
 * in a realm that has no workers.
 */
export function displayPlannerSource(scope = 'self'): string {
  return `(${displayPlannerRuntime.toString()})(${scope},${planDisplayScripts.toString()},${JSON.stringify(
    PLAN_LIMITS,
  )});`;
}

let workerUrl: string | null = null;

/** A real worker, built from a blob so nothing extra has to be served. */
function spawnWorker(): PlannerWorker {
  if (!workerUrl) {
    workerUrl = URL.createObjectURL(new Blob([displayPlannerSource()], { type: 'text/javascript' }));
  }
  return new Worker(workerUrl) as unknown as PlannerWorker;
}

/* -------------------------------------------------------------- the parent */

interface Pending {
  id: number;
  request: PlanRequest;
  settle: (plan: DisplayPlan | null) => void;
}

export function createDisplayPlanner(spawn: () => PlannerWorker): DisplayPlanner {
  let worker: PlannerWorker | null = null;
  let ready = false;
  let active: Pending | null = null;
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

  /** Ends the current answer, whatever it turned out to be, and starts the next. */
  function finish(plan: DisplayPlan | null): void {
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    const done = active;
    active = null;
    done?.settle(plan);
    pump();
  }

  /**
   * Nobody is going to answer any of these. A worker that cannot start is not a
   * hung pattern to be retried — it is a realm where the transform does not run,
   * and every message waiting on one draws as prose rather than waiting forever.
   */
  function drain(): void {
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    const waiting = [...(active ? [active] : []), ...queue.splice(0)];
    active = null;
    for (const pending of waiting) pending.settle(null);
  }

  function onMessage(data: unknown): void {
    const message = data as Record<string, unknown> | null;
    if (!message || typeof message !== 'object') return;
    if (message['type'] === 'ready') {
      ready = true;
      pump();
      return;
    }
    // An answer to a request that is no longer the live one is an answer from a
    // worker we already gave up on, or a duplicate. Either way it is not ours.
    if (message['type'] !== 'plan' || !active || message['id'] !== active.id) return;
    finish((message['plan'] as DisplayPlan | null) ?? null);
  }

  function pump(): void {
    if (active || queue.length === 0) return;
    if (!worker) {
      const started = spawn();
      worker = started;
      started.onmessage = (event) => {
        // A message from a worker we have already replaced is not an answer.
        if (worker === started) onMessage(event.data);
      };
      started.onerror = () => {
        if (worker !== started) return;
        stop();
        drain();
      };
      // Nothing is timed until the worker says it exists: the first request would
      // otherwise be racing the thread's own start-up.
      return;
    }
    if (!ready) return;

    const next = queue.shift()!;
    active = next;
    deadline = setTimeout(() => {
      // The only thing that stops a pattern that will not stop. The worker takes
      // the request with it; the message it was for renders as prose, and the next
      // request gets a thread of its own.
      stop();
      finish(null);
    }, PLAN_DEADLINE_MS);
    worker.postMessage({
      type: 'plan',
      id: next.id,
      content: next.request.content,
      scripts: next.request.scripts,
      previousSameRole: next.request.previousSameRole,
    });
  }

  return {
    plan(request) {
      return new Promise((resolve) => {
        const id = nextId;
        nextId += 1;
        queue.push({ id, request, settle: resolve });
        pump();
      });
    },
    stop,
  };
}

/**
 * The one the app uses. Without `Worker` there is nowhere safe to run a stranger's
 * regular expression, so there is no transform: on the server, and in any realm
 * that has no workers, every message renders as the model wrote it.
 */
export const displayPlanner: DisplayPlanner =
  typeof Worker === 'function'
    ? createDisplayPlanner(spawnWorker)
    : { plan: () => Promise.resolve(null), stop: () => undefined };
