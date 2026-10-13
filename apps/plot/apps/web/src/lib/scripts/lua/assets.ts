/**
 * wasmoon, fetched from our own origin the first time a chat's Lua runs.
 *
 * The sandbox has no network, so the page fetches both files and hands them
 * over the port (`sandbox.ts`). The `?url` imports make the bundler emit
 * wasmoon's own `dist` files unchanged as static assets and answer with their
 * addresses (the `turbopack.rules` entry in `next.config.ts`), so nothing of
 * wasmoon is in any page's bundle: this module is only ever imported
 * dynamically, by a chat whose plot carries Lua, and the files are fetched then.
 */

import wasmoonUrl from 'wasmoon/dist/index.js?url';
import glueUrl from 'wasmoon/dist/glue.wasm?url';
import type { LuaAssets } from './sandbox';

async function fetched(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url}: ${response.status}`);
  return response;
}

export async function loadLuaAssets(): Promise<LuaAssets> {
  const [source, wasm] = await Promise.all([
    fetched(wasmoonUrl).then((response) => response.text()),
    fetched(glueUrl).then((response) => response.arrayBuffer()),
  ]);
  return { wasmoon: source, wasm };
}
