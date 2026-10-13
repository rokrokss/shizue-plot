/**
 * A card's request triggers — RisuAI's `runTrigger(char, 'request', …)`, which
 * edits the request it is about to send — run here, on the server, over the
 * prompt a generation has put together. The prompt never reaches the reader's
 * browser, so this is the one trigger mode the API runs itself.
 *
 * RisuAI runs them before every request it sends (`requestChatData`), a
 * script's own model calls included, so they run over `script-llm`'s too
 * (`editRequestTurns`). That request already is a list of turns — the one the
 * script made, which is what RisuAI's triggers see of a script's — and goes to
 * the model as `script-llm` sends any, its leading system turns as the
 * instructions. What follows is about a generation's.
 *
 * **The request as the triggers see it.** RisuAI hands them its request as
 * JSON, a list of `{role, content}` turns. Ours is a system string and a list
 * of messages, so the list is `[{role: 'system', content: system},
 * ...messages]`, each message's content as its text. A turn's images are set
 * aside: RisuAI keeps them beside the text too (`multimodals`), and the effects
 * only read and write the text and the role.
 *
 * **What comes back.** RisuAI takes any array; this takes one whose every turn
 * has a role of `system`, `user` or `assistant` and string content, and sends
 * the request unedited otherwise. The first turn is the system string while it
 * is still a system turn — otherwise the system string is empty and that turn
 * leads the messages — and every other turn is a message, in order, `system`
 * ones included (an adapter sends those where they stand). Leading system
 * turns are not folded into the system string: the directions block opens the
 * messages on purpose, outside the cached prefix (§6 of ARCHITECTURE.md).
 *
 * **Images.** They go back on their turns by position, but only while the
 * request has the same number of turns in the same roles. Once a role changed,
 * none are sent (logged): a picture on a turn that became a system or an
 * assistant turn is one a provider may refuse, and RisuAI's own effects never
 * change the number of turns, so any reshaping is a role change. (RisuAI sends
 * the pictures on their turn whatever its role.)
 *
 * **Failure.** The triggers run in a worker thread against a clock: a card's
 * regex runs on the native engine (`v2ExtractRegex`, `v2RegexTest`,
 * `v2SplitString`) and can backtrack forever, and a loop may walk a long prompt
 * up to the interpreter's step limit. A run that throws (RisuAI's
 * `json[index].content` on a missing turn throws too), ends early, breaks the
 * thread or runs out the clock sends the request as it was, and says so in the
 * log — as RisuAI's try/catch around the run sends it unedited.
 */
import { countTokens, promptText, type AssembledPrompt, type PromptMessage, type PromptPart, type PromptReport } from '@shizue/core';
import type { RequestTurn, TriggerLogEntry, TriggerRunInput } from '@shizue/core/triggers';
import { Worker } from 'node:worker_threads';

/**
 * How long a run may take before its thread is terminated: three seconds. The
 * cost of an honest run grows with the request's size times its effects, since
 * every request effect parses and re-serializes the whole request (RisuAI's
 * does too): a trigger that reads and rewrites every turn of a 150,000-character
 * request — past the largest context a chat can have (32k tokens) — took about
 * 65 ms, and a fresh thread answered in about 110. Three seconds leaves a card
 * that walks the request a dozen times, on a busy server, well inside, and is
 * small beside the reply it delays, which takes tens of seconds; a run that
 * would not end costs a generation at most this, once.
 */
export const REQUEST_TRIGGER_DEADLINE_MS = 3_000;

/**
 * Threads kept for the triggers. Their own pool rather than the prompt
 * scripts' (`regexWorker.ts`): a run that takes its seconds must not hold up the
 * scripts' 200 ms tries.
 */
const POOL_SIZE = 2;

/** The same ceiling as the prompt scripts' threads: a run that builds strings until something stops it. */
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 };

/** How a run ended: the request as it left it, or why there is none. */
export type RequestTriggerOutcome = { ok: true; displayData: string } | { ok: false; reason: string };

