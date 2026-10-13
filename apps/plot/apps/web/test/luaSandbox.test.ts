// @vitest-environment node
/**
 * The Lua sandbox, on real threads, with the sources that ship.
 *
 * Each test drives the page's client (`createLuaSandbox`) against the frame's
 * program (`runLuaFrame`, the watchdog) whose worker is a real worker thread
 * running wasmoon and our worker runtime — the same text the frame turns into
 * a blob. Only the iframe is missing: the port is a pair of functions that
 * clone what passes, as a `MessagePort` does, and the worker thread is told it
 * is a browser worker so wasmoon takes its browser loader and our fetch shim.
 *
 * What only a browser can show — that the frame's CSP refuses every connection
 * and every `Function`, and that the worker inherits it — is checked against
 * the policy text here, and the worker's own second lock (the network names
 * taken off its global) against a script that climbs out of Lua to look.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import { runTriggers, type CodeScope, type TriggerScript } from '@shizue/core/triggers';
import { afterEach, describe, expect, it } from 'vitest';
import { LUA_CLASSIFICATION } from '../src/lib/scripts/lua/classification';
import { createLuaEngine, luaFunctionNames } from '../src/lib/scripts/lua/engine';
import { LUA_WRAPPER } from '../src/lib/scripts/lua/prelude';
import {
  createLuaSandbox,
  type LuaHost,
  type LuaSandbox,
  type OpenLuaChannel,
} from '../src/lib/scripts/lua/sandbox';
import {
  LUA_LIMITS,
  luaFrameCsp,
  luaFrameSrcdoc,
  luaWorkerSource,
  runLuaFrame,
  type LuaEntry,
  type LuaLimits,
  type LuaSnapshot,
} from '../src/lib/scripts/lua/sandboxRuntime';

const dist = dirname(createRequire(import.meta.url).resolve('wasmoon'));
const WASMOON = readFileSync(join(dist, 'index.js'), 'utf8');
const GLUE = readFileSync(join(dist, 'glue.wasm'));
const wasmBytes = (): ArrayBuffer => GLUE.buffer.slice(GLUE.byteOffset, GLUE.byteOffset + GLUE.byteLength) as ArrayBuffer;

/** A worker thread dressed as a browser worker: `self`, `importScripts`, a blob `location`, a message port. */
const BOOTSTRAP = `
const { parentPort } = require('node:worker_threads');
globalThis.self = globalThis;
globalThis.importScripts = function () {};
globalThis.location = { href: 'blob:null/lua' };
globalThis.postMessage = (message) => parentPort.postMessage(message);
parentPort.on('message', (data) => { if (globalThis.onmessage) globalThis.onmessage({ data }); });
`;

const threads: NodeWorker[] = [];
const sandboxes: LuaSandbox[] = [];

afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) sandbox.dispose();
  await Promise.all(threads.splice(0).map((thread) => thread.terminate()));
});

/** The frame's program on a real clock, its workers real threads, behind a cloning "port". */
function sandboxWith(limits: Partial<LuaLimits> = {}, onIdleKill?: (reason: string) => void): LuaSandbox {
  const open: OpenLuaChannel = async (events) => {
    const receive = runLuaFrame(
      {
        send: (message: unknown) => {
          const copy = structuredClone(message);
          setTimeout(() => events.message(copy), 0);
        },
        makeWorker: (source: string) => {
          const thread = new NodeWorker(BOOTSTRAP + source, { eval: true });
          threads.push(thread);
          const worker = {
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as ((error: unknown) => void) | null,
            postMessage: (message: unknown) => thread.postMessage(message),
            terminate: () => void thread.terminate(),
          };
          thread.on('message', (data) => worker.onmessage?.({ data }));
          thread.on('error', (error) => worker.onerror?.(error));
          return worker;
        },
        now: () => performance.now(),
        every: (fn: () => void, ms: number) => setInterval(fn, ms),
        later: (fn: () => void, ms: number) => setTimeout(fn, ms),
        cancel: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
        stopEvery: (id: ReturnType<typeof setInterval>) => clearInterval(id),
      },
      { ...LUA_LIMITS, ...limits },
    );
    return { post: (message) => receive(structuredClone(message)), close: () => receive({ type: 'dispose' }) };
  };
  const sandbox = createLuaSandbox({
    open,
    loadAssets: async () => ({ wasmoon: WASMOON, wasm: wasmBytes() }),
    ...(onIdleKill ? { onIdleKill } : {}),
  });
  sandboxes.push(sandbox);
  return sandbox;
}

