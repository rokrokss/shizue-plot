// @vitest-environment jsdom
/**
 * The half of the transform that can hang, and the thread it hangs on.
 *
 * Two things are proved here. That the worker's job (`serveDisplayPlans`) plans a
 * message correctly from what crosses to it — a context as data, sent once, and
 * a request per message — and that a pattern which never returns costs one
 * worker and one message, rather than the reader's tab.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEPT_CONTEXTS, serveDisplayPlans, type PlanWorkerScope } from '../src/lib/displayPlanJob';
import { createDisplayPlanner, displayPlanner, type PlannerWorker, type PlanRequest } from '../src/lib/displayPlanner';
import {
  displayContextAt,
  displayScriptsAt,
  PLAN_LIMITS,
  renderDisplayPlan,
  transformDisplay,
  type DisplayContext,
  type DisplayPlan,
} from '../src/lib/displayScripts';
import type { DisplayScript } from '../src/lib/types';

const script = (overrides: Partial<DisplayScript> = {}): DisplayScript => ({
  in: '\\[status\\] hp=(\\d+)',
  out: '<div class="hp">HP $1</div>',
  order: 0,
  enabled: true,
  ...overrides,
});

const context = (scripts: DisplayScript[], overrides: Partial<DisplayContext> = {}): DisplayContext => ({
  scripts,
  variables: { gold: '12' },
  assets: new Map(),
  turn: 1,
  char: '아리아',
  user: '민준',
  ...overrides,
});

/* ----------------------------------------------------------------- the job */

/** The job against a stand-in global, as the worker entry runs it. */
function bootJob(): { send: (message: unknown) => void; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const scope: PlanWorkerScope = {
    onmessage: null,
    postMessage: (data) => sent.push(structuredClone(data) as Record<string, unknown>),
  };
  serveDisplayPlans(scope);
  // Everything crosses by structured clone, as it would between threads.
  return { send: (message) => scope.onmessage?.({ data: structuredClone(message) }), sent };
}

/** A context as the page sends it: data only. */
const bindings = (ctx: DisplayContext): Record<string, unknown> => {
  const { scripts: _scripts, resolveAsset: _resolver, ...rest } = ctx;
  return rest;
};

