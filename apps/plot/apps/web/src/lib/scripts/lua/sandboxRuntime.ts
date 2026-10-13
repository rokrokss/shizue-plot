/**
 * Where a card's Lua actually runs: a worker inside a sandboxed frame, both
 * built here as text.
 *
 * RisuAI runs card Lua on its own page, in wasmoon (Lua 5.4 compiled to
 * WebAssembly), with every host function a closure over the live app — and
 * wasmoon lets the script index the JavaScript objects it is handed, so a
 * script can climb from `Promise.create` to `Function` and from there to
 * anything the page can do. Here the reader's page holds their session cookie
 * and their ChatGPT-backed chat, so the same script must not run anywhere near
 * it. Three realms, the way Layer 2 components already run:
 *
 * - **The parent** (our page, `sandbox.ts`) owns the chat. It hands each call a
 *   snapshot of what the script may read, serves the few things that need the
 *   reader or the server — a dialog, a model call — and takes back what the
 *   script wrote, all of it validated as a stranger's data.
 * - **The frame** (`luaFrameRuntime`) is a `srcdoc` iframe with
 *   `sandbox="allow-scripts"` and nothing else: an opaque origin, so no cookies,
 *   no storage, nothing addressed to our API is ours. Its CSP is
 *   `default-src 'none'` with `connect-src 'none'`: no fetch, no XHR, no
 *   WebSocket, no EventSource, to anywhere — and the worker it starts from a
 *   blob inherits that policy. It runs only our code: it relays messages and it
 *   is the **watchdog**.
 * - **The worker** (`luaWorkerRuntime`) runs wasmoon and the script. A worker
 *   has no DOM, no navigable location and no `RTCPeerConnection`, and it can be
 *   terminated, which is the only thing that stops `while true do end`. The CSP
 *   allows `'wasm-unsafe-eval'` (wasmoon is WebAssembly) and not
 *   `'unsafe-eval'`, so a script that does reach `Function` cannot compile
 *   anything with it.
 *
 * ## The watchdog
 *
 * wasmoon has a `functionTimeout`, and it is the wrong clock: it counts wall
 * time, including the minutes a script spends awaiting the reader's answer or a
 * model call. The frame keeps its own, and it can, because every way a script
 * waits goes through the frame: a dialog and a model call are host calls it
 * relays, and `sleep` is a host call it answers itself, on its own timer. So for
 * each call it knows, without sampling anything:
 *
 * - **active** time: wall time less the time a dialog or a model call was open.
 *   Past `active` ms the worker is terminated — a script that sleeps forever.
 * - **CPU** time: active time less the time spent asleep — what is left is the
 *   script running. Past `cpu` ms it is terminated — a script that yields to a
 *   one-millisecond sleep between busy stretches, forever.
 *
 * And one thing it measures directly: a worker running Lua cannot read its
 * message queue, so the frame pings it, and a ping unanswered for `stretch` ms
 * is a script that has not yielded once in that long — `while true do end` —
 * terminated within seconds, whatever the other two say.
 *
 * Terminating the worker answers every call in flight as killed; the next call
 * starts a fresh worker, so the chat goes on without the script's state. The
 * parent can always end all of it by removing the frame.
 *
 * Memory: each Lua state's allocator is capped (`traceAllocations` with
 * `setMemoryMax`), so `s = s .. s` ends in Lua's own "not enough memory" error
 * rather than the tab's, and the worker keeps at most `engines` of them.
 *
 * ## Why these are functions that get stringified
 *
 * As with `componentRuntime.ts`: the frame and the worker have no module scope,
 * so their programs are these function bodies, inlined with `toString()`. Each
 * must be **completely self-contained** — no imports, nothing from outside its
 * own body, and none of the syntax a bundler might lower into a helper call (no
 * object spread, optional chaining, `??`, classes or async functions). The tests
 * run the very same text.
 */

import { MAX_TRIGGER_WAIT_MS } from '@shizue/core/triggers';
import { selfContained } from '../../componentRuntime';
import { JSON_LUA, LUA_WRAPPER } from './prelude';

/** Both stringified runtimes are written loosely; they are erased to plain JavaScript anyway. */
type Any = any;

/** Every number the two realms are held to, interpolated into both. */
export const LUA_LIMITS = {
  /** How often the frame's watchdog looks. */
  tick: 100,
  /** Ping interval while a call is outstanding, and while the worker is idle. */
  ping: 250,
  idlePing: 2000,
  /** Longest the worker may go without reaching its message queue. */
  stretch: 2500,
  /** One call's running time: its active time less the time it slept. */
  cpu: 15_000,
  /** One call's wall time, less the time a dialog or a model call it asked for was open. */
  active: 120_000,
  /** How long the worker has to load wasmoon. */
  boot: 20_000,
  /** Bytes one Lua state may allocate. */
  memory: 32 * 1024 * 1024,
  /** Lua states the worker keeps — RisuAI keeps one per mode, and a manual name is a mode. */
  engines: 8,
  /** A single `sleep` is cut to this, as a trigger's wait is. */
  sleep: MAX_TRIGGER_WAIT_MS,
};

export type LuaLimits = typeof LUA_LIMITS;

/* ------------------------------------------------------------- protocol */

/** One message of the reader's chat, as the script reads it. */
export interface LuaMessage {
  role: 'user' | 'char';
  data: string;
  time?: number;
}

/** A lore entry in RisuAI's own shape, which is what `getLoreBooks` returns. */
export interface LuaLoreBook {
  key: string;
  secondkey: string;
  insertorder: number;
  comment: string;
  content: string;
  mode: string;
  alwaysActive: boolean;
  selective: boolean;
  useRegex: boolean;
}

/** What a call may read, taken when it starts. */
export interface LuaSnapshot {
  vars: [string, string][];
  globals: [string, string][];
  messages: LuaMessage[];
  char: { name: string; description: string; greeting: string; lore: LuaLoreBook[] };
  user: string;
  persona: string;
  note: string;
  lowLevel: boolean;
}

