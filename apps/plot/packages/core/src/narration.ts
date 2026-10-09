/**
 * Narration — a message that moves the scene rather than whoever sent it.
 *
 * It is an ordinary message stored verbatim, prefix and all, and the role does not
 * decide: the reader types the prefix on a turn of their own, the server writes it
 * on a narration turn the model generated, and both read back as the same thing.
 * The prefix is a convention, not a column — nothing in the schema knows about it,
 * so narration turns branch, swipe and regenerate like any other message.
 *
 * The cost of a content convention is that a character opening a reply with `@:`
 * of its own accord reads as narration. That is the convention working as
 * specified, not a case to detect.
 */

/** What a narration message begins with. */
export const NARRATION_PREFIX = '@:';

export function isNarration(content: string): boolean {
  return content.trimStart().startsWith(NARRATION_PREFIX);
}

/** The message without its prefix — what a reader is meant to see. */
export function narrationBody(content: string): string {
  const text = content.trimStart();
  return isNarration(content) ? text.slice(NARRATION_PREFIX.length).trim() : text.trim();
}

/**
 * The text as a narration message. Written by the server on a generated narration
 * turn: the model is told to produce the scene alone, but a model that wrote the
 * prefix anyway must not end up with two, so the body is taken first either way.
 */
export function withNarrationPrefix(text: string): string {
  return `${NARRATION_PREFIX} ${narrationBody(text)}`;
}
