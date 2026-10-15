/**
 * The program a card's Lua runs in: wasmoon (Lua 5.4 compiled to WebAssembly)
 * with RisuAI's host functions over a snapshot, built here as text for whatever
 * realm runs it. Two do, each with the same text:
 *
 * - **The reader's browser** (`apps/web/src/lib/scripts/lua/sandboxRuntime.ts`):
 *   a blob worker inside an opaque-origin frame whose CSP has `connect-src
 *   'none'` and no `'unsafe-eval'`, the frame its watchdog. Every mode but one
 *   runs there.
 * - **The API** (`apps/api/src/requestLua.ts`): a child process under Node's
 *   permission model, for `editRequest` alone — the request is put together on
 *   the server and never reaches the browser. There nothing like a CSP stands
 *   between a script and `Function`, so the child asks for the `server` variant
 *   (`luaWorkerSource`): no JavaScript object proxies, and no Lua library that
 *   reaches past the state (`LUA_LOCK`).
 *
 * The protocol is the same in both: `init` with wasmoon's WebAssembly, then
 * `call`s, each answered by `done`; a call that needs its host posts `host` and
 * waits for the `reply`, and a `ping` is answered by a `pong` whenever the
 * script yields.
 *
 * Memory: each Lua state's allocator is capped (`traceAllocations` with
 * `setMemoryMax`), so `s = s .. s` ends in Lua's own "not enough memory" error
 * rather than the realm's, and the worker keeps at most `engines` of them.
 *
 * ## Why this is a function that gets stringified
 *
 * As with the web's `componentRuntime.ts`: a worker has no module scope, so its
 * program is this function body, inlined with `toString()`. It must be
 * **completely self-contained** — no imports, nothing from outside its own body,
 * and none of the syntax a bundler might lower into a helper call (no object
 * spread, optional chaining, `??`, classes or async functions). The tests run
 * the very same text.
 */

import { MAX_TRIGGER_WAIT_MS } from '../triggers/interpreter.js';
import type { LuaCbsData } from './cbsEngine.js';
import { JSON_LUA, LUA_WRAPPER } from './prelude.js';

/** The stringified runtime is written loosely; it is erased to plain JavaScript anyway. */
type Any = any;

/** Every number the browser's frame and worker are held to, interpolated into both. */
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
  /** One call's wall time, less the time a dialog, a model call, a search or a request it asked for was open. */
  active: 120_000,
  /** How long the worker has to load wasmoon. */
  boot: 20_000,
  /** Bytes one Lua state may allocate. */
  memory: 32 * 1024 * 1024,
  /**
   * Lua states the worker keeps — RisuAI keeps one per mode, and a manual name is
   * a mode; the browser keeps one per card's code and mode
   * (`LuaCallMessage.stateKey`), for every chat of the reader's in the tab. Past
   * it, the one used longest ago is closed, and that code's next call in that
   * mode starts afresh.
   */
  engines: 12,
  /** A single `sleep` is cut to this, as a trigger's wait is. */
  sleep: MAX_TRIGGER_WAIT_MS,
};

export type LuaLimits = typeof LUA_LIMITS;

/**
 * Bytes one Lua state may allocate in the server's `editRequest` child, in
 * place of `LUA_LIMITS.memory`: the request a listener is handed carries the
 * reader's pictures as data URLs, and RisuAI's wrapper holds the request's JSON,
 * its decoding and the JSON it answers with at once — about ten times the
 * pictures' data, measured: 6 MB of them fit in 64 MB, 8 MB did not. The API
 * hands a listener at most 4 MB (its `REQUEST_IMAGE_BUDGET`).
 */
