import { parseAssistantSpeech } from '@shizue/core/speech';
import { splitBlocks } from './markdown/blocks';

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
 * The unattributed text is left exactly as it was written, newlines and all: in
 * a reply with an owner it is the owner's (`speaker`, below), and in a scene with
 * several speakers and none it is all 상황묘사, which needs no marks — the run
 * itself is drawn in italics.
 */
export interface SpeechRun {
  /** The roster member speaking, or null for the scene's own lines. */
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
 * The last line of a reply still being written, while it may yet be a speaker's
 * name with its colon to come (`아리` of `아리아: …`, by roster name or alias),
 * is held back, `content` without it. Read now, it would be a scene's line of
 * its own and cut the run before it short, which would be drawn as settled
 * markdown until the colon lands and joins the line to it again (or to its new
 * speaker's run). Its newline, or a letter no name goes on with, lets it go.
 */
function withoutNameInProgress(content: string, named: readonly string[]): string {
  const line = content.slice(content.lastIndexOf('\n') + 1);
  const start = line.trimStart();
  const name = start.trimEnd();
  if (!name || name.includes(':')) return content;
  // The parser trims the name, so a whole one may be followed by spaces.
  const pending = named.some((other) => other.startsWith(start) || other === name);
  return pending ? content.slice(0, content.length - line.length) : content;
}

/**
 * Pure and cheap, so a streaming reply can be re-cut on every render: a half
 * written last line is one run now and another once the rest of it lands. With
 * `streaming`, `content` is the end of a reply still being written, and a last
 * line that may yet be a name is not drawn until it is one or is not
 * (`withoutNameInProgress`).
 *
 * `aliases` (`speakerAliases`) are read as the members they belong to: a line
 * under a nickname is attributed to the member's own name, and runs of one
 * member under both spellings are one run.
 *
 * `speaker` says the lines that name no one in a reply that has one owner: a
 * message a card's script wrote as its character (`source` `script`), which
 * RisuAI draws as that character's own; a group reply, stored under its
 * speaker; a one-member plot's message that names no one at all, which
 * `MessageBody` (`soleMember`) decides over the whole message. Those lines are
 * the owner's own 지문 and speech, and go in the owner's run exactly as written —
 * a line that names someone is still theirs. Without it they are the scene's (a message with
 * several speakers and no owner).
 */
export function speechRuns(
  content: string,
  roster: readonly string[],
  aliases: ReadonlyMap<string, string> = NO_ALIASES,
  speaker: string | null = null,
  streaming = false,
): SpeechRun[] {
  const named = aliases.size > 0 ? [...roster, ...aliases.keys()] : roster;
  const runs: SpeechRun[] = [];
  // Paragraph by paragraph: the parser reads a blank line as spacing and drops
  // it, and a run that goes on past one is still a paragraph apart — a reply
  // that writes a `*지문*` and its line as two paragraphs keeps them two.
  for (const paragraph of splitBlocks(streaming ? withoutNameInProgress(content, named) : content)) {
    let fresh = true;
    for (const block of parseAssistantSpeech(paragraph, named)) {
      const run: SpeechRun =
        block.speaker.kind === 'character'
          ? {
              name: aliases.get(block.speaker.name) ?? block.speaker.name,
              text: block.parts
                .map((part) => (part.kind === 'description' ? `*${part.text}*` : part.text))
                .join(' '),
            }
          : { name: speaker, text: block.parts.map((part) => part.text).join('\n\n') };
      const last = runs[runs.length - 1];
      // Within a paragraph, only a character's: the parser already keeps the
      // scene's lines together. Across one, the scene's too.
      if (last && last.name === run.name && (run.name !== null || fresh)) {
        last.text += fresh ? `\n\n${run.text}` : `\n${run.text}`;
      } else runs.push(run);
      fresh = false;
    }
  }
  return runs;
}
