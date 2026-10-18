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
 * JSON, a list of its `OpenAIChat` items, in the shape its `sendChat` put it
 * together in. Ours is a system string and a list of messages, so the list is
 * the view of it in that shape (`risuRequestView` in @shizue/core): the system
 * string, the memory as RisuAI's `supaMemory` turn, each example block as
 * RisuAI's `NewChatExample` separator and its lines named `example_user` and
 * `example_assistant`, the `NewChat` separator while the chat is sent from its
 * start, and each message as its text with the fields RisuAI sets on the turn
 * it stands for. A turn's pictures are its `multimodals`, each `base64` the
 * picture's data URL, as RisuAI's are — unless a request's pictures come to
 * more than `REQUEST_IMAGE_BUDGET`, when each is a stand-in that names it
 * (`image:0`, …) for that request alone. `cachePoint` (Claude's prompt
 * caching) is never set.
 *
 * **What comes back.** RisuAI takes any array; this takes one whose every turn
 * has a role of `system`, `user` or `assistant` and string content, and sends
 * the request unedited otherwise. A request the editors left as the view had
 * it — the same turns, roles, text and pictures — goes as the prompt was put
 * together, which is not the view's shape. One they changed goes in the view's
 * shape, as RisuAI sends what they leave: the first turn is the system string
 * while it is still a system turn — otherwise the system string is empty and
 * that turn leads the messages — and every other turn is a message, in order,
 * `system` ones included (an adapter sends those where they stand), the
 * separators among them, as RisuAI's Responses request sends its separators.
 * Leading system turns are not folded into the system string: the directions
 * block opens the messages on purpose, outside the cached prefix (§6 of
 * ARCHITECTURE.md). Of a turn's other fields only `multimodals` is read, for
 * the pictures it still holds; the rest are the next editor's to read and are
 * not sent — `name` included: our provider takes the Responses API's turns,
 * which have no name, and RisuAI's own Responses request drops it too.
 *
 * **Images.** A picture goes on the first turn whose `multimodals` still holds
 * it — its data, or its stand-in — when that turn is a user or a system turn;
 * one no turn holds any more was removed, and is not sent. A system turn goes as
 * a developer message with the picture beside its text, as RisuAI's own
 * Responses request (`buildResponseInputItems`) sends a system turn's pictures —
 * and a first turn that carries one is not folded into the system string, which
 * our provider sends as `instructions`, a string, but leads the messages, the
 * system string left empty. One left on an assistant turn is not sent (logged):
 * the Responses API takes only `output_text` and `refusal` in an assistant turn,
 * and RisuAI's Responses request drops it too. An editor never adds one: data or
 * a name we did not hand out is nothing.
 *
 * **Fitting again.** RisuAI counts the request again once its `editRequest`
 * listeners left it (`sendChat`, between `runLuaEditTrigger` and
 * `requestChatData`), and one over the context is cut down to fit
 * (`refitRequest`) — or not sent at all. The request triggers come after it and
 * are not measured again.
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
  IMAGE_TOKEN_ESTIMATE,
  risuRequestView,
  type AssembledPrompt,
  type PromptMessage,
  type PromptPart,
  type PromptReport,
  type PromptReportBlock,
  type RisuRequestItem,
  type RisuRequestView,
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

/**
 * The most picture data one request hands its editors as data — the length of
 * its data URLs, all of them together: 4 MB, about a 3 MB picture, or a
 * screenshot and a photo; a turn may carry up to 16 MB. Past it, that request's
 * pictures are stand-ins that name them.
 *
 * Set by what a Lua listener pays for the data, which is time before memory:
 * RisuAI's `json.lua` decodes the request byte by byte in Lua, every script of
 * the card again, inside the run's three seconds (`REQUEST_LUA_DEADLINE_MS`).
 * Measured on the Lua child (macOS, M-series; four pictures on one turn, the
 * listener returning the request, the time including a child's ~120 ms start
 * the pool hides): 1 MB 0.26–0.34 s, 2 MB 0.36–0.61 s, 4 MB 0.57–0.60 s and
 * 1.0 s for a card of two scripts, 8 MB 1.4 s, 16 MB 3.4–3.5 s — past the
 * deadline. A Lua state needed about ten times the data (6 MB fit in 64 MB, 8 MB
 * did not), so `LUA_SERVER_MEMORY` is 64 MB, and the child peaked at about
 * 210–240 MB resident at 4 MB, under the 512 MB watchdog. The request triggers
 * take it in stride (about 5 ms a megabyte for a run that reads every turn).
 */
