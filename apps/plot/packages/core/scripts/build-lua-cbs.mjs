// The CBS evaluator a card's Lua reaches through `cbs()` (`src/lua/cbsEngine.ts`),
// bundled into one expression for the Lua worker. The worker is text
// (`luaWorkerSource`), so the evaluator has to be text too: this writes it to
// `dist/lua/cbsEngineSource.js` as `LUA_CBS_ENGINE`, exported as
// `@shizue/core/lua-cbs`, which the web's sandbox and the API's Lua child hand
// to `luaWorkerSource`. Run by `build`, after `tsc`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GLOBAL = 'shizueLuaCbs';

const result = await build({
  entryPoints: [join(root, 'src/lua/cbsEngine.ts')],
  bundle: true,
  format: 'iife',
  globalName: GLOBAL,
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  write: false,
});

// Wrapped so the global stays the expression's own, whatever scope it lands in.
const expression = `(function () {\n${result.outputFiles[0].text}\nreturn ${GLOBAL};\n})()`;
const out = join(root, 'dist/lua');
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, 'cbsEngineSource.js'),
  `/** The CBS evaluator for the Lua worker, as one expression (scripts/build-lua-cbs.mjs). */\nexport const LUA_CBS_ENGINE = ${JSON.stringify(expression)};\n`,
);
writeFileSync(
  join(out, 'cbsEngineSource.d.ts'),
  '/** The CBS evaluator for the Lua worker, as one expression (scripts/build-lua-cbs.mjs). */\nexport declare const LUA_CBS_ENGINE: string;\n',
);
