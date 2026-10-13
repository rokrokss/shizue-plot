/**
 * The process a card's `editRequest` listeners run in (`requestLua.ts`): Node
 * under its permission model, spawned with the flags `luaChildArgs` gives it —
 * no network, no file but this one, no child process, no worker, no addon, no
 * code compiled from a string — and an empty environment.
 *
 * Everything it runs arrives on stdin, one JSON message a line: first the
 * program — `@shizue/core/lua`'s worker with wasmoon inlined, the same text the
 * reader's browser runs — and wasmoon's WebAssembly, then the worker's own
 * messages. What the worker posts goes out on stdout the same way. The parent
 * reads every line as a stranger's: a card that climbed out of Lua could write
 * anything there.
 *
 * Before a card's code runs, what reaches the operating system from JavaScript
 * comes off the global — `process`, `Buffer` — and the console goes quiet, so
 * a script's `log` cannot write into the parent's channel. The permission model
 * refuses the rest whatever a script reaches.
 *
 * Erasable TypeScript importing only `node:` modules: the parent runs this file
 * itself (type-stripped from `src`, `.js` once built), and the permission
 * model lets it read nothing else.
 */
import vm from 'node:vm';

const input = process.stdin;
const write = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);
const decode = (base64: string): ArrayBuffer => {
  const bytes = Buffer.from(base64, 'base64');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const scope = globalThis as unknown as Record<string, unknown>;
const quiet = (): void => {};
for (const name of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) console[name] = quiet;
// macOS gives every process `__CF_USER_TEXT_ENCODING`; the parent passed nothing.
for (const key of Object.keys(process.env)) delete process.env[key];
// The names a browser worker has, so wasmoon takes its browser loader and the worker's posts reach the parent.
scope['self'] = globalThis;
scope['importScripts'] = quiet;
scope['location'] = { href: 'blob:null/lua' };
scope['postMessage'] = (message: { type?: unknown }): void => {
  write(`${JSON.stringify(message)}\n`);
  // Loading wasmoon needed Node's own fetch machinery, which reads them; no card's code has run yet.
  if (message.type === 'booted') {
    delete scope['process'];
    delete scope['Buffer'];
  }
};

let started = false;
const receive = (data: { type?: unknown; source?: unknown; wasm?: unknown }): void => {
  if (!started) {
    if (data.type !== 'program' || typeof data.source !== 'string' || typeof data.wasm !== 'string') exit(1);
    started = true;
    vm.runInThisContext(data.source as string, { filename: 'lua-worker.js' });
    const onmessage = scope['onmessage'] as (event: { data: unknown }) => void;
    onmessage({ data: { type: 'init', wasm: decode(data.wasm as string) } });
    return;
  }
  (scope['onmessage'] as (event: { data: unknown }) => void)({ data });
};

let pending = '';
input.setEncoding('utf8');
input.on('data', (chunk: string) => {
  pending += chunk;
  for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    receive(JSON.parse(line) as Parameters<typeof receive>[0]);
  }
});
// The parent is gone, or done with this one.
input.on('end', () => exit(0));
