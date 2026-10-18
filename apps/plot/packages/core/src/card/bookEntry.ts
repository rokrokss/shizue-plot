/**
 * One lorebook entry between the file formats and `LoreEntry`, both ways.
 *
 * Three places can say the same thing about an entry, and they are read in this
 * order: a V3 decorator at the head of its content, SillyTavern's per-entry
 * `extensions` (ST writes the whole set on every entry it exports), and the
 * entry's own CCv3 fields. A World Info file is the ST set under other names.
 *
 * Dependency-free, so `@shizue/core/world-info` can carry it into the web bundle.
 */

import {
  LORE_TRIGGERS,
  type LoreCharacterFilter,
  type LoreEntry,
  type LoreMatchSource,
  type LorePosition,
  type LoreRole,
  type LoreSelectiveLogic,
  type LoreTrigger,
  type RisuLoreInjection,
  type RisuLoreOptions,
} from '../types.js';

/** RisuAI's placements, of which an entry has one (`pos` in `loadLoreBookV3Prompt`): whichever decorator set it last. */
export type RisuLorePos =
  | 'depth'
  | 'reverse_depth'
  | 'before_desc'
  | 'after_desc'
  | 'personality'
  | 'scenario'
  | `pt_${string}`;

/** The decorators RisuAI's lorebook reads (`loadLoreBookV3Prompt`), as read off an entry's content. */
export interface LoreDecorators {
  constant?: boolean;
  /**
   * RisuAI's one placement: `@@depth N`, `@@reverse_depth N`, `@@end` (depth 0)
   * and `@@position …` each set it, so the last of them stands.
   */
  pos?: RisuLorePos;
  /** The depth `@@depth`, `@@reverse_depth` or `@@end` set. */
  depth?: number;
  role?: LoreRole;
  /** `@@activate_only_after N`. */
  delay?: number;
  /** `@@activate_only_every N`. */
  every?: number;
  /** `@@scan_depth N`. */
  scanDepth?: number;
  /** `@@is_greeting N`. */
  greeting?: number;
  /** `@@keep_activate_after_match`. */
  sticky?: number;
  /** `@@dont_activate_after_match`. */
  cooldown?: number;
  /** `@@probability N`, clamped to 0–100. */
  probability?: number;
  /** `@@priority N`, or `@@ignore_on_max_context` (-1000). */
  priority?: number;
  /** `@@activate` or `@@dont_activate`, whichever comes last. */
  force?: 'activate' | 'deactivate';
  /** `@@additional_keys a,b`, one list per line, case kept. */
  additionalKeys?: string[][];
  /** `@@exclude_keys a,b`, every line's keys together, case kept. */
  excludeKeys?: string[];
  /** `@@exclude_keys_all a,b`, every line's keys together, case kept. */
  excludeAllKeys?: string[];
  /** `@@recursive` (true) or `@@unrecursive` (false), whichever comes last. */
  recursive?: boolean;
  /** `@@no_recursive_search`. */
  noRecursiveSearch?: true;
  /** `@@match_full_word` (true) or `@@match_partial_word` (false), whichever comes last. */
  fullWord?: boolean;
  /** `@@inject_lore`, `@@inject_at`, `@@inject_replace`, `@@inject_prepend`, built up as RisuAI builds its `inject`. */
  inject?: RisuLoreInjection;
}

/**
 * What "for the rest of the chat" becomes for the two decorators that have no
 * number of their own: longer than any chat, and still a plain sticky/cooldown.
 * The API's lore coercion caps both at this, so a saved entry keeps it; the
 * export reads anything at or above it back out as the decorator.
 */
export const FOREVER_MESSAGES = 10000;

