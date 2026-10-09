/**
 * 선택지 — what the reader could do next, offered as the last lines of a turn.
 *
 * A content convention like the status block next door: the style directive teaches
 * the model to end its turn with `>> ` lines, this parser reads them back, and the
 * message is stored with them in it. Only a trailing run counts. A `>>` in the
 * middle of a turn is prose, because that is where prose is.
 *
 * Tolerant of a half-arrived message the same way the speech parser is: a line
 * reads as what it currently says. A `>> ` with nothing after it yet is not a
 * choice, so an empty button never appears and then changes its label.
 */

export interface ExtractedChoices {
  /** The message without its choice lines. Unchanged when there are none. */
  body: string;
  /** The offered choices, in the order they were written. */
  choices: string[];
}

/** One choice line: the marker, a separator, and the choice itself. */
const CHOICE_RE = /^>>\s+(\S.*)$/;

/**
 * Splits the trailing run of choice lines off a message. Blank lines inside the
 * run are spacing — the model likes to leave one before the offers — and a line
 * that is neither ends it.
 */
export function extractChoices(content: string): ExtractedChoices {
  const lines = content.split(/\r?\n/);
  const choices: string[] = [];
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1]!.trim();
    if (line) {
      const match = CHOICE_RE.exec(line);
      if (!match) break;
      choices.unshift(match[1]!.trim());
    }
    end -= 1;
  }
  if (choices.length === 0) return { body: content, choices: [] };
  return { body: lines.slice(0, end).join('\n').trimEnd(), choices };
}
