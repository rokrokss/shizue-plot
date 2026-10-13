// @vitest-environment node
/**
 * A card's `editinput`/`editoutput` regex scripts, run where the page can stop
 * them: the shipped job module (`editScriptJob.ts`) hosted in a real worker
 * thread, behind the runner the chat uses (`editScriptRunner.ts`). A worker is a
 * worker and `terminate()` is `terminate()`; what is shown here — a pattern that
 * never returns costs the pass its clock, not the reader's tab — is the same
 * claim in a browser.
 */
import { pathToFileURL } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { runEditScripts, type EditScript, type EditScriptType } from '@shizue/core/triggers';
import { emptyVariables, readVariable } from '@shizue/core/variables';
import { afterAll, describe, expect, it } from 'vitest';
import type { EditJob } from '../src/lib/scripts/editScriptJob';
import { createEditScriptRunner, inlineEditRunner, type EditWorker } from '../src/lib/scripts/editScriptRunner';

const JOB_MODULE = pathToFileURL(new URL('../src/lib/scripts/editScriptJob.ts', import.meta.url).pathname).href;

/** The job module as the worker entry serves it, over this runtime's message plumbing. */
const BOOTSTRAP = `
const { parentPort } = require('node:worker_threads');
const scope = { onmessage: null, postMessage: (message) => parentPort.postMessage(message) };
parentPort.on('message', (data) => { if (scope.onmessage) scope.onmessage({ data }); });
import(${JSON.stringify(JOB_MODULE)}).then((job) => job.serveEditJobs(scope));
`;

const threads: NodeWorker[] = [];
let spawned = 0;

function spawnThread(): EditWorker {
  spawned += 1;
  const thread = new NodeWorker(BOOTSTRAP, { eval: true });
  threads.push(thread);
  const port: EditWorker = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => thread.postMessage(message),
    terminate: () => void thread.terminate(),
  };
  thread.on('message', (data) => port.onmessage?.({ data }));
  thread.on('error', (error) => port.onerror?.(error));
  return port;
}

afterAll(async () => {
  await Promise.all(threads.map((thread) => thread.terminate()));
});

const variables = Object.assign(emptyVariables(), { hp: '7', name: '리안' });
const data = { user: '아린', char: '리안' };

const output = (input: string, out: string, extra: Partial<EditScript> = {}): EditScript => ({ type: 'editoutput', in: input, out, ...extra });

const job = (text: string, scripts: EditScript[], extra: Partial<EditJob> = {}): EditJob => ({
  text,
  scripts,
  mode: 'editoutput',
  chatIndex: 3,
  variables,
  globals: emptyVariables(),
  data,
  ...extra,
});

/** Exponential in the run of `a`s before the `b` that makes it fail. */
const nearMiss = `${'a'.repeat(40)}b`;