describe('the worker’s job', () => {
  it('announces itself before it is asked for anything', () => {
    expect(bootJob().sent).toEqual([{ type: 'ready' }]);
  });

  it('plans a status line from a context it was sent once, and the plan sanitizes to the markup', () => {
    const job = bootJob();
    const ctx = context([script({ out: '<div class="hp">HP $1 · {{getvar::gold}} · {{chat_index}}</div>' })]);
    job.send({ type: 'context', id: 1, bindings: bindings(ctx), scripts: ctx.scripts });
    job.send({ type: 'plan', id: 7, context: 1, content: '앞 [status] hp=50 뒤', previousSameRole: '', chatIndex: 3 });
    const answer = job.sent[1]!;
    expect(answer['type']).toBe('plan');
    expect(answer['id']).toBe(7);
    const plan = answer['plan'] as DisplayPlan;
    // Prose, and the creator's markup with the bindings already read into it.
    expect(plan.body).toEqual([
      { kind: 'text', text: '앞 ' },
      // The line break RisuAI writes after a template that ends in `>`; the sanitized island drops it.
      { kind: 'html', html: '<div class="hp">HP \u000250\u0003 · \u000112\u0001 · 3</div>\n' },
      { kind: 'text', text: ' 뒤' },
    ]);
    // Sanitized on the other side, the marks taken off.
    expect(renderDisplayPlan(plan)).toEqual([
      { kind: 'text', text: '앞 ' },
      { kind: 'html', html: '<div class="x-shizue-hp">HP 50 · 12 · 3</div>' },
      { kind: 'text', text: ' 뒤' },
    ]);
  });

  it('builds the image resolver again from the names it was sent', () => {
    const job = bootJob();
    const ctx = context([script({ out: '<p>{{img::profile.png}}</p>' })], {
      assets: new Map([['aria', '/api/plots/p1/assets/aria']]),
      namedAssets: [{ slug: 'aria', name: 'profile.png' }],
    });
    job.send({ type: 'context', id: 1, bindings: bindings(ctx), scripts: ctx.scripts });
    job.send({ type: 'plan', id: 1, context: 1, content: '[status] hp=1', previousSameRole: '' });
    const plan = job.sent[1]!['plan'] as DisplayPlan;
    expect(renderDisplayPlan(plan)).toEqual([
      { kind: 'html', html: '<p><img src="/api/plots/p1/assets/aria" alt="aria"></p>' },
    ]);
  });

  it('answers a message with nothing to do with null, one it holds no context for as missing, and nothing else', () => {
    const job = bootJob();
    job.send({ type: 'context', id: 1, bindings: bindings(context([])), scripts: [] });
    job.send({ type: 'plan', id: 2, context: 1, content: '안녕', previousSameRole: '' });
    expect(job.sent[1]).toEqual({ type: 'plan', id: 2, plan: null });
    job.send({ type: 'plan', id: 3, context: 9, content: '안녕', previousSameRole: '' });
    expect(job.sent[2]).toEqual({ type: 'plan', id: 3, plan: null, missing: true });
    job.send({ type: 'nonsense' });
    expect(job.sent).toHaveLength(3);
  });

  it('keeps the contexts it was sent last, as many as the page counts on', () => {
    const job = bootJob();
    const ctx = context([script()]);
    for (let id = 1; id <= KEPT_CONTEXTS + 1; id += 1) {
      job.send({ type: 'context', id, bindings: bindings(ctx), scripts: ctx.scripts });
    }
    job.send({ type: 'plan', id: 1, context: 1, content: '[status] hp=1', previousSameRole: '' });
    job.send({ type: 'plan', id: 2, context: 2, content: '[status] hp=1', previousSameRole: '' });
    expect(job.sent[1]!['missing']).toBe(true);
    expect(job.sent[2]!['plan']).not.toBeNull();
  });
});

/* ------------------------------------------------------- a pattern that hangs */

/** A worker under the test's control: it answers when told to, or never. */
class StubWorker implements PlannerWorker {
  static made: StubWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  /** Contexts it was sent. */
  contexts: Record<string, unknown>[] = [];
  /** Requests it received and has not answered. */
  asked: Record<string, unknown>[] = [];
  /** When set, it takes requests and never answers — a pattern that will not return. */
  deaf = false;

  constructor() {
    StubWorker.made.push(this);
  }

  ready(): void {
    this.onmessage?.({ data: { type: 'ready' } });
  }

  postMessage(message: unknown): void {
    if (this.terminated) return;
    const data = message as Record<string, unknown>;
    if (data['type'] === 'context') this.contexts.push(data);
    else this.asked.push(data);
  }

  /** Answers the oldest outstanding request with a plan of its own choosing. */
  answer(plan: DisplayPlan | null, extra: Record<string, unknown> = {}): void {
    const request = this.asked.shift()!;
    if (this.deaf || this.terminated) return;
    this.onmessage?.({ data: { type: 'plan', id: request['id'], plan, ...extra } });
  }

  terminate(): void {
    this.terminated = true;
  }
}

const EMPTY: DisplayPlan = { top: [], body: [{ kind: 'text', text: 'x' }], bottom: [] };
const SCRIPTS = [script()];
const CONTEXT = context(SCRIPTS);
const request: PlanRequest = { content: '[status] hp=50', scripts: SCRIPTS, previousSameRole: '', context: CONTEXT };

