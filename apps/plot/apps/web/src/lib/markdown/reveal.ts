/**
 * Word reveal: a rehype plugin, used only while a message is streaming, that
 * puts every word in its own `<span class="shizue-reveal">` so a new word fades in
 * instead of appearing.
 *
 * The spans are numbered in document order. Text only ever arrives at the end,
 * so word *n* stays word *n* and React keeps the element it already mounted —
 * which is the point: a remounted span replays its animation, and a paragraph
 * that re-blurs itself on every token is worse than no animation at all.
 *
 * The plugin is dropped when the stream ends. The spans go with it, and since
 * they hold exactly the text they wrapped, nothing on screen moves.
 */
import { rewriteText, text, type HastNode } from './hast';

/** Words and the whitespace between them, kept apart so the gaps stay plain text. */
const WORD_RE = /\S+/g;

/** Splits prose into numbered word spans, leaving code and dialogue marks alone. */
export function rehypeWordReveal() {
  return (tree: HastNode): undefined => {
    let index = 0;
    rewriteText(tree, (value) => {
      const out: HastNode[] = [];
      let cursor = 0;
      for (const match of value.matchAll(WORD_RE)) {
        if (match.index > cursor) out.push(text(value.slice(cursor, match.index)));
        out.push({
          type: 'element',
          tagName: 'span',
          properties: { className: ['shizue-reveal'], dataI: index },
          children: [text(match[0])],
        });
        index += 1;
        cursor = match.index + match[0].length;
      }
      if (out.length === 0) return null;
      if (cursor < value.length) out.push(text(value.slice(cursor)));
      return out;
    });
    return undefined;
  };
}
