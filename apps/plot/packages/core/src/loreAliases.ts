/**
 * Korean aliases for a lorebook written in another language (ARCHITECTURE §6
 * 로어북, §7.9). In the `instruct` language mode a Korean reader writes Korean
 * and the model answers in Korean, so an English book's keys never meet the
 * chat and its lore goes silent. The API asks the auxiliary model, once per
 * entry, for the Korean a reader would write for what each keyed entry is about,
 * stores the answer apart from the entry (`lore_entry_aliases`) and hands it to
 * the activation as `ActivateLoreInput.aliases`. Measured offline on 2026-10-15
 * (four RisuRealm books, 160 Korean windows): F1 0.90 against 0.07 for the
 * English keys alone and 0.42 for the best vector setting, at the same lore
 * tokens per turn.
 *
 * The pure half: which entries are aliased, which books need it, the request
 * and its batches, and reading the answer. Storage, scheduling and the call are
 * the API's (`loreAliases.ts`).
 */
import type { LoreEntry } from './types.js';
import { countTokens } from './tokens.js';

/** The language aliases are written in. Only Korean was measured, so only Korean is made. */
export const LORE_ALIAS_LANGUAGE = 'ko' as const;

/**
 * Below this share of keyed entries carrying a Hangul key, a book counts as one
 * whose keys a Korean reader never types. RisuRealm creators add Korean keys
 * beside English ones on most of their entries (the four measured books: 76–95%);
 * an English book from chub or SillyTavern has none.
 */
export const KOREAN_KEY_SHARE = 0.2;

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const HANGUL_SYLLABLE = /[가-힯]/;

/**
 * Keys nobody types: a script's switch (`__HOGWARTS_START_ADULT__`), a toggle
 * (`@@year1@@`), a RisuAI folder (`folder:<id>`, sometimes behind U+F000).
 */
const SENTINEL_KEY = /^?(?:__.+__|@@.+@@|folder:)/;

/** The keys of an entry a reader could type: trimmed, the empty and the switches left out. */
export function naturalKeys(entry: Pick<LoreEntry, 'keys'>): string[] {
  return entry.keys.map((key) => key.trim()).filter((key) => key.length > 0 && !SENTINEL_KEY.test(key));
}

/**
 * An entry the chat activates by its keys: switched on, with something to say,
 * not always on, not a character's note, and with at least one key a reader
 * could type. What the alias pass aliases, and what a book's key language is
 * judged on.
 */
export function isKeyedLoreEntry(entry: LoreEntry): boolean {
  return (
    entry.enabled &&
    !entry.constant &&
    !entry.depthPrompt &&
    entry.content.trim().length > 0 &&
    naturalKeys(entry).length > 0
  );
}

/**
 * Whether a Korean reader's turns would leave the book's keys unmatched: it has
 * keyed entries, and fewer than `KOREAN_KEY_SHARE` of them carry a Hangul key.
 */
export function lacksKoreanKeys(entries: readonly LoreEntry[]): boolean {
  const keyed = entries.filter(isKeyedLoreEntry);
  if (keyed.length === 0) return false;
  const korean = keyed.filter((entry) => entry.keys.some((key) => HANGUL.test(key))).length;
  return korean / keyed.length < KOREAN_KEY_SHARE;
}

/**
 * What an entry's aliases are made from, and so what they are stored under (the
 * API hashes it): its keys and its content. Editing either makes new aliases;
 * its secondary keys, order and settings do not touch them.
 */
export const aliasSourceText = (entry: Pick<LoreEntry, 'keys' | 'content'>): string =>
  JSON.stringify([entry.keys, entry.content]);

/** Most aliases kept for one entry, as the prompt allows. */
export const MAX_ALIASES_PER_ENTRY = 12;

/**
 * The instruction, as the 2026-10-15 experiment's import-time prompt wrote it,
 * for a book in any language rather than English alone. The rules keep aliases
 * to the distinctive forms: two syllables at least, never a word ordinary Korean
 * is full of — the measured aliases fired on 0.05 small-talk turns, where the
 * creators' own one-syllable Korean keys (문, 은, 금) fired on 0.9.
 */
