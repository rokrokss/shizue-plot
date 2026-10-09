/**
 * Splits markdown into top-level blocks, so a streaming message can re-parse
 * only the paragraph it is still writing.
 *
 * The contract the rest of the pipeline leans on is stronger than "roughly
 * paragraphs": `splitBlocks(md).join('') === md`, and a block that is already
 * finished keeps the exact same string as more text arrives. That is what lets
 * MessageBody memoize a block by its content and never think about it again.
 *
 * A block therefore owns the blank lines that ended it: the separator is part of
 * the block before it, and a block is only handed over once a non-blank line has
 * proved the separator was final.
 */

/**
 * ``` or ~~~, optionally indented up to three spaces, with an info string.
 * Lines keep their terminator here, so the tail is matched rather than anchored.
 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)/;

const isBlank = (line: string): boolean => line.trim() === '';

/**
 * Whether `line` closes a fence opened with `marker`: same character, at least
 * as long, and nothing after it. A fence opened with ``` is not closed by ~~~.
 */
function closesFence(line: string, marker: string): boolean {
  const match = FENCE_RE.exec(line);
  if (!match) return false;
  const found = match[1]!;
  return found[0] === marker[0] && found.length >= marker.length && match[2]!.trim() === '';
}

/**
 * Top-level blocks, in order, each keeping its own trailing newlines.
 *
 * An empty string has no blocks; an unterminated fence is one block, however
 * many blank lines are inside it.
 */
export function splitBlocks(md: string): string[] {
  if (md === '') return [];

  // Keeping the terminators on the lines is what makes the join exact: the last
  // line of a file with no trailing newline is not given one back.
  const lines = md.match(/[^\n]*\n|[^\n]+/g) ?? [];

  const blocks: string[] = [];
  let current = '';
  /** The open fence's marker, or null outside a fence. */
  let fence: string | null = null;
  /** Set once a blank line ended the current block; the next real line splits. */
  let separated = false;

  for (const line of lines) {
    if (fence !== null) {
      current += line;
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    if (isBlank(line)) {
      // A leading blank line belongs to nothing; it is its own scrap of a block
      // rather than the opening of the next one, so the join stays exact.
      current += line;
      if (current.trim() !== '') separated = true;
      continue;
    }

    if (separated) {
      blocks.push(current);
      current = '';
      separated = false;
    }

    current += line;
    const opened = FENCE_RE.exec(line);
    if (opened) fence = opened[1]!;
  }

  if (current !== '') blocks.push(current);
  return blocks;
}
