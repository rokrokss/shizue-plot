import { stripImageMacros } from './macro.js';
import { isNarration, narrationBody } from './narration.js';
import { NARRATION_HEADER } from './prompt.js';
import { readerRuns, spokenBy, type ReaderMember } from './speech.js';

/**
 * One transcript line for the sidecar models (memory, suggestions).
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
 * `speakerName`, its lines go under that name (`spokenBy`).
 *
 * The reader's own turn is the persona's — except, given the `members`, the
 * lines the reader wrote as someone else (`readerRuns`): a `@이름:` line goes
 * under that member's roster name and a `@내레이터:` line under the narration
 * header, as the main prompt sends them.
 */
export function transcriptLine(
  message: { role: 'user' | 'assistant'; content: string },
  userName: string,
  speakerName?: string,
  members: readonly ReaderMember[] = [],
): string {
  if (isNarration(message.content)) {
    return `${NARRATION_HEADER} ${stripImageMacros(narrationBody(message.content)).trim()}`;
  }
  const text = stripImageMacros(message.content);
  if (message.role === 'assistant') return speakerName !== undefined ? spokenBy(text, speakerName) : text;
  const runs = readerRuns(text, members);
  if (runs.every((run) => run.kind === 'user')) return `${userName}: ${text}`;
  return runs
    .map((run) => {
      if (run.kind === 'narration') return `${NARRATION_HEADER} ${run.text}`;
      const name = run.kind === 'member' ? members.find((member) => member.id === run.memberId)?.names[0] : undefined;
      return name !== undefined ? spokenBy(run.text, name) : `${userName}: ${run.text}`;
    })
    .join('\n');
}
