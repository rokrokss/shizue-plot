/**
 * Where a second script language plugs into the chat's script runtime.
 *
 * RisuAI runs Lua in three places, and the runtime leaves a seat at each:
 *
 * - **In a trigger list.** A trigger whose first effect is `triggerlua` runs in
 *   every mode, at its place among the other triggers, and its code sees the
 *   run's variables and chat. The interpreter yields it as a `code` request in
 *   order (`TriggerRequest` in `@shizue/core/triggers`) and the runtime hands it
 *   to `runCode` — so a Lua trigger between two v2 triggers runs between them.
 * - **Before the regex scripts.** RisuAI's `editInput`/`editOutput`/`editDisplay`
 *   listeners rewrite the text first (`runLuaEditTrigger`); `edit` is that.
 * - **On a `risu-btn` click** (`onButtonClick`); `button` is that. A
 *   `risu-trigger` click is a manual trigger run, and goes to the interpreter.
 *
 * No engine is installed in this wave: every one of these is a no-op that the
 * runtime logs, and `handles` keeps a plot whose only scripts are Lua from
 * holding its replies pending for an engine that is not there.
 */

import type { TriggerRequest } from '@shizue/core/triggers';

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
  edit?(phase: EditPhase, text: string, meta: { chatIndex: number }): Promise<string>;
  /** A `risu-btn` click, with the attribute's value. */
  button?(data: string): Promise<void>;
}