describe('a worker that stops answering', () => {
  afterEach(() => {
    StubWorker.made = [];
    vi.useRealTimers();
  });

  const start = () => createDisplayPlanner(() => new StubWorker());

  it('times nothing until the worker exists', async () => {
    vi.useFakeTimers();
    const planner = start();
    const pending = planner.plan(request);
    // Started, but not yet timed: a worker's own boot must not eat the deadline.
    expect(StubWorker.made).toHaveLength(1);
    expect(StubWorker.made[0]!.asked).toHaveLength(0);
    StubWorker.made[0]!.ready();
    expect(StubWorker.made[0]!.asked).toHaveLength(1);
    StubWorker.made[0]!.answer(EMPTY);
    await expect(pending).resolves.toEqual(EMPTY);
  });

  it('terminates it and draws the message as prose', async () => {
    vi.useFakeTimers();
    const planner = start();
    const pending = planner.plan(request);
    const worker = StubWorker.made[0]!;
    worker.deaf = true;
    worker.ready();

    vi.advanceTimersByTime(999);
    expect(worker.terminated).toBe(false);
    vi.advanceTimersByTime(2);
    expect(worker.terminated).toBe(true);
    await expect(pending).resolves.toBeNull();
  });

  it('gives the next message a thread of its own, and sends it the context again', async () => {
    vi.useFakeTimers();
    const planner = start();
    const hung = planner.plan(request);
    const first = StubWorker.made[0]!;
    first.deaf = true;
    first.ready();
    vi.advanceTimersByTime(1001);
    await expect(hung).resolves.toBeNull();

    const after = planner.plan({ ...request, content: '[status] hp=49' });
    expect(StubWorker.made).toHaveLength(2);
    const second = StubWorker.made[1]!;
    expect(second.terminated).toBe(false);
    second.ready();
    expect(second.contexts).toHaveLength(1);
    second.answer(EMPTY);
    await expect(after).resolves.toEqual(EMPTY);
  });

  it('does not let a late answer from a terminated worker land', async () => {
    vi.useFakeTimers();
    const planner = start();
    const hung = planner.plan(request);
    const first = StubWorker.made[0]!;
    first.ready();
    vi.advanceTimersByTime(1001);
    await expect(hung).resolves.toBeNull();

    const after = planner.plan({ ...request, content: '[status] hp=49' });
    // The old worker comes back to life with the answer nobody is waiting for.
    first.terminated = false;
    first.answer(EMPTY);
    StubWorker.made[1]!.ready();
    StubWorker.made[1]!.answer(null);
    await expect(after).resolves.toBeNull();
  });

  it('answers one at a time, in order, sending a context once', async () => {
    const planner = start();
    const first = planner.plan({ ...request, content: 'a' });
    const second = planner.plan({ ...request, content: 'b' });
    const worker = StubWorker.made[0]!;
    worker.ready();
    expect(worker.asked.map((message) => message['content'])).toEqual(['a']);
    worker.answer(EMPTY);
    await expect(first).resolves.toEqual(EMPTY);
    expect(worker.asked.map((message) => message['content'])).toEqual(['b']);
    worker.answer(null);
    await expect(second).resolves.toBeNull();
    // One context for both, as data: the scripts beside it, no function in it.
    expect(worker.contexts).toHaveLength(1);
    expect(worker.contexts[0]!['scripts']).toBe(SCRIPTS);
    expect(() => structuredClone(worker.contexts[0])).not.toThrow();
  });

  it('takes a worker that fails to start as a message to draw plainly', async () => {
    const planner = start();
    const pending = planner.plan(request);
    StubWorker.made[0]!.onerror?.({ message: 'no' });
    await expect(pending).resolves.toBeNull();
  });

  it('lets go of a request every asker gave up on before its turn', async () => {
    const planner = start();
    const first = planner.plan({ ...request, content: 'a' });
    const gone = new AbortController();
    const stale = planner.plan({ ...request, content: 'b' }, gone.signal);
    const third = planner.plan({ ...request, content: 'c' });
    gone.abort();
    const worker = StubWorker.made[0]!;
    worker.ready();
    worker.answer(EMPTY);
    await first;
    await expect(stale).resolves.toBeNull();
    // Not asked, and not kept: drawn again, it is a question again.
    expect(worker.asked.map((message) => message['content'])).toEqual(['c']);
    expect(planner.cached({ ...request, content: 'b' })).toBeUndefined();
    worker.answer(EMPTY);
    await expect(third).resolves.toEqual(EMPTY);
  });
});

