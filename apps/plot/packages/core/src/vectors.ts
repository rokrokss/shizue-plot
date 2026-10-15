/**
 * SillyTavern's Vector Storage (`public/scripts/extensions/vectors/index.js`),
 * the two parts the server runs with its embedder (the API's `vectors.ts`):
 *
 * - **Vectorized World Info.** An entry marked `vectorized` — or every entry,
 *   under the book's `vectorizeAll` — activates when its content is among the
 *   `maxEntries` closest to the latest turns, scoring at least the threshold,
 *   as one more way in beside its keys (`ActivateLoreInput.vectorMatched`).
 * - **Chat vectorization.** The earlier messages of the branch most like the
 *   latest turns are taken out of the history and sent instead in one block
 *   after the memory (`retrievalBlock`), so the model reads them however long
 *   ago they were.
 *
 * Both search with one query, ST's `getQueryText`: the newest `query` messages
 * the model may read, newest first. The chat search keeps ST's defaults. The
 * lore search keeps them only for a model nobody measured: a measured one gets
 * the bar measured for it and for where the turns stand against the lore
 * (`vectorLoreBar`), and in the `instruct` language mode it stands in for keys
 * a Korean reader never types until the book's Korean aliases land
 * (`vectorLoreSearch`).
 */
import { isKeyedLoreEntry, lacksKoreanKeys, naturalKeys } from './loreAliases.js';
import type { MacroLocale } from './macro.js';
import { countTokens } from './tokens.js';
import type { LoreEntry, LoreSettings } from './types.js';

/**
 * ST's World Info vector settings: `query`, `score_threshold` and `max_entries`,
 * at their defaults — the bar of a model with none measured (`VECTOR_LORE_BARS`).
 */
export const VECTOR_LORE = {
  /** The newest messages the search reads. */
  query: 2,
  /** The least cosine similarity that activates an entry. */
  scoreThreshold: 0.25,
  /** The most entries one search activates, over the whole book. */
  maxEntries: 5,
} as const;

/** What a lore search keeps: the entries at or above the threshold, the best `maxEntries` of them. */
export interface VectorLoreBar {
  scoreThreshold: number;
  maxEntries: number;
}

/**
 * The bars measured for a model (ARCHITECTURE §7.3 의미로 켜는 로어의 문턱), by
 * where the turns stand against the lore:
 *
 * - `cross` — the turns are in the reader's language, the lore in another, and no
 *   key reaches the reader (the `instruct` mode over an English book with no
 *   aliases yet). KURE-v1, Korean turns against English lore: 0.48 and 3. 0.47
 *   had the best F1 (0.42) on 160 windows and every leave-one-card-out fold
 *   picked 0.46–0.47; 0.48 has the same F1 and was the first threshold no pure
 *   small-talk window reached (their best entry topped out at 0.475). ST's 0.25/5
 *   put 4.5 entries into every turn, 80% of them wrong. Cap 3 matched or beat 5
 *   at every threshold from 0.45 up.
 * - `crossKeyed` — the same, but the book's keys already reach the reader: its
 *   own Korean keys, or its aliases. On top of them the leave-one-card-out folds
 *   picked 0.56–0.61; below that the vector only adds wrong entries (shipped
 *   RisuRealm keys F1 0.78 alone, 0.63 with the vector at 0.47).
 * - `same` — the turns in the lore's language. Not measured: 0.52 is provisional,
 *   from the English-on-English control (related pairs about 0.08 higher than
 *   across languages). Only an entry or book that asks for it is searched.
 *
 * Another model gets ST's defaults (`VECTOR_LORE`): a number measured on one
 * model says nothing about another's cosines.
 */
export const VECTOR_LORE_BARS: Readonly<
  Record<string, { cross: VectorLoreBar; crossKeyed: VectorLoreBar; same: VectorLoreBar }>
> = {
  'KURE-v1': {
    cross: { scoreThreshold: 0.48, maxEntries: 3 },
    crossKeyed: { scoreThreshold: 0.57, maxEntries: 3 },
    same: { scoreThreshold: 0.52, maxEntries: 3 },
  },
};

/** The bar a search with `model` keeps to, where the turns stand as they do. */
export function vectorLoreBar(model: string, crossLanguage: boolean, keysReach: boolean): VectorLoreBar {
  const bars = VECTOR_LORE_BARS[model];
  if (!bars) return { scoreThreshold: VECTOR_LORE.scoreThreshold, maxEntries: VECTOR_LORE.maxEntries };
  return !crossLanguage ? bars.same : keysReach ? bars.crossKeyed : bars.cross;
}

/**
 * An entry the search takes by default in place of keys the reader cannot type
 * (`vectorLoreSearch`): keyed (`isKeyedLoreEntry` — no constant, which is sent
 * anyway, no keyless entry and no key that is only a script's switch, which
 * their authors gate on purpose), not waiting for recursion, and not wrapped in
 * a `{{#…}}` block that a toggle opens.
 */
