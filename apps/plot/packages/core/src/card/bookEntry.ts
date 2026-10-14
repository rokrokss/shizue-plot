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

import type { LoreEntry, LorePosition, LoreRole, LoreSelectiveLogic } from '../types.js';

/** The V3 decorator subset this implementation understands. */
export interface LoreDecorators {
  constant?: boolean;
  depth?: number;
  role?: LoreRole;
  position?: LorePosition;
  /** `@@activate_only_after N`. */
  delay?: number;
  /** `@@scan_depth N`. */
  scanDepth?: number;
  /** `@@keep_activate_after_match`. */
  sticky?: number;
  /** `@@dont_activate_after_match`. */
  cooldown?: number;
  /** `@@probability N`, clamped to 0–100. */
  probability?: number;
  /** `@@activate` or `@@dont_activate`, whichever comes last. */
  force?: 'activate' | 'deactivate';
  /** `@@additional_keys a,b`, one list per line, case kept. */
  additionalKeys?: string[][];
  /** `@@exclude_keys a,b`, every line's keys together, case kept. */
  excludeKeys?: string[];
  /** `@@exclude_keys_all a,b`, every line's keys together, case kept. */
  excludeAllKeys?: string[];
}

/**
 * What "for the rest of the chat" becomes for the two decorators that have no
 * number of their own: longer than any chat, and still a plain sticky/cooldown.
 * The API's lore coercion caps both at this, so a saved entry keeps it; the
 * export reads anything at or above it back out as the decorator.
 */
export const FOREVER_MESSAGES = 10000;

/** `@@name arg`. `@@@name` (a fallback decorator) does not match and is stripped. */
const DECORATOR_LINE = /^@@([a-z_]+)(?:[ \t]+(.*))?$/;