/** What runs a request run — the pool, unless a test hands its own. */
export type RequestTriggerRunner = (input: TriggerRunInput) => Promise<RequestTriggerOutcome>;

/** The worker entry beside this module: `.ts` where Node runs the sources, `.js` once built. */
const THREAD_URL = new URL(
  `./requestTriggerThread${new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'}`,
  import.meta.url,
);

interface Thread {
  worker: Worker;
  busy: boolean;
}

let threads: Thread[] = [];
const waiting: ((thread: Thread) => void)[] = [];
let nextId = 0;

function spawn(): Thread {
  const worker = new Worker(THREAD_URL, { resourceLimits: RESOURCE_LIMITS });
  // An idle pool must never keep the process (or a test run) alive.
  worker.unref();
  const thread: Thread = { worker, busy: false };
  threads.push(thread);
  return thread;
}

/** Ends a thread that ran out the clock or broke, and hands whoever waits a fresh one. */
function retire(thread: Thread): void {
  threads = threads.filter((other) => other !== thread);
  void thread.worker.terminate();
  const next = waiting.shift();
  if (next) {
    const fresh = spawn();
    fresh.busy = true;
    next(fresh);
  }
}

function acquire(): Promise<Thread> {
  const idle = threads.find((thread) => !thread.busy);
  const thread = idle ?? (threads.length < POOL_SIZE ? spawn() : undefined);
  if (thread) {
    thread.busy = true;
    return Promise.resolve(thread);
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release(thread: Thread): void {
  const next = waiting.shift();
  if (next) next(thread);
  else thread.busy = false;
}

/** What a run's log says went wrong, for the line that says the request went unedited. */
const failureOf = (log: readonly TriggerLogEntry[]): string =>
  log.find((entry) => entry.kind === 'error' || entry.kind === 'limit')?.message ?? 'the run ended early';

/** Runs `input` in a pool thread, which is terminated and replaced past `deadlineMs`. */
export function runRequestTriggers(
  input: TriggerRunInput,
  { deadlineMs = REQUEST_TRIGGER_DEADLINE_MS }: { deadlineMs?: number } = {},
): Promise<RequestTriggerOutcome> {
  return acquire().then(
    (thread) =>
      new Promise<RequestTriggerOutcome>((resolve) => {
        const id = (nextId += 1);
        let settled = false;
        const finish = (outcome: RequestTriggerOutcome, healthy: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          thread.worker.off('message', onMessage);
          thread.worker.off('error', onError);
          thread.worker.off('exit', onExit);
          if (healthy) release(thread);
          else retire(thread);
          resolve(outcome);
        };
        const onMessage = (message: { id: number; displayData?: string; log: TriggerLogEntry[] }): void => {
          if (message.id !== id) return;
          finish(
            message.displayData !== undefined
              ? { ok: true, displayData: message.displayData }
              : { ok: false, reason: failureOf(message.log) },
            true,
          );
        };
        const onError = (error: Error): void => finish({ ok: false, reason: `the thread failed: ${error.message}` }, false);
        const onExit = (): void => finish({ ok: false, reason: 'the thread exited' }, false);
        const timer = setTimeout(() => finish({ ok: false, reason: `no answer in ${deadlineMs} ms` }, false), deadlineMs);
        thread.worker.on('message', onMessage);
        thread.worker.on('error', onError);
        thread.worker.on('exit', onExit);
        thread.worker.postMessage({ id, input });
      }),
  );
}

/* --------------------------------------------------------------- mapping */

const ROLES: readonly string[] = ['system', 'user', 'assistant'];

/** The request as the triggers read it, and each message's images, by position. */
function requestOf(prompt: AssembledPrompt): { turns: RequestTurn[]; images: (PromptPart[] | undefined)[] } {
  return {
    turns: [
      { role: 'system', content: prompt.system },
      ...prompt.messages.map((message) => ({ role: message.role, content: promptText(message.content) })),
    ],
    images: prompt.messages.map((message) =>
      typeof message.content === 'string' ? undefined : message.content.filter((part) => part.type === 'image'),
    ),
  };
}

/** The run's JSON as a request, or null for anything but a list of turns we can send. */
function readTurns(json: string): RequestTurn[] | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const turns: RequestTurn[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const { role, content } = item as Record<string, unknown>;
    if (typeof role !== 'string' || !ROLES.includes(role) || typeof content !== 'string') return null;
    turns.push({ role: role as RequestTurn['role'], content });
  }
  return turns;
}

/**
 * The report with the request as it is sent: a turn the triggers left as it was
 * keeps its blocks, and one they rewrote is one `request` block under the role
 * it went as. The totals stay the assembler's — the budget was spent before the
 * triggers ran, and RisuAI does not measure their edit either.
 */
function editedReport(report: PromptReport, before: RequestTurn[], after: RequestTurn[]): PromptReport {
  const messages = before.length - 1;
  const groups = [
    report.blocks.slice(0, report.blocks.length - messages),
    ...report.blocks.slice(report.blocks.length - messages).map((block) => [block]),
  ];
  return {
    ...report,
    blocks: after.flatMap((turn, index) => {
      const was = before[index];
      if (was && was.role === turn.role && was.content === turn.content) return groups[index]!;
      return [{ kind: 'request' as const, label: turn.role, tokens: countTokens(turn.content), text: turn.content }];
    }),
  };
}

/** What a request run is run by, and the chat it names in the log. */
interface RunOptions {
  run?: RequestTriggerRunner | undefined;
  label: string;
}

/**
 * `turns` as the card's request triggers leave them, run by `run` with
 * `input`'s chat — or null when they go as they were: the run failed or changed
 * nothing, or what it left is not a request. A failure is said in the log.
 */
export async function editRequestTurns(
  turns: RequestTurn[],
  input: Omit<TriggerRunInput, 'mode' | 'displayData'>,
  { run = runRequestTriggers, label }: RunOptions,
): Promise<RequestTurn[] | null> {
  const sent = JSON.stringify(turns);
  let outcome: RequestTriggerOutcome;
  try {
    outcome = await run({ ...input, mode: 'request', displayData: sent });
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!outcome.ok) {
    console.warn('[api] request triggers sent the request unedited:', label, outcome.reason);
    return null;
  }
  if (outcome.displayData === sent) return null;
  const edited = readTurns(outcome.displayData);
  if (!edited) console.warn('[api] request triggers left something that is not a request; sent unedited:', label);
  return edited;
}

/** The prompt a generation sends, as the card's request triggers leave it (`editRequestTurns`). */
export async function withRequestTriggers(
  prompt: AssembledPrompt,
  input: Omit<TriggerRunInput, 'mode' | 'displayData'>,
  options: RunOptions,
): Promise<AssembledPrompt> {
  const { turns, images } = requestOf(prompt);
  const edited = await editRequestTurns(turns, input, options);
  if (!edited) return prompt;

  const sameShape = edited.length === turns.length && edited.every((turn, index) => turn.role === turns[index]!.role);
  const dropped = sameShape ? 0 : images.reduce((count, parts) => count + (parts?.length ?? 0), 0);
  if (dropped > 0) console.warn(`[api] request triggers changed a role; ${dropped} image(s) not sent:`, options.label);
  const system = edited[0]?.role === 'system' ? edited[0].content : null;
  const messages: PromptMessage[] = (system !== null ? edited.slice(1) : edited).map((turn, index) => {
    // Same shape: the first turn is still the system string, so a message's index is its own.
    const parts = sameShape ? images[index] : undefined;
    return {
      role: turn.role,
      content: parts?.length ? [{ type: 'text', text: turn.content }, ...parts] : turn.content,
    };
  });
  return {
    ...prompt,
    system: system ?? '',
    messages,
    ...(prompt.report ? { report: editedReport(prompt.report, turns, edited) } : {}),
  };
}
