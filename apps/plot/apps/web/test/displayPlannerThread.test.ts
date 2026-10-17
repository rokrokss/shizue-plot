// @vitest-environment node
/**
 * The claim, on a real thread.
 *
 * Everything else about the planner is exercised against a stand-in worker, which
 * proves the bookkeeping and nothing about the thing the bookkeeping is for. This
 * file hosts the shipped job module (`displayPlanJob.ts`) in an actual worker
 * thread and gives it a pattern that does not come back: a `Worker` is a
 * `Worker`, `terminate()` is `terminate()`, and what is being demonstrated — that
 * a creator's regular expression can no longer take the reader's thread with it —
 * is the same claim in a browser as it is here.
 *
 * The pattern is one the authoring screen accepts, which is the point: it has no
 * parenthesised group for the screen to look at, and it is exponential in the
 * length of the line it scans.
 */
import { pathToFileURL } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { displayScriptPatternError } from '@shizue/core/display-script';
import { describe, expect, it } from 'vitest';
import { createDisplayPlanner, type PlannerWorker } from '../src/lib/displayPlanner';
import type { DisplayContext } from '../src/lib/displayScripts';
import type { DisplayScript } from '../src/lib/types';

const JOB_MODULE = pathToFileURL(new URL('../src/lib/displayPlanJob.ts', import.meta.url).pathname).href;

/**
 * The job module as the worker entry serves it, over this runtime's message
 * plumbing. Node reads the TypeScript as it is; the one thing it needs told is
 * where an extensionless import of a sibling module points, which the bundler
 * otherwise works out.
 */
const BOOTSTRAP = `
const { parentPort } = require('node:worker_threads');
const { registerHooks } = require('node:module');
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (/^\\.\\.?\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  },
});
const scope = { onmessage: null, postMessage: (message) => parentPort.postMessage(message) };
parentPort.on('message', (data) => { if (scope.onmessage) scope.onmessage({ data }); });
import(${JSON.stringify(JOB_MODULE)}).then((job) => job.serveDisplayPlans(scope));
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
  out: '<div>HP $1 · {{getvar::gold}}</div>',
  order: 0,
  enabled: true,
  ...overrides,
});

const context = (scripts: DisplayScript[]): DisplayContext => ({
  scripts,
  variables: { gold: '12' },
  assets: new Map(),
  turn: 1,
  char: '아리아',
  user: '민준',
  // There is no window on a thread: the page sends the one it has.
  screen: { width: 375, height: 812 },
});

/** No group to inspect, and doubling for every two characters the model adds. */
const CATASTROPHIC = '\\[status\\] hp=\\d+ a+a+a+a+a+a+a+a+a+a+b';
const FEEDS_IT = `[status] hp=5 ${'a'.repeat(60)}!`;

describe('a pattern that does not come back', () => {
  it('is one the authoring screen has no objection to', () => {
    expect(displayScriptPatternError(CATASTROPHIC)).toBeNull();
  });

  it('plans an ordinary message on a real thread, its CBS read there', async () => {
    const planner = createDisplayPlanner(spawnThread);
    const ctx = context([script()]);
    const plan = await planner.plan({
      content: '앞 [status] hp=50 뒤',
      scripts: ctx.scripts,
      previousSameRole: '',
      context: ctx,
    });
    expect(plan?.body).toEqual([
      { kind: 'text', text: '앞 ' },
      { kind: 'html', html: '<div>HP \u000250\u0003 · \u000112\u0001</div>' },
      { kind: 'text', text: ' 뒤' },
    ]);
    // A card's phone layout reads the window the page sent, the thread having none.
    const wide = context([script({ out: '{{#if {{? {{screen_width}} > 768 }}}}넓다{{/if}}{{screen_width}}' })]);
    const laid = await planner.plan({ content: '[status] hp=1', scripts: wide.scripts, previousSameRole: '', context: wide });
    expect(laid?.body).toEqual([{ kind: 'html', html: '375' }]);
    planner.stop();
  }, 20_000);

  it('costs a thread and a message, and nothing else', async () => {
    const planner = createDisplayPlanner(spawnThread);

    // A stand-in for the reader's tab having something to do: if the pattern were
    // running here, none of these would fire until it finished — which for this
    // input is measured in tens of minutes.
    let ticks = 0;
    const beating = setInterval(() => {
      ticks += 1;
    }, 50);

    const hanging = context([script({ in: CATASTROPHIC, out: '<div>x</div>' })]);
    // The thread's own start-up is not the pattern's to pay for.
    await planner.plan({ content: 'warm-up', scripts: hanging.scripts, previousSameRole: '', context: hanging });
    const started = Date.now();
    const hung = await planner.plan({ content: FEEDS_IT, scripts: hanging.scripts, previousSameRole: '', context: hanging });
    const waited = Date.now() - started;
    clearInterval(beating);

    // The message draws as prose, on time, and this thread never stopped.
    expect(hung).toBeNull();
    expect(waited).toBeGreaterThan(900);
    expect(waited).toBeLessThan(4000);
    expect(ticks).toBeGreaterThan(5);

    // …and the next message gets a thread of its own, so one bad pattern does not
    // end the transform for the whole chat.
    const ordinary = context([script()]);
    const after = await planner.plan({
      content: '[status] hp=50',
      scripts: ordinary.scripts,
      previousSameRole: '',
      context: ordinary,
    });
    expect(after?.body).toEqual([{ kind: 'html', html: '<div>HP \u000250\u0003 · \u000112\u0001</div>' }]);
    planner.stop();
  }, 30_000);

  it('leaves nothing running behind it', async () => {
    // Every thread this file started is gone: the hung one was terminated rather
    // than waited for, which is the whole difference.
    await Promise.all(threads.map((thread) => thread.terminate()));
    expect(threads.length).toBeGreaterThan(1);
  });
});