export const LUA_SERVER_MEMORY = 64 * 1024 * 1024;

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
  /**
   * RisuAI's `char`: `name` its name (`getName`), `nickname` what `{{char}}` is
   * instead where the card sets one, `firstMessage` and `background` as the
   * reader's overlay has them, and `image` the markup `getCharacterImage` answers
   * ('' without an avatar).
   */
  char: {
    name: string;
    nickname: string;
    description: string;
    firstMessage: string;
    background: string;
    image: string;
    /** The character's own book, RisuAI's `globalLore`. */
    lore: LuaLoreBook[];
    /**
     * The chat's, RisuAI's `localLore`: what `upsertLocalLoreBook` wrote here
     * before. `getLoreBooks` searches it first, and an upsert replaces entries
     * of its name in it alone.
     */
    localLore?: LuaLoreBook[];
    /**
     * The modules' lore on this chat (RisuAI's `getModuleLorebooks`), after the
     * other two wherever RisuAI reads all three. Read-only: nothing a script
     * calls writes it, and it is never handed back as the character's.
     */
    moduleLore?: LuaLoreBook[];
  };
  user: string;
  persona: string;
  /** The markup `getPersonaImage` answers for the persona's picture, as `char.image` is for the member's ('' without one). */
  personaImage: string;
  note: string;
  lowLevel: boolean;
  /**
   * What RisuAI's `risuChatParser` reads besides the above, for `cbs()` and the
   * persona and lore readers (`luaCbs`): the reader's clock and the rest of a
   * run's `data`, and the manual trigger that fired. Absent, they read nothing
   * more, and `{{trigger_id}}` reads `null`.
   */
  cbs?: LuaCbsData;
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
  | { kind: 'display'; items: { text: string; index: number }[] }
  /** The `editRequest` hooks over the request about to be sent: RisuAI's `OpenAIChat` list, as JSON. */
  | { kind: 'request'; data: unknown };

/** Parent → frame → worker. */
export interface LuaCallMessage {
  type: 'call';
  call: number;
  code: string;
  entry: LuaEntry;
  snapshot: LuaSnapshot;
  /**
   * Whose states these are: the card's Lua, all its scripts, by a hash (web
   * `lua/engine.ts`'s `luaCodeKey`) — so the same card in two works shares its
   * states as RisuAI's do while the code is the same, and a group's members,
   * whose code differs, keep theirs apart instead of wiping one another's as
   * RisuAI's one state a mode would on every speaker change. The browser names
   * one on every call, as its sandbox is the reader's and outlives a chat.
   * Absent, the state is the mode's alone, as on the server.
   */
  stateKey?: string;
  /**
   * The server's `editRequest` runs only (`luaWorkerSource`'s `server`): the
   * Lua state's plain-data globals as an earlier call left them, put back once
   * the code has loaded (`restore`), and taken again once this call is done
   * (`capture`) — RisuAI's state for a mode outlives a generation (`LUA_STATE`).
   */
  keep?: { restore?: string; capture?: boolean };
}

/** What a call left — still the worker's word, which the parent checks before using any of it. */
export interface LuaCallResult {
  stopSending: boolean;
  /**
   * An edit's text, or a display pass's texts, in order. A request pass's is
   * whatever JSON the listeners returned, which the server reads for itself.
   */
  res?: string | string[];
  /** Chat variables written, in first-write order, final values; `null` unsets. */
  vars: [string, string | null][];
  /** The chat as the script left it, when it touched it; `key` is the snapshot index a message came from. */
  messages: { role: 'user' | 'char'; data: string; key: number | null }[] | null;
  description: string | null;
  /** `setName`, `setCharacterFirstMessage` and `setBackgroundEmbedding`: the last value each was set to, or null. */
  name: string | null;
  firstMessage: string | null;
  background: string | null;
  /** `upsertLocalLoreBook` calls, in order. */
  lore: LuaLoreBook[];
  /** Functions called that are not carried out here, with why. */
  notes: [string, string][];
  error: string | null;
  /**
   * What `keep.capture` took (`LUA_STATE`): the globals in its own format, or
   * false when they would not fit or could not be read. Absent when not asked.
   */
  state?: string | false;
}

/** The host calls a script can make. Every other name is dropped. */
export type LuaHostName = 'alert' | 'input' | 'select' | 'confirm' | 'llm' | 'similarity' | 'request' | 'lore';

/* ------------------------------------------------------------ the worker */

/* eslint-disable */
/**
 * The worker's program, after wasmoon. `scope` is the worker global; `prelude`
 * is `json.lua` and the two halves of RisuAI's wrapper, and for the server
 * `proxy: false` (`luaWorkerSource`); `cbs` is the CBS evaluator the build
 * bundled (`./cbsEngine.ts`, `@shizue/core/lua-cbs`).
 *
 * The functions declared on each Lua state are RisuAI's (`runScripted` in its
 * `process/scriptings.ts`) — the same names, arguments, gating by access key,
 * sync or promise return — over the call's snapshot instead of the live app.
 * The web's `LUA_CLASSIFICATION` says where each one ends up.
 */
