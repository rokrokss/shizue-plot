/**
 * The scripts a RisuAI card carries, read off the card as the import left it.
 *
 * RisuAI keeps two kinds of script on a character, both under
 * `extensions.risuai`: `triggerscript`, a list of triggers (`{comment, type,
 * conditions, effect}` — the v1 effects and the v2 block language alike), and
 * `customScripts`, regex scripts whose `type` says when they run. Of the regex
 * scripts, `editdisplay` became our display scripts at import (`card/risu.ts`)
 * and `editprocess` is the prompt's; the two read here are `editinput`, which
 * rewrites what the reader sends, and `editoutput`, which rewrites what the
 * model wrote before it is stored. A module (`.risum`) merged into the card at
 * import lands in the same two fields (`card/risum.ts`).
 *
 * Nothing is copied out at import: the card keeps its extensions verbatim, and
 * these readers take what the runtime needs when a chat asks for it. A card
 * imported before the runtime existed therefore plays its scripts too.
 *
 * Card data is a stranger's JSON, so every reader here is defensive: a trigger
 * whose mode is not one RisuAI has, an effect without a `type`, a regex script
 * without a pattern — each is dropped rather than trusted, and nothing throws.
 */

import type { LuaLoreBook } from '../lua/runtime.js';
import type { LoreEntry, NormalizedCard } from '../types.js';

/** When a trigger runs, in RisuAI's words. */
export type TriggerMode = 'start' | 'manual' | 'output' | 'input' | 'display' | 'request';

export const TRIGGER_MODES: readonly TriggerMode[] = ['start', 'manual', 'output', 'input', 'display', 'request'];

/**
 * A condition or an effect as the card wrote it. The fields differ by `type` —
 * ninety-odd shapes, every one of them read through the accessors in the
 * interpreter, which treat a missing field the way RisuAI's code would meet it.
 */
export interface TriggerStep {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface TriggerScript {
  /** The trigger's name: what a manual run and `{{button}}` call it by. */
  readonly comment: string;
  readonly type: TriggerMode;
  readonly conditions: readonly TriggerStep[];
  readonly effect: readonly TriggerStep[];
}

/** The effect types that hold code for another language rather than steps. */
export const CODE_EFFECTS: readonly string[] = ['triggerlua', 'triggercode'];

/** Whether a trigger is a code trigger: one RisuAI runs in every mode, for its code to decide. */
export const isCodeTrigger = (trigger: TriggerScript): boolean =>
  CODE_EFFECTS.includes(trigger.effect[0]?.type ?? '');

/** The Lua scripts on a card, in trigger order: each trigger whose first effect is `triggerlua`. */
export function luaScriptsOf(triggers: readonly TriggerScript[]): string[] {
  return triggers.flatMap((trigger) => {
    const first = trigger.effect[0];
    if (first?.type !== 'triggerlua') return [];
    const code = first['code'];
    return [typeof code === 'string' ? code : ''];
  });
}

/** A lore entry in RisuAI's shape, as Lua's `getLoreBooks` answers. */
export const risuLore = (entry: LoreEntry): LuaLoreBook => ({
  key: entry.keys.join(', '),
  secondkey: entry.secondaryKeys.join(', '),
  insertorder: entry.insertionOrder,
  comment: entry.name ?? '',
  content: entry.content,
  mode: 'normal',
  alwaysActive: entry.constant,
  selective: entry.selective,
  useRegex: entry.useRegex,
});

/** When a regex script runs. Only the two the reader's browser runs are kept. */
export type EditScriptType = 'editinput' | 'editoutput';

/** A RisuAI regex script (`customscript`) of one of those two types. */
export interface EditScript {
  readonly type: EditScriptType;
  /** The pattern's source. A script with an empty one never runs, as in RisuAI. */
  readonly in: string;
  /** The replacement, or an `@@` directive followed by one. */
  readonly out: string;
  /** Regex flags with `<…>` directives mixed in — read only when `ableFlag` is on. */
  readonly flag?: string;
  readonly ableFlag?: boolean;
}

/** What one card carries for the browser to run. */
export interface CardScripts {
  triggers: TriggerScript[];
  editScripts: EditScript[];
  /**
   * RisuAI's `lowLevelAccess`: the card may use the effects RisuAI keeps behind
   * a consent at import — alerts and regex extraction in v1, an extra model turn,
   * and unbounded trigger recursion.
   */
  lowLevelAccess: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const risuOf = (card: Pick<NormalizedCard, 'extensions'>): Record<string, unknown> | null => {
  const risu = card.extensions?.['risuai'];
  return isRecord(risu) ? risu : null;
};

const steps = (value: unknown): TriggerStep[] =>
  Array.isArray(value)
    ? value.filter((step): step is TriggerStep => isRecord(step) && typeof step['type'] === 'string')
    : [];

/** One trigger as RisuAI would run it, or null for one it could not. */
function readTrigger(value: unknown): TriggerScript | null {
  if (!isRecord(value)) return null;
  const type = value['type'];
  if (typeof type !== 'string' || !(TRIGGER_MODES as readonly string[]).includes(type)) return null;
  return {
    comment: typeof value['comment'] === 'string' ? value['comment'] : '',
    type: type as TriggerMode,
    conditions: steps(value['conditions']),
    effect: steps(value['effect']),
  };
}

function readEditScript(value: unknown): EditScript | null {
  if (!isRecord(value)) return null;
  const type = value['type'];
  if (type !== 'editinput' && type !== 'editoutput') return null;
  const pattern = value['in'];
  if (typeof pattern !== 'string' || pattern === '') return null;
  const out = value['out'];
  const flag = value['flag'];
  return {
    type,
    in: pattern,
    out: typeof out === 'string' ? out : '',
    ...(typeof flag === 'string' ? { flag } : {}),
    ...(value['ableFlag'] === true ? { ableFlag: true } : {}),
  };
}

/**
 * The scripts on one card, or null when it carries none the browser runs. A card
 * whose only triggers are empty shells (no effect at all) still counts: RisuAI
 * would loop over them, and a manual trigger with no effect is still a button
 * that does nothing rather than one that falls back to filling the composer.
 */
export function cardScripts(card: Pick<NormalizedCard, 'extensions'>): CardScripts | null {
  const risu = risuOf(card);
  if (!risu) return null;
  const triggers = Array.isArray(risu['triggerscript'])
    ? risu['triggerscript'].map(readTrigger).filter((trigger): trigger is TriggerScript => trigger !== null)
    : [];
  const editScripts = Array.isArray(risu['customScripts'])
    ? risu['customScripts'].map(readEditScript).filter((script): script is EditScript => script !== null)
    : [];
  if (triggers.length === 0 && editScripts.length === 0) return null;
  return { triggers, editScripts, lowLevelAccess: risu['lowLevelAccess'] === true };
}

/** Whether a card carries anything the reader's browser would run. */
export const carriesScripts = (card: Pick<NormalizedCard, 'extensions'>): boolean => cardScripts(card) !== null;

/**
 * The member whose scripts a chat runs: the first in roster order that carries
 * any. RisuAI runs one character's triggers — the one the chat is with — and a
 * plot with several imported members has no single answer to "which character
 * is this", so the roster's order, which already decides whose card stands in
 * for the work in the prompt, decides this too.
 */
export function scriptedMember<T extends { card: Pick<NormalizedCard, 'extensions'> }>(
  members: readonly T[],
): { member: T; scripts: CardScripts } | null {
  for (const member of members) {
    const scripts = cardScripts(member.card);
    if (scripts) return { member, scripts };
  }
  return null;
}
