/**
 * The conversion rules every site's mapper shares (design §3.3): reading the
 * form defensively, our protocol for scene text, macro and image-reference
 * spellings, keyword lists, cutting to our limits, and lore entries.
 *
 * Nothing here throws on what the creator pasted. A value of the wrong type
 * reads as empty, and anything the draft cannot carry becomes a warning and,
 * when it is text, a preserved copy.
 */

import { lineSpeaker, spokenBy } from '../speech.js';
import { MAX_TAG_LENGTH, MAX_TAGS, type LoreEntry } from '../types.js';
import type {
  ConvertOptions,
  MigrationWarning,
  MigrationWarningCode,
  PreservedText,
  SiteInput,
  SiteSchema,
  SpeakerMode,
} from './types.js';

/* -------------------------------------------------------------- reading */

/** A text value with its line endings unified; '' for anything that is not a string. */
export const text = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';

/** A `multiChoice` value; a lone string reads as one choice. */
export const choices = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string' && value
      ? [value]
      : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The form itself, or an empty one when what arrived is not an object. */
export const formOf = (input: unknown): SiteInput => (isRecord(input) ? input : {});

/** A repeated section's rows; anything that is not a row is skipped. */
export const rowsOf = (input: SiteInput, section: string): Record<string, unknown>[] => {
  const value = input[section];
  return Array.isArray(value) ? value.filter(isRecord) : [];
};

/* ------------------------------------------------------------- collecting */

/** What one conversion accumulates besides the draft. */
export interface Conversion {
  schema: SiteSchema;
  options: ConvertOptions;
  warnings: MigrationWarning[];
  preserved: PreservedText[];
}

export function warn(
  c: Conversion,
  code: MigrationWarningCode,
  field?: string,
  detail?: Record<string, string | number>,
): void {
  c.warnings.push({ code, ...(field ? { field } : {}), ...(detail ? { detail } : {}) });
}

/**
 * The source's own name for a field — `섹션 › 칸` — which is what a preserved
 * copy is filed under. Falls back to the id for a field the schema lacks.
 */
export function labelOf(c: Conversion, sectionId: string, fieldId?: string): string {
  const section = c.schema.sections.find((s) => s.id === sectionId);
  if (!section) return fieldId ?? sectionId;
  const field = fieldId ? section.fields.find((f) => f.id === fieldId) : undefined;
  return field ? `${section.label} › ${field.label}` : section.label;
}

export function preserve(c: Conversion, label: string, value: string): void {
  if (value.trim()) c.preserved.push({ label, text: value });
}

/* ---------------------------------------------------------- normalizing */

/** `{user}` / `{char}` — not the doubled forms, which are ours already. */
const SINGLE_BRACES = /(?<!\{)\{(user|char)\}(?!\})/gi;

/** `{user}` → `{{user}}`, `{char}` → `{{char}}`; `{{user}}` is left alone. */
export const normalizeBraces = (value: string): string =>
  value.replace(SINGLE_BRACES, (_, name: string) => `{{${name.toLowerCase()}}}`);

/**
 * Image references in our one spelling: BabeChat's `img:[x]` and Crack's older
 * `{{img: x}}` become `{{img::x}}`; `{{img::x}}` is already it.
 */
export const normalizeImageRefs = (value: string): string =>
  value
    .replace(/img:\[([^\]\n]+)\]/g, (_, ref: string) => `{{img::${ref.trim()}}}`)
    .replace(/\{\{\s*img\s*:(?!:)\s*([^{}\n]+?)\s*\}\}/gi, (_, ref: string) => `{{img::${ref}}}`);

/**
 * Words a public page shows where the reader's name goes — Zeta's `Guest`,
 * Crack's `사용자`. They cannot be told apart from the same word used as a word,
 * so they are pointed out rather than replaced.
 */
const PLACEHOLDERS: { name: string; pattern: RegExp }[] = [
  { name: 'Guest', pattern: /\bGuest\b/g },
  { name: '사용자', pattern: /사용자/g },
];

function placeholderWarnings(c: Conversion, field: string, value: string): void {
  for (const { name, pattern } of PLACEHOLDERS) {
    const count = value.match(pattern)?.length ?? 0;
    if (count > 0) warn(c, 'placeholderName', field, { name, count });
  }
}

/** Prose the model or a reader reads: trimmed, macros and image references in our spelling. */
export function prose(c: Conversion, field: string, value: unknown): string {
  const raw = text(value).trim();
  const out = normalizeImageRefs(c.options.normalizeBraces === false ? raw : normalizeBraces(raw));
  placeholderWarnings(c, field, out);
  return out;
}

