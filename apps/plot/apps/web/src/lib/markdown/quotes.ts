/**
 * Dialogue typography: a rehype plugin that wraps quoted speech in `<q
 * data-dialogue>` so the stylesheet can tell what a character *said* from what
 * they *did* (`*지문*`, already an `<em>`).
 *
 * The quotation marks stay in the text and the element re-generates none of its
 * own (`quotes: none` in globals.css) — the model wrote 「」 or «» for a reason,
 * and swapping them for the browser's idea of a quote would be a translation.
 *
 * A pair that has only opened is left as plain text. During streaming every line
 * of dialogue spends a second in that state, and wrapping it early would restyle
 * the rest of the paragraph until the closer arrived.
 */
import { rewriteText, text, type HastNode } from './hast';

/** Open/close pairs, in the order they are tried. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['«', '»'],
];

const OPENERS = new Map(PAIRS.map((pair) => [pair[0], pair]));

/**
 * Index of the mark closing the pair opened at `from`, or -1.
 *
 * Distinct marks nest, so 「그가 「…」 했다」 finds its own closer; a pair written
 * with the same mark on both ends cannot nest and takes the next one it finds.
 */
function findClose(value: string, from: number, open: string, close: string): number {
  let depth = 1;
  for (let i = from + 1; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    } else if (ch === open && open !== close) {
      depth += 1;
    }
  }
  return -1;
}

/** The text, with each closed pair turned into a `<q>` holding its own marks. */
function wrap(value: string): HastNode[] | null {
  const out: HastNode[] = [];
  let plain = '';
  let i = 0;
  while (i < value.length) {
    const pair = OPENERS.get(value[i]!);
    const end = pair ? findClose(value, i, pair[0], pair[1]) : -1;
    if (!pair || end < 0) {
      plain += value[i];
      i += 1;
      continue;
    }
    if (plain) {
      out.push(text(plain));
      plain = '';
    }
    const inner = wrap(value.slice(i + 1, end));
    out.push({
      type: 'element',
      tagName: 'q',
      properties: { dataDialogue: '' },
      children: [text(pair[0]), ...(inner ?? [text(value.slice(i + 1, end))]), text(pair[1])],
    });
    i = end + 1;
  }
  if (out.length === 0) return null;
  if (plain) out.push(text(plain));
  return out;
}

/** Wraps closed quotation pairs outside code in `<q data-dialogue>`. */
export function rehypeDialogueQuotes() {
  return (tree: HastNode): undefined => {
    rewriteText(tree, wrap);
    return undefined;
  };
}
