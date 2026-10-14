/**
 * A card's Lua `editRequest` listeners — RisuAI's `runLuaEditTrigger(char,
 * 'editRequest', formated)`, which `sendChat` runs over the request it has just
 * put together, before `requestChatData` runs the request triggers over what
 * they leave — run here, on the server: the request is assembled here and never
 * reaches the reader's browser, where every other Lua hook runs.
 *
 * **The sandbox is a process.** Card Lua is a stranger's code, and in Node no
 * CSP keeps it from compiling JavaScript should it climb out of wasmoon. So it
 * runs in a child (`requestLuaChild.ts`) spawned with Node's permission model
 * (`luaChildArgs`): it may read its own entry file and nothing else, write
 * nothing, start no process, worker, addon or WASI module, open no socket and
 * resolve no name — no `--allow-net` — compile no code from a string, and keep
 * a heap of `HEAP_MB`; its environment is empty, and everything it runs arrives
 * on stdin. Inside, the worker is `@shizue/core/lua`'s, the program the reader's
 * browser runs, in its `server` variant: no JavaScript object a script can
 * index, no Lua library that reaches past the state, `LUA_SERVER_MEMORY`
 * (64 MB) a Lua state — twice the browser's, for the request's pictures.
 *
 * Node's permission model controls the network only from 25 on, and before
 * that a child under it can still connect anywhere. So the server asks once,
 * at startup (`probeRequestLua`): a child spawned the same way must be refused
 * a name lookup and a socket. Where it is not, no card's Lua runs here at all —
 * its requests go unedited, and the log says so once.
 *
 * **A child runs once.** One run — every Lua script on the card, in trigger
 * order, each listener's request the next one's — and the child is killed,
 * whatever happened: nothing a script left in the child's JavaScript reaches
 * another chat or another reader. Each script gets a fresh Lua state, as
 * RisuAI makes one when the code changes. `POOL_SIZE` children are kept
 * booted, so a run does not wait the ~60 ms one takes to start.
 *
 * **What a state keeps.** RisuAI keeps one `editRequest` state, rebuilt only
 * when the next script's code differs, so its globals outlive a generation —
 * for a card with one Lua script; with more, the code alternates and the state
 * is rebuilt every call. The closest thing here: the last script's plain-data
 * globals are taken when a run ends (`LUA_STATE` — strings, numbers, booleans
 * and tables of them, never code), kept by reader and the card's Lua
 * (`luaStateKey`: RisuAI's one state lives in one reader's app and holds while
 * the code is the same, and the browser keeps one per code too) and tagged with
 * that script's hash (`LuaStateStore`, in memory), and put back into the next
 * run's first script once its code has loaded — whichever of the reader's chats
 * and works with that code it runs for, and only when it is the same script, so
 * a card with several scripts starts every one fresh, as in RisuAI. They go in
 * as data, read by the keeper the state made before the card's code ran.
 *
 * **What a listener has.** What the browser hands its worker: the chat (the
 * whole branch), its variables, the reader's global variables, the character
 * as the reader's overlay has it, the chat's own lore, the persona and the
 * chat's note — and the request as the request triggers read it: RisuAI's
 * `OpenAIChat` items in the shape RisuAI's request has, `memo` and the rest
 * beside `role` and `content`, the pictures as their data URLs — stand-ins past
 * a request's budget (`requestTriggers.ts`). RisuAI's
 * `runLuaEditTrigger` gives its listeners no low-level access, so `LLM`,
 * `axLLM`, `simpleLLM`, `request`, `similarity` and `loadLoreBooks` answer nil
 * in the worker, and the child asking for any of them anyway is a broken child.
 * A dialog has no one to ask: it is answered as the browser answers a display
 * pass's. `sleep` sleeps, on the clock below.
 *
 * **What comes back.** Each script's value replaces the request unless it is
 * null, as RisuAI's `res ?? data`; the last must be a list of turns we can
 * send (`turnsOf`), and goes on to the request triggers as it was left, every
 * field of it. Chat variables a listener wrote are the generated turn's,
 * as RisuAI's listener writes the live chat — so the browser's output run folds
 * from them. What it did to the chat, the character and the chat's lore comes
 * back too (`ListenerEdits`), read as the browser's sandbox reads a call's, and
 * each script reads what the ones before it did; the reply keeps it — the chat
 * as the branch it hangs under, the character in the reader's overlay, the lore
 * in the chat's own (`generation.ts`).
 *
 * **Failure.** One hard clock for the whole run (`REQUEST_LUA_DEADLINE_MS`).
 * A child that runs it out, exits, writes a line that is not one of the
 * worker's messages, or asks for something no listener may have is killed, and
 * the request goes as it was — RisuAI's try/catch around the run sends it
 * unedited too. So does a listener that throws (its writes stand, as RisuAI's).
 */
