/**
 * A child spawned exactly as the Lua child is (`spawnLuaChild`) that runs the
 * JavaScript it is sent instead of wasmoon: the escape suite's way to show what
 * the process boundary refuses to code that is already out of Lua, with the
 * whole of Node in reach. It reads stdin to its end, runs it as the body of an
 * async function, and prints the result as JSON.
 *
 * Erasable TypeScript importing only `node:` modules, as the Lua child is: the
 * permission model lets it read nothing but itself.
 */
import vm from 'node:vm';

let source = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  source += chunk;
});
process.stdin.on('end', () => {
  // `vm` is allowed under --disallow-code-generation-from-strings; `eval` and `Function` are not.
  const body = vm.runInThisContext(`(async (require) => {\n${source}\n})`) as (load: unknown) => Promise<unknown>;
  void body(process.getBuiltinModule).then(
    (value) => process.stdout.write(`${JSON.stringify({ value })}\n`),
    (error: unknown) => process.stdout.write(`${JSON.stringify({ thrown: String(error) })}\n`),
  );
});