const snapshot = (extra: Partial<LuaSnapshot> = {}): LuaSnapshot => ({
  vars: [['hp', '10']],
  globals: [['coins', '7']],
  messages: [
    { role: 'user', data: '안녕', time: 1 },
    { role: 'char', data: '어서 와', time: 2 },
  ],
  char: { name: '리안', description: '사서.', greeting: '첫 인사', lore: [] },
  user: '아린',
  persona: '{{user}}는 여행자',
  note: '노트',
  lowLevel: false,
  ...extra,
});

const asked: string[] = [];
const host: LuaHost = {
  alert: async (text) => void asked.push(`alert:${text}`),
  input: async (text) => {
    asked.push(`input:${text}`);
    return '카드';
  },
  select: async (options) => options[1] ?? '',
  confirm: async () => true,
  llm: async (messages) => `모델:${messages.map((message) => `${message.role}=${message.content}`).join('|')}`,
};

const start: LuaEntry = { kind: 'trigger', mode: 'start' };

async function done(sandbox: LuaSandbox, code: string, entry: LuaEntry = start, snap = snapshot()) {
  const outcome = await sandbox.call(code, entry, snap, host);
  if (outcome.kind !== 'done') throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
  return outcome.result;
}

describe('the Lua sandbox', () => {
  it('runs a hook with RisuAI’s functions over the snapshot and hands back what it wrote', async () => {
    const sandbox = sandboxWith();
    const result = await done(
      sandbox,
      `
      function onStart(id)
        local hp = tonumber(getChatVar(id, 'hp'))
        setChatVar(id, 'hp', hp - 3)
        setChatVar(id, 'seen', getGlobalVar(id, 'coins') .. '/' .. getChatVar(id, 'missing'))
        setState(id, 'bag', { '열쇠', '지도' })
        local last = getChat(id, -1)
        setChatVar(id, 'last', last.role .. ':' .. last.data .. ':' .. getChatLength(id))
        setChatVar(id, 'who', getName(id) .. '/' .. getPersonaName(id) .. '/' .. getAuthorsNote(id))
        setChatVar(id, 'cbs', cbs('{{char}}와 {{user}}, hp={{getvar::hp}} {{random}}'))
        setChat(id, -1, '고쳐 쓴 답')
        setDescription(id, getDescription(id) .. ' 바뀜')
        upsertLocalLoreBook(id, '탑', '높은 탑', { key = '탑', alwaysActive = true })
        stopChat(id)
      end`,
    );
    expect(result.error).toBeNull();
    expect(Object.fromEntries(result.vars)).toEqual({
      hp: '7',
      seen: '7/null',
      __bag: '["열쇠","지도"]',
      last: 'char:어서 와:2',
      who: '리안/아린/노트',
      cbs: '리안와 아린, hp=7 {{random}}',
    });
    expect(result.stopSending).toBe(true);
    expect(result.messages).toEqual([
      { role: 'user', data: '안녕', key: 0 },
      { role: 'char', data: '고쳐 쓴 답', key: 1 },
    ]);
    expect(result.description).toBe('사서. 바뀜');
    expect(result.lore).toEqual([expect.objectContaining({ comment: '탑', content: '높은 탑', key: '탑', alwaysActive: true })]);
    expect(result.notes.map(([name]) => name)).toContain('cbs');
  });

  it('keeps one Lua state per mode, as RisuAI does, until the code changes', async () => {
    const sandbox = sandboxWith();
    const code = `count = 0
      function onStart(id) count = count + 1 setChatVar(id, 'count', count) end`;
    expect((await done(sandbox, code)).vars).toEqual([['count', '1']]);
    expect((await done(sandbox, code)).vars).toEqual([['count', '2']]);
    expect((await done(sandbox, code + '\n')).vars).toEqual([['count', '1']]);
  });

  it('answers a false return as a stop, and calls a manual run’s global by name', async () => {
    const sandbox = sandboxWith();
    expect((await done(sandbox, 'function onInput(id) return false end', { kind: 'trigger', mode: 'input' })).stopSending).toBe(true);
    const named = await done(sandbox, "function attack(id) setChatVar(id, 'hit', '1') end", { kind: 'trigger', mode: 'attack' });
    expect(named.vars).toEqual([['hit', '1']]);
  });

  it('runs the edit listeners in order, through the async helper, and a display pass writes nothing back', async () => {
    const sandbox = sandboxWith();
    const code = `
      listenEdit('editInput', function(id, value, meta) return value .. '!' .. meta.index end)
      listenEdit('editInput', function(id, value) setChatVar(id, 'edited', 'yes') return '[' .. value .. ']' end)
      listenEdit('editDisplay', function(id, value, meta)
        setChatVar(id, 'temp', 'x')
        return value .. '#' .. meta.index .. getChatVar(id, 'temp')
      end)`;
    const input = await done(sandbox, code, { kind: 'edit', phase: 'editInput', text: '안녕', index: -1 });
    expect(input.res).toBe('[안녕!-1]');
    expect(input.vars).toEqual([['edited', 'yes']]);
    const shown = await done(sandbox, code, {
      kind: 'display',
      items: [
        { text: 'a', index: 0 },
        { text: 'b', index: 1 },
      ],
    });
    expect(shown.res).toEqual(['a#0x', 'b#1x']);
    expect(shown.vars).toEqual([]);
  });

  it('asks the reader through the page, and keeps the model behind low-level access', async () => {
    asked.length = 0;
    const sandbox = sandboxWith();
    const code = `
      onStart = async(function(id)
        alertNormal(id, '알림')
        local name = alertInput(id, '이름?'):await()
        local pick = alertSelect(id, { '가', '나' }):await()
        local ok = alertConfirm(id, '확인?'):await()
        setChatVar(id, 'answers', name .. '/' .. pick .. '/' .. tostring(ok))
        setChatVar(id, 'hash', hash(id, '한글 abc'):await())
        local reply = LLM(id, { { role = 'sys', content = '규칙' }, { role = 'char', content = '앞' }, { role = 'user', content = '질문' } })
        setChatVar(id, 'llm', tostring(reply and reply.success) .. ':' .. tostring(reply and reply.result))
      end)`;
    const without = await done(sandbox, code);
    expect(Object.fromEntries(without.vars)).toMatchObject({
      answers: '카드/나/true',
      // The sandbox has no crypto.subtle; its own SHA-256 agrees with Node's.
      hash: createHash('sha256').update('한글 abc').digest('hex'),
    });
    // RisuAI's gate: no access, no call — `LLMMain` answers nil and the wrapper's decode fails.
    expect(without.error).toMatch(/expected argument of type string/);
    expect(asked).toEqual(['alert:알림', 'input:이름?']);

    const granted = await done(sandbox, code, start, snapshot({ lowLevel: true }));
    expect(Object.fromEntries(granted.vars)['llm']).toBe('true:모델:system=규칙|assistant=앞|user=질문');
    // The edit hooks never get it, whatever the card says.
    const edit = await done(
      sandbox,
      "listenEdit('editOutput', function(id, v) local r = simpleLLM(id, 'x'):await() return tostring(r) end)",
      { kind: 'edit', phase: 'editOutput', text: 'v', index: 0 },
      snapshot({ lowLevel: true }),
    );
    expect(edit.res).toBe('nil');
  });

  it('stops `while true do end` and starts over on the next call', async () => {
    let idle = '';
    const sandbox = sandboxWith({}, (reason) => (idle = reason));
    const began = performance.now();
    const outcome = await sandbox.call('function onStart(id) while true do end end', start, snapshot(), host);
    const took = performance.now() - began;
    expect(outcome).toEqual({ kind: 'killed', reason: 'stretch' });
    // The stretch budget, plus a tick and the worker's start.
    expect(took).toBeGreaterThan(LUA_LIMITS.stretch);
    expect(took).toBeLessThan(LUA_LIMITS.stretch + 3000);
    console.info(`[lua] while true do end stopped after ${Math.round(took)}ms`);
    // The chat goes on: a fresh worker answers the next call.
    expect((await done(sandbox, "function onStart(id) setChatVar(id, 'after', '1') end")).vars).toEqual([['after', '1']]);
    expect(idle).toBe('');
  }, 15_000);

  it('stops a script that yields between busy stretches, and one that sleeps forever', async () => {
    const busy = sandboxWith({ cpu: 1_000 });
    const spin = `onStart = async(function(id)
      while true do
        local x = 0
        for i = 1, 2000000 do x = x + i end
        sleep(id, 1):await()
      end
    end)`;
    let began = performance.now();
    expect(await busy.call(spin, start, snapshot(), host)).toEqual({ kind: 'killed', reason: 'cpu' });
    const spun = performance.now() - began;
    // Its running time, not a sample of it: the budget, plus a tick and the worker's start.
    expect(spun).toBeLessThan(1_000 + 2_000);

    const asleep = sandboxWith({ active: 1_500 });
    const nap = 'onStart = async(function(id) while true do sleep(id, 100):await() end end)';
    began = performance.now();
    expect(await asleep.call(nap, start, snapshot(), host)).toEqual({ kind: 'killed', reason: 'time' });
    console.info(`[lua] yielding busy loop stopped after ${Math.round(spun)}ms; endless sleep after ${Math.round(performance.now() - began)}ms`);
  }, 20_000);

  it('does not count the reader’s answer against the script', async () => {
    const sandbox = sandboxWith({ active: 800 });
    const slow: LuaHost = {
      ...host,
      input: () => new Promise((resolve) => setTimeout(() => resolve('늦은 답'), 1_500)),
    };
    const outcome = await sandbox.call(
      "onStart = async(function(id) setChatVar(id, 'a', alertInput(id, '?'):await()) end)",
      start,
      snapshot(),
      slow,
    );
    expect(outcome.kind === 'done' && outcome.result.vars).toEqual([['a', '늦은 답']]);
  }, 10_000);

  it('caps a Lua state’s memory in Lua’s own error, and the state goes on', async () => {
    const sandbox = sandboxWith();
    const result = await done(
      sandbox,
      `function onStart(id)
        local ok, err = pcall(function() local s = 'x' for i = 1, 40 do s = s .. s end end)
        setChatVar(id, 'grown', tostring(ok) .. ':' .. tostring(err))
      end`,
    );
    expect(result.vars).toEqual([['grown', 'false:not enough memory']]);
  });

  it('gives a script no network: not in Lua, and not on the worker’s global', async () => {
    const sandbox = sandboxWith();
    const result = await done(
      sandbox,
      `onStart = async(function(id)
        -- A JavaScript error reaches Lua as an object it may read, but a function it finds there is only callable: no Function to reach.
        local ok, err = pcall(logMain, '{')
        setChatVar(id, 'error', type(err) .. ':' .. type(err.constructor) .. ':' .. tostring(pcall(function() return err.constructor.constructor end)))
        setChatVar(id, 'request', request(id, 'https://example.com/'):await())
      end)`,
      start,
      snapshot({ lowLevel: true }),
    );
    expect(result.error).toBeNull();
    expect(Object.fromEntries(result.vars)).toEqual({
      error: 'userdata:function:false',
      request: JSON.stringify({ status: 400, data: 'request to https://example.com/ is not allowed' }),
    });

    // The worker's second lock: once wasmoon is up, the network names are gone from its global.
    const probe = new NodeWorker(
      BOOTSTRAP.replace(
        'globalThis.postMessage = (message) => parentPort.postMessage(message);',
        `globalThis.postMessage = (message) => {
          if (message && message.type === 'booted') {
            message.globals = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'postMessage']
              .map((name) => typeof globalThis[name]).join();
          }
          parentPort.postMessage(message);
        };`,
      ) + luaWorkerSource(WASMOON),
      { eval: true },
    );
    threads.push(probe);
    const booted = new Promise<{ globals: string }>((resolve) => probe.on('message', resolve));
    probe.postMessage({ type: 'init', wasm: wasmBytes() });
    expect((await booted).globals).toBe('undefined,undefined,undefined,undefined,undefined,undefined');

    // In the browser the frame's policy is the boundary: no connection from it or
    // from the worker that inherits it, and no 'unsafe-eval' to build code with.
    const csp = luaFrameCsp();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/'unsafe-eval'/);
    expect(luaFrameSrcdoc()).toContain(`content="${csp}"`);
  });

  it('hashes across the padding boundaries as Node does', async () => {
    const sandbox = sandboxWith();
    const inputs = ['', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64), '가'.repeat(70)];
    const result = await done(
      sandbox,
      `onStart = async(function(id)
        local inputs = json.decode(getChatVar(id, 'inputs'))
        for i, value in ipairs(inputs) do setChatVar(id, 'h' .. i, hash(id, value):await()) end
      end)`,
      start,
      snapshot({ vars: [['inputs', JSON.stringify(inputs)]] }),
    );
    expect(result.vars.map(([, value]) => value)).toEqual(
      inputs.map((input) => createHash('sha256').update(input).digest('hex')),
    );
  });

  it('takes a frame down again when wasmoon could not be fetched, and tries afresh next time', async () => {
    let opened = 0;
    let closed = 0;
    let fail = true;
    const sandbox = createLuaSandbox({
      open: async () => {
        opened += 1;
        return { post: () => undefined, close: () => void (closed += 1) };
      },
      loadAssets: async () => {
        if (fail) throw new Error('offline');
        return { wasmoon: WASMOON, wasm: wasmBytes() };
      },
    });
    sandboxes.push(sandbox);
    expect(await sandbox.call('', start, snapshot(), host)).toEqual({ kind: 'unavailable', message: 'offline' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([opened, closed]).toEqual([1, 1]);
    fail = false;
    void sandbox.call('', start, snapshot(), host);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toBe(2);
  });

  it('refuses what the worker should not be able to hand back', async () => {
    const sandbox = sandboxWith();
    // A message identity claimed twice, or out of range, is no identity.
    const result = await done(
      sandbox,
      `function onStart(id)
        setFullChat(id, { { role = 'user', data = 'a' }, { role = 'char', data = 'b' }, { role = 'char', data = 'c' } })
      end`,
    );
    expect(result.messages).toEqual([
      { role: 'user', data: 'a', key: 0 },
      { role: 'char', data: 'b', key: 1 },
      { role: 'char', data: 'c', key: null },
    ]);
  });
});

