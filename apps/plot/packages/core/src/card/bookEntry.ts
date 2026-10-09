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
  /** `@@exclude_keys a,b`, case kept. */
  excludeKeys?: string[];
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

/**
 * Splits the leading `@@`-prefixed decorator lines of a V3 lorebook entry off its
 * content and interprets the supported subset. Unsupported decorators are
 * stripped without effect, per spec.
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
      case 'exclude_keys': {
        // Keys are matched as written, so this one argument keeps its case.
        const keys = raw.split(',').map((key) => key.trim()).filter((key) => key.length > 0);
        if (keys.length > 0) decorators.excludeKeys = keys;
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

/** `world_info_position`: 0 before char, 1 after char, 4 at depth; the rest have no counterpart. */
const ST_BEFORE = 0;
const ST_AFTER = 1;
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
});

/**
 * ST's settings as `LoreEntry` fields. Every value ST writes as its default reads
 * back as absent — ST writes the whole set on every entry, and a materialized
 * default would make each imported entry look hand-tuned.
 */
function loreFieldsOfSillyTavern(fields: SillyTavernFields): Partial<LoreEntry> {
  const out: Partial<LoreEntry> = {};

  const position = finite(fields.position);
  if (position === ST_AFTER) out.position = 'after_char';
  else if (position !== undefined) out.position = 'before_char';
  if (position === ST_AT_DEPTH) {
    out.depth = wholeCount(fields.depth) ?? ST_DEFAULT_DEPTH;
    const role = roleFromSillyTavern(fields.role);
    if (role) out.role = role;
  }

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
  return out;
}

/** `/pattern/flags`, the one form in which ST reads a key as a regex (`parseRegexFromString`). */
const SLASH_REGEX = /^\/([\w\W]+?)\/([gimsuy]*)$/;

/** The source of a `/pattern/flags` key, or null when ST would read it as plain text. */
function slashRegexSource(key: string): string | null {
  const match = SLASH_REGEX.exec(key);
  // ST refuses a pattern with an unescaped delimiter in it, and so do we.
  if (!match || /(^|[^\\])\//.test(match[1]!)) return null;
  return match[1]!.replaceAll('\\/', '/');
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ST ignores `use_regex` (and writes `true` on every entry it exports): a key is a
 * regex exactly when it is spelled `/pattern/flags`. That is per key, and ours is
 * per entry, so an entry with any such key becomes a regex entry whose plain keys
 * are escaped into literals. The flags are dropped; case follows the entry.
 */
function keysOfSillyTavern(
  keys: string[],
  secondaryKeys: string[],
): { keys: string[]; secondaryKeys: string[]; useRegex: boolean } {
  if (![...keys, ...secondaryKeys].some((key) => slashRegexSource(key) !== null)) {
    return { keys, secondaryKeys, useRegex: false };
  }
  const toSource = (key: string): string => slashRegexSource(key) ?? escapeRegex(key);
  return { keys: keys.map(toSource), secondaryKeys: secondaryKeys.map(toSource), useRegex: true };
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
  const { position: stPosition, depth: stDepth, role: stRole, ...stRest } = sillyTavern;
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
    constant: decorators.constant ?? base.constant,
    position,
    ...(depth === undefined ? {} : { depth }),
    ...(depth !== undefined && role ? { role } : {}),
    ...stRest,
    ...(decorators.delay !== undefined ? { delay: decorators.delay } : {}),
    ...(decorators.scanDepth !== undefined ? { scanDepth: decorators.scanDepth } : {}),
    ...(decorators.sticky !== undefined ? { sticky: decorators.sticky } : {}),
    ...(decorators.cooldown !== undefined ? { cooldown: decorators.cooldown } : {}),
  };

  // Exclusion is what NOT_ANY secondary keys already are; the spec has the
  // decorator ignored on a regex entry, and an entry with secondary keys of its
  // own has no room for a second set.
  if (decorators.excludeKeys && entry.secondaryKeys.length === 0 && !entry.useRegex) {
    entry.secondaryKeys = decorators.excludeKeys;
    entry.selective = true;
    entry.selectiveLogic = 'not_any';
  }
  return entry;
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
    : { keys, secondaryKeys, useRegex: entry['use_regex'] === true };

  return assemble(
    {
      ...matching,
      selective: entry['selective'] === true,
      content: body,
      enabled: entry['enabled'] !== false,
      constant: entry['constant'] === true,
      insertionOrder: finite(entry['insertion_order']) ?? 0,
      // ST keeps case in its extensions and leaves the CCv3 field out.
      caseSensitive:
        boolOf(entry['case_sensitive']) ?? boolOf(extensions['case_sensitive']) ?? false,
      position: entry['position'] === 'after_char' ? 'after_char' : 'before_char',
    },
    decorators,
    fromSillyTavern ? loreFieldsOfSillyTavern(fieldsOfBookExtensions(extensions)) : {},
  );
}

/** An entry of a SillyTavern World Info file (`{ entries: { [uid]: … } }`). */
export function loreEntryFromWorldInfo(raw: unknown): LoreEntry {
  const entry = isObject(raw) ? raw : {};
  const { decorators, body } = parseDecorators(
    typeof entry['content'] === 'string' ? entry['content'] : '',
  );
  return assemble(
    {
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
}

/** ST's settings for one entry, under the World Info names; the caller renames for a book. */
function sillyTavernFieldsOf(entry: LoreEntry): SillyTavernOut {
  return {
    position:
      entry.depth !== undefined ? ST_AT_DEPTH : entry.position === 'after_char' ? ST_AFTER : ST_BEFORE,
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
  const { groupWeight, scanDepth, ...fields } = sillyTavernFieldsOf(entry);
  return {
    ...fields,
    group_weight: groupWeight,
    ...(scanDepth !== undefined ? { scan_depth: scanDepth } : {}),
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
    comment: '',
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