describe('the answers it keeps', () => {
  afterEach(() => {
    StubWorker.made = [];
    vi.useRealTimers();
  });

  it('has nothing for a message it was never asked about', () => {
    const planner = createDisplayPlanner(() => new StubWorker());
    expect(planner.cached(request)).toBeUndefined();
    expect(StubWorker.made).toHaveLength(0);
  });

  it('answers a message drawn again from what it kept, without the worker', async () => {
    const planner = createDisplayPlanner(() => new StubWorker());
    const first = planner.plan(request);
    const worker = StubWorker.made[0]!;
    worker.ready();
    worker.answer(EMPTY);
    await expect(first).resolves.toEqual(EMPTY);

    expect(planner.cached(request)).toEqual(EMPTY);
    await expect(planner.plan(request)).resolves.toEqual(EMPTY);
    expect(worker.asked).toHaveLength(0);
    // Its own text, previous turn, place and bindings: another message is another question.
    expect(planner.cached({ ...request, previousSameRole: '전' })).toBeUndefined();
    expect(planner.cached({ ...request, chatIndex: 4 })).toBeUndefined();
    expect(planner.cached({ ...request, context: context(SCRIPTS, { variables: { gold: '99' } }) })).toBeUndefined();
    expect(planner.cached({ ...request, scripts: [script({ out: '<b>$1</b>' })] })).toBeUndefined();
  });

  it('asks once for a message drawn twice before its answer lands', async () => {
    const planner = createDisplayPlanner(() => new StubWorker());
    const one = planner.plan(request);
    const two = planner.plan({ ...request });
    const worker = StubWorker.made[0]!;
    worker.ready();
    expect(worker.asked).toHaveLength(1);
    worker.answer(EMPTY);
    await expect(Promise.all([one, two])).resolves.toEqual([EMPTY, EMPTY]);
  });

  it('keeps a message that hung as prose, so it never holds the queue up again', async () => {
    vi.useFakeTimers();
    const planner = createDisplayPlanner(() => new StubWorker());
    const hung = planner.plan(request);
    StubWorker.made[0]!.deaf = true;
    StubWorker.made[0]!.ready();
    vi.advanceTimersByTime(1001);
    await expect(hung).resolves.toBeNull();
    expect(planner.cached(request)).toBeNull();
    await expect(planner.plan(request)).resolves.toBeNull();
    expect(StubWorker.made).toHaveLength(1);
  });

  it('keeps nothing of an answer about a context the worker no longer held', async () => {
    const planner = createDisplayPlanner(() => new StubWorker());
    const pending = planner.plan(request);
    StubWorker.made[0]!.ready();
    StubWorker.made[0]!.answer(null, { missing: true });
    await expect(pending).resolves.toBeNull();
    expect(planner.cached(request)).toBeUndefined();
  });
});

