/**
 * The thread a card's request triggers run in (`requestTriggers.ts`): the
 * interpreter over the assembled request, where a run that does not come back —
 * a card's regex backtracking, a loop walking a long prompt up to the step
 * limit — costs this thread and not the server. One run at a time.
 *
 * Erasable TypeScript only: in development and under the tests Node loads this
 * file itself, stripping the types, rather than through the compiler.
 */
import { parentPort } from 'node:worker_threads';
import { runTriggersSync, type TriggerRunInput } from '@shizue/core/triggers';

// `v2ConsoleLog` writes to the browser's console in RisuAI; here it would write
// to the server's log, as often as a card's loop asks.
console.log = () => {};

parentPort!.on('message', ({ id, input }: { id: number; input: TriggerRunInput }) => {
  const result = runTriggersSync(input);
  parentPort!.postMessage({
    id,
    ...(result.displayData !== undefined ? { displayData: result.displayData } : {}),
    log: result.log,
  });
});
