import { stripImageMacros } from './macro.js';
import { isNarration, narrationBody } from './narration.js';
import { NARRATION_HEADER } from './prompt.js';
import { spokenBy } from './speech.js';

/**
 * One transcript line for the sidecar models (memory, relationship, suggestions).
 * A narrating turn moves the scene rather than speaking — whoever sent it — so
 * attributing it to the reader or to a character would write false memories
 * either way, and it goes out speaker-less under the same header the main prompt
 * uses.
 *
 * An assistant turn names its own speakers: the script protocol writes each
 * member's lines under `이름: ` and the scene under no prefix at all, so the text
 * is already attributed and one name in front of the whole turn would be wrong
 * for every line but the first. The exception is a reply stored under one
 * member — a group turn's — which carries no prefix of its own: given
 * `speakerName`, its lines go under that name (`spokenBy`). The reader's own turn
 * is the persona's.
 *
 * The API's copy (`apps/api/src/transcript.ts`) is this without the speaker; it
 * moves here when the API tags its transcripts.
 */
export function transcriptLine(
  message: { role: 'user' | 'assistant'; content: string },
  userName: string,
  speakerName?: string,
): string {
  if (isNarration(message.content)) {
    return `${NARRATION_HEADER} ${stripImageMacros(narrationBody(message.content)).trim()}`;
  }
  const text = stripImageMacros(message.content);
  if (message.role === 'user') return `${userName}: ${text}`;
  return speakerName !== undefined ? spokenBy(text, speakerName) : text;
}