/** A one-line value: a name, a label. */
export const line = (value: unknown): string => text(value).replace(/\s*\n\s*/g, ' ').trim();

/* --------------------------------------------------------------- scenes */

/** A Zeta turn marker: `@이름: …`, or `@: …` for the narrator. */
const ZETA_TURN = /^[ \t]*@([^:\n]{0,40}):[ \t]?(.*)$/;

/** A line with quoted dialogue in it. */
const QUOTED = /"[^"\n]+"|“[^”\n]+”/;

/** The reader's own name, which is never on the roster and never a mistake. */
const USER_MACRO = '{{user}}';

export function speakerMode(c: Conversion, field: string): SpeakerMode {
  const mode = c.options.speaker?.[field];
  return mode === 'character' || mode === 'narrator' || mode === 'verbatim' ? mode : 'auto';
}

/**
 * The member a scene field's lines go to: the one the creator picked for it,
 * else `fallback`, else the first. Undefined only when there is no roster.
 */
export function mainSpeaker(
  c: Conversion,
  field: string,
  roster: readonly string[],
  fallback = 0,
): string | undefined {
  const picked = c.options.mainSpeaker?.[field];
  if (typeof picked === 'number' && Number.isInteger(picked) && roster[picked] !== undefined) {
    return roster[picked];
  }
  return roster[fallback] ?? roster[0];
}

/** The first roster member a Zeta scene names with `@이름:` or a speaker prefix. */
export function firstSpeaker(value: string, roster: readonly string[]): number {
  for (const row of value.split('\n')) {
    const name = ZETA_TURN.exec(row)?.[1]?.trim() ?? lineSpeaker(row, roster);
    const at = name ? roster.indexOf(name) : -1;
    if (at >= 0) return at;
  }
  return -1;
}

/** One line under a speaker mode (`SpeakerMode`), for lines nothing else decided. */
function byMode(row: string, mode: SpeakerMode, roster: readonly string[], main: string | undefined): string {
  if (!main) return row;
  if (mode === 'character' || (mode === 'auto' && QUOTED.test(row))) return spokenBy(row, main, roster);
  return row;
}

/**
 * Scene text — an opening, a first message, an example turn — in our speech
 * protocol (`speech.ts`). The field's speaker mode decides each line, except on
 * Zeta, whose turns already say who speaks: `@이름: …` becomes `이름: …` and
 * `@: …` a narrator line whatever the mode, and the lines after a turn marker
 * belong to that turn. A name off the roster stays as written — the parser then
 * reads it as narration — and is pointed out, except `{{user}}`.
 *
 * `verbatim` also leaves macro and image spellings as pasted.
 */
export function scene(
  c: Conversion,
  field: string,
  value: unknown,
  roster: readonly string[],
  main: string | undefined,
  zeta: boolean,
): string {
  const mode = speakerMode(c, field);
  let body = text(value).trim();
  if (mode === 'verbatim') placeholderWarnings(c, field, body);
  else body = prose(c, field, body);

  const unknown = new Set<string>();
  // undefined: no Zeta turn yet; null: the narrator's turn; a string: that name's.
  let turn: string | null | undefined;
  const rows = body.split('\n').map((row) => {
    if (zeta) {
      const marker = ZETA_TURN.exec(row);
      if (marker) {
        const name = marker[1]!.trim();
        turn = name || null;
        if (!name) return marker[2]!;
        if (!roster.includes(name) && name !== USER_MACRO) unknown.add(name);
        return `${name}: ${marker[2]!}`.trimEnd();
      }
      if (turn === null) return row;
      if (turn !== undefined) return spokenBy(row, turn, [...roster, turn]);
    }
    return byMode(row, mode, roster, main);
  });
  for (const name of unknown) warn(c, 'speakerNotInRoster', field, { name });
  return rows.join('\n');
}

/* ---------------------------------------------------------------- lists */

/** Keywords as a source lists them: split on `,` `|` and newlines, trimmed, de-duplicated. */
export const splitKeywords = (value: unknown, separators = /[,|\n]/): string[] => [
  ...new Set(
    text(value)
      .split(separators)
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword.length > 0),
  ),
];

/**
 * A plot's tags from a source's tag field: keywords, with `#` as one more
 * separator so a pasted `#로맨스 #학원물` reads as two, each cut to our length and
 * the list to our count.
 */