export const REQUEST_IMAGE_BUDGET = 4 * 1024 * 1024;

/** What a picture is called in a request whose pictures are past the budget: a stand-in, not its bytes. */
const imageName = (at: number): string => `image:${at}`;

/**
 * The request as its editors read it, what each item is of ours, and each
 * picture by what its `multimodals` entry holds — its data URL, or past
 * `budget` its stand-in — as many times as the request carries it.
 */
function requestOf(prompt: AssembledPrompt, budget: number): RisuRequestView & { images: Map<string, string[]> } {
  const view = risuRequestView(prompt);
  const size = view.items.reduce(
    (sum, item) => sum + (item.multimodals ?? []).reduce((total, image) => total + image.base64.length, 0),
    0,
  );
  const named = size > budget;
  const images = new Map<string, string[]>();
  let count = 0;
  const items = view.items.map((item): RisuRequestItem => {
    if (!item.multimodals) return item;
    return {
      ...item,
      multimodals: item.multimodals.map((image) => {
        const shown = named ? imageName(count++) : image.base64;
        images.set(shown, [...(images.get(shown) ?? []), image.base64]);
        return { type: 'image', base64: shown };
      }),
    };
  });
  return { items, origins: view.origins, images };
}

/** What a turn's `multimodals` holds, in order — whatever an editor left there. */
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

/** A request still over the context once every turn RisuAI may drop is gone: RisuAI's `toomuchtoken`. */
export class RequestTooLongError extends Error {
  readonly code = 'prompt_too_long';
  constructor(
    readonly tokens: number,
    readonly limit: number,
  ) {
    super(`The edited request needs ${tokens} tokens, more than the chat's ${limit}`);
  }
}

/** What a turn costs the context, counted as the assembler counts it: its text, and a flat estimate a picture. */
const turnTokens = (turn: RequestTurn): number =>
  countTokens(turn.content) + imagesNamed(turn).length * IMAGE_TOKEN_ESTIMATE;

/**
 * The request the `editRequest` listeners left, fitted to the chat's context
 * again, as RisuAI's `sendChat` does after them ("token rechecking"): counted
 * whole, and when it is over `limit` — the whole context, not the context less
 * the reply's share the prompt was put together in — the turns are walked from
 * the first, each one still `removable` as the listeners left it blanked, until
 * it fits. The blanked turns are then dropped, and with them any other turn
 * left empty, unless a picture is still on it (its count went with its text,
 * as RisuAI's does). Walking off the end still over is RisuAI's `toomuchtoken`:
 * the request is not sent (`RequestTooLongError`).
 *
 * Counted the way the assembler counts the prompt (`countTokens`, and
 * `IMAGE_TOKEN_ESTIMATE` a picture), where RisuAI's tokenizer adds a few tokens
 * a turn on top — ours did not count those when the prompt was put together
 * either. A request that fits comes back as it was.
 */
export function refitRequest<T extends RequestTurn>(turns: readonly T[], limit: number): T[] {
  let total = turns.reduce((sum, turn) => sum + turnTokens(turn), 0);
  if (total <= limit) return [...turns];
  const fitted = [...turns];
  for (let at = 0; total > limit; at += 1) {
    if (at >= fitted.length) throw new RequestTooLongError(total, limit);
    const turn = fitted[at]!;
    if ((turn as { removable?: unknown }).removable) {
      total -= turnTokens(turn);
      fitted[at] = { ...turn, content: '' };
    }
  }
  return fitted.filter((turn) => turn.content !== '' || imagesNamed(turn).length > 0);
}