describe('the range a script runs in', () => {
  afterEach(() => {
    StubWorker.made = [];
  });

  const near = script({ in: 'near', maxDepth: 1 });
  const far = script({ in: 'far', minDepth: 2 });
  const always = script({ in: 'always' });
  const scripts = [near, far, always];

  it('keeps out the scripts out of range, the same list for the same ones', () => {
    expect(displayScriptsAt(scripts, 0)).toEqual([near, always]);
    expect(displayScriptsAt(scripts, 1)).toBe(displayScriptsAt(scripts, 0));
    expect(displayScriptsAt(scripts, 2)).toEqual([far, always]);
    expect(displayScriptsAt(scripts, 40)).toBe(displayScriptsAt(scripts, 2));
    // No range in the list, or no depth on the message (hidden from the AI): the list itself.
    const plain = [always];
    expect(displayScriptsAt(plain, 5)).toBe(plain);
    expect(displayScriptsAt(scripts, undefined)).toBe(scripts);
  });

  it("keeps a script placed on one side to that side's messages, as ST's messageFormatting asks USER_INPUT or AI_OUTPUT", () => {
    const user = script({ in: 'user', role: 'user' });
    const reply = script({ in: 'reply', role: 'assistant', maxDepth: 1 });
    const placed = [user, reply, always];
    expect(displayScriptsAt(placed, 0, 'user')).toEqual([user, always]);
    expect(displayScriptsAt(placed, 0, 'assistant')).toEqual([reply, always]);
    // The depth still holds on its side, and a hidden message (no depth) still keeps to its side.
    expect(displayScriptsAt(placed, 3, 'assistant')).toEqual([always]);
    expect(displayScriptsAt(placed, undefined, 'assistant')).toEqual([reply, always]);
    // A list with no role in it is untouched by the role.
    expect(displayScriptsAt(scripts, undefined, 'user')).toBe(scripts);
    const shown = context(placed);
    expect(displayContextAt(shown, 0, 'user')).toBe(displayContextAt(shown, 5, 'user'));
  });

  it("keeps a script placed on ST's narrator messages (SLASH_COMMAND) to the narrations", () => {
    const narrator = script({ in: 'narrator', role: 'narration' });
    const sides = script({ in: 'both', role: ['user', 'assistant'] });
    const placed = [narrator, sides, always];
    expect(displayScriptsAt(placed, 0, 'narration')).toEqual([narrator, always]);
    expect(displayScriptsAt(placed, 0, 'assistant')).toEqual([sides, always]);
    expect(displayScriptsAt(placed, 0, 'user')).toEqual([sides, always]);
  });

  it('sends no script for a message out of every range, and only the scripts in range', async () => {
    const lone = context([near]);
    // Out of every range, the message's own CBS is still read, as RisuAI reads every message.
    expect(displayContextAt(lone, 2)!.scripts).toEqual([]);
    expect(displayContextAt(lone, 2)).toBe(displayContextAt(lone, 7));
    expect(displayContextAt(lone, 0)).toBe(lone);

    const all = context(scripts);
    const at = (depth: number): PlanRequest => {
      const narrowed = displayContextAt(all, depth)!;
      return { content: 'far always', scripts: narrowed.scripts, previousSameRole: '', context: narrowed };
    };
    expect(displayContextAt(all, 3)).toBe(displayContextAt(all, 9));
    const planner = createDisplayPlanner(() => new StubWorker());
    const asked = planner.plan(at(3));
    const worker = StubWorker.made[0]!;
    worker.ready();
    expect((worker.contexts[0]!['scripts'] as DisplayScript[]).map((one) => one.in)).toEqual(['far', 'always']);
    worker.answer(EMPTY);
    await asked;
    // A turn later the message is deeper, its scripts the same: its plan is kept.
    expect(planner.cached(at(4))).toEqual(EMPTY);
    expect(planner.cached(at(0))).toBeUndefined();
  });
});

describe('a realm with no workers', () => {
  it('runs no creator patterns at all', async () => {
    // jsdom has no `Worker`, and neither does the server. There is nowhere safe to
    // run a stranger's regular expression, so nothing runs one: every message is
    // drawn as the model wrote it.
    await expect(displayPlanner.plan(request)).resolves.toBeNull();
  });
});

/* --------------------------------------------------------------- the budget */

describe('the cooperative deadline', () => {
  it('still gives up on a transform that is merely slow', () => {
    // Many matches, each cheap: the clock between matches catches this one, and
    // termination never has to.
    let clock = 0;
    const now = (): number => {
      clock += 100;
      return clock;
    };
    const plan = transformDisplay(
      { content: 'hp=1 hp=2 hp=3 hp=4 hp=5', scripts: [script({ in: 'hp=(\\d)' })], previousSameRole: '' },
      CONTEXT,
      PLAN_LIMITS,
      now,
    );
    expect(plan).toBeNull();
  });

  it('gives up whole on CBS that reads more than it may, rather than showing a template’s source', () => {
    const plan = transformDisplay(
      { content: '[status] hp=50', scripts: [script({ out: '<b>{{getvar::gold}}</b>' })], previousSameRole: '' },
      CONTEXT,
      { ...PLAN_LIMITS, evaluated: 40 },
      Date.now,
    );
    expect(plan).toBeNull();
  });
});