import { fitVariableDelta, type VariableDelta } from '@shizue/core';
import { LUA_LIMITS, LUA_STATE_LIMIT, luaWorkerSource, type LuaLoreBook, type LuaSnapshot } from '@shizue/core/lua';
import { LUA_CBS_ENGINE } from '@shizue/core/lua-cbs';
import { MAX_TRIGGER_VALUE_LENGTH, type RequestTurn } from '@shizue/core/triggers';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUEST_IMAGE_BUDGET, turnsOf, type EditedTurn } from './requestTriggers.js';

/**
 * How long a whole run may take, from the child it is handed to its last
 * answer: three seconds, as the request triggers that run right after it get.
 * Honest work is far inside it — RisuAI's `json.lua` decodes and re-encodes the
 * request in Lua, and a 160,000-character request (past the largest context a
 * chat has) took about 26 ms through a listener that rewrote every turn; a
 * listener that reads a 2,000-message chat whole decoded its 4 MB in about
 * 430 ms. A script that hangs costs its reader's reply three seconds, once,
 * beside a reply that takes tens of seconds.
 *
 * This is the only clock: the browser's watchdog also counts CPU time (15 s)
 * and time excluding the waits on the reader, the model and the network
 * (120 s), and here there are no such waits — a dialog is answered at once and
 * a listener has no model or network call — so wall time is active time, and
 * both budgets are far past this one. A `sleep` counts against it.
 */
export const REQUEST_LUA_DEADLINE_MS = 3_000;

/**
 * Children kept, booted or running: two, as the request triggers have two
 * threads. A run takes milliseconds and a reply tens of seconds, so two serve
 * many generations at once, and a card that hangs holds one for the deadline
 * at most. Each idles at about 70 MB of memory and is held to `HEAP_MB` of heap
 * and `LUA_SERVER_MEMORY` (64 MB) a Lua state; a third run waits for one to finish.
 */
const POOL_SIZE = 2;

/** The child's JavaScript heap: the request — its pictures too, up to `REQUEST_IMAGE_BUDGET` — the chat and their JSON, twice over. */
const HEAP_MB = 128;

/**
 * The most a child may hold in memory during a run, counted the way the
 * kernel counts it (resident set), so WebAssembly memory and anything else
 * off the V8 heap is in it. Set well above what a run uses (about 70 MB idle,
 * the 128 MB heap and the Lua states on top; a listener over a request with
 * 4 MB of pictures peaked at about 210–240 MB) so it only ever stops a child
 * that is running away. Read from `/proc`, so only where there is one — Linux,
 * where the API is deployed; elsewhere the heap and Lua limits stand alone.
 */
const RSS_LIMIT_MB = 512;
const RSS_POLL_MS = 100;

/**
 * The longest line the parent reads from a child: 8 MB — far past any request
 * a chat's text makes, or a whole 2,000-message chat — and the request's
 * pictures, which a listener hands back as data up to `REQUEST_IMAGE_BUDGET`.
 */
const MAX_LINE = 8 * 1024 * 1024 + REQUEST_IMAGE_BUDGET;

/** How long a child has to load wasmoon, and the probe to answer. */
const BOOT_MS = 10_000;

/** Variable writes a run may hand back, as the browser's sandbox takes them. */
const MAX_VARS = 10_000;
/** Messages one call may hand back beyond the ones it was given, as the browser's sandbox takes them. */
const MAX_ADDED_MESSAGES = 1_000;
/** Lore entries a run may upsert, as the browser's sandbox takes them from one call. */
const MAX_LORE = 2_000;