describe('the edit runner on a real thread', () => {
  it('stops a pattern that never returns, sets it aside, and still runs the rest', async () => {
    const run = createEditScriptRunner(spawnThread, { deadlineMs: 300 });
    const scripts = [output('^(a+)+$', 'x'), output('b', 'B')];
    const started = Date.now();
    const first = await run(job(nearMiss, scripts));
    const took = Date.now() - started;
    // The pass is tried again without it, on a worker of its own.
    expect(first.text).toBe(`${'a'.repeat(40)}B`);
    expect(first.notices).toEqual([expect.stringContaining('ran out of time and is skipped from now on: ^(a+)+$')]);
    expect(took).toBeGreaterThanOrEqual(300);
    expect(took).toBeLessThan(3000);

    // Set aside for the page's life: the next pass does not wait on it again.
    const again = Date.now();
    const second = await run(job(nearMiss, scripts));
    expect(second).toEqual({ text: `${'a'.repeat(40)}B`, skipped: [], notices: [] });
    expect(Date.now() - again).toBeLessThan(300);
    run.stop();
  });

  it('keeps the text as it was once its tries are spent', async () => {
    const run = createEditScriptRunner(spawnThread, { deadlineMs: 150 });
    const hung = ['^(a+)+$', '^(a|a)+$', '^(a|aa)+$', '^(aa?)+$'].map((pattern) => output(pattern, 'x'));
    const result = await run(job(nearMiss, [...hung, output('b', 'B')]));
    expect(result.text).toBe(nearMiss);
    expect(result.notices.at(-1)).toContain('the text is kept as it was');
    expect(result.notices.filter((notice) => notice.includes('skipped from now on'))).toHaveLength(3);
    run.stop();
  });

  it('answers as the scripts answer on this thread, over the core fixtures', async () => {
    const run = createEditScriptRunner(spawnThread);
    const fixtures: { text: string; scripts: EditScript[]; mode?: EditScriptType; chatIndex?: number; previousSameRole?: string }[] = [
      { text: 'a1 b2', scripts: [output('\\d', '<$&>')] },
      { text: 'a1 b2', scripts: [output('[a-z]\\d', '[$&|{{data}}]$n')] },
      { text: 'HP 3', scripts: [output('HP (\\d+)', 'HP {{calc::$1+{{getvar::hp}}}} ({{user}})')] },
      { text: 'say {{getvar::hp}}', scripts: [output('say (.*)', '“$1”')] },
      { text: 'abc', scripts: [{ type: 'editinput', in: 'a', out: 'b' }, output('(', 'x'), output('c', 'd')] },
      { text: 'abc', scripts: [{ type: 'editinput', in: 'a', out: 'b' }, output('c', 'd')], mode: 'editinput', chatIndex: -1 },
      { text: 'aA', scripts: [output('a', 'x', { flag: 'gi', ableFlag: true })] },
      {
        text: 'a',
        scripts: [output('a', 'b', { flag: 'g<order 1>', ableFlag: true }), output('b', 'c', { flag: 'g<order 5>', ableFlag: true })],
      },
      { text: '본문 [상태] 끝 [두번째]', scripts: [output('\\[[^\\]]+\\]', '@@move_top $&')] },
      { text: '[상태] 본문', scripts: [output('\\[[^\\]]+\\]', '<b>$&</b>', { flag: 'g<move_bottom>', ableFlag: true })] },
      { text: '대답', scripts: [output('<status>.*?</status>', '@@repeat_back end_nl')], previousSameRole: '전 <status>HP 3</status>' },
      { text: '대답', scripts: [output('<status>.*?</status>', '@@repeat_back')], previousSameRole: '없음' },
      { text: 'a [memo] b', scripts: [output('\\[memo\\]', '@@inject')] },
      { text: '리안 왔다', scripts: [output('{{getvar::name}}', '그녀', { flag: 'g<cbs>', ableFlag: true })] },
    ];
    for (const fixture of fixtures) {
      const mode = fixture.mode ?? 'editoutput';
      const chatIndex = fixture.chatIndex ?? 3;
      const skipped: string[] = [];
      const here = runEditScripts(fixture.text, fixture.scripts, mode, {
        chatIndex,
        ...(fixture.previousSameRole !== undefined ? { previousSameRole: fixture.previousSameRole } : {}),
        env: { variable: (name) => readVariable(variables, name), data },
        onSkip: (_script, reason) => skipped.push(reason),
      });
      const there = await run(
        job(fixture.text, fixture.scripts, {
          mode,
          chatIndex,
          ...(fixture.previousSameRole !== undefined ? { previousSameRole: fixture.previousSameRole } : {}),
        }),
      );
      expect(there.text, fixture.text).toBe(here);
      expect(there.skipped.map((skip) => skip.reason)).toEqual(skipped);
    }
    // One worker for all of them.
    run.stop();
  });

  it('keeps the text as it was, and says so, where no worker will start', async () => {
    const broken = (): EditWorker => {
      const port: EditWorker = { onmessage: null, onerror: null, postMessage: () => undefined, terminate: () => undefined };
      queueMicrotask(() => port.onerror?.(new Error('blocked')));
      return port;
    };
    const run = createEditScriptRunner(broken);
    const result = await run(job('HP 3', [output('HP', 'MP')]));
    expect(result.text).toBe('HP 3');
    expect(result.notices).toEqual([expect.stringContaining('could not run')]);
  });

  it('runs on this thread where there are no workers, with the run’s random', async () => {
    const run = inlineEditRunner(() => 0);
    const result = await run(job('x', [output('x', '{{random::가::나}}')]));
    expect(result.text).toBe('가');
    expect(spawned).toBeGreaterThan(0);
  });
});
