/**
 * Where a second script language plugs into the chat's script runtime.
 *
 * RisuAI runs Lua in four places, and the runtime leaves a seat at each:
 *
 * - **In a trigger list.** A trigger whose first effect is `triggerlua` runs in
 *   every mode, at its place among the other triggers, and its code sees the
 *   run's variables and chat. The interpreter yields it as a `code` request in
 *   order (`TriggerRequest` in `@shizue/core/triggers`) and the runtime hands it
 *   to `runCode` — so a Lua trigger between two v2 triggers runs between them.
 * - **Before the regex scripts.** RisuAI's `editInput`/`editOutput` listeners
 *   rewrite the text first (`runLuaEditTrigger`); `edit` is that.
 * - **While a message is drawn.** The `editDisplay` listeners rewrite what the
 *   screen shows, before the display triggers; `display` is that, for several
 *   messages at once, and what it writes is the screen's alone.
 * - **On a `risu-btn` click** (`onButtonClick`); `button` is that. A
 *   `risu-trigger` click is a manual trigger run, and goes to the interpreter.
 *
 * Outside a trigger run the runtime builds the `CodeScope` itself — the chat
 * as the moment has it — and keeps what the engine wrote through it, exactly as
 * a trigger run keeps a code effect's writes. `handles` keeps a plot whose
 * scripts never act at a moment from paying for it: no reply is held pending for
 * an output hook a card does not have.
 *
 * The Lua engine (`lua/engine.ts`) is the one engine there is.
 */

import type { CodeScope, TriggerRequest } from '@shizue/core/triggers';

export type EditPhase = 'editinput' | 'editoutput' | 'editdisplay';

/** The moments a script can act at, for `handles`. */
export type ScriptPhase = 'input' | 'start' | 'output' | 'manual' | 'display' | EditPhase | 'button';

export type CodeRequest = Extract<TriggerRequest, { kind: 'code' }>;

export interface ScriptEngine {
  name: string;
  /** Whether this engine has anything to run at `phase` for the plot it was built for. */
  handles(phase: ScriptPhase): boolean;
  /** A code effect, at its place in a trigger run. */
  runCode?(request: CodeRequest): Promise<{ stopSending?: boolean } | void>;
  /** RisuAI's edit listeners: the text before the regex scripts see it. */
  edit?(phase: Exclude<EditPhase, 'editdisplay'>, text: string, meta: { chatIndex: number }, scope: CodeScope): Promise<string>;
  /** The display listeners over several messages: their texts as the screen should show them, in order. */
  display?(items: readonly { text: string; chatIndex: number }[], scope: CodeScope): Promise<string[]>;
  /** A `risu-btn` click, with the attribute's value. */
  button?(data: string, scope: CodeScope): Promise<void>;
  /** Names a manual run would find something to call by — for a `{{button}}` to name. */
  manualNames?(): readonly string[];
  /** Ends whatever the engine keeps running. */
  dispose?(): void;
}
