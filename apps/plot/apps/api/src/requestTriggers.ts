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
 * instructions. What follows is about a generation's, where the card's Lua
 * `editRequest` listeners (`requestLua.ts`) have the same list first and the
 * triggers read what they left; the request is mapped back once, for both
 * (`withEditedRequest`).
 *
 * **The request as the triggers see it.** RisuAI hands them its request as
 * JSON, a list of its `OpenAIChat` items. Ours is a system string and a list
 * of messages, so the list is `[{role: 'system', content: system},
 * ...messages]`, each message's content as its text, with the fields RisuAI
 * sets beside them on the turn it stands for — `memo`, `removable`, `attr`,
 * `thoughts` (`risuRequestExtras` in @shizue/core, from what each block is).
 * A turn's pictures are its `multimodals`, as RisuAI's are, but each one's
 * `base64` is a stand-in that names it (`image:0`, …) rather than its bytes:
 * the reader's pictures run to 16 MB a turn, past what a listener's Lua state
 * (32 MB, holding the request's JSON and its decoding at once) or a line of the
 * Lua child's (8 MB) holds. `name` (RisuAI's per-side example turns) and
 * `cachePoint` (Claude's prompt caching) are never set.
 *
 * **What comes back.** RisuAI takes any array; this takes one whose every turn
 * has a role of `system`, `user` or `assistant` and string content, and sends
 * the request unedited otherwise. The first turn is the system string while it
 * is still a system turn — otherwise the system string is empty and that turn
 * leads the messages — and every other turn is a message, in order, `system`
 * ones included (an adapter sends those where they stand). Leading system
 * turns are not folded into the system string: the directions block opens the
 * messages on purpose, outside the cached prefix (§6 of ARCHITECTURE.md). Of
 * a turn's other fields only `multimodals` is read, for the pictures it still
 * names; the rest are the next editor's to read and are not sent.
 *
 * **Images.** A picture goes on the first turn whose `multimodals` still names
 * it, when that turn is a user turn; one no turn names any more was removed,
 * and is not sent. One left on the system string or on a system or an
 * assistant turn is not sent either (logged): a provider may refuse it there.
 * (RisuAI sends the pictures on their turn whatever its role.) An editor never
 * adds one: a name we did not hand out is nothing.
 *
 * **Failure.** The triggers run in a worker thread against a clock: a card's
 * regex runs on the native engine (`v2ExtractRegex`, `v2RegexTest`,
 * `v2SplitString`) and can backtrack forever, and a loop may walk a long prompt
 * up to the interpreter's step limit. A run that throws (RisuAI's
 * `json[index].content` on a missing turn throws too), ends early, breaks the
 * thread or runs out the clock sends the request as it was, and says so in the
 * log — as RisuAI's try/catch around the run sends it unedited.
 */
import {
  countTokens,
  promptText,
  risuRequestExtras,
  type AssembledPrompt,
  type PromptMessage,
  type PromptPart,
  type PromptReport,
  type RisuRequestItem,
} from '@shizue/core';
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

/**
 * A turn as an editor of the request left it: a role and text we can send,
 * and whatever else it carries, kept for the next editor and read here only
 * for the pictures it names.
 */
export type EditedTurn = RequestTurn & { readonly [field: string]: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a picture is called in the request the editors read: a stand-in, not its bytes. */
const imageName = (at: number): string => `image:${at}`;

/** The request as its editors read it, and each picture by the name it goes by there. */
function requestOf(prompt: AssembledPrompt): { items: RisuRequestItem[]; images: Map<string, PromptPart> } {
  const images = new Map<string, PromptPart>();
  const items: RisuRequestItem[] = [
    { role: 'system', content: prompt.system },
    ...prompt.messages.map((message, at): RisuRequestItem => {
      const parts = typeof message.content === 'string' ? [] : message.content.filter((part) => part.type === 'image');
      const multimodals = parts.map((part) => {
        const name = imageName(images.size);
        images.set(name, part);
        return { type: 'image' as const, base64: name };
      });
      return {
        role: message.role,
        content: promptText(message.content),
        ...risuRequestExtras(prompt.sources?.[at]),
        ...(multimodals.length > 0 ? { multimodals } : {}),
      };
    }),
  ];
  return { items, images };
}

/** The pictures a turn's `multimodals` names, in order — whatever an editor left there. */
function imagesNamed(turn: RequestTurn): string[] {
  const list = (turn as { multimodals?: unknown }).multimodals;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => (isRecord(entry) && typeof entry['base64'] === 'string' ? [entry['base64']] : []));
}