/** What one run takes: the card's Lua scripts in trigger order, the request, and what a script may read. */
export interface RequestLuaInput {
  scripts: string[];
  /** RisuAI's `OpenAIChat` items (`requestTriggers.ts`), as JSON goes. */
  request: readonly RequestTurn[];
  snapshot: LuaSnapshot;
  /**
   * The state's globals across runs (`LUA_STATE`): `restore` is put into the
   * first script's state once its code has loaded, and `capture` takes the last
   * script's when the run is done — RisuAI's one `editRequest` state, which
   * holds the code it ran last and is rebuilt when the next code differs.
   */
  keep?: { restore?: string; capture?: boolean };
}

/** A message of the chat as the listeners left it: `key` is the snapshot message it is, null for one they added. */
export interface LuaChatMessage {
  role: 'user' | 'char';
  data: string;
  key: number | null;
}

/** What the listeners rewrote of the character (RisuAI's `char`): the last value each was set to. */
export interface LuaCharacterRewrite {
  name?: string;
  description?: string;
  firstMessage?: string;
  background?: string;
}

/**
 * How a run ended: the request as the listeners left it — any JSON, checked by
 * the caller — with the chat variables they wrote, the chat as they left it
 * (null when untouched), what they rewrote of the character and the lore they
 * upserted, in order — all of it read as a stranger's data, to the browser
 * sandbox's sizes — and what was noted; with `keep.capture`, the last state's
 * globals (`state`, null when they would not fit); or why there is none. `quiet`
 * is a run that was never made because the server cannot sandbox it, which the
 * log has said once already.
 */
export type RequestLuaOutcome =
  | {
      ok: true;
      request: unknown;
      vars: [string, string | null][];
      notes: string[];
      messages?: LuaChatMessage[] | null;
      character?: LuaCharacterRewrite;
      lore?: LuaLoreBook[];
      state?: string | null;
    }
  | { ok: false; reason: string; quiet?: boolean };

/** What runs the listeners — the pool, unless a test hands its own. */
export type RequestLuaRunner = (input: RequestLuaInput) => Promise<RequestLuaOutcome>;

/** The child's entry, and the probe's, beside this module: `.ts` where Node runs the sources, `.js` once built. */
const EXTENSION = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js';
const CHILD_PATH = fileURLToPath(new URL(`./requestLuaChild${EXTENSION}`, import.meta.url));
const PROBE_PATH = fileURLToPath(new URL(`./requestLuaProbe${EXTENSION}`, import.meta.url));

/**
 * How a child is started, `entry` the one file it may read. No `--allow-net`,
 * `--allow-fs-write`, `--allow-child-process`, `--allow-worker`,
 * `--allow-addons` or `--allow-wasi`: under `--permission` each is refused.
 */
export const luaChildArgs = (entry: string): string[] => [
  '--permission',
  `--allow-fs-read=${entry}`,
  '--disallow-code-generation-from-strings',
  `--max-old-space-size=${HEAP_MB}`,
  entry,
];

/** Starts `entry` as a child is started: those flags, an empty environment, nothing inherited. */
export const spawnLuaChild = (entry: string, stdio: ('pipe' | 'ignore')[]): ChildProcess =>
  spawn(process.execPath, luaChildArgs(entry), { env: {}, stdio });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/* ---------------------------------------------------------------- the probe */

let probed: Promise<boolean> | null = null;

/**
 * Whether a child spawned as `luaChildArgs` spawns it is off the network:
 * `requestLuaProbe.ts`, run so, must be refused a lookup and a socket. Asked
 * once a process, at startup, and the answer is logged then. An unknown flag,
 * a failed spawn, a lookup that answers or no answer in time are all "no".
 */
export function probeRequestLua(): Promise<boolean> {
  probed ??= new Promise<boolean>((resolve) => {
    const proc = spawnLuaChild(PROBE_PATH, ['ignore', 'pipe', 'ignore']);
    let out = '';
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill('SIGKILL');
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), BOOT_MS);
    timer.unref();
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      out += chunk;
      if (out.length > 1_000) done(false);
    });
    proc.on('error', () => done(false));
    proc.on('close', () => {
      try {
        const answer: unknown = JSON.parse(out);
        done(isRecord(answer) && answer['lookupDenied'] === true && answer['connectDenied'] === true);
      } catch {
        done(false);
      }
    });
  }).then((ok) => {
    if (ok) {
      console.info(`[api] cards' Lua editRequest listeners run in a sandboxed child (Node ${process.version})`);
    } else {
      console.warn(
        `[api] Node ${process.version} cannot keep a child process off the network (its permission model ` +
          "controls it from Node 25); cards' Lua editRequest listeners will not run, and their requests go unedited",
      );
    }
    return ok;
  });
  return probed;
}