const count = (arg: string): number | undefined => {
  const value = Number.parseInt(arg, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

/** A decorator's comma-separated keys, as RisuAI's parser splits them. */
const keyList = (arg: string): string[] =>
  arg.split(',').map((key) => key.trim()).filter((key) => key.length > 0);

/**
 * Splits the leading `@@`-prefixed decorator lines of a V3 lorebook entry off its
 * content and interprets the supported subset. Unsupported decorators are
 * stripped without effect, per spec.
 *
 * The key decorators may repeat, and RisuAI applies every line: its own import
 * of a SillyTavern entry writes NOT_ANY and AND_ALL as one `@@exclude_keys` or
 * `@@additional_keys` line per key. Of the rest, the last line wins.
 */
export function parseDecorators(content: string): { decorators: LoreDecorators; body: string } {
  const lines = content.split('\n');
  const decorators: LoreDecorators = {};
  let start = 0;
  for (; start < lines.length; start += 1) {
    const line = lines[start]!.trim();
    if (!line.startsWith('@@')) break;
    const match = DECORATOR_LINE.exec(line);
    if (!match) continue;
    const raw = (match[2] ?? '').trim();
    const arg = raw.toLowerCase();
    switch (match[1]) {
      case 'constant':
        decorators.constant = true;
        break;
      case 'depth': {
        const depth = count(arg);
        if (depth !== undefined) decorators.depth = depth;
        break;
      }
      case 'role':
        if (arg === 'user' || arg === 'assistant' || arg === 'system') decorators.role = arg;
        break;
      case 'position':
        if (arg === 'before_desc') decorators.position = 'before_char';
        else if (arg === 'after_desc') decorators.position = 'after_char';
        break;
      case 'activate_only_after': {
        const delay = count(arg);
        if (delay !== undefined) decorators.delay = delay;
        break;
      }
      case 'scan_depth': {
        const scanDepth = count(arg);
        if (scanDepth !== undefined) decorators.scanDepth = scanDepth;
        break;
      }
      case 'keep_activate_after_match':
        decorators.sticky = FOREVER_MESSAGES;
        break;
      case 'dont_activate_after_match':
        decorators.cooldown = FOREVER_MESSAGES;
        break;
      case 'probability': {
        // RisuAI drops the entry when a roll of 0–100 exceeds N, so anything
        // under 0 never fires and anything from 100 always does.
        const chance = Number.parseInt(arg, 10);
        if (Number.isFinite(chance)) decorators.probability = Math.min(100, Math.max(0, chance));
        break;
      }
      case 'activate':
        decorators.force = 'activate';
        break;
      case 'dont_activate':
        decorators.force = 'deactivate';
        break;
      // Keys are matched as written, so these arguments keep their case.
      case 'additional_keys': {
        const keys = keyList(raw);
        if (keys.length > 0) decorators.additionalKeys = [...(decorators.additionalKeys ?? []), keys];
        break;
      }
      case 'exclude_keys': {
        const keys = keyList(raw);
        if (keys.length > 0) decorators.excludeKeys = [...(decorators.excludeKeys ?? []), ...keys];
        break;
      }
      case 'exclude_keys_all': {
        const keys = keyList(raw);
        if (keys.length > 0) decorators.excludeAllKeys = [...(decorators.excludeAllKeys ?? []), ...keys];
        break;
      }
      default:
        break;
    }
  }
  return { decorators, body: lines.slice(start).join('\n') };
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
}

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
  // The 🔗 status: the entry activates by meaning as well (`LoreEntry.vectorized`).
  if (fields.vectorized === true) out.vectorized = true;
  return out;
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

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

/** Layers the ST settings, then the decorators, onto the entry's own fields. */
function assemble(
  base: BaseEntry,
  decorators: LoreDecorators,
  sillyTavern: Partial<LoreEntry>,
): LoreEntry {
  const { position: stPosition, depth: stDepth, role: stRole, outletName, ...stRest } = sillyTavern;
  let position = base.position;
  let depth: number | undefined;
  let role: LoreRole | undefined;
  if (decorators.position !== undefined) {
    // Per spec, `@@position` takes precedence over `@@depth`.
    position = decorators.position;
  } else if (decorators.depth !== undefined) {
    depth = decorators.depth;
    role = decorators.role ?? stRole;
  } else {
    position = stPosition ?? position;
    depth = stDepth;
    role = decorators.role ?? stRole;
  }

  const entry: LoreEntry = {
    ...base,
    // RisuAI lore has no `enabled`; `@@dont_activate` is how it switches one off.
    enabled: decorators.force === 'deactivate' ? false : base.enabled,
    constant: decorators.force === 'activate' || (decorators.constant ?? base.constant),
    position,
    // The outlet's name only means something while the entry is an outlet.
    ...(position === 'outlet' && outletName ? { outletName } : {}),
    ...(depth === undefined ? {} : { depth }),
    ...(depth !== undefined && role ? { role } : {}),
    ...stRest,
    ...(decorators.delay !== undefined ? { delay: decorators.delay } : {}),
    ...(decorators.scanDepth !== undefined ? { scanDepth: decorators.scanDepth } : {}),
    ...(decorators.sticky !== undefined ? { sticky: decorators.sticky } : {}),
    ...(decorators.cooldown !== undefined ? { cooldown: decorators.cooldown } : {}),
  };
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

/** A CCv2/CCv3 character_book entry, from a card or from a stand-alone book. */
export function loreEntryFromBook(raw: unknown): LoreEntry {
  const entry = isObject(raw) ? raw : {};
  const extensions = isObject(entry['extensions']) ? entry['extensions'] : {};
  const { decorators, body } = parseDecorators(
    typeof entry['content'] === 'string' ? entry['content'] : '',
  );
  // ST writes a numeric position on every entry; nothing else does.
  const fromSillyTavern = typeof extensions['position'] === 'number';
  const keys = strings(entry['keys']);
  const secondaryKeys = strings(entry['secondary_keys']);
  const matching = fromSillyTavern
    ? keysOfSillyTavern(keys, secondaryKeys)
    : keysOfRisuAi(keys, secondaryKeys, entry['use_regex'] === true);

  return assemble(
    {
      // RisuAI writes the label as both; ST writes only `comment`.
      ...labelOf(entry['name'], entry['comment']),
      ...matching,
      selective: entry['selective'] === true,
      content: body,
      enabled: entry['enabled'] !== false,
      constant: entry['constant'] === true,
      insertionOrder: finite(entry['insertion_order']) ?? 0,
      // A RisuAI regex's flags come first. ST keeps case in its extensions and
      // leaves the CCv3 field out.
      caseSensitive:
        matching.caseSensitive ??
        boolOf(entry['case_sensitive']) ??
        boolOf(extensions['case_sensitive']) ??
        false,
      position: entry['position'] === 'after_char' ? 'after_char' : 'before_char',
    },
    decorators,
    fromSillyTavern ? loreFieldsOfSillyTavern(fieldsOfBookExtensions(extensions)) : {},
  );
}

/**
 * An entry of a SillyTavern World Info file (`{ entries: { [uid]: … } }`),
 * marked as ST's (`LoreEntry.sillyTavern`) so it scans the greeting as ST does.
 */
export function loreEntryFromWorldInfo(raw: unknown): LoreEntry {
  const entry = isObject(raw) ? raw : {};
  const { decorators, body } = parseDecorators(
    typeof entry['content'] === 'string' ? entry['content'] : '',
  );
  const read = assemble(
    {
      ...labelOf(entry['comment']),
      ...keysOfSillyTavern(strings(entry['key']), strings(entry['keysecondary'])),
      selective: entry['selective'] === true,
      content: body,
      enabled: entry['disable'] !== true,
      constant: entry['constant'] === true,
      insertionOrder: finite(entry['order']) ?? 0,
      caseSensitive: entry['caseSensitive'] === true,
      position: 'before_char',
    },
    decorators,
    loreFieldsOfSillyTavern(entry as SillyTavernFields),
  );
  return { ...read, sillyTavern: true };
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
  };
}

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
  const { groupWeight, scanDepth, outletName, ...fields } = sillyTavernFieldsOf(entry);
  return {
    ...fields,
    group_weight: groupWeight,
    ...(scanDepth !== undefined ? { scan_depth: scanDepth } : {}),
    ...(outletName !== undefined ? { outlet_name: outletName } : {}),
    case_sensitive: entry.caseSensitive,
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
    caseSensitive: entry.caseSensitive,
    ...fields,
    scanDepth: fields.scanDepth ?? null,
    sticky: fields.sticky ?? null,
    cooldown: fields.cooldown ?? null,
    delay: fields.delay ?? null,
  };
}
