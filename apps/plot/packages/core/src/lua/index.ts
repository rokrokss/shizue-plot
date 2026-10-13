/**
 * A card's Lua, as the reader's browser and the API both run it: RisuAI's
 * prelude (`prelude.ts`) and the worker program over it (`runtime.ts`). Kept out
 * of `@shizue/core/triggers` so the web loads it only when a chat's scripts
 * first reach Lua.
 */

export * from './runtime.js';
export { JSON_LUA, LUA_WRAPPER } from './prelude.js';