/** A turn the editors changed, in the report: one `request` block under the role it goes as. */
const requestBlock = (turn: RequestTurn): PromptReportBlock => ({
  kind: 'request',
  label: turn.role,
  tokens: countTokens(turn.content),
  text: turn.content,
});

/**
 * The report with the request as it is sent: a turn the editors left as the
 * view had it keeps the blocks it stands for — a turn of the system string its
 * sections (the memory's apart, as the assembler runs them together:
 * `RisuPromptParts.system`), a message its block, a separator or a line of an
 * example block that block's kind and name — and one they rewrote is one
 * `request` block under the role it went as. The totals stay the assembler's —
 * the budget was spent before the editors ran, and RisuAI does not measure
 * their edit either.
 */
function editedReport(report: PromptReport, messages: number, view: RisuRequestView, after: readonly RequestTurn[]): PromptReport {
  const sections = report.blocks.slice(0, report.blocks.length - messages);
  const turns = report.blocks.slice(report.blocks.length - messages);
  // The system string's turns, as the assembler made them: a run of sections, the memory's alone.
  const systemTurns: PromptReportBlock[][] = [];
  for (const block of sections) {
    const previous = systemTurns.at(-1);
    if (previous && (previous[0]!.kind === 'memory') === (block.kind === 'memory')) previous.push(block);
    else systemTurns.push([block]);
  }
  const blocksOf = (index: number): PromptReportBlock[] => {
    const origin = view.origins[index]!;
    const item = view.items[index]!;
    switch (origin.kind) {
      case 'system':
        return systemTurns[origin.at] ?? [requestBlock(item)];
      case 'message':
        return [turns[origin.at]!];
      case 'example': {
        const label = turns[origin.at]?.label;
        return [{ kind: 'examples', ...(label !== undefined ? { label } : {}), tokens: countTokens(item.content), text: item.content }];
      }
    }
  };
  return {
    ...report,
    blocks: after.flatMap((turn, index) => {
      const was = view.items[index];
      return was && was.role === turn.role && was.content === turn.content ? blocksOf(index) : [requestBlock(turn)];
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
 * `OpenAIChat`, `risuRequestView`) on and answers null for a request it leaves
 * as it was. `imageBudget` is `REQUEST_IMAGE_BUDGET` but for the tests.
 */
export async function withEditedRequest(
  prompt: AssembledPrompt,
  edit: (items: RisuRequestItem[]) => Promise<EditedTurn[] | null>,
  label: string,
  { imageBudget = REQUEST_IMAGE_BUDGET }: { imageBudget?: number } = {},
): Promise<AssembledPrompt> {
  const view = requestOf(prompt, imageBudget);
  const edited = await edit(view.items);
  if (!edited || sameRequest(view.items, edited)) return prompt;

  // A leading system turn is the system string — the provider's `instructions`,
  // which is text — unless it carries a picture we handed out, when it stays a
  // turn of its own that can.
  const first = edited[0];
  const system =
    first?.role === 'system' && !imagesNamed(first).some((name) => view.images.has(name)) ? first.content : null;
  // Each picture on the first turn that still holds it, if that turn may carry one.
  let refused = 0;
  const partsOf = (turn: EditedTurn): PromptPart[] =>
    imagesNamed(turn).flatMap((name): PromptPart[] => {
      const url = view.images.get(name)?.shift();
      if (url === undefined) return [];
      if (turn.role === 'assistant') {
        refused += 1;
        return [];
      }
      return [{ type: 'image', url }];
    });
  const messages: PromptMessage[] = (system !== null ? edited.slice(1) : edited).map((turn) => {
    const parts = partsOf(turn);
    return {
      role: turn.role,
      content: parts.length > 0 ? [{ type: 'text', text: turn.content }, ...parts] : turn.content,
    };
  });
  if (refused > 0) console.warn(`[api] the request's scripts left ${refused} image(s) on an assistant turn; not sent:`, label);
  const { sources: _stale, risu: _view, systemSections: _sections, ...rest } = prompt;
  return {
    ...rest,
    system: system ?? '',
    messages,
    ...(prompt.report ? { report: editedReport(prompt.report, prompt.messages.length, view, edited) } : {}),
  };
}