/** Where in the script a call enters. */
export type LuaEntry =
  /** `onStart`/`onInput`/`onOutput`, or the global function a manual run names. */
  | { kind: 'trigger'; mode: string }
  /** `onButtonClick(id, data)` — a `risu-btn`. */
  | { kind: 'button'; data: string }
  /** The `listenEdit` hooks for one text. */
  | { kind: 'edit'; phase: 'editInput' | 'editOutput'; text: string; index: number }
  /** The `editDisplay` hooks over several messages, in one pass. */
  | { kind: 'display'; items: { text: string; index: number }[] };

/** Parent → frame → worker. */
export interface LuaCallMessage {
  type: 'call';
  call: number;
  code: string;
  entry: LuaEntry;
  snapshot: LuaSnapshot;
}

/** What a call left — still the worker's word, which the parent checks before using any of it. */
export interface LuaCallResult {
  stopSending: boolean;
  /** An edit's text, or a display pass's texts, in order. */
  res?: string | string[];
  /** Chat variables written, in first-write order, final values; `null` unsets. */
  vars: [string, string | null][];
  /** The chat as the script left it, when it touched it; `key` is the snapshot index a message came from. */
  messages: { role: 'user' | 'char'; data: string; key: number | null }[] | null;
  description: string | null;
  /** `upsertLocalLoreBook` calls, in order. */
  lore: LuaLoreBook[];
  /** Functions called that are not carried out here, with why. */
  notes: [string, string][];
  error: string | null;
}

/** The host calls a script can make. Every other name is dropped. */
export type LuaHostName = 'alert' | 'input' | 'select' | 'confirm' | 'llm';

/* ------------------------------------------------------------ the worker */

/* eslint-disable */
/**
 * The worker's program, after wasmoon. `scope` is the worker global; `prelude`
 * is `json.lua` and the two halves of RisuAI's wrapper.
 *
 * The functions declared on each Lua state are RisuAI's (`runScripted` in its
 * `process/scriptings.ts`) — the same names, arguments, gating by access key,
 * sync or promise return — over the call's snapshot instead of the live app.
 * `LUA_CLASSIFICATION` says where each one ends up.
 */
