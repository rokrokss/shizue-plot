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

const NO_ALIASES: ReadonlyMap<string, string> = new Map();

/**
 * The other names a member's lines may go by, each mapped to the member's own.
 *
 * RisuAI's `{{char}}` is a card's nickname where it sets one, so a model told
 * about `{{char}}` writes `세이 님: …` for the member called `세이`. Those lines are
 * still that member's, and are drawn with the member's face and under the member's name. A nickname that is
 * also some member's own name is that member's; between two members sharing a
 * nickname, the first on the roster has it. A member's `aliases` — the name its
 * scripts renamed it from — are read the same way, after its nickname: the lines
 * written before the rename are still its, drawn under the name it has now.
 */
export function speakerAliases(
  members: readonly {
    name: string;
    nickname?: string | null | undefined;
    aliases?: readonly string[] | undefined;
  }[],
): ReadonlyMap<string, string> {
  const names = new Set(members.map((member) => member.name));
  const aliases = new Map<string, string>();
  for (const member of members) {
    for (const other of [member.nickname, ...(member.aliases ?? [])]) {
      const alias = other?.trim();
      if (!alias || names.has(alias) || aliases.has(alias)) continue;
      aliases.set(alias, member.name);
    }
  }
  return aliases.size > 0 ? aliases : NO_ALIASES;
}

/**
 * Pure and cheap, so a streaming reply can be re-cut on every render: a half
 * written last line is one run now and another once the rest of it lands.
 *
 * `aliases` (`speakerAliases`) are read as the members they belong to: a line
 * under a nickname is attributed to the member's own name, and runs of one
 * member under both spellings are one run.
 */
export function speechRuns(
  content: string,
  roster: readonly string[],
  aliases: ReadonlyMap<string, string> = NO_ALIASES,
): SpeechRun[] {
  const named = aliases.size > 0 ? [...roster, ...aliases.keys()] : roster;
  const runs: SpeechRun[] = [];
  for (const block of parseAssistantSpeech(content, named)) {
    const run: SpeechRun =
      block.speaker.kind === 'character'
        ? {
            name: aliases.get(block.speaker.name) ?? block.speaker.name,
            text: block.parts
              .map((part) => (part.kind === 'description' ? `*${part.text}*` : part.text))
              .join(' '),
          }
        : { name: null, text: block.parts.map((part) => part.text).join('\n\n') };
    const last = runs[runs.length - 1];
    // Only a character's: the parser already keeps the narrator's lines together.
    if (last && run.name !== null && last.name === run.name) last.text += `\n${run.text}`;
    else runs.push(run);
  }
  return runs;
}
