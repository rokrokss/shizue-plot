/**
 * The server's Lua sandbox (`requestLua.ts`) on real child processes, with no
 * database: the process boundary, the worker inside it as RisuAI's listeners
 * meet it, what a script cannot reach from Lua, and the parent's side of the
 * protocol. The generation side is in `api.test.ts` (`editRequest listeners`).
 */
import type { LuaSnapshot } from '@shizue/core/lua';
import type { RequestTurn } from '@shizue/core/triggers';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
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

  it('get a fresh Lua state every run: nothing a global held survives', async () => {
    const counted = listener(`counter = (counter or 0) + 1 req[1].content = tostring(counter) return req`);
    for (let run = 0; run < 3; run += 1) {
      expect(((await done([counted])).request as RequestTurn[])[0]!.content).toBe('1');
    }
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
