/**
 * RisuAI's `parseThoughtsAndTools` (`src/ts/parser/parser.svelte.ts`, e773240),
 * which its `ParseMarkdown` runs over every message after the display scripts
 * and before the markdown: a `<Thoughts>…</Thoughts>` — the reasoning a preset
 * asks the model to write first, or the one a module wraps around it — becomes
 * a fold, `<details><summary>{language.cot}</summary>…</details>`, closed until
 * the reader opens it; and a `<tool_call>` becomes the line that says a tool was
 * called. Nested `<Thoughts>` count, so only the one closing the outermost ends
 * the fold; one never closed is left as written, which the sanitizer then
 * unwraps (it keeps no `<thoughts>` element) and so shows its text.
 *
 * Here it runs where the markup it makes is read: over each prose segment before
 * it is cut into prose and markup (`MessageBody`), so the fold is a block of
 * the message's own HTML, and over each island before its markdown
 * (`renderIsland`). A `<Thoughts>` one segment opens and another closes is
 * therefore not folded — RisuAI's runs over the whole message as one string —
 * but the module that wraps a reply's reasoning wraps it in one script's output,
 * which is one island.
 */

/** The two strings the fold writes, in the reader's language (RisuAI's `cot` and `toolCalled`). */
export interface ThoughtLabels {
  /** The fold's summary. */
  cot: string;
  /** The tool line; `{{tool}}` is where the tool's name goes. */
  toolCalled: string;
}

const OPEN = '<Thoughts>';
const CLOSE = '</Thoughts>';
const TOOL_CALL_RE = /<tool_call>(.+?)<\/tool_call>/gms;

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `parseThoughtsAndTools`, as RisuAI writes it; the labels are escaped, being text. */
export function parseThoughtsAndTools(data: string, labels: ThoughtLabels): string {
  if (!data.includes(OPEN) && !data.includes('<tool_call>')) return data;
  let result = '';
  let i = 0;
  while (i < data.length) {
    if (data.startsWith(OPEN, i)) {
      let j = i + OPEN.length;
      let depth = 1;
      while (j < data.length && depth > 0) {
        if (data.startsWith(OPEN, j)) depth += 1;
        if (data.startsWith(CLOSE, j)) depth -= 1;
        j += 1;
      }
      if (depth === 0) {
        result += `<details><summary>${escapeText(labels.cot)}</summary>${data.substring(i + OPEN.length, j - 1)}</details>`;
        i = j + OPEN.length;
        continue;
      }
    }
    result += data[i];
    i += 1;
  }
  return result.replace(TOOL_CALL_RE, (_call, text: string) => {
    const tool = text.split('')[1] ?? 'unknown';
    return `<div class="x-risu-tool-call">🛠️ ${escapeText(labels.toolCalled.replace('{{tool}}', tool))}</div>\n\n`;
  });
}
