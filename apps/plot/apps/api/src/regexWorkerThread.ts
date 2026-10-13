/**
 * The thread the prompt scripts run in (`regexWorker.ts`): a creator's regex,
 * run with the native engine, where a pattern that never returns costs this
 * thread and not the server. It takes one job at a time and marks the script it
 * is on in the shared progress cell before each one, so the pool can name the
 * script it had to stop.
 *
 * Erasable TypeScript only: in development and under the tests Node loads this
 * file itself, stripping the types, rather than through the compiler.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runPromptScripts, type PromptScriptJob } from '@shizue/core/prompt-scripts';

const progress = new Int32Array((workerData as { progress: SharedArrayBuffer }).progress);

parentPort!.on('message', ({ id, job }: { id: number; job: PromptScriptJob }) => {
  const texts = runPromptScripts(job, (index) => Atomics.store(progress, 0, index));
  parentPort!.postMessage({ id, texts });
});