export function plotTags(c: Conversion, field: string, value: unknown): string[] {
  const tags: string[] = [];
  for (const tag of splitKeywords(value, /[,|\n#]/)) {
    if (tag.length > MAX_TAG_LENGTH) warn(c, 'truncated', field, { limit: MAX_TAG_LENGTH, length: tag.length });
    const cut = clip(tag, MAX_TAG_LENGTH).trim();
    if (cut && !tags.includes(cut)) tags.push(cut);
  }
  if (tags.length > MAX_TAGS) warn(c, 'tooMany', field, { limit: MAX_TAGS, count: tags.length });
  return tags.slice(0, MAX_TAGS);
}

/* --------------------------------------------------------------- limits */

/** Where a sentence may end: the punctuation and the line break. */
const SENTENCE_END = /[.?!。？！…\n]/;

/**
 * `value` cut to `max` UTF-16 units — the unit our limits are counted in, as
 * `.length` counts them — without splitting a surrogate pair.
 */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * `value` cut to `max` at the last sentence boundary inside the limit, or at the
 * limit itself when there is none.
 */
export function cutAtSentence(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = clip(value, max);
  for (let i = head.length - 1; i > 0; i -= 1) {
    if (SENTENCE_END.test(head[i]!)) return head.slice(0, i + 1).trimEnd();
  }
  return head.trimEnd();
}

/**
 * `value` within `max`, cut at a sentence when it is longer — with a warning,
 * and the whole original kept under `label` so nothing is lost.
 */
export function limited(c: Conversion, field: string, label: string, value: string, max: number): string {
  if (value.length <= max) return value;
  warn(c, 'truncated', field, { limit: max, length: value.length });
  preserve(c, label, value);
  return cutAtSentence(value, max);
}

/**
 * Rows past our cap: dropped with a warning, their text kept. `describe` turns
 * a dropped row into what is preserved.
 */
export function capped<T>(
  c: Conversion,
  section: string,
  items: T[],
  max: number,
  describe: (item: T) => string,
): T[] {
  if (items.length <= max) return items;
  warn(c, 'tooMany', section, { limit: max, count: items.length });
  for (const item of items.slice(max)) preserve(c, labelOf(c, section), describe(item));
  return items.slice(0, max);
}

/* ----------------------------------------------------------------- lore */

/** A keyword-triggered entry with every field our lorebook requires, at the defaults. */
export const loreEntry = (
  keys: string[],
  content: string,
  insertionOrder: number,
  extra: Partial<LoreEntry> = {},
): LoreEntry => ({
  keys,
  secondaryKeys: [],
  selective: false,
  content,
  enabled: true,
  constant: false,
  insertionOrder,
  caseSensitive: false,
  useRegex: false,
  position: 'before_char',
  ...extra,
});

/**
 * The constant "image list" entry (D7): one line per described asset, so the
 * model can pick a picture the way the source picked by description.
 *
 * The syntax is shown once and the list gives bare names. The prompt keeps
 * asset macros as written, so the model reads `{{img::이름}}` here the way it
 * reads its own earlier ones in the history.
 */
export function imageListEntry(c: Conversion, insertionOrder: number): LoreEntry | undefined {
  const seen = new Set<string>();
  const rows: string[] = [];
  const assets: unknown[] = Array.isArray(c.options.assets) ? c.options.assets : [];
  for (const asset of assets) {
    if (!isRecord(asset)) continue;
    const name = line(asset['name']);
    const description = line(asset['description']);
    if (!name || !description || seen.has(name)) continue;
    seen.add(name);
    rows.push(`- ${name}: ${description}`);
  }
  if (rows.length === 0) return undefined;
  const content = [
    '[이미지] 아래 목록에 지금 장면에 맞는 그림이 있으면, 그 그림을 {{img::이름}} 표기로 한 줄에 출력한다.',
    ...rows,
  ].join('\n');
  return loreEntry([], content, insertionOrder, { constant: true, position: 'after_char' });
}

/**
 * The names of the lore rows, which our entries have no field for (§3.3), kept
 * as one list so the creator can still tell which entry was which.
 */
export function preserveLoreNames(
  c: Conversion,
  label: string,
  named: { name: string; keys: string[]; order: number }[],
): void {
  const rows = named
    .filter(({ name }) => name)
    .map(({ name, keys, order }) => `${order + 1}. ${name}${keys.length ? ` (${keys.join(', ')})` : ''}`);
  preserve(c, label, rows.join('\n'));
}
