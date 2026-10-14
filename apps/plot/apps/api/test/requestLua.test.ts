/**
 * The server's Lua sandbox (`requestLua.ts`) on real child processes, with no
 * database: the process boundary, the worker inside it as RisuAI's listeners
 * meet it, what a script cannot reach from Lua, and the parent's side of the
 * protocol. The generation side is in `api.test.ts` (`editRequest listeners`).
 */
import { LUA_STATE_LIMIT, type LuaSnapshot } from '@shizue/core/lua';
import type { RequestTurn } from '@shizue/core/triggers';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createLuaStateStore,
  luaStateHash,
  luaStateKey,
  probeRequestLua,
  runRequestLua,
  runRequestLuaAt,
  spawnLuaChild,
  type RequestLuaOutcome,
} from '../src/requestLua.js';

const HARNESS = fileURLToPath(new URL('./luaChildHarness.ts', import.meta.url));
const ROGUE = fileURLToPath(new URL('./luaRogueChild.ts', import.meta.url));
/** A file the API can read and the child must not. */
const OWN_SOURCE = fileURLToPath(new URL('../src/requestLua.ts', import.meta.url));

/** Runs `js` as an async function body in a child spawned as the Lua child is; `require` is `process.getBuiltinModule`. */
function inChild(js: string): Promise<{ value?: unknown; thrown?: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawnLuaChild(HARNESS, ['pipe', 'pipe', 'pipe']);
    let out = '';
    let err = '';
    proc.stdout!.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    proc.stderr!.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    proc.on('close', () => {
      try {
        resolve(JSON.parse(out) as { value?: unknown; thrown?: string });
      } catch {
        reject(new Error(`the harness said nothing: ${out}${err}`));
      }
    });
    proc.stdin!.end(js);
  });
}