function luaWorkerRuntime(scope: Any, limits: Any, prelude: Any): void {
  'use strict';

  // Captured before `lockDown` takes the names off the global.
  const post = scope.postMessage.bind(scope);
  const ResponseCtor = scope.Response;
  const wasmoon = scope.wasmoon;
  const encoder = new TextEncoder();
  const consoleLog = scope.console && scope.console.log ? scope.console.log.bind(scope.console) : function () {};

  let factory: Any = null;
  let ready: Any = null;
  /** RisuAI's engines: one Lua state per mode, recreated when the code changes. */
  const engines = new Map();
  /** RisuAI's access keys: a call's `id` argument, and what it opens. */
  const safeIds = new Set();
  const displayIds = new Set();
  const lowIds = new Set();
  const waits = new Map();
  let hostSeq = 0;
  let keySeq = 0;

  const AX_MODES: Any = { emotion: true, memory: true, otherAx: true, submodel: true, translate: true };

  function messageOf(error: Any): string {
    if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
    return String(error);
  }

  function noop(): void {}

  /**
   * Network, storage and nested workers off the global. The CSP already refuses
   * every one of them; this is the second lock, and it is applied only after
   * wasmoon is up because its loader reads some of them.
   */
  function lockDown(): void {
    const BLOCKED = [
      'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts',
      'BroadcastChannel', 'indexedDB', 'caches', 'Worker', 'SharedWorker', 'navigator', 'location',
      'origin', 'postMessage',
    ];
    for (let b = 0; b < BLOCKED.length; b += 1) {
      try {
        Object.defineProperty(scope, BLOCKED[b] as Any, { value: undefined, configurable: true, writable: true });
      } catch (error) {
        // Non-configurable in this engine; the CSP still holds.
      }
    }
  }

  /**
   * Loads wasmoon from the bytes the parent sent. Its loader fetches
   * `glue.wasm`, and there is no network here, so for the length of the load
   * `fetch` answers with these bytes and nothing else.
   */
  function boot(wasm: Any): void {
    if (ready) return;
    const realFetch = scope.fetch;
    scope.fetch = function () {
      return Promise.resolve(new ResponseCtor(wasm, { headers: { 'Content-Type': 'application/wasm' } }));
    };
    let made: Any;
    try {
      made = new wasmoon.LuaFactory('glue.wasm');
    } catch (error) {
      scope.fetch = realFetch;
      ready = Promise.reject(error);
      ready.catch(noop);
      lockDown();
      post({ type: 'bootFailed', message: messageOf(error) });
      return;
    }
    ready = made
      .getLuaModule()
      .then(function () {
        scope.fetch = realFetch;
        factory = made;
        return made.mountFile('json.lua', prelude.json);
      })
      .then(
        function () {
          lockDown();
          post({ type: 'booted' });
        },
        function (error: Any) {
          scope.fetch = realFetch;
          lockDown();
          post({ type: 'bootFailed', message: messageOf(error) });
          throw error;
        },
      );
    ready.catch(noop);
  }

  /* -------------------------------------------------------- the host calls */

  function host(ctx: Any, name: string, args: Any): Any {
    hostSeq += 1;
    const id = hostSeq;
    return new Promise(function (resolve) {
      waits.set(id, resolve);
      post({ type: 'host', call: ctx.call, host: id, name: name, args: args });
    });
  }

  /* ------------------------------------------------------------ the state */

  function text(value: Any): string {
    return value === undefined || value === null ? '' : String(value);
  }

  function readMap(map: Any, key: Any): string {
    const value = map.get(String(key));
    return value === undefined ? 'null' : value;
  }

  /** RisuAI's `setVar`: true when the value changed. A nil unsets. */
  function writeVar(ctx: Any, key: Any, value: Any): boolean {
    const name = String(key);
    const next = value === undefined || value === null ? null : String(value);
    const before = ctx.vars.has(name) ? ctx.vars.get(name) : null;
    if (before === next) return false;
    if (next === null) ctx.vars.delete(name);
    else ctx.vars.set(name, next);
    if (!ctx.display) ctx.varWrites.set(name, next);
    return true;
  }

  function note(ctx: Any, name: string, why: string): void {
    if (!ctx.notes.has(name)) ctx.notes.set(name, why);
  }

  /**
   * The macros a script's `cbs()` can be answered with from inside the
   * sandbox: the names and the variables. RisuAI runs its whole evaluator here;
   * ours lives on the page, which a synchronous call cannot reach, so the rest
   * is left as written.
   */
  function cbsLite(ctx: Any, value: Any): string {
    note(ctx, 'cbs', 'only {{char}}, {{user}}, {{getvar}} and {{getglobalvar}} are answered inside the sandbox');
    return text(value).replace(/\{\{\s*([^{}]*?)\s*\}\}/g, function (whole: string, inner: string) {
      const at = inner.indexOf('::');
      const name = (at === -1 ? inner : inner.slice(0, at)).toLowerCase().replace(/[\s_-]/g, '');
      const arg = at === -1 ? '' : inner.slice(at + 2);
      if (name === 'char' || name === 'bot') return ctx.char.name;
      if (name === 'user') return ctx.user;
      if (name === 'getvar') return readMap(ctx.vars, arg);
      if (name === 'getglobalvar') return readMap(ctx.globals, arg);
      return whole;
    });
  }

  function role(value: Any): string {
    return value === 'user' ? 'user' : 'char';
  }

  function chatOf(message: Any): Any {
    return { role: message.role, data: message.data, time: message.time || 0 };
  }

  function lastOf(ctx: Any, which: string): Any {
    for (let i = ctx.messages.length - 1; i >= 0; i -= 1) {
      if (ctx.messages[i].role === which) return ctx.messages[i];
    }
    return null;
  }

  function llmRole(value: Any): string {
    if (value === 'system' || value === 'sys') return 'system';
    if (value === 'user') return 'user';
    return 'assistant';
  }

  function llmMessages(prompt: Any): Any {
    const out: Any[] = [];
    for (let i = 0; i < prompt.length; i += 1) {
      const dict = prompt[i] || {};
      out.push({ role: llmRole(dict.role), content: text(dict.content) });
    }
    return out;
  }

  function parseOptions(value: Any): Any {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  /**
   * SHA-256, hex — RisuAI's `hash`. Written out because the sandbox has no
   * `crypto.subtle`: an opaque-origin worker is not given one. The constants are
   * derived as the standard defines them, from the primes' roots.
   */
  function sha256(value: string): string {
    const primes: number[] = [];
    for (let n = 2; primes.length < 64; n += 1) {
      let prime = true;
      for (let d = 2; d * d <= n; d += 1) if (n % d === 0) prime = false;
      if (prime) primes.push(n);
    }
    const frac = function (x: number): number {
      return ((x - Math.floor(x)) * 0x100000000) >>> 0;
    };
    const K = primes.map(function (p: number) {
      return frac(Math.cbrt(p));
    });
    const H = primes.slice(0, 8).map(function (p: number) {
      return frac(Math.sqrt(p));
    });
    const bytes = encoder.encode(value);
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
    view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 0x100000000));
    const W = new Uint32Array(64);
    const rotr = function (x: number, n: number): number {
      return (x >>> n) | (x << (32 - n));
    };
    for (let off = 0; off < padded.length; off += 64) {
      for (let t = 0; t < 16; t += 1) W[t] = view.getUint32(off + t * 4);
      for (let t = 16; t < 64; t += 1) {
        const x = W[t - 15] as number;
        const y = W[t - 2] as number;
        W[t] = ((W[t - 16] as number) + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + (W[t - 7] as number) + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) >>> 0;
      }
      let a = H[0] as number, b = H[1] as number, c = H[2] as number, d = H[3] as number;
      let e = H[4] as number, f = H[5] as number, g = H[6] as number, h = H[7] as number;
      for (let t = 0; t < 64; t += 1) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[t] as number) + (W[t] as number)) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      const round = [a, b, c, d, e, f, g, h];
      for (let i = 0; i < 8; i += 1) H[i] = ((H[i] as number) + (round[i] as number)) >>> 0;
    }
    return H.map(function (word: number) {
      return ('0000000' + word.toString(16)).slice(-8);
    }).join('');
  }

  /* ------------------------------------------------------ the declarations */

  /** RisuAI's `declareAPI` calls, each a closure over the state's current call. */
  function declare(engine: Any, state: Any): void {
    const g = engine.global;
    function set(name: string, fn: Any): void {
      g.set(name, fn);
    }
    function c(): Any {
      return state.ctx;
    }
    function safe(id: Any): boolean {
      return safeIds.has(id);
    }
    function safeOrDisplay(id: Any): boolean {
      return safeIds.has(id) || displayIds.has(id);
    }
    function low(id: Any): boolean {
      return lowIds.has(id);
    }
    function touched(ctx: Any): void {
      ctx.messagesChanged = true;
    }

    set('getChatVar', function (_id: Any, key: Any) {
      return readMap(c().vars, key);
    });
    set('setChatVar', function (id: Any, key: Any, value: Any) {
      if (!safeOrDisplay(id)) return;
      writeVar(c(), key, value);
    });
    set('setChatVarChanged', function (id: Any, key: Any, value: Any) {
      if (!safeOrDisplay(id)) return;
      if (writeVar(c(), key, value)) return true;
    });
    set('getGlobalVar', function (_id: Any, key: Any) {
      return readMap(c().globals, key);
    });
    set('stopChat', function (id: Any) {
      if (!safe(id)) return;
      c().stopSending = true;
    });
    set('alertError', function (id: Any, value: Any) {
      if (!safe(id)) return;
      host(c(), 'alert', { text: text(value), error: true });
    });
    set('alertNormal', function (id: Any, value: Any) {
      if (!safe(id)) return;
      host(c(), 'alert', { text: text(value), error: false });
    });
    set('alertInput', function (id: Any, value: Any) {
      if (!safe(id)) return;
      return host(c(), 'input', { text: text(value) }).then(function (answer: Any) {
        return answer.ok ? text(answer.value) : '';
      });
    });
    set('alertSelect', function (id: Any, value: Any) {
      if (!safe(id)) return;
      const options: string[] = [];
      if (value && typeof value.length === 'number') {
        for (let i = 0; i < value.length; i += 1) options.push(text(value[i]));
      }
      return host(c(), 'select', { options: options }).then(function (answer: Any) {
        return answer.ok ? text(answer.value) : '';
      });
    });
    set('alertConfirm', function (id: Any, value: Any) {
      if (!safe(id)) return;
      return host(c(), 'confirm', { text: text(value) }).then(function (answer: Any) {
        return answer.ok && answer.value === true;
      });
    });

    set('getChatMain', function (_id: Any, index: Any) {
      const message = c().messages.at(index);
      return JSON.stringify(message ? chatOf(message) : null);
    });
    set('getChatData', function (_id: Any, index: Any) {
      const message = c().messages.at(index);
      return message ? message.data : '';
    });
    set('getChatRole', function (_id: Any, index: Any) {
      const message = c().messages.at(index);
      return message ? message.role : '';
    });
    set('getRecentChatsMain', function (_id: Any, count: Any) {
      const messages = c().messages;
      const safeCount = Math.max(0, Math.floor(count || 0));
      return JSON.stringify(messages.slice(Math.max(0, messages.length - safeCount)).map(chatOf));
    });
    set('setChat', function (id: Any, index: Any, value: Any) {
      if (!safe(id)) return;
      const ctx = c();
      const message = ctx.messages.at(index);
      if (message) {
        message.data = text(value);
        touched(ctx);
      }
    });
    set('setChatRole', function (id: Any, index: Any, value: Any) {
      if (!safe(id)) return;
      const ctx = c();
      const message = ctx.messages.at(index);
      if (message) {
        message.role = role(value);
        touched(ctx);
      }
    });
    set('cutChat', function (id: Any, start: Any, end: Any) {
      if (!safe(id)) return;
      const ctx = c();
      ctx.messages = ctx.messages.slice(start, end);
      touched(ctx);
    });
    set('removeChat', function (id: Any, index: Any) {
      if (!safe(id)) return;
      const ctx = c();
      ctx.messages.splice(index, 1);
      touched(ctx);
    });
    set('addChat', function (id: Any, which: Any, value: Any) {
      if (!safe(id)) return;
      const ctx = c();
      ctx.messages.push({ role: role(which), data: text(value), time: 0, key: null });
      touched(ctx);
    });
    set('insertChat', function (id: Any, index: Any, which: Any, value: Any) {
      if (!safe(id)) return;
      const ctx = c();
      ctx.messages.splice(index, 0, { role: role(which), data: text(value), time: 0, key: null });
      touched(ctx);
    });
    set('getTokens', function (id: Any, value: Any) {
      const ctx = c();
      return Promise.resolve().then(function () {
        if (!safe(id)) return undefined;
        note(ctx, 'getTokens', 'token counts are estimated, four characters a token');
        return Math.ceil(text(value).length / 4);
      });
    });
    set('getChatLength', function () {
      return c().messages.length;
    });
    set('getFullChatMain', function () {
      return JSON.stringify(c().messages.map(chatOf));
    });
    set('sleep', function (id: Any, time: Any) {
      if (!safe(id)) return;
      // Answered by the frame, on its timer: that is how the watchdog knows the script is idle.
      return host(c(), 'sleep', { ms: Math.min(limits.sleep, Math.max(0, Number(time) || 0)) }).then(function () {
        return true;
      });
    });
    set('cbs', function (value: Any) {
      return cbsLite(c(), value);
    });
    set('setFullChatMain', function (id: Any, value: Any) {
      if (!safe(id)) return;
      const ctx = c();
      const parsed = JSON.parse(value);
      const before = ctx.messages;
      // A message that stays where it was, as what it was, is still that message.
      ctx.messages = parsed.map(function (entry: Any, at: number) {
        const which = role(entry && entry.role);
        const old = before[at];
        return {
          role: which,
          data: text(entry && entry.data),
          time: old && old.role === which ? old.time : 0,
          key: old && old.role === which ? old.key : null,
        };
      });
      touched(ctx);
    });
    set('logMain', function (value: Any) {
      consoleLog(JSON.parse(value));
    });
    set('reloadDisplay', function () {
      // The chat redraws from its state on its own.
    });
    set('reloadChat', function () {
      // As above.
    });

    // Low-level access.
    set('similarity', function (id: Any) {
      const ctx = c();
      return Promise.resolve().then(function () {
        if (!low(id)) return undefined;
        note(ctx, 'similarity', 'there is no embedder for scripts here');
        return [];
      });
    });
    set('request', function (id: Any, url: Any) {
      const ctx = c();
      return Promise.resolve().then(function () {
        if (!low(id)) return undefined;
        note(ctx, 'request', 'scripts have no network here');
        // RisuAI's own answer for an address it refuses.
        return JSON.stringify({ status: 400, data: 'request to ' + text(url) + ' is not allowed' });
      });
    });
    set('generateImage', function (id: Any) {
      const ctx = c();
      return Promise.resolve().then(function () {
        if (!low(id)) return undefined;
        note(ctx, 'generateImage', 'scripts cannot generate images here');
        return 'Error: Image generation failed';
      });
    });
    set('getCharacterImageMain', function () {
      const ctx = c();
      return Promise.resolve().then(function () {
        note(ctx, 'getCharacterImage', 'there are no inlay images here');
        return '';
      });
    });
    set('getPersonaImageMain', function () {
      const ctx = c();
      return Promise.resolve().then(function () {
        note(ctx, 'getPersonaImage', 'there are no inlay images here');
        return '';
      });
    });
    set('hash', function (_id: Any, value: Any) {
      return Promise.resolve().then(function () {
        return sha256(text(value));
      });
    });
    set('LLMMain', function (id: Any, promptStr: Any) {
      const ctx = c();
      return Promise.resolve().then(function () {
        // RisuAI reads the prompt before it checks the key.
        const prompt = JSON.parse(promptStr);
        if (!low(id)) return undefined;
        return host(ctx, 'llm', { messages: llmMessages(prompt) }).then(function (answer: Any) {
          return JSON.stringify(
            answer.ok ? { success: true, result: text(answer.value) } : { success: false, result: 'Error: ' + text(answer.error) },
          );
        });
      });
    });
    set('simpleLLM', function (id: Any, prompt: Any) {
      const ctx = c();
      return Promise.resolve().then(function () {
        if (!low(id)) return undefined;
        return host(ctx, 'llm', { messages: [{ role: 'user', content: text(prompt) }] }).then(function (answer: Any) {
          return answer.ok ? { success: true, result: text(answer.value) } : { success: false, result: 'Error: ' + text(answer.error) };
        });
      });
    });
    set('axLLMMain', function (id: Any, promptStr: Any, _useMultimodal: Any, optionsStr: Any) {
      const ctx = c();
      return Promise.resolve().then(function () {
        const prompt = JSON.parse(promptStr);
        if (!low(id)) return undefined;
        const mode = parseOptions(optionsStr).mode || 'otherAx';
        if (!Object.prototype.hasOwnProperty.call(AX_MODES, mode)) {
          return JSON.stringify({ result: 'Error: Invalid axLLM mode: ' + mode, success: false });
        }
        // Every auxiliary model is the chat's own here.
        return host(ctx, 'llm', { messages: llmMessages(prompt) }).then(function (answer: Any) {
          return JSON.stringify(
            answer.ok ? { success: true, result: text(answer.value) } : { success: false, result: 'Error: ' + text(answer.error) },
          );
        });
      });
    });

    // The character, the persona and the note.
    set('getName', function () {
      return c().char.name;
    });
    set('setName', function (id: Any, name: Any) {
      if (!safe(id)) return;
      if (typeof name !== 'string') throw 'Invalid data type';
      note(c(), 'setName', 'the name is the plot’s and is not rewritten per chat');
    });
    set('getDescription', function (id: Any) {
      if (!safe(id)) return;
      return c().char.description;
    });
    set('setDescription', function (id: Any, desc: Any) {
      if (!safe(id)) return;
      const ctx = c();
      ctx.char.description = text(desc);
      ctx.descriptionChanged = true;
    });
    set('getCharacterFirstMessage', function () {
      return c().char.greeting;
    });
    set('setCharacterFirstMessage', function (id: Any, data: Any) {
      if (!safe(id)) return;
      if (typeof data !== 'string') return false;
      note(c(), 'setCharacterFirstMessage', 'the greeting is a stored message and is not rewritten');
      return false;
    });
    set('getPersonaName', function () {
      return c().user;
    });
    set('getPersonaDescription', function () {
      const ctx = c();
      return cbsLite(ctx, ctx.persona);
    });
    set('getAuthorsNote', function () {
      return c().note;
    });
    set('getBackgroundEmbedding', function (id: Any) {
      if (!safe(id)) return;
      note(c(), 'getBackgroundEmbedding', 'there is no background HTML here');
      return '';
    });
    set('setBackgroundEmbedding', function (id: Any, data: Any) {
      if (!safe(id)) return;
      if (typeof data !== 'string') return false;
      note(c(), 'setBackgroundEmbedding', 'there is no background HTML here');
      return false;
    });
    set('getLoreBooksMain', function (_id: Any, search: Any) {
      const ctx = c();
      const found: Any[] = [];
      for (let i = 0; i < ctx.lore.length; i += 1) {
        const book = ctx.lore[i];
        if (book.comment === search) found.push(Object.assign({}, book, { content: cbsLite(ctx, book.content) }));
      }
      return JSON.stringify(found);
    });
    set('upsertLocalLoreBook', function (id: Any, name: Any, content: Any, options: Any) {
      if (!safe(id)) return;
      const ctx = c();
      const o = options && typeof options === 'object' ? options : {};
      const secondKey = o.secondKey === undefined ? '' : text(o.secondKey);
      const book = {
        alwaysActive: o.alwaysActive === undefined ? false : Boolean(o.alwaysActive),
        comment: text(name),
        content: text(content),
        insertorder: typeof o.insertOrder === 'number' ? o.insertOrder : 100,
        mode: 'normal',
        key: o.key === undefined ? '' : text(o.key),
        secondkey: secondKey,
        selective: secondKey !== '',
        useRegex: o.regex === undefined ? false : Boolean(o.regex),
      };
      ctx.lore = ctx.lore.filter(function (entry: Any) {
        return entry.comment !== book.comment;
      });
      ctx.lore.push(book);
      ctx.loreUpserts.push(book);
    });
    set('loadLoreBooksMain', function (id: Any) {
      const ctx = c();
      return Promise.resolve().then(function () {
        if (!low(id)) return undefined;
        note(ctx, 'loadLoreBooks', 'lore is activated on the server when the prompt is built');
        return '[]';
      });
    });
    set('getCharacterLastMessage', function () {
      const ctx = c();
      const found = lastOf(ctx, 'char');
      return found ? found.data : ctx.char.greeting;
    });
    set('getUserLastMessage', function () {
      const found = lastOf(c(), 'user');
      return found ? found.data : '';
    });
  }

  /* ------------------------------------------------------------- a call */

  function context(request: Any): Any {
    const snap = request.snapshot;
    const kind = request.entry.kind;
    return {
      call: request.call,
      display: kind === 'display',
      // The edit hooks never get low-level access in RisuAI, whatever the card says.
      lowLevel: snap.lowLevel === true && kind !== 'edit' && kind !== 'display',
      vars: new Map(snap.vars),
      varWrites: new Map(),
      globals: new Map(snap.globals),
      messages: snap.messages.map(function (message: Any, at: number) {
        return { role: role(message.role), data: text(message.data), time: message.time || 0, key: at };
      }),
      messagesChanged: false,
      char: { name: snap.char.name, description: snap.char.description, greeting: snap.char.greeting },
      descriptionChanged: false,
      lore: snap.char.lore.slice(),
      loreUpserts: [],
      user: snap.user,
      persona: snap.persona,
      note: snap.note,
      stopSending: false,
      res: undefined,
      notes: new Map(),
      error: null,
    };
  }

  function outcome(ctx: Any): Any {
    return {
      stopSending: ctx.stopSending === true,
      res: ctx.res,
      vars: Array.from(ctx.varWrites.entries()),
      messages: ctx.messagesChanged
        ? ctx.messages.map(function (message: Any) {
            return { role: message.role, data: message.data, key: typeof message.key === 'number' ? message.key : null };
          })
        : null,
      description: ctx.descriptionChanged ? ctx.char.description : null,
      lore: ctx.loreUpserts,
      notes: Array.from(ctx.notes.entries()),
      error: ctx.error,
    };
  }

  function closeEngine(state: Any): void {
    if (!state.engine) return;
    try {
      state.engine.global.close();
    } catch (error) {
      // Already gone.
    }
    state.engine = null;
    state.code = null;
  }

  /** The state for a mode, newest last; past the cap the oldest idle one is closed. */
  function stateFor(name: string): Any {
    let state = engines.get(name);
    if (state) {
      engines.delete(name);
      engines.set(name, state);
      return state;
    }
    state = { code: null, engine: null, ctx: null, busy: false, queue: Promise.resolve() };
    engines.set(name, state);
    if (engines.size > limits.engines) {
      const names = Array.from(engines.keys());
      for (let i = 0; i < names.length && engines.size > limits.engines; i += 1) {
        const old = engines.get(names[i]);
        if (old === state || old.busy) continue;
        closeEngine(old);
        engines.delete(names[i]);
      }
    }
    return state;
  }

  /** A Lua state with this code loaded — RisuAI's: a new state whenever the code differs. */
  function prepare(state: Any, code: string): Any {
    if (state.engine && state.code === code) return Promise.resolve();
    closeEngine(state);
    return factory.createEngine({ injectObjects: true, traceAllocations: true }).then(function (engine: Any) {
      engine.global.setMemoryMax(limits.memory);
      declare(engine, state);
      state.engine = engine;
      // `os.exit` would take the whole module down, every other state with it.
      return engine
        .doString('os.exit = nil')
        .then(function () {
          return engine.doString(prelude.head + code + prelude.tail);
        })
        .then(
          function () {
            state.code = code;
          },
          function (error: Any) {
            closeEngine(state);
            throw error;
          },
        );
    });
  }

  /** Calls a Lua function; a Lua error thrown on the way in arrives as a rejection like any other. */
  function attempt(fn: Any, args: Any[]): Any {
    try {
      return Promise.resolve(fn.apply(null, args));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function listen(state: Any, phase: string, key: string, value: string, index: number): Any {
    const fn = state.engine.global.get('callListenMain');
    if (typeof fn !== 'function') return Promise.resolve(undefined);
    return attempt(fn, [phase, key, JSON.stringify(value), JSON.stringify({ index: index })]).then(function (res: Any) {
      return JSON.parse(res);
    });
  }

  /** RisuAI's `data = res ?? data` for an edit hook's answer. */
  function edited(res: Any, before: string): string {
    if (res === undefined || res === null) return before;
    return typeof res === 'string' ? res : String(res);
  }

  function enter(state: Any, entry: Any, ctx: Any, key: string): Any {
    if (entry.kind === 'trigger' || entry.kind === 'button') {
      const name =
        entry.kind === 'button'
          ? 'onButtonClick'
          : entry.mode === 'input'
            ? 'onInput'
            : entry.mode === 'output'
              ? 'onOutput'
              : entry.mode === 'start'
                ? 'onStart'
                : entry.mode;
      const fn = state.engine.global.get(name);
      if (!fn) return Promise.resolve();
      if (typeof fn !== 'function') return Promise.reject(new TypeError(name + ' is not a function'));
      return attempt(fn, entry.kind === 'button' ? [key, entry.data] : [key]).then(function (res: Any) {
        if (res === false) ctx.stopSending = true;
      });
    }
    if (entry.kind === 'edit') {
      ctx.res = entry.text;
      return listen(state, entry.phase, key, entry.text, entry.index).then(function (res: Any) {
        ctx.res = edited(res, entry.text);
      });
    }
    // A display pass: every message in turn, one failure leaving that one as it was.
    const texts = entry.items.map(function (item: Any) {
      return item.text;
    });
    ctx.res = texts;
    let chain = Promise.resolve();
    entry.items.forEach(function (item: Any, at: number) {
      chain = chain.then(function () {
        return listen(state, 'editDisplay', key, item.text, item.index).then(
          function (res: Any) {
            texts[at] = edited(res, item.text);
          },
          function (error: Any) {
            if (ctx.error === null) ctx.error = messageOf(error);
          },
        );
      });
    });
    return chain;
  }

  function invoke(state: Any, request: Any): Any {
    const ctx = context(request);
    state.busy = true;
    state.ctx = ctx;
    return prepare(state, request.code)
      .then(function () {
        keySeq += 1;
        const key = 'k' + keySeq + '-' + Math.random().toString(36).slice(2);
        if (ctx.display) displayIds.add(key);
        else {
          safeIds.add(key);
          if (ctx.lowLevel) lowIds.add(key);
        }
        state.ctx = ctx;
        return enter(state, request.entry, ctx, key)
          .then(undefined, function (error: Any) {
            ctx.error = messageOf(error);
          })
          .then(function () {
            safeIds.delete(key);
            displayIds.delete(key);
            lowIds.delete(key);
          });
      })
      .then(undefined, function (error: Any) {
        ctx.error = messageOf(error);
      })
      .then(function () {
        state.busy = false;
        return outcome(ctx);
      });
  }

  function engineName(entry: Any): string {
    if (entry.kind === 'button') return 'onButtonClick';
    if (entry.kind === 'edit') return entry.phase;
    if (entry.kind === 'display') return 'editDisplay';
    return String(entry.mode);
  }

  function run(request: Any): void {
    const call = request.call;
    if (!ready) {
      post({ type: 'done', call: call, result: { error: 'the engine was never started' } });
      return;
    }
    ready
      .then(function () {
        const state = stateFor(engineName(request.entry));
        const next = state.queue.then(function () {
          return invoke(state, request);
        });
        state.queue = next.then(noop, noop);
        return next;
      })
      .then(
        function (result: Any) {
          post({ type: 'done', call: call, result: result });
        },
        function (error: Any) {
          post({ type: 'done', call: call, result: { error: messageOf(error) } });
        },
      );
  }

  scope.onmessage = function (event: Any): void {
    const data = event && event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'ping') {
      post({ type: 'pong', nonce: data.nonce });
      return;
    }
    if (data.type === 'reply') {
      const wait = waits.get(data.host);
      if (wait) {
        waits.delete(data.host);
        wait(data);
      }
      return;
    }
    if (data.type === 'call') {
      run(data);
      return;
    }
    if (data.type === 'init') boot(data.wasm);
  };
}

