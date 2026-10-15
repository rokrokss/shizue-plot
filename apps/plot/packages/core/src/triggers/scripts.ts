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
import type { LoreEntry, NormalizedCard, PlotModule } from '../types.js';

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
  /**
   * RisuAI's per-trigger `lowLevelAccess`, which its `runTrigger` sets on every
   * trigger before it runs: the character's flag on the character's own, the
   * module's on a module's. Set here only where a work's modules join the
   * card's (`cardScripts`); absent, the run's character decides. Never read off
   * card data — RisuAI overwrites whatever a stored trigger says.
   */
  readonly lowLevelAccess?: boolean;
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

const splitLoreKeys = (text: string): string[] =>
  text
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

/** An entry Lua's `upsertLocalLoreBook` made, in ours: keyed, or always on. */
export const loreFromRisu = (book: LuaLoreBook): LoreEntry => ({
  name: book.comment,
  keys: splitLoreKeys(book.key),
  secondaryKeys: splitLoreKeys(book.secondkey),
  selective: book.selective,
  content: book.content,
  enabled: true,
  constant: book.alwaysActive,
  insertionOrder: book.insertorder,
  caseSensitive: false,
  useRegex: book.useRegex,
  position: 'before_char',
});

/**
 * The chat's lore once `upsertLocalLoreBook` wrote `books` into it, in order —
 * RisuAI's chat `localLore`, where each upsert replaces the entries of its name
 * there and only there: the character's own book is a different list, and an
 * entry of the same name in it stays.
 */
