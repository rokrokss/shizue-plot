// @vitest-environment jsdom
/**
 * The half of the transform that can hang, and the thread it hangs on.
 *
 * Two things are proved here. That the shipped worker source — the very string the
 * blob is built from — plans a message correctly, since it is a function torn out
 * of its module by `toString()` and would fail silently if it had kept a reference
 * to anything. And that a pattern which never returns costs one worker and one
 * message, rather than the reader's tab.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDisplayPlanner,
  displayPlanner,
  displayPlannerSource,
  type PlannerWorker,
} from '../src/lib/displayPlanner';
import {
  PLAN_LIMITS,
  planDisplayScripts,
  renderDisplayPlan,
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

const context = (scripts: DisplayScript[]): DisplayContext => ({
  scripts,
  variables: { gold: '12' },
  assets: new Map(),
  relationship: null,
  turn: 1,
  char: '아리아',
  user: '민준',
});

/* -------------------------------------------------------------- the source */

interface WorkerScope extends Record<string, unknown> {
  onmessage?: ((event: { data: unknown }) => void) | undefined;
}

/** Runs the shipped worker source against a stand-in global, as the blob would. */
function bootPlanner(): { send: (message: unknown) => void; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const scope: WorkerScope = {
    postMessage: (data: unknown) => sent.push(data as Record<string, unknown>),
  };
  new Function('scope', displayPlannerSource('scope'))(scope);
  return { send: (message) => scope.onmessage?.({ data: message }), sent };
}

describe('the worker source', () => {
  it('announces itself before it is asked for anything', () => {
    expect(bootPlanner().sent).toEqual([{ type: 'ready' }]);
  });

  it('plans a status line, and the plan renders to the same markup', () => {
    const planner = bootPlanner();
    planner.send({
      type: 'plan',
      id: 7,
      content: '앞 [status] hp=50 뒤',
      scripts: [script()],
      previousSameRole: '',
    });
    const answer = planner.sent[1]!;
    expect(answer['type']).toBe('plan');
    expect(answer['id']).toBe(7);

    const plan = answer['plan'] as DisplayPlan;
    expect(plan.body).toEqual([
      { kind: 'text', text: '앞 ' },
      { kind: 'match', match: { script: 0, captures: ['[status] hp=50', '50'], groups: {} } },
      { kind: 'text', text: ' 뒤' },
    ]);
    // What the reader gets out of it, rendered on the other side.
    const segments = renderDisplayPlan(plan, context([script()]))!;
    expect(segments.map((segment) => (segment.kind === 'html' ? segment.html : segment.text))).toEqual([
      '앞 ',
      '<div class="x-shizue-hp">HP 50</div>',
      ' 뒤',
    ]);
  });

  it('survives a structured clone, which is how the answer travels', () => {
    const planner = bootPlanner();
    planner.send({
      type: 'plan',
      id: 1,
      content: '[status] hp=50',
      scripts: [script({ in: '\\[status\\] hp=(?<hp>\\d+)', out: '<i>$<hp></i>' })],
      previousSameRole: '',
    });
    const plan = structuredClone(planner.sent[1]!['plan']) as DisplayPlan;
    const segments = renderDisplayPlan(
      plan,
      context([script({ in: '\\[status\\] hp=(?<hp>\\d+)', out: '<i>$<hp></i>' })]),
    )!;
    expect(segments).toEqual([{ kind: 'html', html: '<i>50</i>' }]);
  });

  it('answers a message with nothing to do with null, and says nothing else', () => {
    const planner = bootPlanner();
    planner.send({ type: 'plan', id: 2, content: '안녕', scripts: [], previousSameRole: '' });
    expect(planner.sent[1]).toEqual({ type: 'plan', id: 2, plan: null });
    planner.send({ type: 'nonsense' });
    expect(planner.sent).toHaveLength(2);
  });
});

/* ------------------------------------------------------- a pattern that hangs */

/** A worker under the test's control: it answers when told to, or never. */
class StubWorker implements PlannerWorker {
  static made: StubWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
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
    this.asked.push(message as Record<string, unknown>);
  }

  /** Answers the oldest outstanding request with a plan of its own choosing. */
  answer(plan: DisplayPlan | null): void {
    const request = this.asked.shift()!;
    if (this.deaf || this.terminated) return;
    this.onmessage?.({ data: { type: 'plan', id: request['id'], plan } });
  }

  terminate(): void {
    this.terminated = true;
  }
}

const EMPTY: DisplayPlan = { top: [], body: [{ kind: 'text', text: 'x' }], bottom: [] };
const request = { content: '[status] hp=50', scripts: [script()], previousSameRole: '' };

describe('a worker that stops answering', () => {
  afterEach(() => {
    StubWorker.made = [];
    vi.useRealTimers();
  });

  const start = () => {
    const planner = createDisplayPlanner(() => new StubWorker());
    return planner;
  };

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

  it('gives the next message a thread of its own', async () => {
    vi.useFakeTimers();
    const planner = start();
    const hung = planner.plan(request);
    const first = StubWorker.made[0]!;
    first.deaf = true;
    first.ready();
    vi.advanceTimersByTime(1001);
    await expect(hung).resolves.toBeNull();

    const after = planner.plan(request);
    expect(StubWorker.made).toHaveLength(2);
    const second = StubWorker.made[1]!;
    expect(second.terminated).toBe(false);
    second.ready();
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

    const after = planner.plan(request);
    // The old worker comes back to life with the answer nobody is waiting for.
    first.terminated = false;
    first.answer(EMPTY);
    StubWorker.made[1]!.ready();
    StubWorker.made[1]!.answer(null);
    await expect(after).resolves.toBeNull();
  });

  it('answers one at a time, in order', async () => {
    const planner = createDisplayPlanner(() => new StubWorker());
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
  });

  it('takes a worker that fails to start as a message to draw plainly', async () => {
    const planner = createDisplayPlanner(() => new StubWorker());
    const pending = planner.plan(request);
    StubWorker.made[0]!.onerror?.({ message: 'no' });
    await expect(pending).resolves.toBeNull();
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
      clock += 30;
      return clock;
    };
    const plan = planDisplayScripts(
      'hp=1 hp=2 hp=3 hp=4 hp=5',
      [script({ in: 'hp=(\\d)' })],
      '',
      PLAN_LIMITS,
      now,
    );
    expect(plan).toBeNull();
  });
});