/* ------------------------------------------------------------- the frame */

/**
 * The frame's program: our code, and no script's. It keeps the worker alive,
 * relays the calls one way and the host calls the other, answers `sleep`, and
 * keeps the clocks the watchdog reads.
 *
 * `env` is everything it touches outside itself, so the tests can hand it a
 * worker thread and a clock: `send` (to the parent), `makeWorker(source)`,
 * `now`, `every`/`stopEvery`, `later`/`cancel`. It answers with the function
 * the parent's messages go to.
 */
function luaFrameRuntime(env: Any, limits: Any): (data: Any) => void {
  'use strict';

  /** The host calls that wait on the reader or the model: they stop a call's active clock. */
  const HOLDS: Any = { alert: true, input: true, select: true, confirm: true, llm: true };

  let source: Any = null;
  let wasm: Any = null;
  let worker: Any = null;
  let booted = false;
  let bootStarted = 0;
  /** Outstanding calls and their clocks. */
  const calls = new Map();
  /** Outstanding host calls the parent answers: whose, and whether they hold its clock. */
  const hosts = new Map();
  /** Sleeps this frame is answering, by host id. */
  const sleeps = new Map();
  let ping: Any = null;
  let nonce = 0;
  let lastPing = 0;
  let ticker: Any = null;

  function isBuffer(value: Any): boolean {
    return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
  }

  /** A clock that runs except while something holds it. */
  function pause(clock: Any, now: number): void {
    if (clock.holds === 0) clock.since = now;
    clock.holds += 1;
  }
  function resume(clock: Any, now: number): void {
    if (clock.holds === 0) return;
    clock.holds -= 1;
    if (clock.holds === 0) clock.total += now - clock.since;
  }
  function paused(clock: Any, now: number): number {
    return clock.total + (clock.holds > 0 ? now - clock.since : 0);
  }

  function active(record: Any, now: number): number {
    return now - record.started - paused(record.waiting, now);
  }
  function running(record: Any, now: number): number {
    return active(record, now) - paused(record.sleeping, now);
  }

  /** Ends the worker — the only thing that stops a script that will not stop. */
  function kill(reason: string, report: boolean): void {
    if (worker) {
      try {
        worker.terminate();
      } catch (error) {
        // Already gone.
      }
      worker = null;
    }
    booted = false;
    ping = null;
    if (ticker !== null) env.stopEvery(ticker);
    ticker = null;
    sleeps.forEach(function (sleep: Any) {
      env.cancel(sleep.timer);
    });
    sleeps.clear();
    const pending = Array.from(calls.keys());
    calls.clear();
    hosts.clear();
    if (!report) return;
    if (pending.length === 0) env.send({ type: 'killed', call: null, reason: reason });
    for (let i = 0; i < pending.length; i += 1) env.send({ type: 'killed', call: pending[i], reason: reason });
  }

  function sendPing(now: number): void {
    nonce += 1;
    ping = { nonce: nonce, sentAt: now };
    lastPing = now;
    worker.postMessage({ type: 'ping', nonce: nonce });
  }

  function tick(): void {
    if (!worker) return;
    const now = env.now();
    if (!booted) {
      if (now - bootStarted > limits.boot) kill('boot', true);
      return;
    }
    if (ping !== null) {
      if (now - ping.sentAt > limits.stretch) {
        kill('stretch', true);
        return;
      }
    } else if (now - lastPing >= (calls.size > 0 ? limits.ping : limits.idlePing)) {
      sendPing(now);
    }
    let reason: Any = null;
    calls.forEach(function (record: Any) {
      if (reason !== null) return;
      if (active(record, now) > limits.active) reason = 'time';
      else if (running(record, now) > limits.cpu) reason = 'cpu';
    });
    if (reason !== null) kill(reason, true);
  }

  function startWorker(): void {
    if (worker || source === null) return;
    worker = env.makeWorker(source);
    booted = false;
    bootStarted = env.now();
    worker.onmessage = function (event: Any): void {
      fromWorker(event && event.data);
    };
    worker.onerror = function (): void {
      kill('crashed', true);
    };
    worker.postMessage({ type: 'init', wasm: wasm });
    if (ticker === null) ticker = env.every(tick, limits.tick);
  }

  /** `sleep`, answered here so the frame knows the script is idle — capped as the worker caps it. */
  function sleep(record: Any, call: Any, host: number, args: Any, now: number): void {
    const ms = Math.min(limits.sleep, Math.max(0, Number(args && args.ms) || 0));
    pause(record.sleeping, now);
    const timer = env.later(function (): void {
      if (!sleeps.has(host)) return;
      sleeps.delete(host);
      const current = calls.get(call);
      if (current) resume(current.sleeping, env.now());
      if (worker) worker.postMessage({ type: 'reply', host: host, ok: true, value: true });
    }, ms);
    sleeps.set(host, { call: call, timer: timer });
  }

  /** The worker runs a stranger's script: everything it says is checked for shape here, and again upstairs. */
  function fromWorker(message: Any): void {
    if (!message || typeof message !== 'object') return;
    const now = env.now();
    if (message.type === 'pong') {
      if (ping !== null && message.nonce === ping.nonce) ping = null;
      return;
    }
    if (message.type === 'booted') {
      if (booted) return;
      booted = true;
      lastPing = now;
      env.send({ type: 'booted' });
      return;
    }
    if (message.type === 'bootFailed') {
      env.send({ type: 'bootFailed', message: String(message.message).slice(0, 500) });
      kill('boot', true);
      return;
    }
    if (message.type === 'host') {
      const record = calls.get(message.call);
      const host = message.host;
      if (!record || typeof host !== 'number' || hosts.has(host) || sleeps.has(host) || typeof message.name !== 'string') return;
      if (message.name === 'sleep') {
        sleep(record, message.call, host, message.args, now);
        return;
      }
      const holds = Object.prototype.hasOwnProperty.call(HOLDS, message.name);
      hosts.set(host, { call: message.call, holds: holds });
      if (holds) pause(record.waiting, now);
      env.send({ type: 'host', call: message.call, host: host, name: message.name, args: message.args });
      return;
    }
    if (message.type === 'done') {
      if (!calls.has(message.call)) return;
      calls.delete(message.call);
      hosts.forEach(function (entry: Any, id: Any) {
        if (entry.call === message.call) hosts.delete(id);
      });
      sleeps.forEach(function (entry: Any, id: Any) {
        if (entry.call !== message.call) return;
        env.cancel(entry.timer);
        sleeps.delete(id);
      });
      env.send({ type: 'done', call: message.call, result: message.result });
    }
  }

  return function fromParent(data: Any): void {
    if (!data || typeof data !== 'object') return;
    const now = env.now();
    if (data.type === 'boot') {
      if (source !== null || typeof data.source !== 'string' || !isBuffer(data.wasm)) return;
      source = data.source;
      wasm = data.wasm;
      startWorker();
      return;
    }
    if (data.type === 'call') {
      if (typeof data.call !== 'number' || calls.has(data.call)) return;
      // A worker that was killed is replaced on the next call; the script starts over.
      startWorker();
      if (!worker) {
        env.send({ type: 'killed', call: data.call, reason: 'boot' });
        return;
      }
      calls.set(data.call, {
        started: now,
        waiting: { holds: 0, since: 0, total: 0 },
        sleeping: { holds: 0, since: 0, total: 0 },
      });
      worker.postMessage(data);
      return;
    }
    if (data.type === 'reply') {
      const entry = hosts.get(data.host);
      if (!entry) return;
      hosts.delete(data.host);
      const record = calls.get(entry.call);
      if (record && entry.holds) resume(record.waiting, now);
      if (worker) worker.postMessage({ type: 'reply', host: data.host, ok: data.ok === true, value: data.value, error: data.error });
      return;
    }
    if (data.type === 'dispose') kill('disposed', false);
  };
}

