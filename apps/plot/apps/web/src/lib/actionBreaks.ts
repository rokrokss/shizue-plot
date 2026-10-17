/**
 * A character's `*지문*` and their words as paragraphs of their own, as Zeta draws
 * a reply (2026-10-17 owner decision): wherever the model ran an action and a
 * line together — `*카타나를 쥐며* 합동 훈련 따위 필요 없어.` — the action stands
 * on its own and the words follow after a paragraph's gap. Only how the text is
 * drawn and edited: the model's output and the stored message are not touched
 * until the reader saves an edit, which starts from this same text.
 *
 * Every single-asterisk span is an action, a short `*정말*` inside a line too, as
 * Zeta reads them. Left as written: `**bold**`, code (fenced or in backticks),
 * a line holding HTML, and a line that names its speaker (`이름: …`, `@이름: …`),
 * whose text belongs to that speaker only while it stays on that line.
 */

/** A single-asterisk span the markdown reads as emphasis: no space just inside, no `**` around. */
const ACTION = /(?<![*\\])\*(?![\s*])((?:[^*\n]*?[^\s*\\])?)\*(?!\*)/g;
/** A line that opens or closes a fenced code block. */
const FENCE = /^\s{0,3}(```|~~~)/;
/** A line with markup in it: its asterisks may sit inside an attribute or a tag's text. */
const MARKUP = /<[A-Za-z!/]/;
/** A line that names its speaker, as the speech protocol and the reader's write-as do. */
const SPEAKER = /^\s*@?[^\s:*`<>]{1,40}\s*[:：]/;
/** A line markdown reads as a list item, a heading, a quote or a table row, which a cut would break. */
const STRUCTURE = /^\s*(?:[-+*]\s|\d+[.)]\s|#|>|\|)/;

/** The line cut where an action meets other text; the line itself when there is nothing to cut. */
function splitLine(line: string): string[] {
  if (!line.includes('*') || line.includes('`') || MARKUP.test(line) || SPEAKER.test(line) || STRUCTURE.test(line)) {
    return [line];
  }
  const pieces: string[] = [];
  let at = 0;
  for (const match of line.matchAll(ACTION)) {
    const before = line.slice(at, match.index).trim();
    if (before) pieces.push(before);
    pieces.push(match[0]);
    at = match.index + match[0].length;
  }
  const after = line.slice(at).trim();
  if (after) pieces.push(after);
  return pieces.length > 1 ? pieces : [line];
}

/**
 * The text with every action and the words around it in paragraphs of their own.
 * Lines a paragraph already ran together (`*웃는다*\n안녕`) are parted by a
 * blank line as well, where one side of the break is an action.
 */
export function separateActions(text: string): string {
  if (!text.includes('*')) return text;
  const out: string[] = [];
  let fenced = false;
  /** Whether the last line written was a whole action, which a next line of words is parted from. */
  let lastAction = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || FENCE.test(line)) {
      out.push(line);
      lastAction = false;
      continue;
    }
    const pieces = splitLine(line);
    const whole = pieces.length === 1 && pieces[0] === line;
    if (whole && !line.trim()) {
      out.push(line);
      lastAction = false;
      continue;
    }
    const firstIsAction = isAction(pieces[0]!);
    // A line run straight on from the one before, where either side is an action.
    if (out.length > 0 && out[out.length - 1]!.trim() && (lastAction || firstIsAction)) out.push('');
    out.push(pieces.join('\n\n'));
    lastAction = isAction(pieces[pieces.length - 1]!);
  }
  return out.join('\n');
}

/** One action and nothing else; not global, so it keeps no place between calls as `ACTION` would. */
const WHOLE_ACTION = new RegExp(`^${ACTION.source}$`);

/** Whether a piece is one action and nothing else. */
const isAction = (piece: string): boolean => WHOLE_ACTION.test(piece.trim());
