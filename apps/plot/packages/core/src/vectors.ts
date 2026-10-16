/**
 * SillyTavern's Vector Storage (`public/scripts/extensions/vectors/index.js`),
 * the part the server runs with its embedder (the API's `vectors.ts`): **chat
 * vectorization.** The earlier messages of the branch most like the latest
 * turns — of those the history no longer sends, the ones the summaries cover —
 * are copied into one block right after the newest turn, after the
 * facts (`retrievalBlock`), so the model reads them however long ago they were.
 * ST takes them out of the chat it sends instead; here the history stays as it
 * is, so the provider's prefix cache keeps it.
 *
 * The search reads one query, ST's `getQueryText`: the newest `query` messages
 * the model may read, newest first, with ST's defaults. It does not run unless
 * the chat asks for it.
 *
 * ST's vectorized World Info is not here: no lore entry activates by meaning
 * (ARCHITECTURE §7.3, removed 2026-10-16). An entry's `vectorized` flag is kept
 * only so an export writes it back.
 */

/** ST's chat vectorization settings, at their defaults. */
export const RETRIEVAL_DEFAULTS = {
  /** `protect` (Retain#): the newest messages, which are never brought back. */
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
 * `length` counts UTF-16 units, as ST counts them. A level whose delimiter the
 * input lacks passes it down to the next.
 */
export function splitRecursive(
  input: string,
  length: number,
  delimiters: readonly string[] = ['\n\n', '\n', ' ', ''],
): string[] {
  if (length <= 0) return [input];
  const delimiter = delimiters[0] ?? '';
  if (delimiter !== '' && !input.includes(delimiter)) {
    return input.length < length ? [input] : splitRecursive(input, length, delimiters.slice(1));
  }
  // Past the last delimiter there is nothing finer to split on; ST would recurse forever on length 1.
  const flat = input
    .split(delimiter)
    .flatMap((part) => (part.length < length || delimiter === '' ? [part] : splitRecursive(part, length, delimiters.slice(1))));
  const chunks: string[] = [];
  for (let at = 0; at < flat.length; ) {
    let chunk = flat[at]!;
    let next = at + 1;
    while (next < flat.length && chunk.length + delimiter.length + flat[next]!.length <= length) {
      chunk += delimiter + flat[next]!;
      next += 1;
    }
    at = next;
    chunks.push(chunk);
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