function luaWorkerRuntime(scope: Any, limits: Any, prelude: Any, cbs: Any): void {
  'use strict';

  // Captured before `lockDown` takes the names off the global.
  const post = scope.postMessage.bind(scope);
  const ResponseCtor = scope.Response;
  const wasmoon = scope.wasmoon;
  const encoder = new TextEncoder();
  const consoleLog = scope.console && scope.console.log ? scope.console.log.bind(scope.console) : function () {};

  let factory: Any = null;
  let ready: Any = null;
  /** RisuAI's engines: one Lua state per mode (and card's code), recreated when the code changes. */
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
   * RisuAI's `risuChatParser(text, { chara })`, which `cbs()` and the persona
   * and lore readers go through: the whole evaluator, with the call as it
   * stands — the variables as the script has left them so far, the chat as it
   * has it (`luaCbs`). A text that grows past what one evaluation may hold is
   * left as written, and noted.
   */
  function parse(ctx: Any, value: Any): string {
    try {
      return cbs.luaCbs(value, ctx);
    } catch (error) {
      note(ctx, 'cbs', 'a text was left as written: ' + messageOf(error));
      return text(value);
    }
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
      return parse(c(), value);
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
    set('similarity', function (id: Any, source: Any, value: Any) {
      const ctx = c();
      return Promise.resolve().then(function () {
        if (!low(id)) return undefined;
        // The page embeds, and checks what it is handed. The texts come back best first as
        // a JavaScript array, which wasmoon hands the script as it does RisuAI's.
        return host(ctx, 'similarity', { source: source, texts: value }).then(function (answer: Any) {
          // RisuAI's embedder throws into the script, where `pcall` can catch it.
          if (!answer.ok) throw new Error(text(answer.error));
          return answer.value;
        });
      });
    });
    set('request', function (id: Any, url: Any) {
      const ctx = c();
      return Promise.resolve().then(function () {
        if (!low(id)) return undefined;
        // Our server makes it, as RisuAI's proxy does on the web, and answers RisuAI's
        // `{status, data}` — its limits and refusals included. Anything but text is
        // sent as nothing, which the server answers (and counts) as RisuAI does.
        return host(ctx, 'request', { url: typeof url === 'string' ? url : null }).then(function (answer: Any) {
          // A request the page could not make is a fetch that threw, to RisuAI.
          const value = answer.ok ? answer.value : { status: 400, data: 'internal error' };
          return JSON.stringify({ status: value.status, data: value.data });
        });
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
      // RisuAI's is an inlay token for the character's picture; here, the picture's own
      // markup, which a message or the display draws the same way. '' without one.
      return Promise.resolve().then(function () {
        return ctx.char.image;
      });
    });
    set('getPersonaImageMain', function () {
      const ctx = c();
      // RisuAI's is an inlay token for the persona's picture; here, as for the
      // character's, the picture's own markup. '' without one, as RisuAI's.
      return Promise.resolve().then(function () {
        return ctx.personaImage;
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
        return host(ctx, 'llm', { messages: llmMessages(prompt), model: 'main' }).then(function (answer: Any) {
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
        return host(ctx, 'llm', { messages: [{ role: 'user', content: text(prompt) }], model: 'main' }).then(function (answer: Any) {
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
        // RisuAI's auxiliary models, one per mode there, are the chat's one auxiliary model here.
        return host(ctx, 'llm', { messages: llmMessages(prompt), model: 'sub' }).then(function (answer: Any) {
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
      const ctx = c();
      ctx.char.name = name;
      ctx.nameChanged = true;
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
      return c().char.firstMessage;
    });
    set('setCharacterFirstMessage', function (id: Any, data: Any) {
      if (!safe(id)) return;
      if (typeof data !== 'string') return false;
      const ctx = c();
      ctx.char.firstMessage = data;
      ctx.firstMessageChanged = true;
      return true;
    });
    set('getPersonaName', function () {
      return c().user;
    });
    set('getPersonaDescription', function () {
      const ctx = c();
      return parse(ctx, ctx.persona);
    });
    set('getAuthorsNote', function () {
      return c().note;
    });
    set('getBackgroundEmbedding', function (id: Any) {
      if (!safe(id)) return;
      return c().char.background;
    });
    set('setBackgroundEmbedding', function (id: Any, data: Any) {
      if (!safe(id)) return;
      if (typeof data !== 'string') return false;
      const ctx = c();
      ctx.char.background = data;
      ctx.backgroundChanged = true;
      return true;
    });
    set('getLoreBooksMain', function (_id: Any, search: Any) {
      const ctx = c();
      const found: Any[] = [];
      // RisuAI's order: the chat's lore, then the character's, then the modules'.
      const sources = [ctx.localLore, ctx.lore, ctx.moduleLore];
      for (let s = 0; s < sources.length; s += 1) {
        const source = sources[s];
        for (let i = 0; i < source.length; i += 1) {
          const book = source[i];
          if (book.comment === search) found.push(Object.assign({}, book, { content: parse(ctx, book.content) }));
        }
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
      // The chat's lore, as RisuAI's `currentChat.localLore`: the character's book is left as it is.
      ctx.localLore = ctx.localLore.filter(function (entry: Any) {
        return entry.comment !== book.comment;
      });
      ctx.localLore.push(book);
      ctx.loreUpserts.push(book);
    });
    set('loadLoreBooksMain', function (id: Any, reserve: Any) {
      const ctx = c();
      return Promise.resolve().then(function () {
        if (!low(id)) return undefined;
        // The page activates the book as the prompt would, over the chat as the script
        // has it and the entries it upserted so far; the rest is RisuAI's, here.
        const history = ctx.messages.map(function (message: Any) {
          return message.data;
        });
        return host(ctx, 'lore', { history: history, upserts: ctx.loreUpserts }).then(function (answer: Any) {
          if (!answer.ok) throw new Error(text(answer.error));
          // RisuAI's arithmetic as written: a reserve its wrapper never passes leaves NaN, which caps nothing.
          const maxContext = answer.value.maxContext - reserve;
          if (maxContext < 0) return JSON.stringify([]);
          let total = 0;
          const books: Any[] = [];
          const actives = answer.value.actives;
          for (let i = 0; i < actives.length; i += 1) {
            const parsed = parse(ctx, actives[i].prompt).trim();
            if (parsed.length === 0) continue;
            // As `getTokens` counts them.
            const tokens = Math.ceil(parsed.length / 4);
            if (total + tokens > maxContext) break;
            total += tokens;
            books.push({ data: parsed, role: actives[i].role === 'assistant' ? 'char' : actives[i].role });
          }
          return JSON.stringify(books);
        });
      });
    });
    set('getCharacterLastMessage', function () {
      const ctx = c();
      const found = lastOf(ctx, 'char');
      return found ? found.data : ctx.char.firstMessage;
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
      lowLevel: snap.lowLevel === true && kind !== 'edit' && kind !== 'display' && kind !== 'request',
      vars: new Map(snap.vars),
      varWrites: new Map(),
      globals: new Map(snap.globals),
      messages: snap.messages.map(function (message: Any, at: number) {
        return { role: role(message.role), data: text(message.data), time: message.time || 0, key: at };
      }),
      messagesChanged: false,
      char: {
        name: snap.char.name,
        nickname: snap.char.nickname,
        description: snap.char.description,
        firstMessage: snap.char.firstMessage,
        background: snap.char.background,
        image: snap.char.image,
      },
      descriptionChanged: false,
      nameChanged: false,
      firstMessageChanged: false,
      backgroundChanged: false,
      lore: snap.char.lore.slice(),
      localLore: (snap.char.localLore || []).slice(),
      moduleLore: (snap.char.moduleLore || []).slice(),
      loreUpserts: [],
      user: snap.user,
      persona: snap.persona,
      personaImage: snap.personaImage,
      note: snap.note,
      cbs: snap.cbs || null,
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
      name: ctx.nameChanged ? ctx.char.name : null,
      firstMessage: ctx.firstMessageChanged ? ctx.char.firstMessage : null,
      background: ctx.backgroundChanged ? ctx.char.background : null,
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
    state.keeper = null;
  }

  /** The state for a mode, newest last; past the cap the oldest idle one is closed. */
  function stateFor(name: string): Any {
    let state = engines.get(name);
    if (state) {
      engines.delete(name);
      engines.set(name, state);
      return state;
    }
    state = { code: null, engine: null, keeper: null, ctx: null, busy: false, queue: Promise.resolve() };
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
    // The server's states hand the script no JavaScript object to index (`luaWorkerSource`).
    return factory.createEngine({ injectObjects: true, traceAllocations: true, enableProxy: prelude.proxy !== false }).then(function (engine: Any) {
      engine.global.setMemoryMax(limits.memory);
      declare(engine, state);
      state.engine = engine;
      // `os.exit` would take the whole module down, every other state with it.
      return engine
        .doString('os.exit = nil')
        .then(function () {
          // The server's keeper of the state's globals, made before the wrapper and
          // the card's code so the names it skips are the library's and ours.
          if (typeof prelude.state !== 'string') return undefined;
          return engine.doString(prelude.state).then(function (keeper: Any) {
            state.keeper = typeof keeper === 'function' ? keeper : null;
          });
        })
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

  function listen(state: Any, phase: string, key: string, value: Any, meta: Any): Any {
    const fn = state.engine.global.get('callListenMain');
    if (typeof fn !== 'function') return Promise.resolve(undefined);
    return attempt(fn, [phase, key, JSON.stringify(value), JSON.stringify(meta)]).then(function (res: Any) {
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
      return listen(state, entry.phase, key, entry.text, { index: entry.index }).then(function (res: Any) {
        ctx.res = edited(res, entry.text);
      });
    }
    if (entry.kind === 'request') {
      // RisuAI hands these no meta (`{}`), and takes back any value but null as the request.
      return listen(state, 'editRequest', key, entry.data, {}).then(function (res: Any) {
        ctx.res = res;
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
        return listen(state, 'editDisplay', key, item.text, { index: item.index }).then(
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

  /** Runs the keeper (`LUA_STATE`), which answers false for anything it could not do. */
  function keep(state: Any, op: string, data: Any): Any {
    if (!state.engine || typeof state.keeper !== 'function') return false;
    try {
      return state.keeper(op, data);
    } catch (error) {
      return false;
    }
  }

  function invoke(state: Any, request: Any): Any {
    const ctx = context(request);
    const kept = request.keep && typeof request.keep === 'object' ? request.keep : null;
    state.busy = true;
    state.ctx = ctx;
    return prepare(state, request.code)
      .then(function () {
        // Over what the code's top level just set, as RisuAI's state never ran it again.
        if (kept && typeof kept.restore === 'string' && keep(state, 'restore', kept.restore) !== true) {
          note(ctx, 'state', 'the globals an earlier run left could not be put back; this run starts without them');
        }
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
        const result = outcome(ctx);
        if (kept && kept.capture === true) {
          const taken = keep(state, 'capture', null);
          result.state = typeof taken === 'string' ? taken : false;
        }
        return result;
      });
  }

  function engineName(entry: Any): string {
    if (entry.kind === 'button') return 'onButtonClick';
    if (entry.kind === 'edit') return entry.phase;
    if (entry.kind === 'display') return 'editDisplay';
    if (entry.kind === 'request') return 'editRequest';
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
        const name = engineName(request.entry);
        const state = stateFor(typeof request.stateKey === 'string' ? request.stateKey + ':' + name : name);
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
/* eslint-enable */

/**
 * What the server's states lose before the card's code runs, after RisuAI's
 * wrapper has loaded `json` with `require`: the Lua that reaches past the state
 * — `debug` but its `traceback`, `io`, `os` but its clock and calendar,
 * `dofile`/`loadfile`, the module system — and bytecode, which Lua does not
 * verify: `string.dump` is gone and `load` takes text only. In the browser these
 * reach only wasmoon's own memory and file system, behind the frame; on the
 * server they are the first thing a script that wants out would try.
 */
export const LUA_LOCK = String.raw`
do
  local traceback = debug.traceback
  local time, date, clock, difftime = os.time, os.date, os.clock, os.difftime
  local rawload = load
  debug = { traceback = traceback }
  os = { time = time, date = date, clock = clock, difftime = difftime }
  io = nil
  dofile = nil
  loadfile = nil
  require = nil
  package = nil
  string.dump = nil
  load = function(chunk, name, _, env) return rawload(chunk, name, 't', env) end
end
`;

/** The most the server keeps of one chat's `editRequest` globals, in bytes of `LUA_STATE`'s format. */
export const LUA_STATE_LIMIT = 1_000_000;
/** How deep a kept table may nest. */
export const LUA_STATE_DEPTH = 32;

/**
 * The keeper of a server state's globals between runs (`LuaCallMessage.keep`).
 *
 * RisuAI keeps one Lua state per mode and makes a new one only when the code
 * differs (`runScripted`), so what an `editRequest` listener leaves in a global
 * is there at the next generation. The server's child runs once and is killed,
 * so the state does not outlive the run; this takes what it can carry across —
 * as data, never as code — and puts it back in the next run's state once that
 * state has loaded the same code.
 *
 * Run before the wrapper and the card's code, it returns one function,
 * `keeper(op, text)`, which closes over the library functions it uses and the
 * names the global table already has then — Lua's library and our host
 * functions — and never touches those. `capture` answers every other global
 * whose value is a string (valid UTF-8, which is what can travel as text), a
 * number, a boolean or a table of those — string and number keys, no
 * metatable, no cycle, at most `LUA_STATE_DEPTH` deep — in a length-prefixed
 * format of its own; a global holding anything else (a function, a coroutine, a
 * class instance) is left out, since the code that made it makes it again. Past
 * `LUA_STATE_LIMIT` bytes it answers false. `restore` reads the format back —
 * whole or not at all, any malformed or deeper input being refused — and sets
 * what it read, skipping those same names, answering true; it never loads
 * anything as code.
 */
export const LUA_STATE = String.raw`
local next, type, rawset, tonumber, pcall, error, getmetatable = next, type, rawset, tonumber, pcall, error, getmetatable
local mtype, tointeger = math.type, math.tointeger
local format, sub, find = string.format, string.sub, string.find
local concat = table.concat
local ulen = utf8.len
local G = _G
local LIMIT, DEPTH = ${LUA_STATE_LIMIT}, ${LUA_STATE_DEPTH}
local reserved = {}
for name in next, G do reserved[name] = true end
local SKIP, TOO_LARGE = {}, {}

local out, size, seen
local function put(piece)
  size = size + #piece
  if size > LIMIT then error(TOO_LARGE, 0) end
  out[#out + 1] = piece
end
local function str(s)
  if ulen(s) == nil then error(SKIP, 0) end
  put('s' .. #s .. ':')
  put(s)
end
local function num(x)
  if mtype(x) == 'integer' then return put('i' .. format('%d', x) .. ';') end
  if x ~= x then return put('fnan;') end
  if x == 1/0 then return put('finf;') end
  if x == -1/0 then return put('f-inf;') end
  put('f' .. format('%a', x) .. ';')
end
local function value(v, depth)
  local t = type(v)
  if t == 'string' then return str(v) end
  if t == 'number' then return num(v) end
  if t == 'boolean' then return put(v and 'T' or 'F') end
  if t ~= 'table' or depth >= DEPTH or seen[v] or getmetatable(v) ~= nil then error(SKIP, 0) end
  seen[v] = true
  local count = 0
  for _ in next, v do count = count + 1 end
  put('t' .. count .. ':')
  for k, item in next, v do
    local kt = type(k)
    if kt == 'string' then str(k) elseif kt == 'number' then num(k) else error(SKIP, 0) end
    value(item, depth + 1)
  end
  seen[v] = nil
end
local function capture()
  local pieces, total = {}, 0
  for name, v in next, G do
    if type(name) == 'string' and not reserved[name] then
      out, size, seen = {}, total, {}
      local ok, err = pcall(function() str(name) value(v, 0) end)
      if ok then
        pieces[#pieces + 1] = concat(out)
        total = size
      elseif err ~= SKIP then
        return false
      end
    end
  end
  out, seen = nil, nil
  return concat(pieces)
end

local data, pos
local function need(ok) if not ok then error(SKIP, 0) end end
local function readstr()
  local stop = find(data, ':', pos, true)
  need(stop)
  local len = tointeger(tonumber(sub(data, pos, stop - 1)))
  need(len and len >= 0)
  local s = sub(data, stop + 1, stop + len)
  need(#s == len)
  pos = stop + len + 1
  return s
end
local function readnum(tag)
  local stop = find(data, ';', pos, true)
  need(stop)
  local text = sub(data, pos, stop - 1)
  pos = stop + 1
  if tag == 'i' then
    local x = tointeger(tonumber(text))
    need(x ~= nil)
    return x
  end
  if text == 'nan' then return 0/0 end
  if text == 'inf' then return 1/0 end
  if text == '-inf' then return -1/0 end
  local x = tonumber(text)
  need(x ~= nil)
  if mtype(x) ~= 'float' then x = x * 1.0 end
  return x
end
local function read(depth)
  local tag = sub(data, pos, pos)
  pos = pos + 1
  if tag == 's' then return readstr() end
  if tag == 'i' or tag == 'f' then return readnum(tag) end
  if tag == 'T' then return true end
  if tag == 'F' then return false end
  need(tag == 't' and depth < DEPTH)
  local stop = find(data, ':', pos, true)
  need(stop)
  local count = tointeger(tonumber(sub(data, pos, stop - 1)))
  need(count and count >= 0)
  pos = stop + 1
  local t = {}
  for _ = 1, count do
    local kt = sub(data, pos, pos)
    need(kt == 's' or kt == 'i' or kt == 'f')
    local k = read(depth)
    need(k == k)
    rawset(t, k, read(depth + 1))
  end
  return t
end
local function restore(text)
  need(type(text) == 'string' and #text <= LIMIT)
  data, pos = text, 1
  local found = {}
  while pos <= #data do
    need(sub(data, pos, pos) == 's')
    pos = pos + 1
    local name = readstr()
    found[#found + 1] = name
    found[#found + 1] = read(0)
  end
  for i = 1, #found, 2 do
    if not reserved[found[i]] then rawset(G, found[i], found[i + 1]) end
  end
  return true
end

return function(op, text)
  if op == 'capture' then
    local ok, res = pcall(capture)
    out, seen = nil, nil
    if ok then return res end
    return false
  end
  if op == 'restore' then
    local ok, res = pcall(restore, text)
    data = nil
    return ok and res == true
  end
  return false
end
`;

/**
 * The worker's whole program: wasmoon's own bundle, with the names a CommonJS
 * or AMD host would have shadowed so it settles on `globalThis.wasmoon` and its
 * browser loader, then our runtime. `scope` is the worker global — `self`, or a
 * stand-in in a test.
 *
 * `cbs` is the CBS evaluator as the build bundled it (`LUA_CBS_ENGINE` from
 * `@shizue/core/lua-cbs`): an expression the runtime takes as its own, so
 * `cbs()` answers at once with the whole language. It is our code, made from
 * `./cbsEngine.ts`, and runs before the worker locks its global; it compiles
 * nothing from strings, so the frame's CSP and the server's
 * `--disallow-code-generation-from-strings` hold over it.
 *
 * `server` is the API's child, where no CSP keeps `Function` from compiling:
 * its states are made without wasmoon's proxy, so a script cannot index any
 * JavaScript value it is handed (an error's `constructor`, a returned object's
 * `__proto__`), and with `LUA_LOCK` between the wrapper and the card's code;
 * a state there may hold `LUA_SERVER_MEMORY`, for the request's pictures.
 * `check` vets the runtime's compiled text — the web's bundler check.
 */
export function luaWorkerSource(
  wasmoonSource: string,
  scope: string,
  {
    cbs,
    server = false,
    check = (runtime: string): string => runtime,
  }: { cbs: string; server?: boolean; check?: (runtime: string) => string },
): string {
  const runtime = check(luaWorkerRuntime.toString());
  const prelude = server
    ? { json: JSON_LUA, head: LUA_WRAPPER[0] + LUA_LOCK, tail: LUA_WRAPPER[1], proxy: false, state: LUA_STATE }
    : { json: JSON_LUA, head: LUA_WRAPPER[0], tail: LUA_WRAPPER[1] };
  const limits = server ? { ...LUA_LIMITS, memory: LUA_SERVER_MEMORY } : LUA_LIMITS;
  return [
    '(function (exports, module, define, require, process, __filename, __dirname) {',
    wasmoonSource,
    `}).call(${scope});`,
    `(${runtime})(${scope}, ${JSON.stringify(limits)}, ${JSON.stringify(prelude)}, ${cbs});`,
  ].join('\n');
}