export function isVectorFallbackCandidate(entry: LoreEntry): boolean {
  return isKeyedLoreEntry(entry) && !entry.delayUntilRecursion && !/^\s*\{\{#/.test(entry.content);
}

/** What one request's lore search looks for and keeps. */
export interface VectorLoreSearch {
  /** The entries it compares. */
  candidate: (entry: LoreEntry) => boolean;
  bar: VectorLoreBar;
  /** Whether it searches by default, for a Korean reader whose keys are not there yet. */
  fallback: boolean;
}

/**
 * The lore search one request runs, or null for none:
 *
 * - **Asked for**: an entry marked `vectorized`, or every entry under the book's
 *   `vectorizeAll` — ST's rule (`isVectorLoreCandidate`), constants included.
 * - **By default**, only in the `instruct` mode for a Korean reader
 *   (`crossLanguage` `ko`), only over a book without Korean keys
 *   (`lacksKoreanKeys`) and only with a measured model: its keyed entries that
 *   have no aliases yet (`aliased`) — so the search goes quiet entry by entry as
 *   the alias pass covers the book, and is off once it has.
 *
 * The bar is the model's for the language pair (`vectorLoreBar`); the keys reach
 * a Korean reader where the book has Korean keys of its own, or aliases for
 * every keyed entry.
 */
export function vectorLoreSearch(input: {
  model: string;
  entries: readonly LoreEntry[];
  settings: Pick<LoreSettings, 'vectorizeAll'> | undefined;
  /** The reader's language where the turns are in it and the lore is not — the `instruct` mode's. */
  crossLanguage?: MacroLocale;
  /** Whether an entry has Korean aliases to be found by. Absent: none has. */
  aliased?: (entry: LoreEntry) => boolean;
}): VectorLoreSearch | null {
  const { model, entries, settings, crossLanguage } = input;
  const aliased = input.aliased ?? (() => false);
  const korean = crossLanguage === 'ko';
  const needsAliases = korean && VECTOR_LORE_BARS[model] !== undefined && lacksKoreanKeys(entries);
  const fallback = (entry: LoreEntry): boolean => needsAliases && isVectorFallbackCandidate(entry) && !aliased(entry);
  const candidate = (entry: LoreEntry): boolean => isVectorLoreCandidate(entry, settings) || fallback(entry);
  if (!entries.some(candidate)) return null;
  const pending = entries.some(fallback);
  const keysReach = korean && entries.some(isKeyedLoreEntry) && (needsAliases ? !pending : !lacksKoreanKeys(entries));
  return { candidate, bar: vectorLoreBar(model, crossLanguage !== undefined, keysReach), fallback: pending };
}

/** ST's chat vectorization settings, at their defaults. */
export const RETRIEVAL_DEFAULTS = {
  /** `protect` (Retain#): the newest messages that are never taken out of their place. */
  protect: 5,
  /** `insert` (Insert#): how many chunks the search returns, which become at most that many messages. */
  insert: 3,
  /** The newest messages the search reads. */
  query: 2,
  /** `message_chunk_size`: a message is embedded in pieces of at most this many characters. */
  chunkSize: 400,
  /** The least cosine similarity a chunk must score. */
  scoreThreshold: 0.25,
  /** `template`: what the found messages are sent in. */
  template: 'Past events:\n{{text}}',
} as const;

/**
 * A chat's retrieval setting (`chats.retrieval`): whether its earlier messages
 * are searched and brought back. Null or absent is off, as in ST.
 */
export interface ChatRetrievalSettings {
  enabled?: boolean;
}

/** Whether the chat searches its own earlier messages. */
export const retrievalEnabled = (settings: ChatRetrievalSettings | null | undefined): boolean =>
  settings?.enabled === true;

/**
 * Whether an entry activates by meaning: enabled, with something to embed, and
 * marked — or the book marks every entry. ST's `activateWorldInfo` skips the
 * disabled, the empty and the unmarked the same way.
 */
export function isVectorLoreCandidate(
  entry: LoreEntry,
  settings: Pick<LoreSettings, 'vectorizeAll'> | undefined,
): boolean {
  return (
    entry.enabled &&
    entry.content.trim().length > 0 &&
    (entry.vectorized === true || settings?.vectorizeAll === true)
  );
}

/** ST's `collapseNewlines`: every run of line breaks one. */
export const collapseNewlines = (text: string): string => text.replace(/\n+/g, '\n');

/**
 * ST's `getQueryText`: the newest `count` messages that have any text, newest
 * first, one per line, with runs of line breaks collapsed. `texts` is the
 * branch the model reads, oldest first — the messages hidden from it left out.
 */
export function vectorQueryText(texts: readonly string[], count: number): string {
  const newest = texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .reverse()
    .slice(0, count);
  return collapseNewlines(newest.join('\n')).trim();
}

/**
 * ST's `splitRecursive`: `input` split on the first delimiter, any piece still
 * `length` or longer split again on the next, and then neighbours joined back
 * while they fit. Splitting on '' — the last resort — is by UTF-16 unit, as there.
 * `measure` is what `length` counts: UTF-16 units, as ST counts them, unless the
 * caller counts tokens (`loreChunks`). Each piece and the delimiter are measured
 * once and a joined chunk is their sum — exact for UTF-16 units, and for tokens
 * an estimate that never re-encodes a growing chunk, which on text without
 * spaces (Chinese) would take the tokenizer quadratic time over and over.
 */
export function splitRecursive(
  input: string,
  length: number,
  delimiters: readonly string[] = ['\n\n', '\n', ' ', ''],
  measure: (text: string) => number = (text) => text.length,
): string[] {
  if (length <= 0) return [input];
  return splitMeasured(input, length, delimiters, measure).map((piece) => piece.text);
}

/**
 * `splitRecursive` with each chunk's size, which the level above sums rather
 * than measures again; `known` is the input's, where the caller has it. A level
 * whose delimiter the input lacks passes it down unmeasured.
 */
function splitMeasured(
  input: string,
  length: number,
  delimiters: readonly string[],
  measure: (text: string) => number,
  known?: number,
): { text: string; size: number }[] {
  const delimiter = delimiters[0] ?? '';
  if (delimiter !== '' && !input.includes(delimiter)) {
    const size = known ?? measure(input);
    return size < length ? [{ text: input, size }] : splitMeasured(input, length, delimiters.slice(1), measure, size);
  }
  // Past the last delimiter there is nothing finer to split on; ST would recurse forever on length 1.
  const flat = input.split(delimiter).flatMap((part) => {
    const size = measure(part);
    return size < length || delimiter === '' ? [{ text: part, size }] : splitMeasured(part, length, delimiters.slice(1), measure, size);
  });
  const gap = delimiter ? measure(delimiter) : 0;
  const chunks: { text: string; size: number }[] = [];
  for (let at = 0; at < flat.length; ) {
    let { text, size } = flat[at]!;
    let next = at + 1;
    while (next < flat.length && size + gap + flat[next]!.size <= length) {
      text += delimiter + flat[next]!.text;
      size += gap + flat[next]!.size;
      next += 1;
    }
    at = next;
    chunks.push({ text, size });
  }
  return chunks;
}

/**
 * The pieces a message is embedded in for the chat's retrieval: ST's
 * `splitByChunks` at `RETRIEVAL_DEFAULTS.chunkSize`, with nothing embedded for
 * a piece that is only whitespace.
 */
export const retrievalChunks = (text: string): string[] =>
  splitRecursive(text, RETRIEVAL_DEFAULTS.chunkSize).filter((chunk) => chunk.trim().length > 0);

/**
 * How long one embedded piece of a lore entry is at most, in the tokens
 * `countTokens` counts: about 512 of KURE-v1's, whose tokenizer spends 1.2
 * tokens on English for every one of these and 0.95 on Korean (measured
 * 2026-10-15). A transformer's working memory grows with the square of the
 * longest text in a batch — one 4.1k-token entry cost the process about 0.5 GB
 * over KURE-v1's 2 GB — so no inference is ever longer than this.
 */
export const LORE_CHUNK_TOKENS = 420;

/** Where a long entry is cut: paragraphs, then lines, then sentences, then words, then anywhere. */
const LORE_DELIMITERS = ['\n\n', '\n', '. ', '。', ' ', ''];

/**
 * What a long entry's every piece starts with, so one from its middle still
 * says what it is about: its name (the creator's comment) and its first three
 * typable keys.
 */
export function loreChunkHeader(entry: Pick<LoreEntry, 'name' | 'keys'>): string {
  const name = (entry.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const keys = naturalKeys(entry).slice(0, 3).join(', ');
  return [name, keys].filter((part) => part.length > 0).join(' — ');
}

/**
 * The texts a lore entry is embedded as, one vector each: the content whole
 * when it fits in `LORE_CHUNK_TOKENS`, and otherwise ST's recursive split of it
 * (`splitRecursive`, by paragraph, line and sentence) into pieces that fit with
 * the entry's header (`loreChunkHeader`) before each. The entry's score is its
 * best piece's. SillyTavern embeds an entry whole, which a local model cuts at
 * its window; this is a deliberate departure, so a long entry is searched all
 * through and no inference outgrows the chunk.
 */
export function loreChunks(entry: Pick<LoreEntry, 'name' | 'keys' | 'content'>): string[] {
  const { content } = entry;
  const size = countTokens(content);
  if (size <= LORE_CHUNK_TOKENS) return [content];
  const header = loreChunkHeader(entry);
  const room = Math.max(LORE_CHUNK_TOKENS - (header ? countTokens(header) + 1 : 0), LORE_CHUNK_TOKENS / 2);
  return splitMeasured(content, room, LORE_DELIMITERS, countTokens, size)
    .map((piece) => piece.text.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => (header ? `${header}\n${chunk}` : chunk));
}

/**
 * ST's `getPromptText`: the found messages, each `name: text` as `lines` gives
 * it, runs of line breaks collapsed, a blank line between them, in the template.
 * `lines` comes least relevant first — ST puts the most relevant last, nearest
 * the turns. Empty when nothing was found.
 */
export function retrievalBlock(lines: readonly string[]): string {
  const text = lines
    .map((line) => collapseNewlines(line).trim())
    .filter((line) => line.length > 0)
    .join('\n\n');
  return text ? RETRIEVAL_DEFAULTS.template.replace('{{text}}', () => text) : '';
}