describe('the Lua child’s process boundary', () => {
  it('is what this Node gives: the startup probe finds the network refused', async () => {
    expect(await probeRequestLua()).toBe(true);
  });

  it('reads no file but its own entry', async () => {
    const { value } = await inChild(`
      const fs = require('node:fs');
      const attempt = (fn) => { try { fn(); return 'allowed'; } catch (error) { return error.code; } };
      return {
        passwd: attempt(() => fs.readFileSync('/etc/passwd')),
        api: attempt(() => fs.readFileSync(${JSON.stringify(OWN_SOURCE)})),
        root: attempt(() => fs.readdirSync('/')),
      };`);
    expect(value).toEqual({ passwd: 'ERR_ACCESS_DENIED', api: 'ERR_ACCESS_DENIED', root: 'ERR_ACCESS_DENIED' });
  });

  it('writes no file anywhere', async () => {
    const { value } = await inChild(`
      const fs = require('node:fs');
      const attempt = (fn) => { try { fn(); return 'allowed'; } catch (error) { return error.code; } };
      return [require('node:os').tmpdir() + '/lua-escape', '/tmp/lua-escape', ${JSON.stringify(`${OWN_SOURCE}.escape`)}]
        .map((path) => attempt(() => fs.writeFileSync(path, 'x')));`);
    expect(value).toEqual(['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED']);
  });

  it('starts no process and no worker', async () => {
    const { value } = await inChild(`
      const attempt = (fn) => { try { fn(); return 'allowed'; } catch (error) { return error.code; } };
      const cp = require('node:child_process');
      const { Worker } = require('node:worker_threads');
      return {
        spawn: attempt(() => cp.spawnSync('/bin/sh', ['-c', 'id'])),
        exec: attempt(() => cp.execSync('id')),
        worker: attempt(() => new Worker('1', { eval: true })),
      };`);
    expect(value).toEqual({ spawn: 'ERR_ACCESS_DENIED', exec: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED' });
  });

  it('has no network: fetch, sockets, name lookups', async () => {
    const { value } = await inChild(`
      const net = require('node:net');
      const dns = require('node:dns');
      const failed = (error) => (error && (error.code ?? (error.cause && error.cause.code))) || String(error);
      const connect = new Promise((resolve) => {
        try {
          const socket = net.connect({ host: '127.0.0.1', port: 443 });
          socket.on('connect', () => resolve('connected'));
          socket.on('error', (error) => resolve(failed(error)));
        } catch (error) { resolve(failed(error)); }
      });
      const lookup = new Promise((resolve) => dns.lookup('example.com', (error) => resolve(error ? failed(error) : 'resolved')));
      const fetched = fetch('https://example.com/').then(() => 'fetched', failed);
      let listen;
      try { net.createServer().listen(0); listen = 'listening'; } catch (error) { listen = failed(error); }
      return { connect: await connect, lookup: await lookup, fetch: await fetched, listen };`);
    expect(value).toEqual({
      connect: 'ERR_ACCESS_DENIED',
      lookup: 'ERR_ACCESS_DENIED',
      fetch: 'ERR_ACCESS_DENIED',
      listen: 'ERR_ACCESS_DENIED',
    });
  });

  it('starts with an empty environment, and compiles no code from a string', async () => {
    const { value } = await inChild(`
      const attempt = (fn) => { try { fn(); return 'allowed'; } catch (error) { return error.code ?? error.name; } };
      return {
        // macOS gives every process this one; the Lua child clears it too.
        env: Object.keys(process.env).filter((key) => key !== '__CF_USER_TEXT_ENCODING'),
        eval: attempt(() => eval('1')),
        Function: attempt(() => new Function('return 1')),
        addon: attempt(() => process.dlopen({ exports: {} }, '/tmp/x.node')),
        binding: attempt(() => process.binding('fs')),
      };`);
    expect(value).toEqual({ env: [], eval: 'EvalError', Function: 'EvalError', addon: 'ERR_DLOPEN_DISABLED', binding: 'ERR_ACCESS_DENIED' });
  });
});

const snapshot: LuaSnapshot = {
  vars: [['hp', '10']],
  globals: [['coins', '7']],
  messages: [
    { role: 'user', data: '안녕', time: 1 },
    { role: 'char', data: '어서 와', time: 2 },
  ],
  char: {
    name: '리안',
    nickname: '',
    description: '사서.',
    firstMessage: '첫 인사',
    background: '<div>배경</div>',
    image: '<div class="risu-inlay-image"><img src="/api/plots/p/characters/c/avatar"></div>',
    lore: [
      {
        key: '탑',
        secondkey: '',
        insertorder: 100,
        comment: '탑',
        content: '{{char}}의 탑',
        mode: 'normal',
        alwaysActive: false,
        selective: false,
        useRegex: false,
      },
    ],
  },
  user: '아린',
  persona: '{{user}}는 여행자',
  personaImage: '<div class="risu-inlay-image"><img src="/api/personas/p/avatar"></div>',
  note: '노트',
  lowLevel: true,
};

const request: RequestTurn[] = [
  { role: 'system', content: '시스템' },
  { role: 'user', content: '안녕' },
];

const listener = (body: string): string => `listenEdit('editRequest', function(id, req, meta)\n${body}\nend)`;

async function done(scripts: string[], options: { deadlineMs?: number } = {}): Promise<Extract<RequestLuaOutcome, { ok: true }>> {
  const outcome = await runRequestLua({ scripts, request, snapshot }, options);
  if (!outcome.ok) throw new Error(`expected a run, got ${outcome.reason}`);
  return outcome;
}

/** What `expr` gives a listener, under pcall: `true:value` or `false:error`. */
async function reach(expr: string): Promise<string> {
  const outcome = await done([
    listener(`local ok, value = pcall(function() return ${expr} end)
      req[1].content = tostring(ok) .. ':' .. tostring(value)
      return req`),
  ]);
  return (outcome.request as RequestTurn[])[0]!.content;
}

/** Nothing came back: an error, or nil (`null` is wasmoon's JavaScript null, which can be indexed for nothing). */
const NOTHING = /^(false:|true:nil$|true:null$)/;

describe('editRequest listeners in the child', () => {
  it('hand the listener RisuAI’s functions over the snapshot, as the browser’s sandbox does', async () => {
    const { request: edited, vars, notes } = await done([
      listener(`
        local hp = tonumber(getChatVar(id, 'hp'))
        setChatVar(id, 'hp', hp - 3)
        setChatVar(id, 'seen', getGlobalVar(id, 'coins') .. '/' .. getChatVar(id, 'missing'))
        setState(id, 'bag', { '열쇠', '지도' })
        local last = getChat(id, -1)
        setChatVar(id, 'last', last.role .. ':' .. last.data .. ':' .. getChatLength(id))
        setChatVar(id, 'who', getName(id) .. '/' .. getPersonaName(id) .. '/' .. getAuthorsNote(id))
        setChatVar(id, 'cbs', cbs('{{char}}와 {{user}}, hp={{getvar::hp}} {{random}}'))
        setChatVar(id, 'card', getDescription(id) .. '/' .. getCharacterFirstMessage(id) .. '/' .. getBackgroundEmbedding(id))
        setChatVar(id, 'persona', getPersonaDescription(id))
        setChatVar(id, 'lore', getLoreBooks(id, '탑')[1].content)
        setChatVar(id, 'image', getCharacterImage(id))
        setChatVar(id, 'personaImage', getPersonaImage(id))
        setChatVar(id, 'hash', hash(id, 'abc'):await())
        setChatVar(id, 'tokens', tostring(getTokens(id, 'abcdefgh'):await()))
        setChatVar(id, 'meta', json.encode(meta))
        req[#req + 1] = { role = 'assistant', content = getUserLastMessage(id) .. '|' .. getCharacterLastMessage(id) }
        return req`),
    ]);
    expect(Object.fromEntries(vars)).toEqual({
      hp: '7',
      seen: '7/null',
      __bag: '["열쇠","지도"]',
      last: 'char:어서 와:2',
      who: '리안/아린/노트',
      cbs: '리안와 아린, hp=7 {{random}}',
      card: '사서./첫 인사/<div>배경</div>',
      persona: '아린는 여행자',
      lore: '리안의 탑',
      image: snapshot.char.image,
      personaImage: snapshot.personaImage,
      hash: createHash('sha256').update('abc').digest('hex'),
      tokens: '2',
      // RisuAI hands these listeners `{}` as their meta.
      meta: '[]',
    });
    expect(edited).toEqual([...request, { role: 'assistant', content: '안녕|어서 와' }]);
    expect(notes).toContain('cbs: only {{char}}, {{user}}, {{getvar}} and {{getglobalvar}} are answered inside the sandbox');
  });

  it('chain the scripts: each reads the request and the variables the one before left', async () => {
    const { request: edited, vars } = await done([
      listener(`req[1].content = req[1].content .. ' 하나' setChatVar(id, 'step', '1') return req`),
      // A listener that returns nothing leaves the request as it was, as RisuAI's `res ?? data`.
      listener(`setChatVar(id, 'nothing', 'kept') return nil`),
      listener(`req[1].content = req[1].content .. ' 둘 ' .. getChatVar(id, 'step') return req`),
    ]);
    expect((edited as RequestTurn[])[0]!.content).toBe('시스템 하나 둘 1');
    expect(Object.fromEntries(vars)).toEqual({ step: '1', nothing: 'kept' });
  });

  it('keep the writes of a listener that throws, and leave its request', async () => {
    const { request: edited, vars, notes } = await done([listener(`setChatVar(id, 'before', 'yes') error('boom')`)]);
    expect(edited).toEqual(request);
    expect(Object.fromEntries(vars)).toEqual({ before: 'yes' });
    expect(notes.some((note) => note.includes('boom'))).toBe(true);
  });

  it('get a fresh Lua state every run: nothing a global held survives unless it is handed back', async () => {
    const counted = listener(`counter = (counter or 0) + 1 req[1].content = tostring(counter) return req`);
    for (let run = 0; run < 3; run += 1) {
      expect(((await done([counted])).request as RequestTurn[])[0]!.content).toBe('1');
    }
  });

  it('take the last state’s plain globals when asked, and put them back over the code’s own top level', async () => {
    // RisuAI runs the top level once and keeps the state: `counter = 0` must not reset what a listener counted.
    const code = `counter = 0
      bag = { 1, 2.5, 'three', nested = { deep = true, [10] = -0.0 } }
      big = math.maxinteger
      odd = { 1/0, -1/0 }
      helper = function() end
      classy = setmetatable({}, {})
      ${listener(`counter = counter + 1 req[1].content = tostring(counter) .. ' ' .. tostring(bag.nested.deep) .. ' ' .. math.type(bag[2]) .. ' ' .. tostring(big == math.maxinteger) return req`)}`;
    const first = await runRequestLua({ scripts: [code], request, snapshot, keep: { capture: true } });
    if (!first.ok) throw new Error(first.reason);
    expect((first.request as RequestTurn[])[0]!.content).toBe('1 true float true');
    expect(typeof first.state).toBe('string');
    // Data only: no function, no table with a metatable, nothing of the library or ours.
    expect(first.state).not.toContain('helper');
    expect(first.state).not.toContain('classy');
    expect(first.state).not.toContain('getChatVar');

    const second = await runRequestLua({ scripts: [code], request, snapshot, keep: { restore: first.state!, capture: true } });
    if (!second.ok) throw new Error(second.reason);
    expect((second.request as RequestTurn[])[0]!.content).toBe('2 true float true');
    const third = await runRequestLua({
      scripts: [listener(`req[1].content = tostring(odd[1]) .. tostring(odd[2]) .. ' ' .. tostring(1/bag.nested[10]) .. ' ' .. bag[3] return req`)],
      request,
      snapshot,
      keep: { restore: second.state! },
    });
    if (!third.ok) throw new Error(third.reason);
    expect((third.request as RequestTurn[])[0]!.content).toBe('inf-inf -inf three');
    // Not asked to capture: nothing comes back.
    expect(third.state).toBeUndefined();
  });

  it('refuse a kept state that is not one, and never set the library’s names or ours from it', async () => {
    const reading = listener(`req[1].content = tostring(kept) .. ' ' .. type(getChatVar) .. ' ' .. type(string) return req`);
    const forged = 's4:kepts2:ok' + 's10:getChatVars1:x' + 's6:strings1:y';
    const ok = await runRequestLua({ scripts: [reading], request, snapshot, keep: { restore: forged } });
    if (!ok.ok) throw new Error(ok.reason);
    expect((ok.request as RequestTurn[])[0]!.content).toBe('ok function table');
    for (const broken of ['s4:kept', 'x', 's99:kept', `s4:keptt${'t1:'.repeat(40)}`]) {
      const outcome = await runRequestLua({ scripts: [reading], request, snapshot, keep: { restore: broken } });
      if (!outcome.ok) throw new Error(outcome.reason);
      expect((outcome.request as RequestTurn[])[0]!.content, broken).toBe('nil function table');
      expect(outcome.notes.some((note) => note.startsWith('state:')), broken).toBe(true);
    }
  });

  it('keep no state past its size', async () => {
    const outcome = await runRequestLua({
      scripts: [listener(`huge = string.rep('x', ${LUA_STATE_LIMIT}) small = 1 return req`)],
      request,
      snapshot,
      keep: { capture: true },
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.state).toBeNull();
    const fits = await runRequestLua({
      scripts: [listener(`huge = string.rep('x', ${LUA_STATE_LIMIT - 100}) return req`)],
      request,
      snapshot,
      keep: { capture: true },
    });
    if (!fits.ok) throw new Error(fits.reason);
    expect(fits.state!.length).toBeGreaterThan(LUA_STATE_LIMIT - 100);
    expect(fits.state!.length).toBeLessThanOrEqual(LUA_STATE_LIMIT);
  });

  it('carry what they did to the chat, the character and the chat’s lore, each script reading the one before', async () => {
    const outcome = await done([
      listener(`
        setChat(id, -1, '고친 답')
        addChat(id, 'user', '덧붙인 말')
        setName(id, '세라')
        setDescription(id, '바뀐 설명')
        upsertLocalLoreBook(id, '탑', '챗의 탑', { key = '탑' })
        return req`),
      listener(`
        req[1].content = getName(id) .. '/' .. getChat(id, -1).data .. '/' .. getChatLength(id) .. '/' .. #getLoreBooks(id, '탑')
        setCharacterFirstMessage(id, '새 인사')
        setBackgroundEmbedding(id, '<div>밤</div>')
        upsertLocalLoreBook(id, '탑', '다시 쓴 탑', { key = '탑' })
        removeChat(id, 0)
        return req`),
    ]);
    // The second script read the first one's chat, name and lore: the chat's entry before the card's.
    expect((outcome.request as RequestTurn[])[0]!.content).toBe('세라/덧붙인 말/3/2');
    expect(outcome.messages).toEqual([
      { role: 'char', data: '고친 답', key: 1 },
      { role: 'user', data: '덧붙인 말', key: null },
    ]);
    expect(outcome.character).toEqual({ name: '세라', description: '바뀐 설명', firstMessage: '새 인사', background: '<div>밤</div>' });
    expect(outcome.lore!.map((book) => book.content)).toEqual(['챗의 탑', '다시 쓴 탑']);
    // Nothing of it is said to be dropped any more.
    expect(outcome.notes.filter((note) => note.includes('not kept'))).toEqual([]);
  });

  it('answer dialogs as a display pass is answered, and sleep on the parent’s clock', async () => {
    const { vars } = await done([
      listener(`
        alertNormal(id, '알림')
        setChatVar(id, 'input', '[' .. alertInput(id, '이름?'):await() .. ']')
        setChatVar(id, 'select', '[' .. alertSelect(id, { '가', '나' }):await() .. ']')
        setChatVar(id, 'confirm', tostring(alertConfirm(id, '정말?'):await()))
        setChatVar(id, 'slept', tostring(sleep(id, 20):await()))
        return req`),
    ]);
    expect(Object.fromEntries(vars)).toEqual({ input: '[]', select: '[]', confirm: 'false', slept: 'true' });
  });

  it('give a listener no low-level access, as RisuAI does: no model call, request, search or lore', async () => {
    // RisuAI's `runLuaEditTrigger` runs every listener without it, whatever the card grants.
    expect(await reach(`request(id, 'https://example.com'):await()`)).toBe('true:nil');
    expect(await reach(`simpleLLM(id, '안녕'):await()`)).toBe('true:nil');
    expect(await reach(`similarity(id, '가', { '나' }):await()`)).toBe('true:nil');
    // The wrappers decode the nothing they get back, and fail as RisuAI's do.
    expect(await reach(`LLM(id, { { role = 'user', content = '안녕' } })`)).toMatch(/^false:.*expected argument of type string, got nil/);
    expect(await reach(`axLLM(id, { { role = 'user', content = '안녕' } })`)).toMatch(/^false:.*expected argument of type string, got nil/);
    expect(await reach(`loadLoreBooks(id)`)).toMatch(/^false:.*expected argument of type string, got nil/);
  });
});

describe('what a listener cannot reach from Lua', () => {
  it.each([
    'debug.getinfo',
    'debug.getregistry',
    'debug.sethook',
    'debug.getupvalue',
    'require',
    'package',
    'io',
    'io.open("/etc/passwd")',
    'os.execute',
    'os.getenv',
    'os.remove',
    'os.exit',
    'dofile',
    'loadfile',
    'string.dump',
    'load(string.char(27) .. "LuaT")',
    'getmetatable("").__index.dump',
    'rawget(getmetatable(""), "__index").dump',
  ])('the library: %s', async (expr) => {
    expect(await reach(expr)).toMatch(NOTHING);
  });

  it('loads text, never bytecode', async () => {
    expect(await reach(`select(2, load(string.char(27) .. "LuaT"))`)).toMatch(/binary chunk/);
    expect(await reach(`load('return 1 + 1')()`)).toBe('true:2');
    // What is left of `os` and `debug` is the clock and the traceback.
    expect(await reach(`os.time() > 0 and type(os.date()) == 'string' and type(debug.traceback()) == 'string'`)).toBe('true:true');
  });

  it.each([
    'Function',
    'globalThis',
    'process',
    'self',
    'window',
    'js',
    'getName.constructor',
    'getChatVar.prototype',
    'Promise.constructor',
    'Promise.__proto__',
    'Promise.prototype',
    'Promise.create.constructor',
    'Promise.resolve.__proto__',
    'Promise.resolve(1).constructor',
    'Promise.resolve(1).__proto__',
    'Promise.resolve(1)["then"]',
    'getTokens(id, "x").constructor',
    'hash(id, "x").__proto__',
    'Promise.create(function() end).constructor',
    'select(2, pcall(Promise.resolve(1).next, 5)).constructor',
    'select(2, pcall(Promise.resolve(1).next, 5)).__proto__',
    'select(2, pcall(Promise.all, 5)).constructor',
    'null.constructor',
    'getmetatable(Promise.resolve(1)).__index',
  ])('JavaScript, through a host value: %s', async (expr) => {
    expect(await reach(expr)).toMatch(NOTHING);
  });

  it('a metatable it may see is a string, not the table', async () => {
    expect(await reach(`getmetatable(Promise.resolve(1))`)).toBe('true:protected metatable');
  });

  it('caps a state’s memory in Lua’s own error, whatever grows', async () => {
    expect(await reach(`(function() local s = 'x' while true do s = s .. s end end)()`)).toMatch(/^false:.*not enough memory/);
    expect(await reach(`(function() local t = {} for i = 1, 1e9 do t[i] = i end end)()`)).toMatch(/^false:.*not enough memory/);
    expect(await reach(`(function() local t = {} for i = 1, 1e9 do t[i] = coroutine.create(function() end) end end)()`)).toMatch(
      /^false:.*not enough memory/,
    );
    expect(await reach(`string.rep('x', 1e9)`)).toMatch(/^false:.*not enough memory/);
  });

  it('stops deep recursion in an error', async () => {
    // The Lua stack grows into the state's memory cap before Lua's own stack limit.
    expect(await reach(`(function() local function f(n) return 1 + f(n + 1) end return f(1) end)()`)).toMatch(
      /^false:.*(stack overflow|not enough memory)/,
    );
  });

  it('stops a listener that never returns at the deadline, and the next run starts fresh', async () => {
    for (const body of ['while true do end', 'while true do coroutine.yield() end', 'sleep(id, 20000):await()']) {
      const started = Date.now();
      const outcome = await runRequestLua({ scripts: [listener(body)], request, snapshot }, { deadlineMs: 500 });
      expect(outcome).toEqual({ ok: false, reason: 'no answer in 500 ms' });
      expect(Date.now() - started).toBeLessThan(3_000);
    }
    expect(await reach(`'다음'`)).toBe('true:다음');
  });
});

describe('the parent’s side of the protocol', () => {
  const rogue = (code: string): Promise<RequestLuaOutcome> => runRequestLuaAt(ROGUE, { scripts: [code], request, snapshot }, 2_000);

  it.each(['llm', 'request', 'similarity', 'lore'])('kills a child that asks for %s, and answers it nothing', async (name) => {
    expect(await rogue(name)).toEqual({
      ok: false,
      reason: `the Lua process asked for ${name}, which an editRequest listener never has`,
    });
  });

  it('kills a child that writes what the worker never writes', async () => {
    expect(await rogue('garbage')).toEqual({ ok: false, reason: 'the Lua process wrote a line that is not JSON' });
    expect(await rogue('flood')).toEqual({ ok: false, reason: 'the Lua process wrote a line past the limit' });
    expect(await rogue('stray')).toEqual({ ok: false, reason: 'the Lua process wrote a message the worker does not send' });
  });

  it('runs nothing where the probe says the child would have the network', async () => {
    const outcome = await runRequestLua({ scripts: [listener('return {}')], request, snapshot }, { probe: async () => false });
    expect(outcome).toEqual({ ok: false, reason: 'the server cannot sandbox Lua', quiet: true });
  });
});

describe('the kept states', () => {
  it('are one a reader and card code: never another reader’s, never another code’s', () => {
    const card = [listener('return req')];
    // The same card's Lua, in whatever work: one key.
    expect(luaStateKey('reader-a', [...card])).toBe(luaStateKey('reader-a', card));
    const keys = [
      luaStateKey('reader-a', card),
      luaStateKey('reader-b', card),
      luaStateKey('reader-a', [`${card[0]}\n`]),
      // Every script of the card counts, and where one ends.
      luaStateKey('reader-a', [...card, '-- 둘째']),
      luaStateKey('reader-a', [`${card[0]}-- 둘째`]),
    ];
    expect(new Set(keys).size).toBe(5);
  });

  it('keep the most recently used within their count and their size', () => {
    const store = createLuaStateStore({ entries: 2, chars: 10 });
    store.set('a', { hash: 'h', state: 'aaaa' });
    store.set('b', { hash: 'h', state: 'bbbb' });
    // Reading one keeps it: the other is the oldest now.
    expect(store.get('a')?.state).toBe('aaaa');
    store.set('c', { hash: 'h', state: 'cc' });
    expect(store.get('b')).toBeUndefined();
    expect([store.get('a')?.state, store.get('c')?.state]).toEqual(['aaaa', 'cc']);
    // Past the size, the oldest go too.
    store.set('d', { hash: 'h', state: 'ddddddddd' });
    expect([store.get('a'), store.get('c'), store.get('d')?.state]).toEqual([undefined, undefined, 'ddddddddd']);
    store.delete('d');
    expect(store.get('d')).toBeUndefined();
    expect(luaStateHash('x')).toBe(createHash('sha256').update('x').digest('hex'));
  });
});