/* --------------------------------------------------------------- the children */

let program: string | null = null;

/** What a child is sent first: the worker with wasmoon inlined, and wasmoon's WebAssembly. Read once. */
function programLine(): string {
  if (program === null) {
    const dist = dirname(createRequire(import.meta.url).resolve('wasmoon'));
    const source = luaWorkerSource(readFileSync(join(dist, 'index.js'), 'utf8'), 'globalThis', { server: true, cbs: LUA_CBS_ENGINE });
    const wasm = readFileSync(join(dist, 'glue.wasm')).toString('base64');
    program = `${JSON.stringify({ type: 'program', source, wasm })}\n`;
  }
  return program;
}

interface LuaChild {
  proc: ChildProcess;
  /** True once wasmoon is up; false if it never will be. */
  booted: Promise<boolean>;
  /** Where its messages go while a run holds it. */
  listener: ((message: Record<string, unknown>) => void) | null;
  /** Whoever holds it, told once if it dies or breaks. */
  onDead: ((reason: string) => void) | null;
  /** Why it is unusable, once it is. */
  dead: string | null;
  post(message: unknown): void;
  kill(reason: string): void;
}

function spawnChild(entry = CHILD_PATH): LuaChild {
  const proc = spawnLuaChild(entry, ['pipe', 'pipe', 'ignore']);
  let settleBoot: (ok: boolean) => void = () => {};
  const child: LuaChild = {
    proc,
    booted: new Promise<boolean>((resolve) => {
      settleBoot = resolve;
    }),
    listener: null,
    onDead: null,
    dead: null,
    post: (message) => {
      if (child.dead === null) proc.stdin!.write(`${JSON.stringify(message)}\n`);
    },
    kill: (reason) => {
      if (child.dead !== null) return;
      child.dead = reason;
      clearTimeout(bootTimer);
      proc.kill('SIGKILL');
      settleBoot(false);
      child.onDead?.(reason);
    },
  };
  const bootTimer = setTimeout(() => child.kill('did not load wasmoon in time'), BOOT_MS);
  bootTimer.unref();

  // Every line is a stranger's: one that is not a message of the worker's kills the child.
  let pending = '';
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf('\n'); end !== -1 && child.dead === null; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return child.kill('wrote a line that is not JSON');
      }
      if (!isRecord(message)) return child.kill('wrote a message that is not an object');
      if (message['type'] === 'booted') {
        clearTimeout(bootTimer);
        settleBoot(true);
      } else if (message['type'] === 'bootFailed') {
        child.kill(`could not load wasmoon: ${String(message['message']).slice(0, 200)}`);
      } else if (child.listener) {
        child.listener(message);
      } else {
        child.kill('spoke while no run held it');
      }
    }
    if (pending.length > MAX_LINE) child.kill('wrote a line past the limit');
  });
  proc.on('exit', () => child.kill('exited'));
  proc.on('error', (error) => child.kill(`could not run: ${error.message}`));
  // A write to a child that just died.
  proc.stdin!.on('error', () => child.kill('closed its input'));
  proc.stdin!.write(programLine());

  // An idle pool must never keep the process (or a test run) alive.
  proc.unref();
  (proc.stdin as Socket).unref();
  (proc.stdout as Socket).unref();
  return child;
}

const idle: LuaChild[] = [];
const waiting: ((child: LuaChild) => void)[] = [];
let live = 0;

/** A new child, counted, which drops out of the idle pool on its own if it dies there. */
function fresh(): LuaChild {
  live += 1;
  const child = spawnChild();
  child.onDead = () => {
    const at = idle.indexOf(child);
    if (at === -1) return;
    idle.splice(at, 1);
    live -= 1;
  };
  return child;
}

