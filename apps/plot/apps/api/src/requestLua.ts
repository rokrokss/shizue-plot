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
 * index, no Lua library that reaches past the state, 32 MB a Lua state.
 *
 * Node's permission model controls the network only from 25 on, and before
 * that a child under it can still connect anywhere. So the server asks once,
 * at startup (`probeRequestLua`): a child spawned the same way must be refused
 * a name lookup and a socket. Where it is not, no card's Lua runs here at all —
 * its requests go unedited, and the log says so once.
 *
 * **A child runs once.** One run — every Lua script on the card, in trigger
 * order, each listener's request the next one's — and the child is killed,
 * whatever happened: nothing a script left in a Lua global or in the child's
 * JavaScript reaches another chat or another reader. Each script gets a fresh
 * Lua state, as RisuAI makes one when the code changes. `POOL_SIZE` children
 * are kept booted, so a run does not wait the ~60 ms one takes to start.
 *
 * **What a listener has.** What the browser hands its worker: the chat (the
 * whole branch), its variables, the reader's global variables, the character
 * as the chat's overlay has it, the persona and the chat's note — and the
 * request, `[{role, content}, …]`, as the request triggers read it. RisuAI's
 * `runLuaEditTrigger` gives its listeners no low-level access, so `LLM`,
 * `axLLM`, `simpleLLM`, `request`, `similarity` and `loadLoreBooks` answer nil
 * in the worker, and the child asking for any of them anyway is a broken child.
 * A dialog has no one to ask: it is answered as the browser answers a display
 * pass's. `sleep` sleeps, on the clock below.
 *
 * **What comes back.** Each script's value replaces the request unless it is
 * null, as RisuAI's `res ?? data`; the last must be a list of turns we can
 * send (`turnsOf`). Chat variables a listener wrote are the generated turn's,
 * as RisuAI's listener writes the live chat — so the browser's output run folds
 * from them. What it did to the chat, the character or the lore is dropped and
 * logged: those reach the chat before the prompt is planned, and here the plan
 * is made.
 *
 * **Failure.** One hard clock for the whole run (`REQUEST_LUA_DEADLINE_MS`).
 * A child that runs it out, exits, writes a line that is not one of the
 * worker's messages, or asks for something no listener may have is killed, and
 * the request goes as it was — RisuAI's try/catch around the run sends it
 * unedited too. So does a listener that throws (its writes stand, as RisuAI's).
 */
import { checkVariableDelta, type VariableDelta } from '@shizue/core';
import { LUA_LIMITS, luaWorkerSource, type LuaSnapshot } from '@shizue/core/lua';
import { MAX_TRIGGER_VALUE_LENGTH, type RequestTurn } from '@shizue/core/triggers';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { turnsOf } from './requestTriggers.js';

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
 * and 32 MB of Lua; a third run waits for one to finish.
 */
const POOL_SIZE = 2;

/** The child's JavaScript heap: the request, the chat and their JSON, twice over. */
const HEAP_MB = 128;

/** The longest line the parent reads from a child — far past any request a chat sends. */
const MAX_LINE = 8 * 1024 * 1024;

/** How long a child has to load wasmoon, and the probe to answer. */
const BOOT_MS = 10_000;

/** Variable writes a run may hand back, as the browser's sandbox takes them. */
const MAX_VARS = 10_000;

/** What one run takes: the card's Lua scripts in trigger order, the request, and what a script may read. */
export interface RequestLuaInput {
  scripts: string[];
  request: RequestTurn[];
  snapshot: LuaSnapshot;
}

/**
 * How a run ended: the request as the listeners left it — any JSON, checked by
 * the caller — with the chat variables they wrote and what was not kept; or why
 * there is none. `quiet` is a run that was never made because the server cannot
 * sandbox it, which the log has said once already.
 */
export type RequestLuaOutcome =
  | { ok: true; request: unknown; vars: [string, string | null][]; notes: string[] }
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
    const source = luaWorkerSource(readFileSync(join(dist, 'index.js'), 'utf8'), 'globalThis', { server: true });
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
    const broke = (why: string): void => child.kill(why);

    let request = input.request as unknown;
    const vars = new Map(input.snapshot.vars);
    const writes = new Map<string, string | null>();
    const notes = new Set<string>();
    let call = 0;
    let served = new Set<number>();

    const next = (): void => {
      if (call === input.scripts.length) {
        finish({ ok: true, request, vars: [...writes], notes: [...notes] });
        return;
      }
      call += 1;
      served = new Set();
      // Each script reads what the ones before it wrote, as RisuAI's read the live chat.
      const snapshot: LuaSnapshot = { ...input.snapshot, vars: [...vars], lowLevel: false };
      child.post({ type: 'call', call, code: input.scripts[call - 1], entry: { kind: 'request', data: request }, snapshot });
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
        if (Array.isArray(result['messages'])) notes.add('its chat edits are not kept');
        for (const field of ['name', 'description', 'firstMessage', 'background'] as const) {
          if (typeof result[field] === 'string') notes.add(`its ${field} rewrite is not kept`);
        }
        if (Array.isArray(result['lore']) && result['lore'].length > 0) notes.add('its lore upserts are not kept');
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

/** The chat variables a run wrote, as the turn can keep them: a value past what a trigger may write is dropped, as the browser drops it. */
function keptWrites(vars: [string, string | null][], label: string): VariableDelta | null {
  const kept = vars.filter(([, value]) => value === null || value.length <= MAX_TRIGGER_VALUE_LENGTH);
  if (kept.length < vars.length) console.warn('[api] editRequest wrote a variable past its length; dropped:', label);
  const checked = checkVariableDelta(Object.fromEntries(kept));
  if (checked.ok) return checked.delta;
  console.warn(`[api] editRequest's variable writes are not kept (${checked.error}):`, label);
  return null;
}

/** `turns` as the card's `editRequest` listeners left them, or null when unchanged; and the chat variables they wrote. */
export async function editRequestLua(
  turns: RequestTurn[],
  input: Omit<RequestLuaInput, 'request'>,
  { run = runRequestLua, label }: { run?: RequestLuaRunner | undefined; label: string },
): Promise<{ turns: RequestTurn[] | null; writes: VariableDelta | null }> {
  let outcome: RequestLuaOutcome;
  try {
    outcome = await run({ ...input, request: turns });
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!outcome.ok) {
    if (!outcome.quiet) console.warn('[api] editRequest sent the request unedited:', label, outcome.reason);
    return { turns: null, writes: null };
  }
  for (const note of outcome.notes) console.warn(`[api] editRequest: ${note}:`, label);
  const writes = keptWrites(outcome.vars, label);
  const edited = turnsOf(outcome.request);
  if (!edited) {
    console.warn('[api] editRequest left something that is not a request; sent unedited:', label);
    return { turns: null, writes };
  }
  const same = edited.length === turns.length && edited.every((turn, at) => turn.role === turns[at]!.role && turn.content === turns[at]!.content);
  return { turns: same ? null : edited, writes };
}

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The markup the browser's `getCharacterImage` answers for the member's avatar (web `lua/engine.ts`): '' without one. */
export const characterImage = (url: string | null | undefined): string =>
  url ? `<div class="risu-inlay-image"><img src="${escapeAttribute(url)}"></div>` : '';
