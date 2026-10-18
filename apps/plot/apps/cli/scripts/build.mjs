// Builds the `shizue-plot` package from the checkout (`npm pack` runs it first):
//
//   dist/      the app's one process (apps/api/src/index.ts) bundled with the
//              workspace packages, and beside it under their own names the threads
//              and children it starts — found by `new URL('./x.js', import.meta.url)`
//   drizzle/   the migrations, `../drizzle` from the bundle as from @shizue/db's dist
//   web/       the web app's production build: `.next` without its caches and maps, and `public`
//   LICENSE, NOTICE, README.md   from the repository root
//
// What stays outside the bundle is a dependency of the package: what loads files
// beside its own module (PGlite's WebAssembly and pgvector, wasmoon's, onnxruntime's
// addon under transformers.js) and Next, which serves the build it made.
import { execFileSync } from 'node:child_process';
import { cpSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plot = resolve(pkg, '../..');
const repo = resolve(plot, '../..');
const api = join(plot, 'apps/api/src');
const web = join(plot, 'apps/web');

const step = (what) => console.log(`[bundle] ${what}`);
const run = (command, args, env = process.env) => execFileSync(command, args, { cwd: repo, stdio: 'inherit', env });

for (const out of ['dist', 'drizzle', 'web', 'LICENSE', 'NOTICE', 'README.md']) rmSync(join(pkg, out), { recursive: true, force: true });

step('the workspace packages');
run('pnpm', ['--filter', '@shizue/contracts', '--filter', './apps/plot/packages/*', 'build']);

step('the web app, next build');
// The origin the build lets a phone in from (next.config.ts), and nothing of this
// shell's own: no extension ID or tunnel of a developer's goes into the package.
const buildEnv = { ...process.env, NODE_ENV: 'production', BETTER_AUTH_URL: 'http://localhost:13000' };
for (const name of Object.keys(buildEnv)) if (name.startsWith('NEXT_PUBLIC_') || name === 'REMOTE_ORIGINS') delete buildEnv[name];
run('pnpm', ['--filter', '@shizue/web', 'build'], buildEnv);

step('the server bundle');
const node = { bundle: true, platform: 'node', format: 'esm', target: 'node26', outdir: join(pkg, 'dist'), logLevel: 'warning' };
await build({
  ...node,
  entryPoints: {
    server: join(api, 'index.ts'),
    regexWorkerThread: join(api, 'regexWorkerThread.ts'),
    requestTriggerThread: join(api, 'requestTriggerThread.ts'),
    embedderThread: join(api, 'embedderThread.ts'),
  },
  external: ['@electric-sql/*', '@huggingface/transformers', 'wasmoon', 'next'],
  // The CommonJS among the bundled packages (dotenv, …) require Node's own modules.
  banner: { js: "import { createRequire as __shizueRequire } from 'node:module'; const require = __shizueRequire(import.meta.url);" },
});
// The Lua child and its probe run under `--permission` allowed to read their own
// file alone: each must be that one file, with nothing to import but Node's own.
await build({
  ...node,
  entryPoints: { requestLuaChild: join(api, 'requestLuaChild.ts'), requestLuaProbe: join(api, 'requestLuaProbe.ts') },
});

step('the migrations');
cpSync(join(plot, 'packages/db/drizzle'), join(pkg, 'drizzle'), { recursive: true });

step('the web build');
const nextDir = join(web, '.next');
// Build-time and dev-server output, and what only a trace or a debugger reads.
const LEFT_OUT = new Set(['cache', 'dev', 'build', 'diagnostics', 'types', 'trace', 'trace-build', 'turbopack']);
cpSync(nextDir, join(pkg, 'web/.next'), {
  recursive: true,
  filter: (source) => {
    const path = relative(nextDir, source);
    if (path !== '' && LEFT_OUT.has(path.split(sep)[0])) return false;
    return !/\.(map|nft\.json)$/.test(basename(source));
  },
});
cpSync(join(web, 'public'), join(pkg, 'web/public'), { recursive: true });

step('the license and the readme');
for (const file of ['LICENSE', 'NOTICE', 'README.md']) cpSync(join(repo, file), join(pkg, file));

const size = (path) =>
  statSync(path).isDirectory() ? readdirSync(path).reduce((total, entry) => total + size(join(path, entry)), 0) : statSync(path).size;
for (const out of ['dist', 'drizzle', 'web']) step(`${out}/ ${(size(join(pkg, out)) / 1e6).toFixed(1)} MB`);