function acquire(): Promise<LuaChild> {
  const ready = idle.shift();
  if (ready) return Promise.resolve(ready);
  if (live < POOL_SIZE) return Promise.resolve(fresh());
  return new Promise((resolve) => waiting.push(resolve));
}

/** Ends a child after its run, whatever happened, and fills its place: whoever waits, or the warm pool. */
function retire(child: LuaChild): void {
  child.listener = null;
  child.onDead = null;
  child.kill('retired');
  live -= 1;
  const next = waiting.shift();
  if (next) {
    next(fresh());
    return;
  }
  while (live < POOL_SIZE) idle.push(fresh());
}

/* ------------------------------------------------------------------- a run */

/** Runs `input` in a child of the pool, against one clock; the child is ended after. */
export async function runRequestLua(
  input: RequestLuaInput,
  {
    deadlineMs = REQUEST_LUA_DEADLINE_MS,
    probe = probeRequestLua,
  }: { deadlineMs?: number; probe?: () => Promise<boolean> } = {},
): Promise<RequestLuaOutcome> {
  // The probe said so once, at startup.
  if (!(await probe())) return { ok: false, reason: 'the server cannot sandbox Lua', quiet: true };
  const child = await acquire();
  try {
    return await runIn(child, input, deadlineMs);
  } finally {
    retire(child);
  }
}

/**
 * A run in a child of its own, started from `entry` rather than the Lua child —
 * how the tests hand the parent a child that breaks the protocol.
 */
export async function runRequestLuaAt(
  entry: string,
  input: RequestLuaInput,
  deadlineMs = REQUEST_LUA_DEADLINE_MS,
): Promise<RequestLuaOutcome> {
  const child = spawnChild(entry);
  try {
    return await runIn(child, input, deadlineMs);
  } finally {
    child.kill('done');
  }
}

/** Kills the child once its resident memory passes `RSS_LIMIT_MB`, while `done()` is false. */
function watchMemory(child: LuaChild, done: () => boolean): void {
  const pid = child.proc.pid;
  if (process.platform !== 'linux' || pid === undefined) return;
  const poll = async (): Promise<void> => {
    if (done() || child.dead !== null) return;
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const kb = Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1]);
      if (kb > RSS_LIMIT_MB * 1024) return child.kill(`used more than ${RSS_LIMIT_MB} MB`);
    } catch {
      return;
    }
    setTimeout(() => void poll(), RSS_POLL_MS).unref();
  };
  void poll();
}

/** A lore entry as a listener upserted it, in RisuAI's shape, as the browser's sandbox reads one (`checkLore`). */
function checkLore(value: unknown): LuaLoreBook | null {
  if (!isRecord(value)) return null;
  const str = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string) : '');
  return {
    key: str('key'),
    secondkey: str('secondkey'),
    insertorder: typeof value['insertorder'] === 'number' && Number.isFinite(value['insertorder']) ? value['insertorder'] : 100,
    comment: str('comment'),
    content: str('content'),
    mode: 'normal',
    alwaysActive: value['alwaysActive'] === true,
    selective: value['selective'] === true,
    useRegex: value['useRegex'] === true,
  };
}

/**
 * The chat a call left, read as the browser's sandbox reads it (`checkResult`):
 * at most `MAX_ADDED_MESSAGES` beyond the `given` it was handed, each with its
 * text, and a message keeping its identity once at most, and only one it was
 * given. Null when it is not that.
 */
function checkMessages(value: unknown, given: number): LuaChatMessage[] | null {
  if (!Array.isArray(value) || value.length > given + MAX_ADDED_MESSAGES) return null;
  const seen = new Set<number>();
  const messages: LuaChatMessage[] = [];
  for (const message of value) {
    if (!isRecord(message) || typeof message['data'] !== 'string') return null;
    const key = message['key'];
    const kept = typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < given && !seen.has(key) ? key : null;
    if (kept !== null) seen.add(kept);
    messages.push({ role: message['role'] === 'user' ? 'user' : 'char', data: message['data'], key: kept });
  }
  return messages;
}

