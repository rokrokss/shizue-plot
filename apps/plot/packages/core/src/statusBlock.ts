/**
 * 상태창 — the state of the scene, written at the end of a turn as a fenced code
 * block with the `status` info string.
 *
 * Like narration and the speech protocol this is a content convention and not a
 * column: the style directive teaches the model to append the fence, this parser
 * reads the same shape back, and what is stored is still one plain string. The
 * first scene's status therefore needs no field of its own — the creator writes
 * the same fence inside an intro.
 *
 * The parser is pure and runs on every render, so it has to be tolerant of a
 * half-arrived message: a fence that has been opened but not closed is not a
 * status block yet and stays in the body, where it reads as the plain text it
 * currently is. It becomes the card once the closing fence lands.
 */

/** One row of a status block. An empty `key` is a line that carried only a value. */
export interface StatusEntry {
  key: string;
  value: string;
}

export interface ExtractedStatus {
  /** The message without the status block. Unchanged when there is none. */
  body: string;
  /** The block's contents, or null when the turn carries no closed status fence. */
  status: string | null;
}

/** A line that is exactly a fence delimiter, opening (```status) or closing (```). */
const CLOSING_FENCE_RE = /^[ \t]*```[ \t]*$/;
const OPENING_STATUS_RE = /^[ \t]*```[ \t]*status[ \t]*$/;
const ANY_FENCE_RE = /^[ \t]*```/;

/**
 * Splits a TRAILING closed status fence off a message. Trailing only: the block
 * is the current state, so only a fence the turn actually ends on counts — a
 * fence with prose after it is quoted or superseded text and stays in the body.
 * This is also what keeps a stream honest: while text is still arriving after
 * an early fence, nothing is extracted until the message really does end on
 * one. Callers strip trailing choice lines before calling this — the model is
 * taught to put the status block before them.
 *
 * Line-walking rather than one regex: the nearest fence delimiter above the
 * closing line must be the ```status opener, which both pins the block to the
 * end and keeps an unrelated trailing code fence out of the card.
 */
export function extractStatusBlock(content: string): ExtractedStatus {
  const lines = content.replace(/\s+$/, '').split(/\r?\n/);
  if (lines.length < 2 || !CLOSING_FENCE_RE.test(lines.at(-1)!)) {
    return { body: content, status: null };
  }
  for (let i = lines.length - 2; i >= 0; i -= 1) {
    if (!ANY_FENCE_RE.test(lines[i]!)) continue;
    if (!OPENING_STATUS_RE.test(lines[i]!)) break;
    return {
      body: lines.slice(0, i).join('\n').trim(),
      status: lines.slice(i + 1, -1).join('\n'),
    };
  }
  return { body: content, status: null };
}

/**
 * The block's rows, in the order the model wrote them. A line is split at its
 * first colon — the model picks the keys, so a value containing one more colon is
 * ordinary text — and a line without any colon is a value with no key.
 */
export function parseStatusEntries(status: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const line of status.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const colon = text.indexOf(':');
    if (colon < 0) {
      entries.push({ key: '', value: text });
      continue;
    }
    entries.push({ key: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() });
  }
  return entries;
}
