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
 * So the transform runs in a worker, and a worker can be terminated. This is the
 * same answer Layer 2 arrived at for creator components, for the same reason: the
 * fix for code that will not stop is a thread you can end, not a rule you hope it
 * obeys.
 *
 * What that costs, and what it does not:
 *
 *   - The whole transform moved, the CBS reads between the scripts with it
 *     (`transformDisplay`), since RisuAI reads each script's output as CBS before
 *     the next one matches. Only the sanitizing stays on this thread, because it
 *     ends in DOMPurify and a worker has no DOM.
 *   - A plan depends on the message, the scripts, the previous message and the
 *     bindings the CBS reads. The bindings cross once per context (`context`
 *     messages), not once per message, and a message whose bindings moved keeps
 *     its last plan on screen until the new one lands (`MessageBody`).
 *   - A message that is still streaming is not planned at all. Half a status block
 *     is not a status block, and re-matching a growing string on every token would
 *     be both wrong and wasteful.
 *   - Requests are answered one at a time. It makes a plan that never comes back
 *     unambiguous — the request that was in flight is the one that hung — and the
 *     work per message is milliseconds when nothing is wrong. One nobody waits on
 *     any more — its bindings moved on before its turn — is dropped unasked.
 *   - Answers are kept (`cached`), as RisuAI keeps the result of its display pass
 *     (`processScriptCache` in its `process/scripts.ts`, a thousand entries keyed
 *     by the text and the scripts). RisuAI runs that pass on this thread every
 *     time a message is drawn, and the cache is what makes drawing it again cheap;
 *     here it is what lets a message drawn again — scrolled back into a window,
 *     swiped back to, its neighbour edited — paint styled at once instead of as
 *     prose until a round trip lands. A message that hung is kept as prose too,
 *     so it never holds the queue up a second time.
 */

import type { CbsContext } from './cbs';
import { KEPT_CONTEXTS, type PlanAnswer, type PlanBindings, type PlanMessage } from './displayPlanJob';
import type { DisplayPlan } from './displayScripts';
import type { DisplayScript } from './types';

/**
 * How long a plan may take before the worker is treated as hung.
 *
 * Four times the transform's own 250ms budget. Well clear of any honest plan —
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
  /**
   * The bindings the scripts' CBS reads. Keep its identity, and the scripts':
   * the pair is what crosses to the worker once and what a plan is kept under.
   */
  context: CbsContext;
  /** The message's place, RisuAI's way, for `{{chat_index}}`. */
  chatIndex?: number;
  /** The chat's background rather than a message (`DisplayRequest.background`). */
  background?: boolean;
}

/** The little of a `Worker` this uses, so a test can stand in for one. */
export interface PlannerWorker {
  postMessage: (message: unknown) => void;
  terminate: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface DisplayPlanner {
  /**
   * Null when the message should be drawn as prose — including when it hung. A
   * request every asker has given up on (`signal`) before its turn is not sent.
   */
  plan: (request: PlanRequest, signal?: AbortSignal) => Promise<DisplayPlan | null>;
  /** The answer already in hand for this request, or undefined when it has to be asked for. */
  cached: (request: PlanRequest) => DisplayPlan | null | undefined;
  /**
   * Whether any request has been answered yet — however it ended. Until then the
   * page is opening cold (a reload, a chat's first open), and the worker is still
   * starting under messages that would otherwise paint as prose first.
   */
  warm: () => boolean;
  /** Ends the worker. The next request starts a new one. */
  stop: () => void;
}

/** How many answers are kept: RisuAI's thousand. */
const MAX_CACHED_PLANS = 1000;

/** A number for each context and scripts the page drew with, for as long as it holds them. */
const contextIds = new WeakMap<CbsContext, WeakMap<readonly DisplayScript[], number>>();
let nextContextId = 1;

function contextIdOf(context: CbsContext, scripts: readonly DisplayScript[]): number {
  let byScripts = contextIds.get(context);
  if (!byScripts) {
    byScripts = new WeakMap();
    contextIds.set(context, byScripts);
  }
  let id = byScripts.get(scripts);
  if (id === undefined) {
    id = nextContextId;
    nextContextId += 1;
    byScripts.set(scripts, id);
  }
  return id;
}

/**
 * A context as it can cross to the worker: no function (the resolver is built
 * again there from `namedAssets`), no scripts (they cross beside it), and the
 * window's size, which the worker has no window to ask.
 */
function bindingsOf(context: CbsContext): PlanBindings {
  const { resolveAsset: _resolver, random: _draw, chatIndex: _index, ...rest } = context;
  const bindings: PlanBindings & { scripts?: unknown } = { ...rest };
  delete bindings.scripts;
  if (typeof window !== 'undefined') bindings.screen = { width: window.innerWidth, height: window.innerHeight };
  return bindings;
}

const keyOf = (request: PlanRequest): string =>
  [
    contextIdOf(request.context, request.scripts),
    request.chatIndex ?? '',
    request.background ? 'b' : '',
    request.previousSameRole,
    request.content,
  ].join('\u0000');

/** A real worker; the bundler makes `displayPlannerWorker.ts` its own chunk. */
const spawnWorker = (): PlannerWorker =>
  new Worker(new URL('./displayPlannerWorker.ts', import.meta.url), { type: 'module' }) as unknown as PlannerWorker;

/* -------------------------------------------------------------- the parent */

interface Pending {
  id: number;
  key: string;
  request: PlanRequest;
  answer: Promise<DisplayPlan | null>;
  /**
   * `keep`: kept as the answer — not for one answered about nothing. `asked`:
   * false for one let go before its turn, which says nothing of the worker.
   */
  settle: (plan: DisplayPlan | null, keep: boolean, asked?: boolean) => void;
  /** Askers waiting on it, and how many of them have given up. */
  waiters: number;
  abandoned: number;
}

export function createDisplayPlanner(spawn: () => PlannerWorker): DisplayPlanner {
  /** Answers by `keyOf`, the most recently used last. */
  const kept = new Map<string, DisplayPlan | null>();
  /** Answers on their way, so a message drawn twice before one lands asks once. */
  const asking = new Map<string, Pending>();
  let answeredOnce = false;
  let worker: PlannerWorker | null = null;
  let ready = false;
  /** The contexts the worker holds, oldest first — counted as it counts them (`KEPT_CONTEXTS`). */
  const held = new Set<number>();
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
    held.clear();
  }

