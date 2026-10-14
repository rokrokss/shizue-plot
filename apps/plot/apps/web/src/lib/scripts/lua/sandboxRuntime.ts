/**
 * Where a card's Lua actually runs in the reader's browser: a worker inside a
 * sandboxed frame, both built as text — the frame here, the worker's program in
 * `@shizue/core/lua`, which the API's child process runs too (for `editRequest`,
 * `apps/api/src/requestLua.ts`).
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
 *   reader or the server — a dialog, a model call, a request — and takes back
 *   what the script wrote, all of it validated as a stranger's data.
 * - **The frame** (`luaFrameRuntime`) is a `srcdoc` iframe with
 *   `sandbox="allow-scripts"` and nothing else: an opaque origin, so no cookies,
 *   no storage, nothing addressed to our API is ours. Its CSP is
 *   `default-src 'none'` with `connect-src 'none'`: no fetch, no XHR, no
 *   WebSocket, no EventSource, to anywhere — and the worker it starts from a
 *   blob inherits that policy. It runs only our code: it relays messages and it
 *   is the **watchdog**.
 * - **The worker** (`@shizue/core/lua`) runs wasmoon and the script. A worker
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
 * waits goes through the frame: a dialog, a model call, an embedding search and
 * a request are host calls it relays, and `sleep` is a host call it answers
 * itself, on its own timer. So for each call it knows, without sampling anything:
 *
 * - **active** time: wall time less the time a dialog, a model call, a search
 *   or a request was open.
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

import {
  LUA_LIMITS,
  luaWorkerSource as sharedWorkerSource,
  type LuaLimits,
} from '@shizue/core/lua';
import { LUA_CBS_ENGINE } from '@shizue/core/lua-cbs';
import { selfContained } from '../../componentRuntime';

export {
  LUA_LIMITS,
  type LuaCallMessage,
  type LuaCallResult,
  type LuaEntry,
  type LuaHostName,
  type LuaLimits,
  type LuaLoreBook,
  type LuaMessage,
  type LuaSnapshot,
} from '@shizue/core/lua';

/** The stringified runtimes are written loosely; they are erased to plain JavaScript anyway. */
type Any = any;

/* ------------------------------------------------------------- the frame */

/* eslint-disable */
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

  /** The host calls that wait on the reader, the model, the embedder or the network: they stop a call's active clock. */
  const HOLDS: Any = { alert: true, input: true, select: true, confirm: true, llm: true, similarity: true, request: true };

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

/**
 * The worker's whole program (`@shizue/core/lua`), its runtime held to the
 * frame's contract: the bundler compiles it too, and must leave it
 * self-contained. The CBS evaluator `cbs()` answers with comes built
 * (`@shizue/core/lua-cbs`), in this module's chunk, which only a chat whose
 * scripts reach Lua loads.
 */
export function luaWorkerSource(wasmoonSource: string, scope = 'self'): string {
  return sharedWorkerSource(wasmoonSource, scope, {
    cbs: LUA_CBS_ENGINE,
    check: (runtime) => selfContained(runtime, 'luaWorkerRuntime'),
  });
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
