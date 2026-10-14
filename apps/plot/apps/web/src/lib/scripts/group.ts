/**
 * The card scripts of a work of several members, routed: each member that
 * carries scripts has its own runtime (`runtime.ts`), and every moment of a
 * chat goes to the runtime it belongs to.
 *
 * - A send's input triggers and `editinput` scripts run for every member on the
 *   stage that carries any, in roster order, each on what the one before left;
 *   then the speaker's start triggers (`prepareGroupSend`).
 * - Start, output and `editoutput` are the speaker's; display triggers, Lua's
 *   `editDisplay` and a message's buttons are those of the member whose message
 *   it is (`runtimeOf`).
 * - Slash commands, `/trigger` and `/multisend` are the lead's — the first
 *   member that carries scripts, whose runtime ran everything before a work had
 *   one per member.
 *
 * Messages no member is the speaker of — the reader's, a greeting, a narration,
 * a scene written before group turns — are the work's, and run the lead's
 * scripts. A member's own replies run its own scripts or none, the first member
 * no differently from the rest: as in RisuAI, whose start, output and request
 * triggers are the speaking character's, and as the server's request triggers
 * are (`requestScriptsOf`).
 */

import { NARRATOR_SPEAKER } from '@shizue/core/group';
import type { PreparedGeneration, PrepareOptions, ScriptRuntime, ScriptView } from './runtime';

export interface ScriptCast {
  /** Each scripted member's runtime, by member id, in roster order. */
  byMember: ReadonlyMap<string, ScriptRuntime>;
  /** The lead's: the first member that carries scripts. */
  lead: ScriptRuntime;
}

/**
 * Whose scripts a member's message or turn runs: its own, or — for no member at
 * all (`null`, the narrator) — the lead's. Null for a member with no scripts.
 */
export function runtimeOf(cast: ScriptCast, memberId: string | null | undefined): ScriptRuntime | null {
  if (memberId === null || memberId === undefined || memberId === NARRATOR_SPEAKER) return cast.lead;
  return cast.byMember.get(memberId) ?? null;
}

/**
 * A send in a work of several members: every scripted member on the stage
 * (`stage`, member ids) takes its input pass in roster order on one chain; then
 * `pick` names the speaker from the turn as those passes left it — the stored
 * text the round answers — and the speaker's start pass builds the body. A
 * speaker with no scripts of its own runs no start and owes no output pass; the
 * lead's runtime measures the body for it. `pick` answering null (no one to ask)
 * sends the turn as the scene, the lead's.
 */
export async function prepareGroupSend(
  cast: ScriptCast,
  view: ScriptView,
  content: string,
  options: PrepareOptions | undefined,
  { stage, pick }: { stage: readonly string[]; pick: (text: string) => string | null },
): Promise<{ prepared: PreparedGeneration; speakerId: string | null }> {
  const onStage = new Set(stage);
  const inputs = [...cast.byMember].filter(([memberId]) => onStage.has(memberId)).map(([, runtime]) => runtime);
  let chain = (inputs[0] ?? cast.lead).beginSend(view, content, options);
  for (const runtime of inputs) chain = await runtime.input(chain);
  const speakerId = pick(chain.text);
  const speaker = runtimeOf(cast, speakerId);
  const prepared = speaker ? await speaker.startSend(chain) : await cast.lead.startSend(chain, { triggers: false });
  return { prepared, speakerId };
}

/**
 * The display listeners of every runtime over the messages that are theirs,
 * one pass per runtime: `items` carry the member whose message each is. What
 * comes back is every runtime's answer, by message id.
 */
export async function groupDisplayEdits(
  cast: ScriptCast,
  items: readonly { id: string; text: string; memberId: string | null }[],
  run: (runtime: ScriptRuntime, items: readonly { id: string; text: string }[]) => Promise<Map<string, string>>,
): Promise<Map<string, string>> {
  const byRuntime = new Map<ScriptRuntime, { id: string; text: string }[]>();
  for (const item of items) {
    const runtime = runtimeOf(cast, item.memberId);
    if (!runtime?.editsDisplay) continue;
    const list = byRuntime.get(runtime) ?? [];
    list.push({ id: item.id, text: item.text });
    byRuntime.set(runtime, list);
  }
  const shown = new Map<string, string>();
  const answers = await Promise.all([...byRuntime].map(([runtime, list]) => run(runtime, list)));
  for (const answer of answers) for (const [id, text] of answer) shown.set(id, text);
  return shown;
}