/**
 * The frame document's start: the handshake with the parent — `ready` out over
 * the window, a `MessagePort` back, the window never used again — and the
 * browser's own worker, clock and timers for `luaFrameRuntime`.
 */
function luaFrameBootstrap(frameRuntime: Any, limits: Any): void {
  'use strict';
  const every = window.setInterval.bind(window);
  const stopEvery = window.clearInterval.bind(window);
  const later = window.setTimeout.bind(window);
  const cancel = window.clearTimeout.bind(window);
  const clock = window.performance;
  const BlobCtor = window.Blob;
  const URLCtor = window.URL;
  const WorkerCtor = window.Worker;
  let port: Any = null;
  let url: Any = null;
  let urlSource: Any = null;

  const receive = frameRuntime(
    {
      send: function (message: Any): void {
        if (port) port.postMessage(message);
      },
      makeWorker: function (source: string): Any {
        if (url === null || urlSource !== source) {
          url = URLCtor.createObjectURL(new BlobCtor([source], { type: 'text/javascript' }));
          urlSource = source;
        }
        return new WorkerCtor(url);
      },
      now: function (): number {
        return clock.now();
      },
      every: every,
      stopEvery: stopEvery,
      later: later,
      cancel: cancel,
    },
    limits,
  );

  window.addEventListener('message', function (event: Any): void {
    if (port || event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== 'port' || !event.ports || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = function (message: Any): void {
      receive(message.data);
    };
  });
  window.parent.postMessage({ type: 'ready' }, '*');
}
/* eslint-enable */

/* -------------------------------------------------------------- assembly */

/**
 * The frame's policy. Nothing loads and nothing connects: no `connect-src`
 * means no fetch, XHR, WebSocket or EventSource from the frame or from the
 * worker, which inherits it; `'wasm-unsafe-eval'` compiles wasmoon and is not
 * `'unsafe-eval'`, so `Function` stays closed to a script that climbs out of
 * Lua into JavaScript.
 */
export function luaFrameCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
    'worker-src blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** The prelude the worker loads into every Lua state. */
const PRELUDE = { json: JSON_LUA, head: LUA_WRAPPER[0], tail: LUA_WRAPPER[1] };

/**
 * The worker's whole program: wasmoon's own bundle, with the names a CommonJS
 * or AMD host would have shadowed so it settles on `globalThis.wasmoon` and its
 * browser loader, then our runtime. `scope` is the worker global — `self`, or a
 * stand-in in a test.
 */
export function luaWorkerSource(wasmoonSource: string, scope = 'self'): string {
  const runtime = selfContained(luaWorkerRuntime.toString(), 'luaWorkerRuntime');
  return [
    '(function (exports, module, define, require, process, __filename, __dirname) {',
    wasmoonSource,
    `}).call(${scope});`,
    `(${runtime})(${scope}, ${JSON.stringify(LUA_LIMITS)}, ${JSON.stringify(PRELUDE)});`,
  ].join('\n');
}

/** The frame runtime as a value, for the tests to drive with a stand-in `env`. */
export const runLuaFrame = luaFrameRuntime as (env: unknown, limits: LuaLimits) => (data: unknown) => void;

/** The frame document. It carries no script and no wasmoon — both arrive over the port. */
export function luaFrameSrcdoc(): string {
  const frame = selfContained(luaFrameRuntime.toString(), 'luaFrameRuntime');
  const bootstrap = selfContained(luaFrameBootstrap.toString(), 'luaFrameBootstrap');
  const script = `(${bootstrap})(${frame}, ${JSON.stringify(LUA_LIMITS)});`.replace(/<\/(script)/gi, '<\\/$1');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${luaFrameCsp()}">`,
    '</head><body>',
    `<script>${script}</script>`,
    '</body></html>',
  ].join('');
}