function runIn(child: LuaChild, input: RequestLuaInput, deadlineMs: number): Promise<RequestLuaOutcome> {
  return new Promise<RequestLuaOutcome>((resolve) => {
    let settled = false;
    const sleeps = new Set<ReturnType<typeof setTimeout>>();
    const finish = (outcome: RequestLuaOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      for (const timer of sleeps) clearTimeout(timer);
      child.listener = null;
      child.onDead = null;
      resolve(outcome);
    };
    const deadline = setTimeout(() => finish({ ok: false, reason: `no answer in ${deadlineMs} ms` }), deadlineMs);
    child.onDead = (reason) => finish({ ok: false, reason: `the Lua process ${reason}` });
    watchMemory(child, () => settled);
    const broke = (why: string): void => child.kill(why);

    let request = input.request as unknown;
    const vars = new Map(input.snapshot.vars);
    const writes = new Map<string, string | null>();
    const notes = new Set<string>();
    // The chat, the character and the chat's lore as the listeners left them —
    // each script reads what the ones before it did, as RisuAI's read the live
    // chat and character. A message carries the snapshot index it started as.
    let chat = input.snapshot.messages.map((message, at) => ({ ...message, key: at as number | null }));
    let chatChanged = false;
    const char = { ...input.snapshot.char, localLore: [...(input.snapshot.char.localLore ?? [])] };
    const rewrote: LuaCharacterRewrite = {};
    const upserts: LuaLoreBook[] = [];
    let state: string | null | undefined;
    let call = 0;
    let served = new Set<number>();

    const next = (): void => {
      if (call === input.scripts.length) {
        finish({
          ok: true,
          request,
          vars: [...writes],
          notes: [...notes],
          messages: chatChanged ? chat.map(({ role, data, key }) => ({ role, data, key })) : null,
          character: rewrote,
          lore: upserts,
          ...(state !== undefined ? { state } : {}),
        });
        return;
      }
      call += 1;
      served = new Set();
      // Each script reads what the ones before it wrote, as RisuAI's read the live chat.
      const snapshot: LuaSnapshot = {
        ...input.snapshot,
        vars: [...vars],
        messages: chat.map(({ role, data, time }) => ({ role, data, ...(time !== undefined ? { time } : {}) })),
        char: { ...char, localLore: [...char.localLore] },
        lowLevel: false,
      };
      // The state's globals go into the first script's state and come out of the last one's.
      const keep = {
        ...(call === 1 && input.keep?.restore !== undefined ? { restore: input.keep.restore } : {}),
        ...(call === input.scripts.length && input.keep?.capture ? { capture: true } : {}),
      };
      child.post({
        type: 'call',
        call,
        code: input.scripts[call - 1],
        entry: { kind: 'request', data: request },
        snapshot,
        ...(Object.keys(keep).length > 0 ? { keep } : {}),
      });
    };

    child.listener = (message) => {
      if (message['type'] === 'host') {
        const host = message['host'];
        if (message['call'] !== call || typeof host !== 'number' || served.has(host)) return broke('made a host call out of turn');
        served.add(host);
        const reply = (answer: { ok: true; value: unknown } | { ok: false; error: string }): void =>
          child.post({ type: 'reply', host, ...answer });
        switch (message['name']) {
          case 'sleep': {
            const args = message['args'];
            const ms = Math.min(LUA_LIMITS.sleep, Math.max(0, Number(isRecord(args) ? args['ms'] : 0) || 0));
            const timer = setTimeout(() => {
              sleeps.delete(timer);
              reply({ ok: true, value: true });
            }, ms);
            sleeps.add(timer);
            return;
          }
          // No reader to ask: what the browser answers a display pass's dialog.
          case 'alert':
          case 'input':
          case 'select':
          case 'confirm':
            return reply({ ok: false, error: 'not here' });
          default:
            // A model call, a search, a request, the lore: low-level access, which no listener has.
            return broke(`asked for ${String(message['name']).slice(0, 40)}, which an editRequest listener never has`);
        }
      }
      if (message['type'] === 'done' && message['call'] === call) {
        const result = isRecord(message['result']) ? message['result'] : {};
        // RisuAI's `data = res ?? data`: a listener that returned nothing, or threw, leaves it.
        if (result['res'] !== undefined && result['res'] !== null) request = result['res'];
        if (Array.isArray(result['vars'])) {
          for (const pair of result['vars'].slice(0, MAX_VARS)) {
            if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
            const value: unknown = pair[1];
            if (value !== null && typeof value !== 'string') continue;
            writes.set(pair[0], value);
            if (value === null) vars.delete(pair[0]);
            else vars.set(pair[0], value);
          }
        }
        if (typeof result['error'] === 'string') notes.add(`a listener failed: ${result['error'].slice(0, 200)}`);
        if (Array.isArray(result['notes'])) {
          for (const pair of result['notes'].slice(0, 64)) {
            if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
              notes.add(`${pair[0].slice(0, 100)}: ${pair[1].slice(0, 200)}`);
            }
          }
        }
        // What it did to the chat: kept when it is a chat the browser's sandbox would take.
        if (result['messages'] !== null && result['messages'] !== undefined) {
          const left = checkMessages(result['messages'], chat.length);
          if (left) {
            const before = chat;
            chat = left.map((entry) => {
              const was = entry.key !== null ? before[entry.key]! : undefined;
              return { role: entry.role, data: entry.data, time: was?.time ?? 0, key: was ? was.key : null };
            });
            chatChanged = true;
          } else notes.add('its chat edits were not a chat; dropped');
        }
        // What it rewrote of the character, the last value each, as RisuAI's live `char` keeps it.
        for (const [field, into] of [
          ['name', 'name'],
          ['description', 'description'],
          ['firstMessage', 'firstMessage'],
          ['background', 'background'],
        ] as const) {
          const value = result[field];
          if (typeof value !== 'string') continue;
          rewrote[into] = value;
          char[into] = value;
        }
        if (Array.isArray(result['lore'])) {
          for (const raw of result['lore'].slice(0, MAX_LORE - upserts.length)) {
            const book = checkLore(raw);
            if (!book) continue;
            upserts.push(book);
            char.localLore = [...char.localLore.filter((entry) => entry.comment !== book.comment), book];
          }
        }
        if (call === input.scripts.length && input.keep?.capture) {
          const taken = result['state'];
          state =
            typeof taken === 'string' && Buffer.byteLength(taken, 'utf8') <= LUA_STATE_LIMIT ? taken : null;
        }
        next();
        return;
      }
      if (message['type'] === 'pong') return;
      broke('wrote a message the worker does not send');
    };

    void child.booted.then((ok) => {
      if (settled) return;
      if (!ok) finish({ ok: false, reason: `the Lua process ${child.dead ?? 'did not start'}` });
      else next();
    });
  });
}