  /** Ends the current answer, whatever it turned out to be, and starts the next. */
  function finish(plan: DisplayPlan | null, keep = true): void {
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    const done = active;
    active = null;
    done?.settle(plan, keep);
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
    for (const pending of waiting) pending.settle(null, true);
  }

  function onMessage(data: unknown): void {
    const message = data as PlanAnswer | null;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      ready = true;
      pump();
      return;
    }
    // An answer to a request that is no longer the live one is an answer from a
    // worker we already gave up on, or a duplicate. Either way it is not ours.
    if (message.type !== 'plan' || !active || message.id !== active.id) return;
    // A worker that had let the context go answered about nothing; nothing to keep.
    finish(message.plan ?? null, !message.missing);
  }

  function post(message: PlanMessage): void {
    worker!.postMessage(message);
  }

  function pump(): void {
    if (active) return;
    // One nobody waits on any more is let go unasked, and kept as nothing.
    while (queue.length > 0 && queue[0]!.abandoned >= queue[0]!.waiters) queue.shift()!.settle(null, false, false);
    if (queue.length === 0) return;
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
    const { request } = next;
    const context = contextIdOf(request.context, request.scripts);
    if (!held.has(context)) {
      post({ type: 'context', id: context, bindings: bindingsOf(request.context), scripts: request.scripts });
      held.add(context);
      if (held.size > KEPT_CONTEXTS) held.delete(held.values().next().value!);
    }
    deadline = setTimeout(() => {
      // The only thing that stops a pattern that will not stop. The worker takes
      // the request with it; the message it was for renders as prose, and the next
      // request gets a thread of its own.
      stop();
      finish(null);
    }, PLAN_DEADLINE_MS);
    post({
      type: 'plan',
      id: next.id,
      context,
      content: request.content,
      previousSameRole: request.previousSameRole,
      ...(request.chatIndex !== undefined ? { chatIndex: request.chatIndex } : {}),
      ...(request.background ? { background: true } : {}),
    });
  }

  function cached(request: PlanRequest): DisplayPlan | null | undefined {
    const key = keyOf(request);
    if (!kept.has(key)) return undefined;
    const plan = kept.get(key)!;
    kept.delete(key);
    kept.set(key, plan);
    return plan;
  }

  return {
    plan(request, signal) {
      const hit = cached(request);
      if (hit !== undefined) return Promise.resolve(hit);
      const key = keyOf(request);
      let pending = asking.get(key);
      if (!pending) {
        let resolve!: (plan: DisplayPlan | null) => void;
        const answer = new Promise<DisplayPlan | null>((done) => {
          resolve = done;
        });
        const id = nextId;
        nextId += 1;
        const entry: Pending = {
          id,
          key,
          request,
          answer,
          waiters: 0,
          abandoned: 0,
          settle: (plan, keep, asked = true) => {
            asking.delete(key);
            if (asked) answeredOnce = true;
            if (keep) {
              if (kept.size >= MAX_CACHED_PLANS) kept.delete(kept.keys().next().value!);
              kept.set(key, plan);
            }
            resolve(plan);
          },
        };
        pending = entry;
        asking.set(key, entry);
        queue.push(entry);
      }
      const waiting = pending;
      waiting.waiters += 1;
      if (signal) {
        if (signal.aborted) waiting.abandoned += 1;
        else signal.addEventListener('abort', () => (waiting.abandoned += 1), { once: true });
      }
      pump();
      return waiting.answer;
    },
    cached,
    warm: () => answeredOnce,
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
    : { plan: () => Promise.resolve(null), cached: () => null, warm: () => true, stop: () => undefined };