export function upsertLocalLore(local: readonly LoreEntry[], books: readonly LuaLoreBook[]): LoreEntry[] {
  let lore = [...local];
  for (const book of books) {
    lore = lore.filter((entry) => (entry.name ?? '') !== book.comment);
    lore.push(loreFromRisu(book));
  }
  return lore;
}

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
 * A RisuAI `edittrans` regex script: run over a message's translation before it
 * is shown (`applyTranslationScripts`, RisuAI's `applyEdittransRegex`).
 */
export interface TranslationScript {
  readonly in: string;
  readonly out: string;
  readonly flag?: string;
  readonly ableFlag?: boolean;
}

function readTranslationScript(value: unknown): TranslationScript | null {
  if (!isRecord(value) || value['type'] !== 'edittrans') return null;
  const pattern = value['in'];
  if (typeof pattern !== 'string' || pattern === '') return null;
  const out = value['out'];
  const flag = value['flag'];
  return {
    in: pattern,
    out: typeof out === 'string' ? out : '',
    ...(typeof flag === 'string' ? { flag } : {}),
    ...(value['ableFlag'] === true ? { ableFlag: true } : {}),
  };
}

/**
 * The `edittrans` scripts a member's messages are translated through, in
 * RisuAI's sequence: the work's modules' first, then the card's own
 * (`applyEdittransRegex` reads `presetRegex`, `getModuleRegexScripts()`, then the
 * character's `customscript`). Kept apart from `cardScripts`: no runtime runs
 * them, and a card that carries only these is not a scripted card — it does not
 * become the member whose triggers a scene runs (`scriptedMember`).
 */
export function translationScriptsOf(
  card: Pick<NormalizedCard, 'extensions'>,
  modules: readonly Pick<PlotModule, 'regex'>[] = [],
): TranslationScript[] {
  const read = (list: unknown): TranslationScript[] =>
    Array.isArray(list) ? list.map(readTranslationScript).filter((script): script is TranslationScript => script !== null) : [];
  return [...modules.flatMap((module) => read(module.regex)), ...read(risuOf(card)?.['customScripts'])];
}

/** What a work's module brings to the scripts (`PlotModule`). */
export type ModuleScripts = Pick<PlotModule, 'regex' | 'trigger' | 'lowLevelAccess'>;

/** The triggers and edit scripts in RisuAI's two lists, read defensively. */
function readScripts(triggerscript: unknown, customScripts: unknown): { triggers: TriggerScript[]; editScripts: EditScript[] } {
  return {
    triggers: Array.isArray(triggerscript)
      ? triggerscript.map(readTrigger).filter((trigger): trigger is TriggerScript => trigger !== null)
      : [],
    editScripts: Array.isArray(customScripts)
      ? customScripts.map(readEditScript).filter((script): script is EditScript => script !== null)
      : [],
  };
}

/**
 * The scripts on one card, or null when it carries none the browser runs. A card
 * whose only triggers are empty shells (no effect at all) still counts: RisuAI
 * would loop over them, and a manual trigger with no effect is still a button
 * that does nothing rather than one that falls back to filling the composer.
 *
 * The work's `modules` run after the card's own, as RisuAI's `runTrigger`
 * concatenates `char.triggerscript` and `getModuleTriggers()` and its
 * `processScript` the character's `customscript` and `getModuleRegexScripts()`.
 * Where they bring any, every trigger carries its own `lowLevelAccess` — the
 * card's on its own, the module's on the module's, as RisuAI's `runTrigger`
 * marks them — and the whole is `lowLevelAccess` where any trigger is. A gate
 * holds a call to the trigger that made it (`triggerLowLevelAccess`); the whole
 * only says whether anything here may ask at all.
 */
export function cardScripts(
  card: Pick<NormalizedCard, 'extensions'>,
  modules: readonly ModuleScripts[] = [],
): CardScripts | null {
  const risu = risuOf(card);
  const own = readScripts(risu?.['triggerscript'], risu?.['customScripts']);
  const ownAccess = risu?.['lowLevelAccess'] === true;
  const added = modules
    .map((module) => ({ ...readScripts(module.trigger, module.regex), lowLevelAccess: module.lowLevelAccess === true }))
    .filter((read) => read.triggers.length > 0 || read.editScripts.length > 0);
  if (added.length === 0) {
    if (own.triggers.length === 0 && own.editScripts.length === 0) return null;
    return { ...own, lowLevelAccess: ownAccess };
  }
  const marked = (triggers: TriggerScript[], lowLevelAccess: boolean): TriggerScript[] =>
    triggers.map((trigger) => ({ ...trigger, lowLevelAccess }));
  return {
    triggers: [...marked(own.triggers, ownAccess), ...added.flatMap((read) => marked(read.triggers, read.lowLevelAccess))],
    editScripts: [...own.editScripts, ...added.flatMap((read) => read.editScripts)],
    lowLevelAccess: ownAccess || added.some((read) => read.lowLevelAccess && read.triggers.length > 0),
  };
}

/**
 * Whether the trigger at `index` of a bundle's list may use what RisuAI keeps
 * behind `lowLevelAccess` — its own flag (`TriggerScript.lowLevelAccess`: the
 * card's on the card's triggers, a module's on the module's), as RisuAI holds
 * each run to the trigger it runs (`runLuaButtonTrigger`, `runTrigger`), never
 * to "any trigger". Where no module joined the card no trigger carries a flag,
 * and the card's own decides. A call that names no trigger (`index` undefined)
 * is held to the card alone, which only a bundle without modules can say.
 */
export function triggerLowLevelAccess(scripts: CardScripts, index: number | undefined): boolean {
  const unmarked = scripts.triggers.every((trigger) => trigger.lowLevelAccess === undefined);
  if (index === undefined) return unmarked && scripts.lowLevelAccess;
  const trigger = Number.isInteger(index) && index >= 0 ? scripts.triggers[index] : undefined;
  if (!trigger) return false;
  return trigger.lowLevelAccess ?? scripts.lowLevelAccess;
}

/** Whether a card — with the work's modules — carries anything the reader's browser would run. */
export const carriesScripts = (card: Pick<NormalizedCard, 'extensions'>, modules: readonly ModuleScripts[] = []): boolean =>
  cardScripts(card, modules) !== null;

/**
 * The member whose scripts a chat runs: the first in roster order that carries
 * any. RisuAI runs one character's triggers — the one the chat is with — and a
 * plot with several imported members has no single answer to "which character
 * is this", so the roster's order, which already decides whose card stands in
 * for the work in the prompt, decides this too. A work's modules are every
 * member's, so where they carry scripts that is the first member.
 */
export function scriptedMember<T extends { card: Pick<NormalizedCard, 'extensions'> }>(
  members: readonly T[],
  modules: readonly ModuleScripts[] = [],
): { member: T; scripts: CardScripts } | null {
  for (const member of members) {
    const scripts = cardScripts(member.card, modules);
    if (scripts) return { member, scripts };
  }
  return null;
}