/* --------------------------------------------------------------- the edit */

/** The chat variables a run wrote, as the turn can keep them: a value past what a trigger may write is dropped, as the browser drops it, and so is each write past a delta's limits (`fitVariableDelta`) — the rest are kept. */
function keptWrites(vars: [string, string | null][], label: string): VariableDelta | null {
  const kept = vars.filter(([, value]) => value === null || value.length <= MAX_TRIGGER_VALUE_LENGTH);
  if (kept.length < vars.length) console.warn('[api] editRequest wrote a variable past its length; dropped:', label);
  const fitted = fitVariableDelta(Object.fromEntries(kept));
  if (fitted.dropped > 0) {
    console.warn(`[api] ${fitted.dropped} of editRequest's variable writes are not kept (a delta ${fitted.reason}); the rest are:`, label);
  }
  return fitted.delta;
}

/**
 * What the listeners did besides the request and the variables, which RisuAI's
 * listener does to the live chat and character: the chat after its greeting as
 * they left it (null when untouched; `key` the snapshot message each one is),
 * what they rewrote of the scripted member, and the lore they upserted into the
 * chat's own, in order. The caller keeps it with the reply (`generation.ts`).
 */
export interface ListenerEdits {
  messages: LuaChatMessage[] | null;
  character: LuaCharacterRewrite;
  lore: LuaLoreBook[];
}

/**
 * `turns` as the card's `editRequest` listeners left them, every field of them
 * — or null when the run failed or left something that is not a request; the
 * chat variables they wrote; what else they did (`edits`, null when nothing);
 * and, with `keep.capture`, their state's globals (`state`: null when there
 * were none to keep, undefined when the run was not made or failed — what an
 * earlier run kept then stands).
 */
