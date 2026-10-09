import { isNarration, narrationBody, NARRATION_HEADER, stripImageMacros } from '@shizue/core';

/**
 * One transcript line for the sidecar models (memory, relationship). A narrating
 * turn moves the scene rather than speaking — whoever sent it — so attributing it
 * to the reader or to a character would write false memories either way, and it
 * goes out speaker-less under the same header the main prompt uses.
 *
 * An assistant turn names its own speakers: the script protocol writes each
 * member's lines under `이름: ` and the scene under no prefix at all, so the text
 * is already attributed and one name in front of the whole turn would be wrong
 * for every line but the first. Only the reader's own turn needs a speaker put on
 * it, and that one is the persona's.
 */
export function transcriptLine(
  message: { role: 'user' | 'assistant'; content: string },
  userName: string,
): string {
  if (isNarration(message.content)) {
    return `${NARRATION_HEADER} ${stripImageMacros(narrationBody(message.content)).trim()}`;
  }
  const text = stripImageMacros(message.content);
  return message.role === 'user' ? `${userName}: ${text}` : text;
}