/** Whether `edited` sends what `items` would: the same turns, roles, text and pictures. */
function sameRequest(items: readonly RequestTurn[], edited: readonly RequestTurn[]): boolean {
  return (
    edited.length === items.length &&
    edited.every((turn, at) => {
      const was = items[at]!;
      const names = imagesNamed(turn);
      const wasNames = imagesNamed(was);
      return (
        turn.role === was.role &&
        turn.content === was.content &&
        names.length === wasNames.length &&
        names.every((name, index) => name === wasNames[index])
      );
    })
  );
}

/** The run's JSON as a request, or null for anything but a list of turns we can send. */
function readTurns(json: string): EditedTurn[] | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  return turnsOf(value);
}

/**
 * A value an editor of the request left, as a request — or null for anything
 * but a list of turns we can send. A turn's other fields stay as they were
 * left, for the next editor; only its pictures are read here.
 */
export function turnsOf(value: unknown): EditedTurn[] | null {
  if (!Array.isArray(value)) return null;
  for (const item of value as unknown[]) {
    if (!isRecord(item)) return null;
    const { role, content } = item;
    if (typeof role !== 'string' || !ROLES.includes(role) || typeof content !== 'string') return null;
  }
  return value as EditedTurn[];
}

/**
 * The report with the request as it is sent: a turn the triggers left as it was
 * keeps its blocks, and one they rewrote is one `request` block under the role
 * it went as. The totals stay the assembler's — the budget was spent before the
 * triggers ran, and RisuAI does not measure their edit either.
 */
function editedReport(report: PromptReport, before: readonly RequestTurn[], after: readonly RequestTurn[]): PromptReport {
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
  turns: readonly RequestTurn[],
  input: Omit<TriggerRunInput, 'mode' | 'displayData'>,
  { run = runRequestTriggers, label }: RunOptions,
): Promise<EditedTurn[] | null> {
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

/**
 * The prompt a generation sends, as `edit` leaves its request — the card's
 * `editRequest` listeners (`requestLua.ts`), then its request triggers
 * (`editRequestTurns`). `edit` hands the request's items (RisuAI's
 * `OpenAIChat`) on and answers null for a request it leaves as it was.
 */
export async function withEditedRequest(
  prompt: AssembledPrompt,
  edit: (items: RisuRequestItem[]) => Promise<EditedTurn[] | null>,
  label: string,
): Promise<AssembledPrompt> {
  const { items, images } = requestOf(prompt);
  const edited = await edit(items);
  if (!edited || sameRequest(items, edited)) return prompt;

  const system = edited[0]?.role === 'system' ? edited[0].content : null;
  // Each picture on the first turn that still names it, if that turn is the reader's.
  const placed = new Set<string>();
  let refused = 0;
  const partsOf = (turn: EditedTurn, isSystem: boolean): PromptPart[] =>
    imagesNamed(turn).flatMap((name) => {
      const part = images.get(name);
      if (!part || placed.has(name)) return [];
      placed.add(name);
      if (isSystem || turn.role !== 'user') {
        refused += 1;
        return [];
      }
      return [part];
    });
  if (system !== null) partsOf(edited[0]!, true);
  const messages: PromptMessage[] = (system !== null ? edited.slice(1) : edited).map((turn) => {
    const parts = partsOf(turn, false);
    return {
      role: turn.role,
      content: parts.length > 0 ? [{ type: 'text', text: turn.content }, ...parts] : turn.content,
    };
  });
  if (refused > 0) console.warn(`[api] the request's scripts left ${refused} image(s) on a turn not the reader's; not sent:`, label);
  const { sources: _stale, ...rest } = prompt;
  return {
    ...rest,
    system: system ?? '',
    messages,
    ...(prompt.report ? { report: editedReport(prompt.report, items, edited) } : {}),
  };
}