export const LORE_ALIAS_PROMPT = `You are preparing a lorebook written in another language (usually English) so that it still activates when a Korean reader plays it.
Lore entries activate when one of their keys appears in the latest chat messages. The reader writes in Korean and the model replies in Korean, so the entries' own keys never match. For each entry below, given its keys and the start of its content, list the Korean strings that a Korean reader, or a model writing Korean, would actually type when referring to what this entry is about.

How keys match: case-insensitive SUBSTRING match, with all spaces removed from both the key and the chat text. So "마법 약" and "마법약" are the same key, and a key also matches inside longer words.

Rules
- For each proper noun, give the Korean form Korean players would write. Where a well-known Korean rendering exists (official Korean translations of famous works, the standard Korean names of mythological figures and places, Sino-Korean readings of Chinese names that the content gives in hanzi), use it. Add a common variant spelling only if players really use one.
- For common nouns and concepts that are keys (a school subject, an institution, an item, a rule), give the natural Korean word(s) for them.
- Write stems only: no particles or endings (not "덤블도어가", just "덤블도어").
- Every alias must be at least 2 syllables. Never use a word that commonly appears in unrelated Korean text (e.g. 은, 금, 문, 관, 집, 사람, 시간, 오늘, 학교 alone when the entry is one specific school's detail). Prefer the distinctive form ("호그와트 교장" or "덤블도어", not "교장").
- Do not add keys for things the entry only mentions in passing; alias what the existing keys stand for.
- 1 to 8 aliases per entry; up to ${MAX_ALIASES_PER_ENTRY} only for an entry with many distinct keys.

Output: one JSON object mapping each entry's [number] (as a string) to its list of Korean aliases, covering every entry listed. Nothing else.`;

/** Longest alias kept: a name or a short phrase, not a sentence. */
const MAX_ALIAS_LENGTH = 40;
/** How much of an entry's content the model reads: the experiment's 600 characters. */
const PREVIEW_CHARS = 600;
/** Keys shown per entry; a book that lists dozens on one entry repeats itself. */
const MAX_KEYS_SHOWN = 24;
/** One request's entry list at most, in tokens, so a batch fits any model's context with room for the answer. */
export const ALIAS_BATCH_TOKENS = 6_000;
/** Entries one request carries at most, so its answer stays well under its token cap. */
export const ALIAS_BATCH_ENTRIES = 30;

/** One entry as the request lists it: its number, its typable keys and the start of its content. */
export function aliasEntryLine(number: number, entry: Pick<LoreEntry, 'keys' | 'content'>): string {
  const keys = naturalKeys(entry).slice(0, MAX_KEYS_SHOWN);
  const preview = entry.content.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
  return `[${number}] keys: ${JSON.stringify(keys)}\n  ${preview}`;
}

/**
 * The entries, by index, split into requests: in order, a request closed once
 * the next entry would take it past `ALIAS_BATCH_TOKENS` or it holds
 * `ALIAS_BATCH_ENTRIES`. Every request carries at least one entry.
 */
export function aliasBatches(entries: readonly Pick<LoreEntry, 'keys' | 'content'>[]): number[][] {
  const batches: number[][] = [];
  let batch: number[] = [];
  let tokens = 0;
  entries.forEach((entry, index) => {
    const cost = countTokens(aliasEntryLine(batch.length + 1, entry)) + 1;
    if (batch.length > 0 && (tokens + cost > ALIAS_BATCH_TOKENS || batch.length >= ALIAS_BATCH_ENTRIES)) {
      batches.push(batch);
      batch = [];
      tokens = 0;
    }
    batch.push(index);
    tokens += cost;
  });
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** One request: the instruction as the system text, the entries — numbered from 1 — as the user turn. */
export function aliasRequest(entries: readonly Pick<LoreEntry, 'keys' | 'content'>[]): {
  system: string;
  messages: { role: 'user'; content: string }[];
} {
  return {
    system: LORE_ALIAS_PROMPT,
    messages: [{ role: 'user', content: entries.map((entry, at) => aliasEntryLine(at + 1, entry)).join('\n') }],
  };
}

/**
 * One alias as kept: whitespace collapsed, holding Hangul, two characters at
 * least without its spaces and at most `MAX_ALIAS_LENGTH`. Null for anything
 * else.
 */
function cleanAlias(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!HANGUL_SYLLABLE.test(text) || text.length > MAX_ALIAS_LENGTH) return null;
  return text.replace(/ /g, '').length >= 2 ? text : null;
}

/**
 * The aliases an answer gives entries 1 to `count`: the first JSON object in it
 * (a code fence or a preamble around it is tolerated), each entry's list cleaned
 * (`cleanAlias`), the same alias twice — spacing and case aside — kept once, at
 * most `MAX_ALIASES_PER_ENTRY`. An entry the answer leaves out has none. Null
 * when the answer is not that object at all — a refusal, or one cut off.
 */
export function parseLoreAliases(raw: string, count: number): string[][] | null {
  const text = raw.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const answer = parsed as Record<string, unknown>;
  return Array.from({ length: count }, (_, at) => {
    const listed = answer[String(at + 1)];
    if (!Array.isArray(listed)) return [];
    const kept: string[] = [];
    const seen = new Set<string>();
    for (const value of listed) {
      const alias = cleanAlias(value);
      if (!alias) continue;
      const key = alias.toLowerCase().replace(/ /g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(alias);
      if (kept.length === MAX_ALIASES_PER_ENTRY) break;
    }
    return kept;
  });
}