export async function editRequestLua(
  turns: readonly RequestTurn[],
  input: Omit<RequestLuaInput, 'request'>,
  { run = runRequestLua, label }: { run?: RequestLuaRunner | undefined; label: string },
): Promise<{ turns: EditedTurn[] | null; writes: VariableDelta | null; edits: ListenerEdits | null; state?: string | null }> {
  let outcome: RequestLuaOutcome;
  try {
    outcome = await run({ ...input, request: turns });
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!outcome.ok) {
    if (!outcome.quiet) console.warn('[api] editRequest sent the request unedited:', label, outcome.reason);
    return { turns: null, writes: null, edits: null };
  }
  for (const note of outcome.notes) console.warn(`[api] editRequest: ${note}:`, label);
  const writes = keptWrites(outcome.vars, label);
  const character = outcome.character ?? {};
  const lore = outcome.lore ?? [];
  const messages = outcome.messages ?? null;
  const edits = messages || Object.keys(character).length > 0 || lore.length > 0 ? { messages, character, lore } : null;
  const kept = outcome.state !== undefined ? { state: outcome.state } : {};
  const edited = turnsOf(outcome.request);
  if (!edited) console.warn('[api] editRequest left something that is not a request; sent unedited:', label);
  return { turns: edited, writes, edits, ...kept };
}

/* ------------------------------------------------------- state across runs */

/** One kept `editRequest` state's globals (`LUA_STATE`), and the code they were taken from. */
export interface KeptLuaState {
  /** `luaStateHash` of the script whose state they are — the run's last. */
  hash: string;
  state: string;
}

/** Where the server keeps them between generations, by `luaStateKey`. */
export interface LuaStateStore {
  get(key: string): KeptLuaState | undefined;
  set(key: string, kept: KeptLuaState): void;
  delete(key: string): void;
}

/**
 * Whose `editRequest` state it is: one reader's, for one card's Lua — all of
 * its scripts, hashed. RisuAI keeps one state a mode in the reader's own app,
 * kept while the code stays the same, and the reader's browser keeps one a
 * card's code and mode (web `lua/engine.ts`). So every chat the reader has with
 * that code shares it — the same card in two works too, as in RisuAI — while a
 * group's members, whose code differs, keep theirs apart; another reader never
 * sees it.
 *
 * One difference is kept on purpose: RisuAI's one state a mode is made anew
 * whenever other code runs in it, as on every speaker change in a group, which
 * would wipe a group card's globals every turn. Here each code keeps its own,
 * in the store's LRU.
 */
export const luaStateKey = (reader: string, scripts: readonly string[]): string =>
  `${reader}\u0000${luaStateHash(JSON.stringify(scripts))}\u0000editRequest`;

/**
 * The states this process keeps: the most recently used first to stay, up to
 * `entries` of them and `chars` characters in all — each one is at most
 * `LUA_STATE_LIMIT` bytes. In memory, as RisuAI's states live in the reader's
 * tab and go with it: a restart, or another instance of the API, starts the
 * next run without them, which is RisuAI's after a reload.
 */
export function createLuaStateStore({ entries = 1_000, chars = 32_000_000 }: { entries?: number; chars?: number } = {}): LuaStateStore {
  const kept = new Map<string, KeptLuaState>();
  let total = 0;
  const drop = (key: string): void => {
    const was = kept.get(key);
    if (!was) return;
    kept.delete(key);
    total -= was.state.length;
  };
  return {
    get(key) {
      const found = kept.get(key);
      if (found) {
        kept.delete(key);
        kept.set(key, found);
      }
      return found;
    },
    set(key, value) {
      drop(key);
      kept.set(key, value);
      total += value.state.length;
      for (const oldest of kept.keys()) {
        if (kept.size <= entries && total <= chars) break;
        drop(oldest);
      }
    },
    delete: drop,
  };
}

/** The process's own store, unless the app is handed another (`AppDeps.luaStates`). */
export const luaStates = createLuaStateStore();

/** What a kept state is tagged with: the script's text, hashed. */
export const luaStateHash = (code: string): string => createHash('sha256').update(code).digest('hex');

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The markup the browser's `getCharacterImage` answers for the member's avatar
 * (web `lua/engine.ts`), and `getPersonaImage` for the persona's picture: '' without one.
 */
export const characterImage = (url: string | null | undefined): string =>
  url ? `<div class="risu-inlay-image"><img src="${escapeAttribute(url)}"></div>` : '';
