/**
 * The studio's "장면 제목" action: a `# ` line at the caret's line, ready for the
 * title. The chat draws a `#`/`##` line in an opening as a Zeta scene heading
 * (`MessageBody`'s `sceneHeadings`), and the model reads it as it was written —
 * it is the opening's own text, as a prologue's heading is in Zeta and RisuAI.
 *
 * A blank line becomes the heading; a line with words in it moves down under a
 * new one; a line that is a heading already is left alone. `caret` is where the
 * title goes: after the `# `, or at the end of a heading already there.
 */

const HEADING_START = /^ {0,3}#{1,2}[ \t]/;
const MARK = '# ';

export function insertSceneHeading(text: string, caret: number): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const newline = text.indexOf('\n', at);
  const end = newline === -1 ? text.length : newline;
  const line = text.slice(start, end);
  if (HEADING_START.test(line)) return { text, caret: end };
  if (!line.trim()) return { text: text.slice(0, start) + MARK + text.slice(end), caret: start + MARK.length };
  return { text: `${text.slice(0, start)}${MARK}\n${text.slice(start)}`, caret: start + MARK.length };
}
