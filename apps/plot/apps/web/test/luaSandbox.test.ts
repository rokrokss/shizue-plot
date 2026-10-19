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
import { runTriggers, scriptChatOf, type CodeScope, type TriggerMessage, type TriggerScript } from '@shizue/core/triggers';
import type { LoreEntry } from '../src/lib/types';
import { afterEach, describe, expect, it } from 'vitest';
import { LUA_CLASSIFICATION } from '../src/lib/scripts/lua/classification';
import { createLuaEngine, luaCodeKey, luaFunctionNames } from '../src/lib/scripts/lua/engine';
import { LUA_WRAPPER } from '@shizue/core/lua';
import {
  createLuaSandbox,
  type LuaHost,
  type LuaSandbox,
  type OpenLuaChannel,
} from '../src/lib/scripts/lua/sandbox';
import { endReaderLuaSandbox, readerLuaSandbox } from '../src/lib/scripts/lua/readerSandbox';
import {
  LUA_LIMITS,
  luaFrameCsp,
  luaFrameDocument,
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
  char: { name: '리안', nickname: '', description: '사서.', firstMessage: '첫 인사', background: '', image: '', lore: [] },
  user: '아린',
  persona: '{{user}}는 여행자',
  personaImage: '',
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
  // As the page's dialog answers: the index of the option taken, as text.
  select: async (options) => {
    asked.push(`select:${options.join(',')}`);
    return String(options.indexOf('나'));
  },
  confirm: async () => true,
  // The answer says which model it came from: `모델` the chat's own, `보조` its auxiliary one.
  llm: async (messages, model) =>
    `${model === 'sub' ? '보조' : '모델'}:${messages.map((message) => `${message.role}=${message.content}`).join('|')}`,
  // "Best first" is the texts reversed; what was asked is recorded.
  similarity: async (source, texts) => {
    asked.push(`similarity:${source}:${texts.join(',')}`);
    return [...texts].reverse();
  },
  // The server's answer, standing in: a status of its own and a body naming the address.
  request: async (url) => {
    asked.push(`request:${url}`);
    return { status: 203, data: `"본문" of ${url}` };
  },
  // The page's activation, standing in: one entry per upsert after a fixed one, and a budget of 10.
  lore: async (history, upserts) => {
    asked.push(`lore:${history.join(',')}:${upserts.map((book) => book.comment).join(',')}`);
    return {
      actives: [
        { prompt: '{{char}}의 탑', role: 'system' },
        { prompt: '   ', role: 'user' },
        ...upserts.map((book) => ({ prompt: book.content, role: 'assistant' as const })),
      ],
      maxContext: 10,
    };
  },
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
        setChatVar(id, 'cbs', cbs('{{char}}와 {{user}}, hp={{getvar::hp}} {{calc::{{getvar::hp}}*2}}'))
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
      cbs: '리안와 아린, hp=7 14',
    });
    expect(result.stopSending).toBe(true);
    expect(result.messages).toEqual([
      { role: 'user', data: '안녕', key: 0 },
      { role: 'char', data: '고쳐 쓴 답', key: 1 },
    ]);
    expect(result.description).toBe('사서. 바뀜');
    expect(result.lore).toEqual([expect.objectContaining({ comment: '탑', content: '높은 탑', key: '탑', alwaysActive: true })]);
    expect(result.notes).toEqual([]);
  });

  it('answers cbs() at once with the whole language, {{trigger_id}} the manual run’s', async () => {
    // As Magical Girl Life and 당나라 무협 call it: from a plain function, outside any coroutine.
    const code = `
      local function dlcEnabled(id)
        return cbs('{{#when::DLC_First::tis::1}}1{{:else}}0{{/when}}') == '1'
      end
      function user_v1_repair_body(id)
        local data = tostring(cbs('{{trigger_id}}') or '')
        setChatVar(id, 'row', data)
        setChatVar(id, 'dlc', tostring(dlcEnabled(id)))
        setChatVar(id, 'persona', getPersonaDescription(id))
      end`;
    const manual: LuaEntry = { kind: 'trigger', mode: 'user_v1_repair_body' };
    const sandbox = sandboxWith();
    const clicked = await done(sandbox, code, manual, snapshot({ globals: [['toggle_DLC_First', '1']], cbs: { triggerId: '3' } }));
    expect(clicked.error).toBeNull();
    expect(Object.fromEntries(clicked.vars)).toEqual({ row: '3', dlc: 'true', persona: '아린는 여행자' });
    const bare = await done(sandbox, code, manual);
    expect(Object.fromEntries(bare.vars)).toMatchObject({ row: 'null', dlc: 'false' });
  });

  it('leaves a cbs() text that grows past the evaluator’s limit as written, and says so', async () => {
    const result = await done(
      sandboxWith(),
      `
      function onStart(id)
        local big = string.rep('x', 600000)
        setChatVar(id, 'length', tostring(#cbs(big .. '{{getvar::hp}}' .. big)))
      end`,
    );
    expect(result.error).toBeNull();
    expect(Object.fromEntries(result.vars)).toEqual({ length: String(1_200_000 + '{{getvar::hp}}'.length) });
    expect(result.notes.map(([name]) => name)).toEqual(['cbs']);
  });

  it('keeps one Lua state per mode, as RisuAI does, until the code changes', async () => {
    const sandbox = sandboxWith();
    const code = `count = 0
      function onStart(id) count = count + 1 setChatVar(id, 'count', count) end`;
    expect((await done(sandbox, code)).vars).toEqual([['count', '1']]);
    expect((await done(sandbox, code)).vars).toEqual([['count', '2']]);
    expect((await done(sandbox, code + '\n')).vars).toEqual([['count', '1']]);
  });

  it('keeps each state key’s Lua state its own, mode by mode, and closes the one used longest ago past the cap', async () => {
    const sandbox = sandboxWith();
    const code = `count = 0
      function onStart(id) count = count + 1 setChatVar(id, 'count', count) end`;
    const count = async (stateKey?: string) => {
      const outcome = await sandbox.call(code, start, snapshot(), host, stateKey);
      if (outcome.kind !== 'done') throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
      return outcome.result.vars;
    };
    expect(await count('a')).toEqual([['count', '1']]);
    // Another key, with the same code and mode, counts on its own…
    expect(await count('b')).toEqual([['count', '1']]);
    expect(await count('a')).toEqual([['count', '2']]);
    // …and so does a call that names none.
    expect(await count()).toEqual([['count', '1']]);
    // Past the cap the state used longest ago goes: b's, not a's.
    for (let other = 0; other < LUA_LIMITS.engines - 2; other += 1) await count(`m${other}`);
    expect(await count('a')).toEqual([['count', '3']]);
    expect(await count('b')).toEqual([['count', '1']]);
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
        local pick = alertSelect(id, { '가||다', '나' }):await()
        local ok = alertConfirm(id, '확인?'):await()
        setChatVar(id, 'answers', name .. '/' .. pick .. '/' .. type(pick) .. '/' .. tostring(ok))
        setChatVar(id, 'hash', hash(id, '한글 abc'):await())
        local reply = LLM(id, { { role = 'sys', content = '규칙' }, { role = 'char', content = '앞' }, { role = 'user', content = '질문' } })
        setChatVar(id, 'llm', tostring(reply and reply.success) .. ':' .. tostring(reply and reply.result))
      end)`;
    const without = await done(sandbox, code);
    expect(Object.fromEntries(without.vars)).toMatchObject({
      // RisuAI's dialog answers with the index of the button, as text, over the buttons it splits at `||`.
      answers: '카드/2/string/true',
      // The sandbox has no crypto.subtle; its own SHA-256 agrees with Node's.
      hash: createHash('sha256').update('한글 abc').digest('hex'),
    });
    // RisuAI's gate: no access, no call — `LLMMain` answers nil and the wrapper's decode fails.
    expect(without.error).toMatch(/expected argument of type string/);
    expect(asked).toEqual(['alert:알림', 'input:이름?', 'select:가,다,나']);

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

  it('routes LLM and simpleLLM to the main model and every axLLM mode to the auxiliary one, as RisuAI does', async () => {
    const sandbox = sandboxWith();
    const code = `
      onStart = async(function(id)
        local main = LLM(id, { { role = 'user', content = '가' } })
        local simple = simpleLLM(id, '나'):await()
        local side = axLLM(id, { { role = 'user', content = '다' } })
        local translate = axLLM(id, { { role = 'user', content = '라' } }, false, { mode = 'translate' })
        local wrong = axLLM(id, { { role = 'user', content = '마' } }, false, { mode = 'nope' })
        setChatVar(id, 'llm', table.concat({ main.result, simple.result, side.result, translate.result, wrong.result }, '/'))
      end)`;
    const result = await done(sandbox, code, start, snapshot({ lowLevel: true }));
    expect(result.error).toBeNull();
    expect(Object.fromEntries(result.vars)['llm']).toBe(
      '모델:user=가/모델:user=나/보조:user=다/보조:user=라/Error: Invalid axLLM mode: nope',
    );
  });

  it('searches on the page behind RisuAI’s gate, and hands back the list as RisuAI’s wasmoon does, best first', async () => {
    asked.length = 0;
    const sandbox = sandboxWith();
    // A JavaScript array, which wasmoon gives Lua as a proxy indexed from 1 — RisuAI's scripts get the same.
    const code = `
      onStart = async(function(id)
        local found = similarity(id, '검', { '활', '검', '창' }):await()
        if found == nil then setChatVar(id, 'found', 'nil') return end
        local seen = {}
        for i, text in ipairs(found) do seen[i] = text end
        setChatVar(id, 'found', type(found) .. ':' .. #found .. ':' .. found[1] .. ':' .. table.concat(seen, ','))
      end)`;
    const granted = await done(sandbox, code, start, snapshot({ lowLevel: true }));
    expect(granted.error).toBeNull();
    expect(Object.fromEntries(granted.vars)['found']).toBe('userdata:3:창:창,검,활');
    expect(asked).toEqual(['similarity:검:활,검,창']);

    // No access, no search: RisuAI's `similarity` answers nothing. The edit hooks never have it.
    const without = await done(sandbox, code);
    expect(Object.fromEntries(without.vars)['found']).toBe('nil');
    const edit = await done(
      sandbox,
      "listenEdit('editOutput', function(id, v) return tostring(similarity(id, 'q', { 'a' }):await()) end)",
      { kind: 'edit', phase: 'editOutput', text: 'v', index: 0 },
      snapshot({ lowLevel: true }),
    );
    expect(edit.res).toBe('nil');
    expect(asked).toHaveLength(1);
  });

  it('raises a failed search in the script, where pcall catches it, as RisuAI’s rejected promise does', async () => {
    const sandbox = sandboxWith();
    const failing: LuaHost = {
      ...host,
      similarity: async () => {
        throw new Error('the model could not be fetched');
      },
    };
    const call = (code: string, on = failing) => sandbox.call(code, start, snapshot({ lowLevel: true }), on);
    const outcome = await call(`
      onStart = async(function(id)
        local ok = pcall(function() return similarity(id, 'q', { 'a' }):await() end)
        setChatVar(id, 'caught', tostring(ok))
        similarity(id, 'q', { 'a' }):await()
        setChatVar(id, 'after', '1')
      end)`);
    expect(outcome.kind === 'done' && outcome.result.vars).toEqual([['caught', 'false']]);
    expect(outcome.kind === 'done' && outcome.result.error).toMatch(/the model could not be fetched/);

    // Anything but text fails, as it does in RisuAI's embedder; an empty table reaches it as an object.
    for (const list of ['{ 1, 2 }', '{}']) {
      const bad = await call(`onStart = async(function(id) similarity(id, 'q', ${list}):await() end)`, host);
      expect(bad.kind === 'done' && bad.result.error, list).toMatch(/a string and a list of strings/);
    }
  });

  it('does not count a slow search against the script', async () => {
    const sandbox = sandboxWith({ active: 800 });
    const slow: LuaHost = {
      ...host,
      similarity: (_source, texts) => new Promise((resolve) => setTimeout(() => resolve(texts), 1_500)),
    };
    const outcome = await sandbox.call(
      "onStart = async(function(id) setChatVar(id, 'a', similarity(id, 'q', { '첫', '둘' }):await()[1]) end)",
      start,
      snapshot({ lowLevel: true }),
      slow,
    );
    expect(outcome.kind === 'done' && outcome.result.vars).toEqual([['a', '첫']]);
  }, 10_000);

  it('relays a request to the page behind RisuAI’s gate, and hands the script RisuAI’s JSON text', async () => {
    asked.length = 0;
    const sandbox = sandboxWith();
    // RisuAI's wrapper leaves `request` alone: the script awaits the JSON text and decodes it itself.
    const code = `
      onStart = async(function(id)
        local answer = request(id, 'https://example.com/a?b=1'):await()
        if answer == nil then setChatVar(id, 'answer', 'nil') return end
        local decoded = json.decode(answer)
        setChatVar(id, 'answer', answer)
        setChatVar(id, 'decoded', decoded.status .. '|' .. decoded.data)
        setChatVar(id, 'odd', request(id, 42):await())
      end)`;
    const granted = await done(sandbox, code, start, snapshot({ lowLevel: true }));
    expect(granted.error).toBeNull();
    expect(Object.fromEntries(granted.vars)).toEqual({
      answer: JSON.stringify({ status: 203, data: '"본문" of https://example.com/a?b=1' }),
      decoded: '203|"본문" of https://example.com/a?b=1',
      // Anything but text goes to the server as nothing, which answers it as RisuAI does.
      odd: JSON.stringify({ status: 203, data: '"본문" of null' }),
    });
    expect(asked).toEqual(['request:https://example.com/a?b=1', 'request:null']);

    // No access, no request: RisuAI's `request` answers nothing. The edit hooks never have it.
    asked.length = 0;
    expect(Object.fromEntries((await done(sandbox, code)).vars)).toEqual({ answer: 'nil' });
    const edit = await done(
      sandbox,
      "listenEdit('editOutput', function(id, v) return tostring(request(id, 'https://example.com/'):await()) end)",
      { kind: 'edit', phase: 'editOutput', text: 'v', index: 0 },
      snapshot({ lowLevel: true }),
    );
    expect(edit.res).toBe('nil');
    expect(asked).toEqual([]);

    // A request the page could not make is RisuAI's fetch that threw.
    const failing: LuaHost = {
      ...host,
      request: async () => {
        throw new Error('offline');
      },
    };
    const outcome = await sandbox.call(
      "onStart = async(function(id) setChatVar(id, 'answer', request(id, 'https://example.com/'):await()) end)",
      start,
      snapshot({ lowLevel: true }),
      failing,
    );
    expect(outcome.kind === 'done' && outcome.result.vars).toEqual([
      ['answer', JSON.stringify({ status: 400, data: 'internal error' })],
    ]);
  });

  it('does not count a slow request against the script', async () => {
    const sandbox = sandboxWith({ active: 800 });
    const slow: LuaHost = {
      ...host,
      request: () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, data: '늦은 본문' }), 1_500)),
    };
    const outcome = await sandbox.call(
      "onStart = async(function(id) setChatVar(id, 'a', json.decode(request(id, 'https://example.com/'):await()).data) end)",
      start,
      snapshot({ lowLevel: true }),
      slow,
    );
    expect(outcome.kind === 'done' && outcome.result.vars).toEqual([['a', '늦은 본문']]);
  }, 10_000);

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
      end)`,
      start,
      snapshot({ lowLevel: true }),
    );
    expect(result.error).toBeNull();
    expect(Object.fromEntries(result.vars)).toEqual({ error: 'userdata:function:false' });

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
    // Sent with the document by its route; only our pages may frame it.
    expect(csp).toContain("frame-ancestors 'self'");
    expect(luaFrameDocument()).not.toContain('Content-Security-Policy');
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

  it('renames the character and rewrites its first message and background as RisuAI does, behind its gates', async () => {
    const sandbox = sandboxWith();
    const code = `function onStart(id)
      setChatVar(id, 'before', getName(id) .. '|' .. cbs('{{char}}'))
      setName(id, '세라')
      setChatVar(id, 'after', getName(id) .. '|' .. cbs('{{char}}'))
      local ok, err = pcall(setName, id, 3)
      setChatVar(id, 'bad', tostring(ok) .. ':' .. tostring(err))
      setChatVar(id, 'fm', tostring(setCharacterFirstMessage(id, 1)) .. '|' .. getCharacterFirstMessage(id))
      setChatVar(id, 'fm2', tostring(setCharacterFirstMessage(id, '새 인사')) .. '|' .. getCharacterFirstMessage(id))
      setChatVar(id, 'last', getCharacterLastMessage(id))
      setChatVar(id, 'bg', getBackgroundEmbedding(id) .. '|' .. tostring(setBackgroundEmbedding(id, false)))
      setChatVar(id, 'bg2', tostring(setBackgroundEmbedding(id, '<div>밤</div>')) .. '|' .. getBackgroundEmbedding(id))
    end`;
    const snap = snapshot({
      messages: [{ role: 'user', data: '안녕', time: 1 }],
      char: { ...snapshot().char, background: '<style>.a{}</style>' },
    });
    const result = await done(sandbox, code, start, snap);
    expect(result.error).toBeNull();
    const vars = Object.fromEntries(result.vars);
    expect(vars).toMatchObject({
      before: '리안|리안',
      after: '세라|세라',
      // Not a string: RisuAI's setName throws, setCharacterFirstMessage and setBackgroundEmbedding answer false.
      fm: 'false|첫 인사',
      fm2: 'true|새 인사',
      // With no reply of the character's yet, its first message.
      last: '새 인사',
      bg: '<style>.a{}</style>|false',
      bg2: 'true|<div>밤</div>',
    });
    expect(vars['bad']).toMatch(/^false:.*Invalid data type/);
    expect([result.name, result.firstMessage, result.background]).toEqual(['세라', '새 인사', '<div>밤</div>']);

    // `{{char}}` is the card's nickname while it has one, as RisuAI reads it; the name under it moves.
    const nicknamed = await done(
      sandbox,
      "function onStart(id) setName(id, '세라') setChatVar(id, 'n', getName(id) .. '|' .. cbs('{{char}}')) end",
      start,
      snapshot({ char: { ...snapshot().char, nickname: '리리' } }),
    );
    expect(nicknamed.vars).toEqual([['n', '세라|리리']]);

    // A display pass holds no safe key: the setters answer nothing and write nothing, the getter too.
    const shown = await done(
      sandbox,
      `listenEdit('editDisplay', function(id, value)
        setName(id, '화면')
        local set = setBackgroundEmbedding(id, 'x')
        local got = getBackgroundEmbedding(id)
        return tostring(set) .. tostring(got)
      end)`,
      { kind: 'display', items: [{ text: 'a', index: 0 }] },
    );
    expect(shown.error).toBeNull();
    expect(shown.res).toEqual(['nilnil']);
    expect([shown.name, shown.background]).toEqual([null, null]);
    // An edit hook does hold one.
    const edited = await done(sandbox, "listenEdit('editOutput', function(id, v) setName(id, '편집') return v end)", {
      kind: 'edit',
      phase: 'editOutput',
      text: 'v',
      index: 0,
    });
    expect(edited.name).toBe('편집');
  });

  it('lists the active lore as RisuAI does, cut at the budget less the reserve, behind low-level access', async () => {
    asked.length = 0;
    const sandbox = sandboxWith();
    const code = `
      onStart = async(function(id)
        upsertLocalLoreBook(id, '탑', '높은 탑이다', {})
        local all = loadLoreBooks(id)
        local parts = {}
        for i, book in ipairs(all) do parts[i] = book.role .. '=' .. book.data end
        setChatVar(id, 'all', table.concat(parts, '/'))
        setChatVar(id, 'cut', loadLoreBooksMain(id, 7):await())
        setChatVar(id, 'none', loadLoreBooksMain(id, 11):await())
      end)`;
    const granted = await done(sandbox, code, start, snapshot({ lowLevel: true }));
    expect(granted.error).toBeNull();
    expect(Object.fromEntries(granted.vars)).toEqual({
      // RisuAI's wrapper passes no reserve, and its arithmetic then caps nothing. The blank
      // entry is skipped, `{{char}}` answered, and an assistant entry is the character's.
      all: 'system=리안의 탑/char=높은 탑이다',
      // 10 less 7 is 3: the first entry is 2 tokens, the next would make 4.
      cut: JSON.stringify([{ data: '리안의 탑', role: 'system' }]),
      // A reserve past the budget lists nothing.
      none: '[]',
    });
    // The page was handed the chat as the script has it, and what it upserted on the way.
    expect(asked).toEqual(['lore:안녕,어서 와:탑', 'lore:안녕,어서 와:탑', 'lore:안녕,어서 와:탑']);

    // No access: RisuAI's `loadLoreBooksMain` answers nothing, and its wrapper's decode fails.
    asked.length = 0;
    const without = await done(sandbox, code);
    expect(without.error).toMatch(/expected argument of type string/);
    expect(asked).toEqual([]);
  });

  it('answers the character’s and the persona’s pictures as the markup it was given, and nothing without one', async () => {
    const sandbox = sandboxWith();
    const image = '<div class="risu-inlay-image"><img src="/api/plots/p/characters/c/avatar"></div>';
    const personaImage = '<div class="risu-inlay-image"><img src="/api/personas/p/avatar"></div>';
    const code = `onStart = async(function(id)
        setChatVar(id, 'char', getCharacterImage(id))
        setChatVar(id, 'persona', getPersonaImage(id))
      end)`;
    // No gate in RisuAI: a call without low-level access gets it too.
    const result = await done(sandbox, code, start, snapshot({ char: { ...snapshot().char, image }, personaImage }));
    expect(Object.fromEntries(result.vars)).toEqual({ char: image, persona: personaImage });
    const bare = await done(sandbox, code, start, snapshot());
    expect(Object.fromEntries(bare.vars)).toEqual({ char: '', persona: '' });
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

describe('the reader’s Lua sandbox', () => {
  afterEach(() => endReaderLuaSandbox());

  const code = `count = 0
    function onStart(id) count = count + 1 setChatVar(id, 'count', count) end`;
  /** What a chat page's start run of `source` counted, on its lease. */
  const count = async (lease: LuaSandbox, source = code): Promise<string | null | undefined> => {
    const outcome = await lease.call(source, start, snapshot(), host, 'member-1');
    if (outcome.kind !== 'done') throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
    return Object.fromEntries(outcome.result.vars)['count'];
  };

  it('keeps a card’s Lua state from one of the reader’s chats to the next while the code is the same', async () => {
    let opened = 0;
    const open = (): LuaSandbox => {
      opened += 1;
      return sandboxWith();
    };
    const first = readerLuaSandbox('reader-a', open);
    expect(await count(first)).toBe('1');
    expect(await count(first)).toBe('2');
    // The page goes; the next chat's page takes the same sandbox, its states as they were.
    first.dispose();
    const next = readerLuaSandbox('reader-a', open);
    expect(await count(next)).toBe('3');
    expect(opened).toBe(1);
    // New code is a new state, as RisuAI makes one when the code changes.
    expect(await count(next, `${code}\n`)).toBe('1');
  });

  it('never hands one reader’s states to another, and ends them on signing out', async () => {
    const theirs = readerLuaSandbox('reader-a', () => sandboxWith());
    expect(await count(theirs)).toBe('1');
    expect(await count(theirs)).toBe('2');
    const mine = readerLuaSandbox('reader-b', () => sandboxWith());
    expect(await count(mine)).toBe('1');
    // The first reader's lease is spent: their sandbox went with them.
    expect((await theirs.call(code, start, snapshot(), host, 'member-1')).kind).toBe('unavailable');
    endReaderLuaSandbox();
    expect(await count(readerLuaSandbox('reader-b', () => sandboxWith()))).toBe('1');
  });

  it('lets a call go when its page goes waiting on a dialog nobody will answer, and keeps the state for the next', async () => {
    let opened = 0;
    const open = (): LuaSandbox => {
      opened += 1;
      return sandboxWith();
    };
    const lease = readerLuaSandbox('reader-a', open);
    expect(await count(lease)).toBe('1');
    const asking: LuaHost = { ...host, input: () => new Promise<string>(() => undefined) };
    const dialog = `asks = 0
      onStart = async(function(id) asks = asks + 1 setChatVar(id, 'asks', asks) alertInput(id, '이름?'):await() end)`;
    const waiting = lease.call(dialog, start, snapshot(), asking, 'member-2');
    await new Promise((resolve) => setTimeout(resolve, 200));
    lease.dispose();
    expect(await waiting).toEqual({ kind: 'killed', reason: 'disposed' });
    // The next page goes on in the same sandbox, every state as it was — and the
    // dialog failed, so the call ended in the worker rather than holding its
    // state's queue for good.
    const next = readerLuaSandbox('reader-a', open);
    expect(await count(next)).toBe('2');
    const again = await next.call(dialog, start, snapshot(), host, 'member-2');
    expect(again.kind === 'done' && Object.fromEntries(again.result.vars)['asks']).toBe('2');
    expect(opened).toBe(1);
    // A lease given back runs nothing more.
    expect(await lease.call(code, start, snapshot(), host, 'member-1')).toEqual({ kind: 'killed', reason: 'disposed' });
  });

  it("never ends a newer lease's call when an older one is given back mid-call — a module or a preset switched", async () => {
    // The chat page builds the new runtime set, with its lease, before it gives
    // the one it replaces back (`release`, a tick late).
    const old = readerLuaSandbox('reader-a', () => sandboxWith());
    expect(await count(old)).toBe('1');
    let answer!: (text: string) => void;
    const slow: LuaHost = { ...host, llm: () => new Promise<string>((resolve) => (answer = resolve)) };
    const stale = old.call(
      `onStart = async(function(id) setChatVar(id, 'said', tostring(LLM(id, { { role = 'user', content = 'x' } }).result)) end)`,
      start,
      snapshot({ lowLevel: true }),
      slow,
      'member-2',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const fresh = readerLuaSandbox('reader-a', () => sandboxWith());
    old.dispose();
    expect(await stale).toEqual({ kind: 'killed', reason: 'disposed' });
    // The model answers late, to nobody; the newer set's calls run in the same sandbox and state.
    answer('늦은 답');
    expect(await count(fresh)).toBe('2');
    expect(await count(fresh)).toBe('3');
  });
});

describe('the Lua classification', () => {
  it('names every function the worker declares and the wrapper defines, and nothing they do not', () => {
    const declared = new Set(
      [...readFileSync(new URL('../../../packages/core/src/lua/runtime.ts', import.meta.url), 'utf8').matchAll(/\bset\('([A-Za-z]+)'/g)].map(
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
    const source = readFileSync(new URL('../../../packages/core/src/lua/runtime.ts', import.meta.url), 'utf8');
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
      similarity: host.similarity,
      request: host.request,
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

  it('keeps a card’s states by its code: the same card in another work shares them, a card of other code keeps its own', async () => {
    const sandbox = sandboxWith();
    const counting = (from: number): TriggerScript[] => [
      lua(`count = ${from}\nfunction onStart(id) count = count + 1 setChatVar(id, 'count', count) end`),
    ];
    const run = async (triggers: TriggerScript[]): Promise<string | undefined> => {
      // A chat page makes an engine for each member it shows; one here for each run.
      const engine = createLuaEngine({
        triggers,
        lowLevelAccess: false,
        sandbox,
        ui: host,
        llm: host.llm,
        similarity: host.similarity,
        request: host.request,
        log: () => undefined,
      });
      const result = await runTriggers(
        {
          mode: 'start',
          character: { name: '리안', description: '', lorebook: [], postHistoryInstructions: '', lowLevelAccess: false, triggers },
          messages: [],
          note: '',
          persona: '',
          variables: Object.create(null),
        },
        { code: (request) => engine.runCode!(request) },
      );
      return result.variables['count'];
    };
    expect(await run(counting(0))).toBe('1');
    // The same card, another work's member: RisuAI's state, which holds while the code is the same.
    expect(await run(counting(0))).toBe('2');
    // Another card — a group's other member — counts on its own…
    expect(await run(counting(100))).toBe('101');
    // …and leaves the first where it was, where RisuAI's one state would have started afresh.
    expect(await run(counting(0))).toBe('3');
    expect(luaCodeKey(['a', 'b'])).toBe(luaCodeKey(['a', 'b']));
    expect(new Set([luaCodeKey(['a', 'b']), luaCodeKey(['ab']), luaCodeKey(['a\nb']), luaCodeKey(['b', 'a'])]).size).toBe(4);
  });

  it('hands the run the chat the chat functions left: messages added, removed, cut, rewritten and turned', async () => {
    const sandbox = sandboxWith();
    const run = async (code: string) => {
      const triggers = [lua(code)];
      const engine = createLuaEngine({
        triggers,
        lowLevelAccess: false,
        sandbox,
        ui: host,
        llm: host.llm,
        similarity: host.similarity,
        request: host.request,
        log: () => undefined,
      });
      const messages = [
        { role: 'user' as const, data: '안녕', id: 'm0' },
        { role: 'char' as const, data: '어서 와', id: 'm1' },
        { role: 'user' as const, data: '들어간다', id: 'm2' },
      ];
      const result = await runTriggers(
        {
          mode: 'start',
          character: { name: '리안', description: '', lorebook: [], postHistoryInstructions: '', lowLevelAccess: false, triggers },
          messages,
          note: '',
          persona: '',
          variables: Object.create(null),
        },
        { code: (request) => engine.runCode!(request) },
      );
      return { result: result.messages, chat: scriptChatOf(messages, result.messages) };
    };

    const edited = await run(`function onStart(id)
      setChatRole(id, 0, 'char')
      removeChat(id, 1)
      insertChat(id, 1, 'char', '끼움')
      addChat(id, 'user', '덧붙임')
      setChat(id, -2, '고친 말')
    end`);
    // A stored message keeps its id through all of it, with the role and the text it was given.
    expect(edited.result).toEqual([
      { role: 'char', data: '안녕', id: 'm0' },
      { role: 'char', data: '끼움' },
      { role: 'user', data: '고친 말', id: 'm2' },
      { role: 'user', data: '덧붙임' },
    ]);
    expect(edited.chat).toEqual({
      keep: 0,
      messages: [
        { id: 'm0', role: 'assistant' },
        { role: 'assistant', content: '끼움' },
        { id: 'm2', content: '고친 말' },
        { role: 'user', content: '덧붙임' },
      ],
    });

    // `cutChat` is a slice; `setFullChat` keeps a message where its place and role did not change.
    expect((await run('function onStart(id) cutChat(id, 0, 2) end')).chat).toEqual({ keep: 2, messages: [] });
    const full = await run(`function onStart(id)
      local chat = getFullChat(id)
      chat[2].data = '바꾼 인사'
      table.remove(chat, 3)
      setFullChat(id, chat)
    end`);
    expect(full.chat).toEqual({ keep: 1, messages: [{ id: 'm1', content: '바꾼 인사' }] });
  });

  it('runs each script’s button with its own trigger’s access, and names that trigger to the server', async () => {
    const asked: number[] = [];
    const button = (name: string) =>
      `onButtonClick = async(function(id, data) local r = LLM(id, { { role = 'user', content = '${name}' } }) setChatVar(id, '${name}', tostring(r and r.result)) end)`;
    const engine = createLuaEngine({
      triggers: [
        // The card's, without access, and a module's, with it — as `cardScripts` marks them.
        { ...lua(button('card')), lowLevelAccess: false },
        { comment: '', type: 'start', conditions: [], effect: [] },
        { ...lua(button('module')), lowLevelAccess: true },
      ],
      lowLevelAccess: true,
      sandbox: sandboxWith(),
      ui: host,
      llm: async (messages, model, trigger) => (asked.push(trigger), host.llm(messages, model)),
      similarity: host.similarity,
      request: host.request,
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
      localLore: [],
      setLocalLore: () => undefined,
      setName: () => undefined,
      setFirstMessage: () => undefined,
      setBackgroundHtml: () => undefined,
      user: '',
      persona: '',
      note: '',
      greeting: null,
    };
    await engine.button!('x', scope);
    // Only the module's script reached the model, and it said which trigger it was.
    expect(asked).toEqual([2]);
    expect(vars['module']).toContain('module');
    expect(vars['card']).toBeUndefined();
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
      similarity: host.similarity,
      request: host.request,
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
      localLore: [],
      setLocalLore: () => undefined,
      setName: () => undefined,
      setFirstMessage: () => undefined,
      setBackgroundHtml: () => undefined,
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

  it('hands what an edit listener did to the chat to the scope, and nothing a display pass did', async () => {
    const engine = createLuaEngine({
      triggers: [
        lua(`listenEdit('editOutput', function(id, v) addChat(id, 'char', '덧붙임') setChat(id, 0, '고침') return v .. '!' end)
listenEdit('editDisplay', function(id, v) setChat(id, 0, '화면') addChat(id, 'user', '안 됨') return v end)`),
      ],
      lowLevelAccess: false,
      sandbox: sandboxWith(),
      ui: host,
      llm: host.llm,
      similarity: host.similarity,
      request: host.request,
      log: () => undefined,
    });
    const messages: TriggerMessage[] = [
      { role: 'user', data: '안녕', id: 'm1' },
      { role: 'char', data: '응', id: 'm2' },
    ];
    const scope: CodeScope = {
      getVar: () => 'null',
      setVar: () => undefined,
      variables: () => Object.create(null),
      getGlobalVar: () => 'null',
      setGlobalVar: () => undefined,
      globalVariables: () => Object.create(null),
      messages,
      character: { name: '리안', description: '', lorebook: [] },
      setDescription: () => undefined,
      setLorebook: () => undefined,
      localLore: [],
      setLocalLore: () => undefined,
      setName: () => undefined,
      setFirstMessage: () => undefined,
      setBackgroundHtml: () => undefined,
      user: '',
      persona: '',
      note: '',
      greeting: null,
    };
    expect(await engine.edit!('editoutput', '응', { chatIndex: 1 }, scope)).toBe('응!');
    // RisuAI's listener writes the chat as stored; a stored message keeps its id.
    expect(messages).toEqual([
      { role: 'user', data: '고침', id: 'm1' },
      { role: 'char', data: '응', id: 'm2' },
      { role: 'char', data: '덧붙임' },
    ]);
    const before = structuredClone(messages);
    expect(await engine.display!([{ text: 'x', chatIndex: 0 }], scope)).toEqual(['x']);
    expect(messages).toEqual(before);
  });

  it('says nothing of a display pass let go when the chat’s scripts are built anew, and names a dropped write as dropped', async () => {
    // A lease given back — a module or a preset turned on rebuilds the page's
    // scripts — answers its calls `disposed`. The set that replaced it draws the
    // messages again, so a display pass lost nothing; a trigger's writes are lost.
    const logs: { kind: string; message: string }[] = [];
    const letGo: LuaSandbox = { call: async () => ({ kind: 'killed', reason: 'disposed' }), dispose: () => undefined };
    const engine = createLuaEngine({
      triggers: [lua("listenEdit('editDisplay', function(id, v) return v end)\nfunction onStart(id) setChatVar(id, 'x', '1') end")],
      lowLevelAccess: false,
      sandbox: letGo,
      ui: host,
      llm: host.llm,
      similarity: host.similarity,
      request: host.request,
      log: (entry) => logs.push({ kind: entry.kind, message: entry.message }),
    });
    const scope = {
      getVar: () => 'null',
      setVar: () => undefined,
      variables: () => Object.create(null),
      getGlobalVar: () => 'null',
      setGlobalVar: () => undefined,
      globalVariables: () => Object.create(null),
      messages: [],
      character: { name: '리안', description: '', lorebook: [] },
      setDescription: () => undefined,
      setLorebook: () => undefined,
      localLore: [],
      setLocalLore: () => undefined,
      setName: () => undefined,
      setFirstMessage: () => undefined,
      setBackgroundHtml: () => undefined,
      user: '',
      persona: '',
      note: '',
      greeting: null,
    } satisfies CodeScope;
    expect(await engine.display!([{ text: 'x', chatIndex: 0 }], scope)).toEqual(['x']);
    expect(logs).toEqual([]);
    await engine.runCode!({ kind: 'code', language: 'lua', code: '', mode: 'start', scope, lowLevelAccess: false, trigger: 0 });
    expect(logs).toEqual([{ kind: 'dropped', message: 'the chat’s scripts were built anew while a Lua script ran; what it wrote is dropped' }]);
  });

  it('answers a script’s search with the search it was given', async () => {
    const searched: string[][] = [];
    const triggers = [lua("onStart = async(function(id) setChatVar(id, 'best', similarity(id, '물', { '불', '물' }):await()[1]) end)")];
    const engine = createLuaEngine({
      triggers,
      lowLevelAccess: true,
      sandbox: sandboxWith(),
      ui: host,
      llm: host.llm,
      similarity: async (source, texts) => (searched.push([source, ...texts]), texts.filter((text) => text === source)),
      request: host.request,
      log: () => undefined,
    });
    const result = await runTriggers(
      {
        mode: 'start',
        character: { name: '리안', description: '', lorebook: [], postHistoryInstructions: '', lowLevelAccess: true, triggers },
        messages: [],
        note: '',
        persona: '',
        variables: Object.create(null),
      },
      { code: (request) => engine.runCode!(request) },
    );
    expect(searched).toEqual([['물', '불', '물']]);
    expect(result.variables['best']).toBe('물');
  });

  it('carries a rename, a first message and a background through the run, and drops a name the server would not keep', async () => {
    const run = async (name: string) => {
      const logs: string[] = [];
      const triggers = [
        lua(`function onStart(id)
          setName(id, ${JSON.stringify(name)})
          setCharacterFirstMessage(id, '새 인사')
          setBackgroundEmbedding(id, '<div>밤</div>')
        end`),
      ];
      const engine = createLuaEngine({
        triggers,
        lowLevelAccess: false,
        sandbox: sandboxWith(),
        ui: host,
        llm: host.llm,
        similarity: host.similarity,
        request: host.request,
        log: (entry) => logs.push(`${entry.kind}:${entry.effect}`),
      });
      const result = await runTriggers(
        {
          mode: 'start',
          character: { name: '리안', description: '', lorebook: [], postHistoryInstructions: '', lowLevelAccess: false, triggers },
          messages: [],
          note: '',
          persona: '',
          variables: Object.create(null),
        },
        { code: (request) => engine.runCode!(request) },
      );
      return { character: result.character, logs };
    };
    // Kept as a member's own name is: trimmed.
    expect(await run('  세라  ')).toEqual({
      character: { name: '세라', firstMessage: '새 인사', backgroundHtml: '<div>밤</div>' },
      logs: [],
    });
    for (const bad of ['', 'x'.repeat(101), '세\n라']) {
      expect(await run(bad), JSON.stringify(bad)).toEqual({
        character: { firstMessage: '새 인사', backgroundHtml: '<div>밤</div>' },
        logs: ['limit:setName'],
      });
    }
  });

  it('activates the lore a script lists over the character the call has, with what it upserted', async () => {
    const asks: { history: string[]; lore: string[] }[] = [];
    const entry = (name: string, content: string): LoreEntry => ({
      name,
      keys: [name],
      secondaryKeys: [],
      selective: false,
      content,
      enabled: false,
      constant: false,
      insertionOrder: 100,
      caseSensitive: false,
      useRegex: false,
      position: 'before_char',
    });
    const triggers = [
      lua(`onStart = async(function(id)
        upsertLocalLoreBook(id, '탑', '높은 탑', { key = '탑' })
        local books = loadLoreBooks(id)
        setChatVar(id, 'books', books[1].data .. '/' .. books[2].data .. '/' .. #books)
        setChatVar(id, 'image', getCharacterImage(id))
        setChatVar(id, 'persona', getPersonaImage(id))
      end)`),
    ];
    // Asked when the call starts, since the reader may switch the persona mid-chat.
    let personaAvatarUrl: string | null = null;
    const engine = createLuaEngine({
      triggers,
      lowLevelAccess: true,
      sandbox: sandboxWith(),
      ui: host,
      llm: host.llm,
      similarity: host.similarity,
      request: host.request,
      lore: async (history, lorebook) => {
        asks.push({ history, lore: lorebook.map((book) => `${book.name}:${book.enabled}`) });
        return { actives: lorebook.map((book) => ({ prompt: book.content, role: 'system' as const })), maxContext: 100 };
      },
      avatarUrl: '/api/plots/p/characters/c/avatar',
      personaAvatarUrl: () => personaAvatarUrl,
      log: () => undefined,
    });
    personaAvatarUrl = '/api/personas/p/avatar';
    const result = await runTriggers(
      {
        mode: 'start',
        character: {
          name: '리안',
          description: '',
          // A disabled entry stays disabled: the page activates the book as the card has it.
          lorebook: [entry('성', '북쪽의 성')],
          postHistoryInstructions: '',
          lowLevelAccess: true,
          triggers,
        },
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
    expect(asks).toEqual([{ history: ['안녕', '어서 와'], lore: ['성:false', '탑:true'] }]);
    expect(result.variables['books']).toBe('북쪽의 성/높은 탑/2');
    expect(result.variables['image']).toBe(
      '<div class="risu-inlay-image"><img src="/api/plots/p/characters/c/avatar"></div>',
    );
    expect(result.variables['persona']).toBe('<div class="risu-inlay-image"><img src="/api/personas/p/avatar"></div>');
  });

  it('upserts into the chat’s own lore, never the character’s book, and lists the chat’s first, as RisuAI does', async () => {
    const entry = (name: string, content: string): LoreEntry => ({
      name,
      keys: [name],
      secondaryKeys: [],
      selective: false,
      content,
      enabled: true,
      constant: false,
      insertionOrder: 100,
      caseSensitive: false,
      useRegex: false,
      position: 'before_char',
    });
    const triggers = [
      lua(`function onStart(id)
        upsertLocalLoreBook(id, '성', '챗의 성', { key = '성' })
        local found = getLoreBooks(id, '성')
        setChatVar(id, 'found', found[1].content .. '/' .. found[2].content .. '/' .. #found)
      end`),
    ];
    const engine = createLuaEngine({
      triggers,
      lowLevelAccess: false,
      sandbox: sandboxWith(),
      ui: host,
      llm: host.llm,
      similarity: host.similarity,
      request: host.request,
      log: () => undefined,
    });
    const result = await runTriggers(
      {
        mode: 'start',
        character: { name: '리안', description: '', lorebook: [entry('성', '북쪽의 성')], postHistoryInstructions: '', lowLevelAccess: false, triggers },
        localLore: [entry('성', '옛 챗의 성'), entry('숲', '숲')],
        messages: [],
        note: '',
        persona: '',
        variables: Object.create(null),
      },
      { code: (request) => engine.runCode!(request) },
    );
    // The chat's entry of that name was replaced; the card's of the same name still answers, after it.
    expect(result.variables['found']).toBe('챗의 성/북쪽의 성/2');
    expect(result.character.lorebook).toBeUndefined();
    expect(result.localLore!.map((book) => `${book.name}:${book.content}`)).toEqual(['숲:숲', '성:챗의 성']);
  });

  it('answers a script’s request with the page’s, and only with low-level access', async () => {
    const run = async (lowLevelAccess: boolean) => {
      const fetched: (string | null)[] = [];
      const triggers = [lua("onStart = async(function(id) setChatVar(id, 'got', tostring(request(id, 'https://example.com/x'):await())) end)")];
      const engine = createLuaEngine({
        triggers,
        lowLevelAccess,
        sandbox: sandboxWith(),
        ui: host,
        llm: host.llm,
        similarity: host.similarity,
        request: async (url) => (fetched.push(url), { status: 404, data: 'nope' }),
        log: () => undefined,
      });
      const result = await runTriggers(
        {
          mode: 'start',
          character: { name: '리안', description: '', lorebook: [], postHistoryInstructions: '', lowLevelAccess, triggers },
          messages: [],
          note: '',
          persona: '',
          variables: Object.create(null),
        },
        { code: (request) => engine.runCode!(request) },
      );
      return { fetched, got: result.variables['got'] };
    };
    // The target's own status comes through, a 404 as well as a 200.
    expect(await run(true)).toEqual({ fetched: ['https://example.com/x'], got: JSON.stringify({ status: 404, data: 'nope' }) });
    expect(await run(false)).toEqual({ fetched: [], got: 'nil' });
  });
});
