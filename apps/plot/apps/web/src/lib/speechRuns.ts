import { parseAssistantSpeech } from '@shizue/core/speech';

/**
 * A reply, cut into the runs its speakers wrote.
 *
 * The parser answers with parts — dialogue and 상황묘사 told apart — and this puts
 * the character's 상황묘사 back into its `*…*`, because that is markdown emphasis
 * and the message body already draws emphasis the way the design asks a
 * description to be drawn. Rebuilding rather than rendering the parts one by one
 * is what keeps a line reading as a line: `안녕 *웃으며* 반가워` is one sentence
 * with a description inside it, not three stacked blocks.
 *
 * The narrator's text is left exactly as it was written, newlines and all: it is
 * all 상황묘사, so it needs no marks — the run itself is drawn in italics.
 */
export interface SpeechRun {
  /** The roster member speaking, or null for the narrator. */
  name: string | null;
  /** The run as markdown. */
  text: string;
}

/**
 * Pure and cheap, so a streaming reply can be re-cut on every render: a half
 * written last line is one run now and another once the rest of it lands.
 */
export function speechRuns(content: string, roster: readonly string[]): SpeechRun[] {
  return parseAssistantSpeech(content, roster).map((block) =>
    block.speaker.kind === 'character'
      ? {
          name: block.speaker.name,
          text: block.parts
            .map((part) => (part.kind === 'description' ? `*${part.text}*` : part.text))
            .join(' '),
        }
      : { name: null, text: block.parts.map((part) => part.text).join('\n\n') },
  );
}