describe('the Lua classification', () => {
  it('names every function the worker declares and the wrapper defines, and nothing they do not', () => {
    const declared = new Set(
      [...readFileSync(new URL('../src/lib/scripts/lua/sandboxRuntime.ts', import.meta.url), 'utf8').matchAll(/\bset\('([A-Za-z]+)'/g)].map(
        (match) => match[1]!,
      ),
    );
    const wrapped = new Set(
      [...LUA_WRAPPER[0].matchAll(/^(?:function ([A-Za-z]+)\(|([A-Za-z]+) = )/gm)].map((match) => (match[1] ?? match[2])!),
    );
    const entries = Object.entries(LUA_CLASSIFICATION);
    const hosts = entries.filter(([, entry]) => entry.kind === 'host').map(([name]) => name);
    const wrappers = entries.filter(([, entry]) => entry.kind === 'wrapper').map(([name]) => name);
    expect(new Set(hosts)).toEqual(declared);
    expect(new Set(wrappers)).toEqual(wrapped);
    // RisuAI's low-level gate is the worker's `low(id)` check: the same functions.
    const source = readFileSync(new URL('../src/lib/scripts/lua/sandboxRuntime.ts', import.meta.url), 'utf8');
    for (const name of hosts) {
      const body = source.slice(source.indexOf(`set('${name}'`));
      const gated = /^[^]*?if \(!low\(/.exec(body.slice(0, body.indexOf('\n    set(', 1)));
      expect(Boolean(gated), name).toBe(LUA_CLASSIFICATION[name]!.lowLevelAccess === true);
    }
  });
});

describe('the Lua engine', () => {
  const lua = (code: string, type: TriggerScript['type'] = 'start'): TriggerScript => ({
    comment: '',
    type,
    conditions: [],
    effect: [{ type: 'triggerlua', code }],
  });

  it('runs a triggerlua effect at its place in the trigger list, its writes in the run', async () => {
    const sandbox = sandboxWith();
    const triggers: TriggerScript[] = [
      { comment: '', type: 'start', conditions: [], effect: [{ type: 'setvar', var: 'before', value: '1', operator: '=' }] },
      lua("function onStart(id) setChatVar(id, 'fromLua', getChatVar(id, 'before') .. '+') setChat(id, -1, '바뀐 끝') end"),
      { comment: '', type: 'start', conditions: [], effect: [{ type: 'setvar', var: 'after', value: '{{getvar::fromLua}}', operator: '=' }] },
    ];
    const logs: string[] = [];
    const engine = createLuaEngine({
      triggers,
      lowLevelAccess: false,
      sandbox,
      ui: host,
      llm: host.llm,
      log: (entry) => logs.push(entry.message),
    });
    expect(engine.handles('start')).toBe(true);
    expect(engine.handles('output')).toBe(false);
    const result = await runTriggers(
      {
        mode: 'start',
        character: { name: '리안', description: '', lorebook: [], postHistoryInstructions: '', lowLevelAccess: false, triggers },
        messages: [
          { role: 'user', data: '안녕', id: 'm0' },
          { role: 'char', data: '어서 와', id: 'm1' },
        ],
        note: '',
        persona: '',
        variables: Object.create(null),
      },
      { code: (request) => engine.runCode!(request) },
    );
    expect(result.variables['fromLua']).toBe('1+');
    expect(result.variables['after']).toBe('1+');
    // The message keeps its id, so the runtime can tell it is the head being rewritten.
    expect(result.messages.at(-1)).toEqual({ role: 'char', data: '바뀐 끝', id: 'm1' });
    expect(logs).toEqual([]);
  });

  it('chains the edit hooks of every script, and reads the function names a button may call', async () => {
    const sandbox = sandboxWith();
    const engine = createLuaEngine({
      triggers: [
        lua("listenEdit('editOutput', function(id, v) setChatVar(id, 'n', '1') return v .. 'a' end)"),
        lua("listenEdit('editOutput', function(id, v) return v .. getChatVar(id, 'n') end)\nfunction heal(id) end\nattack = async(function(id) end)"),
      ],
      lowLevelAccess: true,
      sandbox,
      ui: host,
      llm: host.llm,
      log: () => undefined,
    });
    const vars: Record<string, string | null> = {};
    const scope: CodeScope = {
      getVar: (name) => vars[name] ?? 'null',
      setVar: (name, value) => void (vars[name] = value),
      variables: () => Object.assign(Object.create(null), vars),
      getGlobalVar: () => 'null',
      setGlobalVar: () => undefined,
      globalVariables: () => Object.create(null),
      messages: [],
      character: { name: '리안', description: '', lorebook: [] },
      setDescription: () => undefined,
      setLorebook: () => undefined,
      user: '',
      persona: '',
      note: '',
      greeting: null,
    };
    expect(await engine.edit!('editoutput', 'x', { chatIndex: 0 }, scope)).toBe('xa1');
    expect(vars).toEqual({ n: '1' });
    expect([...engine.manualNames!()].sort()).toEqual(['attack', 'heal']);
    expect(luaFunctionNames(['local function hidden() end'])).toEqual([]);
  });
});