/** RisuAI's `parseInt`, refusing what it reads as NaN and, where a count is meant, a negative. */
const count = (arg: string | undefined): number | undefined => {
  const value = Number.parseInt(arg ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

/** The placements `@@position` takes besides a prompt template's `pt_` slots. */
const RISU_POSITIONS: readonly string[] = ['after_desc', 'before_desc', 'personality', 'scenario'];

/**
 * Splits the leading decorator lines of a lorebook entry off its content, the
 * way RisuAI's lorebook does: ccardlib's `decorator.parse` walks the trimmed
 * content's lines while they start with `@@`, names each by what follows `@@` up
 * to the first space and splits the rest on commas, and hands it to the
 * lorebook's switch (`loadLoreBookV3Prompt`) — whose `false`, for a decorator it
 * does not know or an argument it cannot read, lets the next `@@@` line (a
 * fallback) be read in its place; any other `@@@` line is skipped, and `@@@end`
 * is `@@end` always. The body is the rest, trimmed.
 *
 * Every decorator RisuAI's lorebook reads is read here. `@@disable_ui_prompt`
 * is read and does nothing, as there (RisuAI collects it and never uses it), and
 * so are the instruct-mode decorators and `@@is_user_icon`, which RisuAI refuses.
 * The key decorators may repeat, and RisuAI applies every line: its own import
 * of a SillyTavern entry writes NOT_ANY and AND_ALL as one `@@exclude_keys` or
 * `@@additional_keys` line per key. Of the rest, the last line wins.
 */
export function parseDecorators(content: string): { decorators: LoreDecorators; body: string } {
  const lines = content.trim().split('\n');
  const decorators: LoreDecorators = {};
  /** RisuAI's switch: false where it does not take the decorator. */
  const read = (name: string, args: string[]): boolean => {
    const first = args[0];
    switch (name) {
      case 'constant':
        decorators.constant = true;
        return true;
      case 'end':
        decorators.pos = 'depth';
        decorators.depth = 0;
        return true;
      case 'activate_only_after': {
        const delay = count(first);
        if (delay === undefined) return false;
        decorators.delay = delay;
        return true;
      }
      case 'activate_only_every': {
        const every = count(first);
        if (every === undefined) return false;
        decorators.every = every;
        return true;
      }
      // Both set their flag and still answer false, as RisuAI's do.
      case 'keep_activate_after_match':
        decorators.sticky = FOREVER_MESSAGES;
        return false;
      case 'dont_activate_after_match':
        decorators.cooldown = FOREVER_MESSAGES;
        return false;
      case 'depth':
      case 'reverse_depth': {
        const depth = count(first);
        if (depth === undefined) return false;
        decorators.depth = depth;
        decorators.pos = name;
        return true;
      }
      case 'role':
        if (first !== 'user' && first !== 'assistant' && first !== 'system') return false;
        decorators.role = first;
        return true;
      case 'scan_depth': {
        const scanDepth = count(first);
        if (scanDepth !== undefined) decorators.scanDepth = scanDepth;
        return true;
      }
      case 'is_greeting': {
        const greeting = count(first);
        if (greeting === undefined) return false;
        decorators.greeting = greeting;
        return true;
      }
      case 'position':
        if (first === undefined || !(first.startsWith('pt_') || RISU_POSITIONS.includes(first))) return false;
        decorators.pos = first as RisuLorePos;
        return true;
      case 'inject_lore':
      case 'inject_at':
        decorators.inject = {
          ...(decorators.inject ?? { operation: 'append', param: '' }),
          location: args.join(' '),
          lore: name === 'inject_lore',
        };
        return true;
      case 'inject_replace':
      case 'inject_prepend':
        decorators.inject = {
          ...(decorators.inject ?? { location: '', lore: false }),
          operation: name === 'inject_replace' ? 'replace' : 'prepend',
          param: args.join(' '),
        };
        return true;
      case 'ignore_on_max_context':
        decorators.priority = -1000;
        return true;
      case 'additional_keys':
        if (args.length > 0) decorators.additionalKeys = [...(decorators.additionalKeys ?? []), args];
        return true;
      case 'exclude_keys':
        if (args.length > 0) decorators.excludeKeys = [...(decorators.excludeKeys ?? []), ...args];
        return true;
      case 'exclude_keys_all':
        if (args.length > 0) decorators.excludeAllKeys = [...(decorators.excludeAllKeys ?? []), ...args];
        return true;
      case 'match_full_word':
        decorators.fullWord = true;
        return true;
      case 'match_partial_word':
        decorators.fullWord = false;
        return true;
      case 'activate':
        decorators.force = 'activate';
        return true;
      case 'dont_activate':
        decorators.force = 'deactivate';
        return true;
      case 'disable_ui_prompt':
        return first === 'post_history_instructions' || first === 'system_prompt';
      case 'probability': {
        // RisuAI drops the entry when a roll of 0–100 exceeds N, so anything
        // under 0 never fires and anything from 100 always does.
        const chance = Number.parseInt(first ?? '', 10);
        if (Number.isFinite(chance)) decorators.probability = Math.min(100, Math.max(0, chance));
        return true;
      }
      case 'priority': {
        const priority = Number.parseInt(first ?? '', 10);
        if (Number.isFinite(priority)) decorators.priority = priority;
        return true;
      }
      case 'unrecursive':
        decorators.recursive = false;
        return true;
      case 'recursive':
        decorators.recursive = true;
        return true;
      case 'no_recursive_search':
        decorators.noRecursiveSearch = true;
        return true;
      default:
        return false;
    }
  };
  let fallback = false;
  for (let at = 0; at < lines.length; at += 1) {
    let line = lines[at]!.trim();
    if (line === '@@@end') line = '@@end';
    if (!line.startsWith('@@')) return { decorators, body: lines.slice(at).join('\n').trim() };
    const fallbackLine = line.startsWith('@@@');
    if (fallbackLine && !fallback) continue;
    const space = line.indexOf(' ');
    const end = space === -1 ? line.length : space;
    const name = line.slice(fallbackLine ? 3 : 2, end);
    const args = line
      .slice(end)
      .split(',')
      .map((arg) => arg.trim())
      .filter((arg) => arg !== '');
    fallback = name !== '' ? !read(name, args) : false;
  }
  return { decorators, body: '' };
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const wholeCount = (value: unknown): number | undefined => {
  const number = finite(value);
  return number !== undefined && number >= 0 ? Math.floor(number) : undefined;
};
const boolOf = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;
/** The first of these that says anything, as an entry's label. */
const labelOf = (...values: unknown[]): { name?: string } => {
  const name = values.map((value) => (typeof value === 'string' ? value.trim() : '')).find(Boolean);
  return name ? { name } : {};
};

/* ------------------------------------------------- SillyTavern's own terms */

/** `world_info_logic` in ST's `world-info.js`. */
const ST_LOGIC: Record<number, LoreSelectiveLogic> = {
  0: 'and_any',
  1: 'not_all',
  2: 'not_any',
  3: 'and_all',
};
const ST_LOGIC_NUMBER: Record<LoreSelectiveLogic, number> = {
  and_any: 0,
  not_all: 1,
  not_any: 2,
  and_all: 3,
};

/**
 * `world_info_position`, as `LorePosition`: 0 before and 1 after the character,
 * 2 and 3 around the author's note, 5 and 6 around the example dialogue, and 7
 * an outlet. 4 is at a depth, which is `LoreEntry.depth` rather than a position.
 */
const ST_POSITIONS: Record<number, LorePosition> = {
  0: 'before_char',
  1: 'after_char',
  2: 'before_author_note',
  3: 'after_author_note',
  5: 'before_examples',
  6: 'after_examples',
  7: 'outlet',
};
const ST_POSITION_NUMBER: Record<LorePosition, number> = {
  before_char: 0,
  after_char: 1,
  before_author_note: 2,
  after_author_note: 3,
  before_examples: 5,
  after_examples: 6,
  outlet: 7,
};
const ST_AT_DEPTH = 4;
/** ST's `DEFAULT_DEPTH`, which is also the depth an at-depth entry with none gets. */
const ST_DEFAULT_DEPTH = 4;
const ST_DEFAULT_WEIGHT = 100;

/** `extension_prompt_roles`: 0 system, 1 user, 2 assistant. */
const ST_ROLES: readonly LoreRole[] = ['system', 'user', 'assistant'];

/**
 * A role in ST's terms: the number an entry carries, or the word a character's
 * note carries (`getExtensionPromptRoleByName` takes both). System is ST's
 * default and the prompt's, so it reads back as no role at all.
 */
export function roleFromSillyTavern(value: unknown): LoreRole | undefined {
  const role =
    typeof value === 'number' ? ST_ROLES[value] : ST_ROLES.find((name) => name === value);
  return role === 'system' ? undefined : role;
}

/** ST's per-entry settings under one set of names (its World Info files use these). */
export interface SillyTavernFields {
  position?: unknown;
  depth?: unknown;
  role?: unknown;
  selectiveLogic?: unknown;
  probability?: unknown;
  useProbability?: unknown;
  group?: unknown;
  groupWeight?: unknown;
  scanDepth?: unknown;
  sticky?: unknown;
  cooldown?: unknown;
  delay?: unknown;
  outletName?: unknown;
  vectorized?: unknown;
  ignoreBudget?: unknown;
  preventRecursion?: unknown;
  excludeRecursion?: unknown;
  delayUntilRecursion?: unknown;
  groupOverride?: unknown;
  useGroupScoring?: unknown;
  matchWholeWords?: unknown;
  matchPersonaDescription?: unknown;
  matchCharacterDescription?: unknown;
  matchCharacterPersonality?: unknown;
  matchCharacterDepthPrompt?: unknown;
  matchScenario?: unknown;
  matchCreatorNotes?: unknown;
  triggers?: unknown;
}

/** ST's `match*` flags, each with the scan text it adds (`LoreEntry.matchSources`). */
const ST_MATCH_FLAGS: readonly [keyof SillyTavernFields, LoreMatchSource][] = [
  ['matchPersonaDescription', 'persona'],
  ['matchCharacterDescription', 'description'],
  ['matchCharacterPersonality', 'personality'],
  ['matchCharacterDepthPrompt', 'depthPrompt'],
  ['matchScenario', 'scenario'],
  ['matchCreatorNotes', 'creatorNotes'],
];

/** The same settings as a character_book entry's `extensions` spells them. */
const fieldsOfBookExtensions = (extensions: Json): SillyTavernFields => ({
  position: extensions['position'],
  depth: extensions['depth'],
  role: extensions['role'],
  selectiveLogic: extensions['selectiveLogic'],
  probability: extensions['probability'],
  useProbability: extensions['useProbability'],
  group: extensions['group'],
  groupWeight: extensions['group_weight'],
  scanDepth: extensions['scan_depth'],
  sticky: extensions['sticky'],
  cooldown: extensions['cooldown'],
  delay: extensions['delay'],
  outletName: extensions['outlet_name'],
  vectorized: extensions['vectorized'],
  ignoreBudget: extensions['ignore_budget'],
  preventRecursion: extensions['prevent_recursion'],
  excludeRecursion: extensions['exclude_recursion'],
  delayUntilRecursion: extensions['delay_until_recursion'],
  groupOverride: extensions['group_override'],
  useGroupScoring: extensions['use_group_scoring'],
  matchWholeWords: extensions['match_whole_words'],
  matchPersonaDescription: extensions['match_persona_description'],
  matchCharacterDescription: extensions['match_character_description'],
  matchCharacterPersonality: extensions['match_character_personality'],
  matchCharacterDepthPrompt: extensions['match_character_depth_prompt'],
  matchScenario: extensions['match_scenario'],
  matchCreatorNotes: extensions['match_creator_notes'],
  triggers: extensions['triggers'],
});

/**
 * ST's settings as `LoreEntry` fields. Every value ST writes as its default reads
 * back as absent — ST writes the whole set on every entry, and a materialized
 * default would make each imported entry look hand-tuned.
 */
function loreFieldsOfSillyTavern(fields: SillyTavernFields): Partial<LoreEntry> {
  const out: Partial<LoreEntry> = {};

  // A position ST has no number for (none yet) reads as before the character.
  const position = finite(fields.position);
  if (position !== undefined) out.position = ST_POSITIONS[position] ?? 'before_char';
  if (position === ST_AT_DEPTH) {
    out.depth = wholeCount(fields.depth) ?? ST_DEFAULT_DEPTH;
    const role = roleFromSillyTavern(fields.role);
    if (role) out.role = role;
  }
  // An outlet without a name is one no macro can name, which ST never sends.
  const outlet = typeof fields.outletName === 'string' ? fields.outletName.trim() : '';
  if (out.position === 'outlet' && outlet) out.outletName = outlet;

  const logic = ST_LOGIC[finite(fields.selectiveLogic) ?? 0];
  if (logic && logic !== 'and_any') out.selectiveLogic = logic;

  // ST rolls unless `useProbability` is off, and reads a missing one as on.
  const probability = finite(fields.probability);
  if (fields.useProbability !== false && probability !== undefined && probability < 100) {
    out.probability = Math.max(0, Math.round(probability));
  }

  const group = typeof fields.group === 'string' ? fields.group.trim() : '';
  if (group) out.group = group;
  const weight = finite(fields.groupWeight);
  if (weight !== undefined && weight > 0 && weight !== ST_DEFAULT_WEIGHT) {
    out.groupWeight = Math.round(weight);
  }

  // 0 is a real scan depth (recursion text only); for the timed effects it is none.
  const scanDepth = wholeCount(fields.scanDepth);
  if (scanDepth !== undefined) out.scanDepth = scanDepth;
  for (const key of ['sticky', 'cooldown', 'delay'] as const) {
    const value = wholeCount(fields[key]);
    if (value) out[key] = value;
  }
  // The 🔗 status, kept only to be written back (`LoreEntry.vectorized`).
  if (fields.vectorized === true) out.vectorized = true;

  if (fields.ignoreBudget === true) out.ignoreBudget = true;
  if (fields.preventRecursion === true) out.preventRecursion = true;
  if (fields.excludeRecursion === true) out.excludeRecursion = true;
  // ST's `true` is the first level; a number is a level of its own.
  const delayed = fields.delayUntilRecursion === true ? 1 : wholeCount(fields.delayUntilRecursion);
  if (delayed) out.delayUntilRecursion = delayed;
  if (fields.groupOverride === true) out.groupOverride = true;
  // null — and anything else — is "the book decides", which is absent here.
  if (typeof fields.useGroupScoring === 'boolean') out.useGroupScoring = fields.useGroupScoring;
  if (typeof fields.matchWholeWords === 'boolean') out.matchWholeWords = fields.matchWholeWords;
  const sources = ST_MATCH_FLAGS.filter(([flag]) => fields[flag] === true).map(([, source]) => source);
  if (sources.length > 0) out.matchSources = sources;
  // ST keeps only the kinds it knows (`arrayFilter` on `triggers`).
  const triggers = strings(fields.triggers).filter((kind): kind is LoreTrigger =>
    LORE_TRIGGERS.includes(kind as LoreTrigger),
  );
  if (triggers.length > 0) out.triggers = [...new Set(triggers)];
  return out;
}

/**
 * A World Info entry's `characterFilter` (`{ isExclude, names, tags }`): ST names
 * a character by its card file (`getCharaFilename`), which a backup import turns
 * into roster names, and a tag by its id, which the import turns into the tag's
 * name. Undefined when it filters nothing.
 */
function characterFilterOf(value: unknown): LoreCharacterFilter | undefined {
  if (!isObject(value)) return undefined;
  const names = strings(value['names']).filter((name) => name.length > 0);
  const tags = strings(value['tags']).filter((tag) => tag.length > 0);
  if (names.length === 0 && tags.length === 0) return undefined;
  return {
    ...(names.length > 0 ? { names } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(value['isExclude'] === true ? { exclude: true as const } : {}),
  };
}

/**
 * The decorators SillyTavern reads off an entry's content (`parseDecorators` in
 * its `world-info.js`): only when the content starts with `@@`, every leading
 * `@@` line comes off, and of them only `@@activate` and `@@dont_activate` mean
 * anything — `@@activate` winning where both are written, as ST checks it first.
 * A `@@@` line is a fallback, read only right after a decorator ST did not know.
 * Every other V3 decorator (`@@depth`, `@@position`, …) is taken off and ignored,
 * as there; content that is nothing but decorators is kept whole.
 */
export function parseTavernDecorators(content: string): { activate: boolean; dontActivate: boolean; body: string } {
  const none = { activate: false, dontActivate: false, body: content };
  if (!content.startsWith('@@')) return none;
  const lines = content.split('\n');
  const known: string[] = [];
  let fallback = false;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i]!;
    if (!line.startsWith('@@')) {
      return { activate: known.includes('@@activate'), dontActivate: known.includes('@@dont_activate'), body: lines.slice(i).join('\n') };
    }
    if (line.startsWith('@@@')) {
      if (!fallback) continue;
      line = line.slice(1);
    }
    if (line.startsWith('@@activate') || line.startsWith('@@dont_activate')) {
      known.push(line);
      fallback = false;
    } else {
      fallback = true;
    }
  }
  return { ...none, activate: known.includes('@@activate'), dontActivate: known.includes('@@dont_activate') };
}

/** `/pattern/flags`, the one form in which ST reads a key as a regex (`parseRegexFromString`). */
const SLASH_REGEX = /^\/([\w\W]+?)\/([gimsuy]*)$/;

/** A `/pattern/flags` key taken apart, or null when ST would read it as plain text. */
function slashRegexSource(key: string): { source: string; flags: string } | null {
  const match = SLASH_REGEX.exec(key);
  // ST refuses a pattern with an unescaped delimiter in it, and so do we.
  if (!match || /(^|[^\\])\//.test(match[1]!)) return null;
  return { source: match[1]!.replaceAll('\\/', '/'), flags: match[2]! };
}

/** `text` as a pattern that matches it literally. */
export const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A regex entry's key as our matcher reads it: a slash key's pattern, anything else as a literal. */
const regexKeySource = (key: string): string => slashRegexSource(key)?.source ?? escapeRegex(key);

/** How an entry's keys came out of the file, and the case they want when that is theirs to say. */
interface EntryKeys {
  keys: string[];
  secondaryKeys: string[];
  useRegex: boolean;
  caseSensitive?: boolean;
}

/**
 * ST ignores `use_regex` (and writes `true` on every entry it exports): a key is a
 * regex exactly when it is spelled `/pattern/flags`. That is per key, and ours is
 * per entry, so an entry with any such key becomes a regex entry whose plain keys
 * are escaped into literals. The flags are dropped; case follows the entry.
 */
function keysOfSillyTavern(keys: string[], secondaryKeys: string[]): EntryKeys {
  if (![...keys, ...secondaryKeys].some((key) => slashRegexSource(key) !== null)) {
    return { keys, secondaryKeys, useRegex: false };
  }
  return { keys: keys.map(regexKeySource), secondaryKeys: secondaryKeys.map(regexKeySource), useRegex: true };
}

/**
 * Everyone else's keys, which means RisuAI's: it does read `use_regex`, but its
 * import keeps the flag only when the first key starts with `/`, and its matcher
 * then takes every key as `/pattern/flags` (a bare pattern never matches there).
 * So the entry is a regex entry on the same terms and its keys lose the slashes.
 *
 * The flags are per key there and case is per entry here: the entry ignores case
 * when any key carries `i` and keeps it otherwise, whatever `case_sensitive` says
 * — RisuAI's regexes never read that field. The other flags are dropped. A key not
 * spelled with slashes makes RisuAI's whole key list fail, which leaves the entry
 * unable to fire; here it is a literal instead, as on the ST path.
 */
function keysOfRisuAi(keys: string[], secondaryKeys: string[], useRegex: boolean): EntryKeys {
  if (!useRegex || !keys[0]?.startsWith('/')) return { keys, secondaryKeys, useRegex: false };
  const all = [...keys, ...secondaryKeys];
  return {
    keys: keys.map(regexKeySource),
    secondaryKeys: secondaryKeys.map(regexKeySource),
    useRegex: true,
    caseSensitive: !all.some((key) => slashRegexSource(key)?.flags.includes('i')),
  };
}

/** The inverse, for export: a regex entry's keys spelled so ST reads them as regexes. */
function keyForSillyTavern(key: string, caseSensitive: boolean): string {
  let escaped = '';
  for (let i = 0; i < key.length; i += 1) {
    const char = key[i]!;
    if (char === '\\') {
      escaped += char + (key[i + 1] ?? '');
      i += 1;
    } else {
      escaped += char === '/' ? '\\/' : char;
    }
  }
  return `/${escaped}/${caseSensitive ? '' : 'i'}`;
}

/* ------------------------------------------------------------ assembling */

interface BaseEntry {
  name?: string;
  keys: string[];
  secondaryKeys: string[];
  selective: boolean;
  content: string;
  enabled: boolean;
  constant: boolean;
  insertionOrder: number;
  caseSensitive: boolean;
  useRegex: boolean;
  position: LorePosition;
}

/**
 * Where RisuAI's one placement (`LoreDecorators.pos`) puts the entry here:
 * `@@depth` and `@@reverse_depth` at a depth, counted from the start or the end
 * of its chat block; `before_desc` before the description; `after_desc`,
 * `personality` and `scenario` after it — RisuAI sends all three there; a
 * prompt template's `pt_` slot nowhere but where `{{position::…}}` asks.
 */
function placementOf(pos: NonNullable<LoreDecorators['pos']>, depth: number | undefined): {
  position?: LorePosition;
  depth?: number;
  risu?: RisuLoreOptions;
} {
  if (pos === 'depth' || pos === 'reverse_depth') {
    return { depth: depth ?? 0, risu: { depthFrom: pos === 'depth' ? 'start' : 'end' } };
  }
  if (pos === 'before_desc') return { position: 'before_char' };
  if (pos.startsWith('pt_')) return { risu: { slot: pos.slice('pt_'.length) } };
  return { position: 'after_char' };
}

/** The rest of RisuAI's decorators, as the entry's `risu` (`RisuLoreOptions`) — empty where none was written. */
function risuOptionsOf(decorators: LoreDecorators): RisuLoreOptions {
  return {
    ...(decorators.every !== undefined ? { every: decorators.every } : {}),
    ...(decorators.greeting !== undefined ? { greeting: decorators.greeting } : {}),
    ...(decorators.priority !== undefined ? { priority: decorators.priority } : {}),
    ...(decorators.recursive === true ? { recursive: true as const } : {}),
    ...(decorators.fullWord !== undefined ? { fullWord: decorators.fullWord } : {}),
    ...(decorators.inject ? { inject: decorators.inject satisfies RisuLoreInjection } : {}),
  };
}

/** Layers the ST settings, then the decorators, onto the entry's own fields. */
function assemble(
  base: BaseEntry,
  decorators: LoreDecorators,
  sillyTavern: Partial<LoreEntry>,
): LoreEntry {
  const { position: stPosition, depth: stDepth, role: stRole, outletName, ...stRest } = sillyTavern;
  let position = base.position;
  let depth: number | undefined;
  let placed: RisuLoreOptions = {};
  if (decorators.pos !== undefined) {
    // RisuAI keeps one placement, which the last of its decorators set.
    const placement = placementOf(decorators.pos, decorators.depth);
    position = placement.position ?? position;
    depth = placement.depth;
    placed = placement.risu ?? {};
  } else {
    position = stPosition ?? position;
    depth = stDepth;
  }
  // RisuAI's `@@role` goes wherever the entry does; SillyTavern's only with a depth.
  const role = decorators.role ?? (depth !== undefined ? stRole : undefined);
  const risu: RisuLoreOptions = { ...placed, ...risuOptionsOf(decorators) };

  const entry: LoreEntry = {
    ...base,
    // RisuAI lore has no `enabled`; `@@dont_activate` is how it switches one off.
    enabled: decorators.force === 'deactivate' ? false : base.enabled,
    constant: decorators.force === 'activate' || (decorators.constant ?? base.constant),
    position,
    // The outlet's name only means something while the entry is an outlet.
    ...(position === 'outlet' && outletName ? { outletName } : {}),
    // The card placed it with `@@position`, so it stays where it was put.
    ...(decorators.pos !== undefined && decorators.pos !== 'depth' && decorators.pos !== 'reverse_depth'
      ? { positioned: true as const }
      : {}),
    ...(depth === undefined ? {} : { depth }),
    ...(role ? { role } : {}),
    ...stRest,
    ...(decorators.delay !== undefined ? { delay: decorators.delay } : {}),
    ...(decorators.scanDepth !== undefined ? { scanDepth: decorators.scanDepth } : {}),
    ...(decorators.sticky !== undefined ? { sticky: decorators.sticky } : {}),
    ...(decorators.cooldown !== undefined ? { cooldown: decorators.cooldown } : {}),
    // `@@unrecursive` is SillyTavern's `preventRecursion`, `@@no_recursive_search` its `excludeRecursion`.
    ...(decorators.recursive === false ? { preventRecursion: true as const } : {}),
    ...(decorators.noRecursiveSearch ? { excludeRecursion: true as const } : {}),
    ...(Object.keys(risu).length > 0 ? { risu } : {}),
  };
  if (decorators.recursive === true) delete entry.preventRecursion;
  if (decorators.probability !== undefined) {
    // 100 is the default, which an entry leaves out.
    if (decorators.probability < 100) entry.probability = decorators.probability;
    else delete entry.probability;
  }

  // An entry whose own secondary keys take part has no room for a second set;
  // inert ones (not selective) give way.
  const secondary = secondaryOfDecorators(decorators);
  if (secondary && (!entry.selective || entry.secondaryKeys.length === 0)) {
    // RisuAI reads these keys the way it reads the entry's own — as regexes on a
    // regex entry, where the V3 spec would ignore `@@exclude_keys` instead.
    entry.secondaryKeys = entry.useRegex ? secondary.keys.map(regexKeySource) : secondary.keys;
    entry.selective = true;
    if (secondary.logic === 'and_any') delete entry.selectiveLogic;
    else entry.selectiveLogic = secondary.logic;
  }
  return entry;
}

/**
 * The key decorators as one set of secondary keys. RisuAI runs each line as a
 * search of its own — every `@@additional_keys` line has to find one of its keys,
 * any `@@exclude_keys` key and all of an `@@exclude_keys_all` line's keys rule the
 * entry out — and ours is one set with one logic. So one line of additional keys
 * is AND_ANY, several lines of one key each (how RisuAI writes ST's AND_ALL) are
 * AND_ALL, and any other several lines loosen to AND_ANY; the exclusions are
 * NOT_ANY and NOT_ALL over every line's keys. Where an entry carries more than one
 * kind, additional keys win over exclusions, and NOT_ANY over NOT_ALL.
 */
function secondaryOfDecorators(
  decorators: LoreDecorators,
): { keys: string[]; logic: LoreSelectiveLogic } | undefined {
  const lines = decorators.additionalKeys;
  if (lines) {
    const each = lines.length > 1 && lines.every((line) => line.length === 1);
    return { keys: lines.flat(), logic: each ? 'and_all' : 'and_any' };
  }
  if (decorators.excludeKeys) return { keys: decorators.excludeKeys, logic: 'not_any' };
  if (decorators.excludeAllKeys) return { keys: decorators.excludeAllKeys, logic: 'not_all' };
  return undefined;
}

/**
 * An entry SillyTavern wrote, read as ST reads it (`convertCharacterBook` and its
 * World Info loader): its keys exactly as written — ST tells a regex key by its
 * `/pattern/flags` spelling, one key at a time, and expands macros in it, both
 * at scan time (`LoreEntry.sillyTavern`) — its content past ST's own decorators
 * (`parseTavernDecorators`), and its settings in ST's terms. A case left to the
 * book (ST's `null`) is `caseSensitiveFromBook`.
 */
function tavernEntry(base: BaseEntry, content: string, settings: Partial<LoreEntry>, caseFromBook: boolean): LoreEntry {
  const { activate, dontActivate, body } = parseTavernDecorators(content);
  const { position: stPosition, depth, role, outletName, ...rest } = settings;
  const position = stPosition ?? base.position;
  return {
    ...base,
    content: body,
    // ST skips a disabled entry before it reads either decorator, and reads
    // `@@activate` before `@@dont_activate`.
    enabled: base.enabled && (activate || !dontActivate),
    constant: base.constant || activate,
    position,
    ...(position === 'outlet' && outletName ? { outletName } : {}),
    ...(depth === undefined ? {} : { depth }),
    ...(depth !== undefined && role ? { role } : {}),
    ...rest,
    ...(caseFromBook ? { caseSensitiveFromBook: true as const } : {}),
    sillyTavern: true,
  };
}

/**
 * A CCv2/CCv3 character_book entry, from a card or from a stand-alone book.
 *
 * An entry that carries SillyTavern's settings in its `extensions` (a numeric
 * `position`, which ST writes on every entry and nothing else does) is ST's and
 * read as ST reads it (`tavernEntry`) — unless the caller knows the book is
 * RisuAI's (`sillyTavern: false`): RisuAI keeps ST's extensions on a card it got
 * from there, and matches that book its own way (`LoreSettings.risuMatching`).
 */
export function loreEntryFromBook(raw: unknown, options: { sillyTavern?: boolean } = {}): LoreEntry {
  const entry = isObject(raw) ? raw : {};
  const extensions = isObject(entry['extensions']) ? entry['extensions'] : {};
  const content = typeof entry['content'] === 'string' ? entry['content'] : '';
  // ST writes a numeric position on every entry; nothing else does.
  const fromSillyTavern = typeof extensions['position'] === 'number';
  const keys = strings(entry['keys']);
  const secondaryKeys = strings(entry['secondary_keys']);
  const base = {
    // RisuAI writes the label as both; ST writes only `comment`.
    ...labelOf(entry['name'], entry['comment']),
    selective: entry['selective'] === true,
    enabled: entry['enabled'] !== false,
    constant: entry['constant'] === true,
    insertionOrder: finite(entry['insertion_order']) ?? 0,
    position: (entry['position'] === 'after_char' ? 'after_char' : 'before_char') as LorePosition,
  };

  if (fromSillyTavern && options.sillyTavern !== false) {
    // ST reads case from its extensions alone, and `null` there is the book's.
    const caseSensitive = boolOf(extensions['case_sensitive']);
    return tavernEntry(
      { ...base, keys, secondaryKeys, useRegex: false, caseSensitive: caseSensitive ?? false, content: '' },
      content,
      loreFieldsOfSillyTavern(fieldsOfBookExtensions(extensions)),
      caseSensitive === undefined,
    );
  }

  const { decorators, body } = parseDecorators(content);
  const matching = fromSillyTavern
    ? keysOfSillyTavern(keys, secondaryKeys)
    : keysOfRisuAi(keys, secondaryKeys, entry['use_regex'] === true);
  return assemble(
    {
      ...base,
      ...matching,
      content: body,
      // A RisuAI regex's flags come first. ST keeps case in its extensions and
      // leaves the CCv3 field out.
      caseSensitive:
        matching.caseSensitive ??
        boolOf(entry['case_sensitive']) ??
        boolOf(extensions['case_sensitive']) ??
        false,
    },
    decorators,
    fromSillyTavern ? loreFieldsOfSillyTavern(fieldsOfBookExtensions(extensions)) : {},
  );
}

/**
 * An ST entry as every other book reads one — what a RisuAI module makes of a
 * World Info file it carries: no longer ST's (`LoreEntry.sillyTavern`), so it
 * leaves the greeting out, and its slash keys become one regex entry
 * (`keysOfSillyTavern`), as ST entries were stored before their keys were kept
 * as written.
 */
export function withoutTavernReading(entry: LoreEntry): LoreEntry {
  const { sillyTavern, caseSensitiveFromBook: _book, ...rest } = entry;
  if (!sillyTavern || entry.useRegex) return rest;
  return { ...rest, ...keysOfSillyTavern(entry.keys, entry.secondaryKeys) };
}

/**
 * The mark our export puts on a character_book's own `extensions`: the book was
 * written here. ST rebuilds a book from scratch whenever it writes one
 * (`convertWorldInfoToCharacterBook`), so a book it wrote again no longer has
 * it. In a marked book only the entries our export flagged as ST's
 * (`ENTRY_TAVERN_MARK`, which ST does carry along in the entry's extensions)
 * are read as ST's; the rest are ours, whose ST extensions are only there for
 * ST to read.
 */
export const BOOK_MARK = 'shizue';
const ENTRY_TAVERN_MARK = 'shizue_sillytavern';

/**
 * A character_book's entries (`loreEntryFromBook`), with our own export told
 * apart from ST's (`BOOK_MARK`). `sillyTavern: false` is the caller knowing the
 * book is RisuAI's.
 */
export function loreEntriesOfBook(book: unknown, options: { sillyTavern?: boolean } = {}): LoreEntry[] {
  const object = isObject(book) ? book : {};
  const entries = Array.isArray(object['entries']) ? object['entries'] : [];
  const ours = isObject(object['extensions']) && object['extensions'][BOOK_MARK] === true;
  return entries.map((raw) => {
    if (!ours) return loreEntryFromBook(raw, options);
    const extensions = isObject(raw) && isObject(raw['extensions']) ? raw['extensions'] : {};
    return loreEntryFromBook(raw, { sillyTavern: extensions[ENTRY_TAVERN_MARK] === true });
  });
}

/**
 * An entry of a SillyTavern World Info file (`{ entries: { [uid]: … } }`),
 * read as ST reads it (`tavernEntry`), with the character filter only a World
 * Info file carries.
 */
export function loreEntryFromWorldInfo(raw: unknown): LoreEntry {
  const entry = isObject(raw) ? raw : {};
  const caseSensitive = boolOf(entry['caseSensitive']);
  const filter = characterFilterOf(entry['characterFilter']);
  const read = tavernEntry(
    {
      ...labelOf(entry['comment']),
      keys: strings(entry['key']),
      secondaryKeys: strings(entry['keysecondary']),
      useRegex: false,
      selective: entry['selective'] === true,
      content: '',
      enabled: entry['disable'] !== true,
      constant: entry['constant'] === true,
      insertionOrder: finite(entry['order']) ?? 0,
      caseSensitive: caseSensitive ?? false,
      position: 'before_char',
    },
    typeof entry['content'] === 'string' ? entry['content'] : '',
    loreFieldsOfSillyTavern(entry as SillyTavernFields),
    caseSensitive === undefined,
  );
  return filter ? { ...read, characterFilter: filter } : read;
}

/* ---------------------------------------------------------------- export */

interface SillyTavernOut {
  position: number;
  depth: number;
  role: number;
  selectiveLogic: number;
  probability: number;
  useProbability: boolean;
  group: string;
  groupWeight: number;
  scanDepth?: number;
  sticky?: number;
  cooldown?: number;
  delay?: number;
  outletName?: string;
  vectorized?: true;
  ignoreBudget?: true;
  preventRecursion?: true;
  excludeRecursion?: true;
  delayUntilRecursion?: number;
  groupOverride?: true;
  useGroupScoring?: boolean;
  matchWholeWords?: boolean;
  matchPersonaDescription?: true;
  matchCharacterDescription?: true;
  matchCharacterPersonality?: true;
  matchCharacterDepthPrompt?: true;
  matchScenario?: true;
  matchCreatorNotes?: true;
  triggers?: LoreTrigger[];
}

/**
 * The settings SillyTavern has and V3 does not, each written only where the
 * entry sets it — ST reads a missing one as its default — so every other entry
 * exports as it always has.
 */
function tavernExtras(entry: LoreEntry): Partial<SillyTavernOut> {
  const sources = new Set(entry.matchSources ?? []);
  const out: Partial<SillyTavernOut> = {
    ...(entry.ignoreBudget ? { ignoreBudget: true as const } : {}),
    ...(entry.preventRecursion ? { preventRecursion: true as const } : {}),
    ...(entry.excludeRecursion ? { excludeRecursion: true as const } : {}),
    ...(entry.delayUntilRecursion ? { delayUntilRecursion: entry.delayUntilRecursion } : {}),
    ...(entry.groupOverride ? { groupOverride: true as const } : {}),
    ...(entry.useGroupScoring !== undefined ? { useGroupScoring: entry.useGroupScoring } : {}),
    ...(entry.matchWholeWords !== undefined ? { matchWholeWords: entry.matchWholeWords } : {}),
    ...(entry.triggers?.length ? { triggers: entry.triggers } : {}),
  };
  for (const [flag, source] of ST_MATCH_FLAGS) {
    if (sources.has(source)) (out as Record<string, unknown>)[flag] = true;
  }
  return out;
}

/** ST's settings for one entry, under the World Info names; the caller renames for a book. */
function sillyTavernFieldsOf(entry: LoreEntry): SillyTavernOut {
  return {
    position: entry.depth !== undefined ? ST_AT_DEPTH : ST_POSITION_NUMBER[entry.position] ?? 0,
    depth: entry.depth ?? ST_DEFAULT_DEPTH,
    role: ST_ROLES.indexOf(entry.role ?? 'system'),
    selectiveLogic: ST_LOGIC_NUMBER[entry.selectiveLogic ?? 'and_any'],
    probability: entry.probability ?? 100,
    useProbability: true,
    group: entry.group ?? '',
    groupWeight: entry.groupWeight ?? ST_DEFAULT_WEIGHT,
    // ST's own "none" for these is null; absent reads the same and keeps the
    // export free of nulls, which ccardlib's checker strips from its input.
    ...(entry.scanDepth !== undefined ? { scanDepth: entry.scanDepth } : {}),
    ...(entry.sticky !== undefined ? { sticky: entry.sticky } : {}),
    ...(entry.cooldown !== undefined ? { cooldown: entry.cooldown } : {}),
    ...(entry.delay !== undefined ? { delay: entry.delay } : {}),
    // Written for an outlet only, so every other entry exports as it always has.
    ...(entry.depth === undefined && entry.position === 'outlet' ? { outletName: entry.outletName ?? '' } : {}),
    // Written when set only, so every other entry exports as it always has.
    ...(entry.vectorized ? { vectorized: true as const } : {}),
    ...tavernExtras(entry),
  };
}

/** A World Info field's name as a character_book entry's `extensions` spells it (`convertWorldInfoToCharacterBook`). */
const BOOK_EXTENSION_NAMES: Partial<Record<keyof SillyTavernOut, string>> = {
  groupWeight: 'group_weight',
  scanDepth: 'scan_depth',
  outletName: 'outlet_name',
  ignoreBudget: 'ignore_budget',
  preventRecursion: 'prevent_recursion',
  excludeRecursion: 'exclude_recursion',
  delayUntilRecursion: 'delay_until_recursion',
  groupOverride: 'group_override',
  useGroupScoring: 'use_group_scoring',
  matchWholeWords: 'match_whole_words',
  matchPersonaDescription: 'match_persona_description',
  matchCharacterDescription: 'match_character_description',
  matchCharacterPersonality: 'match_character_personality',
  matchCharacterDepthPrompt: 'match_character_depth_prompt',
  matchScenario: 'match_scenario',
  matchCreatorNotes: 'match_creator_notes',
};

/** The case ST reads: the entry's own, or `null` where the entry left it to the book. */
const tavernCaseOf = (entry: LoreEntry): boolean | null => (entry.caseSensitiveFromBook ? null : entry.caseSensitive);

/** Keys as ST should read them: regexes in their slash form, plain text as is. */
export function keysForSillyTavern(entry: LoreEntry): { keys: string[]; secondaryKeys: string[] } {
  if (!entry.useRegex) return { keys: entry.keys, secondaryKeys: entry.secondaryKeys };
  const wrap = (key: string): string => keyForSillyTavern(key, entry.caseSensitive);
  return { keys: entry.keys.map(wrap), secondaryKeys: entry.secondaryKeys.map(wrap) };
}

/**
 * The entry's settings as a character_book entry's `extensions`, which is where
 * SillyTavern looks for them. `case_sensitive` is repeated there because ST reads
 * case only from there.
 */
export function bookExtensionsOf(entry: LoreEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(sillyTavernFieldsOf(entry))) {
    if (value !== undefined) out[BOOK_EXTENSION_NAMES[name as keyof SillyTavernOut] ?? name] = value;
  }
  return {
    ...out,
    case_sensitive: tavernCaseOf(entry),
    // Read back as ST's from a book of ours (`loreEntriesOfBook`).
    ...(entry.sillyTavern ? { [ENTRY_TAVERN_MARK]: true } : {}),
  };
}

/**
 * The entry as a SillyTavern World Info entry, minus `uid`/`displayIndex`. The
 * settings ST leaves unset are null, as in its own files.
 */
export function worldInfoFieldsOf(entry: LoreEntry): Record<string, unknown> {
  const { keys, secondaryKeys } = keysForSillyTavern(entry);
  const fields = sillyTavernFieldsOf(entry);
  return {
    key: keys,
    keysecondary: secondaryKeys,
    comment: entry.name ?? '',
    content: entry.content,
    constant: entry.constant,
    selective: entry.selective,
    order: entry.insertionOrder,
    disable: !entry.enabled,
    caseSensitive: tavernCaseOf(entry),
    ...fields,
    scanDepth: fields.scanDepth ?? null,
    sticky: fields.sticky ?? null,
    cooldown: fields.cooldown ?? null,
    delay: fields.delay ?? null,
    ...(entry.characterFilter
      ? {
          characterFilter: {
            isExclude: entry.characterFilter.exclude === true,
            names: entry.characterFilter.names ?? [],
            tags: entry.characterFilter.tags ?? [],
          },
        }
      : {}),
  };
}
