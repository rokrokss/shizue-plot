/**
 * RisuAI's `risuChatParser(text, { chara })` as a card's Lua reaches it — through
 * `cbs()`, `getPersonaDescription`, `getLoreBooks` and `loadLoreBooks`
 * (`runScripted` in its `process/scriptings.ts`) — on the core evaluator, with
 * the host a trigger's text gets (`evaluateScriptCbs`), over what the call holds.
 *
 * RisuAI's `cbs()` answers at once, and cards call it from plain functions,
 * outside the `async` coroutine where anything could wait for the page. So the
 * evaluator goes into the Lua worker with wasmoon: this module is the entry
 * `scripts/build-lua-cbs.mjs` bundles into one script (`@shizue/core/lua-cbs`),
 * which `luaWorkerSource` puts in front of the runtime. Nothing in `src` imports
 * what that build produces; the runtime is handed it.
 */

import type { CbsChat } from '../cbs.js';
import { evaluateScriptCbs } from '../triggers/cbsHost.js';
import type { CodeCbsData } from '../triggers/interpreter.js';

/** `CodeCbsData` made plain for the trip into the worker: the clock's `now` in ms. */
export type LuaCbsData = Omit<CodeCbsData, 'clock'> & {
  clock?: { now: number; timeZone: string; locale: string };
};

/** The call as the worker holds it (`context` in `runtime.ts`): its state as the script has left it so far. */
export interface LuaCbsCall {
  vars: ReadonlyMap<string, string>;
  globals: ReadonlyMap<string, string>;
  char: { name: string; nickname: string; description: string; firstMessage: string };
  /** The character's book and the chat's, in RisuAI's shape. */
  lore: readonly object[];
  localLore: readonly object[];
  user: string;
  persona: string;
  messages: readonly { role: string; data: string; time?: number }[];
  cbs?: LuaCbsData | null;
}

/**
 * `text` as RisuAI's Lua `cbs` answers it. `{{getvar}}` reads the variables as
 * the script has left them so far, `{{char}}` the name a `setName` gave, and the
 * chat functions the chat as the script has it, at index -1 as RisuAI parses
 * it; `{{trigger_id}}` answers `null` outside a manual run. Throws past the
 * evaluator's limit (`ScriptCbsLimit`), which the worker catches.
 */
export function luaCbs(text: unknown, call: LuaCbsCall): string {
  const { clock, character, ...data }: LuaCbsData = call.cbs ?? {};
  const chat = (): CbsChat => ({
    messages: call.messages.map((message) => ({
      role: message.role === 'user' ? 'user' : 'char',
      data: message.data,
      ...(message.time ? { time: message.time } : {}),
    })),
    offset: 0,
    length: call.messages.length,
    index: -1,
    ...(call.char.firstMessage ? { greeting: { text: call.char.firstMessage, index: -1 } } : {}),
  });
  return evaluateScriptCbs(text, {
    variable: (name) => call.vars.get(name),
    globalVariable: (name) => call.globals.get(name),
    data: {
      ...data,
      ...(clock ? { clock: { now: new Date(clock.now), timeZone: clock.timeZone, locale: clock.locale } } : {}),
      user: call.user,
      char: call.char.nickname || call.char.name,
      character: { ...character, description: call.char.description },
      persona: call.persona,
      chat,
      lorebook: () => [...call.lore, ...call.localLore],
      triggerId: data.triggerId ?? null,
    },
  });
}
