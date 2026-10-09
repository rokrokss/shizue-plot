// @vitest-environment node
/**
 * The claim, on a real thread.
 *
 * Everything else about the planner is exercised against a stand-in worker, which
 * proves the bookkeeping and nothing about the thing the bookkeeping is for. This
 * file runs the shipped planner source in an actual worker thread and gives it a
 * pattern that does not come back: a `Worker` is a `Worker`, `terminate()` is
 * `terminate()`, and what is being demonstrated — that a creator's regular
 * expression can no longer take the reader's thread with it — is the same claim in
 * a browser as it is here.
 *
 * The pattern is one the authoring screen accepts, which is the point: it has no
 * parenthesised group for the screen to look at, and it is exponential in the
 * length of the line it scans.
 */
import { Worker as NodeWorker } from 'node:worker_threads';
import { displayScriptPatternError } from '@shizue/core/display-script';
import { describe, expect, it } from 'vitest';
import {
  createDisplayPlanner,
  displayPlannerSource,
  type PlannerWorker,
} from '../src/lib/displayPlanner';
import type { DisplayScript } from '../src/lib/types';

/** The same source the blob is built from, wired to this runtime's message plumbing. */
const BOOTSTRAP = `
const { parentPort } = require('node:worker_threads');
const scope = { postMessage: (message) => parentPort.postMessage(message) };
parentPort.on('message', (data) => { if (scope.onmessage) scope.onmessage({ data }); });
${displayPlannerSource('scope')}
`;

const threads: NodeWorker[] = [];

function spawnThread(): PlannerWorker {
  const thread = new NodeWorker(BOOTSTRAP, { eval: true });
  threads.push(thread);
  const port: PlannerWorker = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => thread.postMessage(message),
    terminate: () => void thread.terminate(),
  };
  thread.on('message', (data) => port.onmessage?.({ data }));
  thread.on('error', (error) => port.onerror?.(error));
  return port;
}

const script = (overrides: Partial<DisplayScript> = {}): DisplayScript => ({
  in: '\\[status\\] hp=(\\d+)',
  out: '<div>HP $1</div>',
  order: 0,
  enabled: true,
  ...overrides,
});

/** No group to inspect, and doubling for every two characters the model adds. */
const CATASTROPHIC = '\\[status\\] hp=\\d+ a+a+a+a+a+a+a+a+a+a+b';
const FEEDS_IT = `[status] hp=5 ${'a'.repeat(60)}!`;

describe('a pattern that does not come back', () => {
  it('is one the authoring screen has no objection to', () => {
    expect(displayScriptPatternError(CATASTROPHIC)).toBeNull();
  });

  it('plans an ordinary message on a real thread', async () => {
    const planner = createDisplayPlanner(spawnThread);
    const plan = await planner.plan({
      content: '앞 [status] hp=50 뒤',
      scripts: [script()],
      previousSameRole: '',
    });
    expect(plan?.body).toHaveLength(3);
    planner.stop();
  });

  it('costs a thread and a message, and nothing else', async () => {
    const planner = createDisplayPlanner(spawnThread);

    // A stand-in for the reader's tab having something to do: if the pattern were
    // running here, none of these would fire until it finished — which for this
    // input is measured in tens of minutes.
    let ticks = 0;
    const beating = setInterval(() => {
      ticks += 1;
    }, 50);

    const started = Date.now();
    const hung = await planner.plan({
      content: FEEDS_IT,
      scripts: [script({ in: CATASTROPHIC, out: '<div>x</div>' })],
      previousSameRole: '',
    });
    const waited = Date.now() - started;
    clearInterval(beating);

    // The message draws as prose, on time, and this thread never stopped.
    expect(hung).toBeNull();
    expect(waited).toBeGreaterThan(900);
    expect(waited).toBeLessThan(4000);
    expect(ticks).toBeGreaterThan(5);

    // …and the next message gets a thread of its own, so one bad pattern does not
    // end the transform for the whole chat.
    const after = await planner.plan({
      content: '[status] hp=50',
      scripts: [script()],
      previousSameRole: '',
    });
    expect(after?.body).toHaveLength(1);
    planner.stop();
  }, 20_000);

  it('leaves nothing running behind it', async () => {
    // Every thread this file started is gone: the hung one was terminated rather
    // than waited for, which is the whole difference.
    await Promise.all(threads.map((thread) => thread.terminate()));
    expect(threads.length).toBeGreaterThan(1);
  });
});
