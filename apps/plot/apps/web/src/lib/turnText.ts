/**
 * A scene — the narration and replies between two of the reader's own turns — as
 * the one text Zeta's editor holds (2026-10-17 owner decision), and back.
 *
 * Each message opens on its speaker's mark, the same `@이름:` the reader writes
 * as with in the composer: `@:` for narration, a member's name for a group
 * reply, the work's own name for any other reply. A scene of one reply is its
 * text alone, as Zeta shows a one-character turn. Every message's actions and
 * words stand in paragraphs of their own (`separateActions`), as the chat draws
 * them, so the reader edits what they see.
 *
 * Saving reads the marks back into the blocks `POST /api/chats/:id/edit-scene`
 * takes: each part is matched, in order, to the next message of the scene with
 * the same speaker, and one that matches none is a new message.
 */
import { isNarration, narrationBody } from '@shizue/core/narration';
import { separateActions } from './actionBreaks';

/** One message of the scene as the server takes it back. */
export interface SceneBlock {
  /** The message this block came from; absent on a block the reader added. */
  originId?: string;
  kind: 'narration' | 'dialogue';
  /** Narration without its prefix — the server writes that part. */
  content: string;
}

/** What of a message the text is made from. */
export interface TurnMessage {
  id: string;
  content: string;
  speakerMemberId?: string | null;
}

/** Who speaks a message: a member's name by its id, and the name of a reply that names none. */
export interface TurnNames {
  member: (id: string) => string | undefined;
  /** The work's own name: the speaker of a reply no member is tagged on. */
  own: string;
}

/** A speaker's mark at the start of a line: `@이름:` or `@:`, the colon full-width too. */
const MARK = /^@([^\n:：]{0,40})[:：][ \t]*/;

/** The mark a message opens on: '' for narration. */
function keyOf(message: TurnMessage, names: TurnNames): string {
  if (isNarration(message.content)) return '';
  return (message.speakerMemberId ? names.member(message.speakerMemberId) : undefined) ?? names.own;
}

/** A message's text as the editor shows it, without its mark. */
const bodyOf = (message: TurnMessage): string =>
  separateActions(isNarration(message.content) ? narrationBody(message.content) : message.content.trim());

/** The scene as one text, oldest message first. */
export function turnText(scene: readonly TurnMessage[], names: TurnNames): string {
  if (scene.length === 1 && !isNarration(scene[0]!.content)) return bodyOf(scene[0]!);
  return scene.map((message) => `@${keyOf(message, names)}: ${bodyOf(message)}`).join('\n\n');
}

/** The text read back into the scene's blocks, in order; parts left empty are dropped. */
export function turnBlocks(text: string, scene: readonly TurnMessage[], names: TurnNames): SceneBlock[] {
  // What comes before any mark is the first message's, as a scene of one shows it.
  const parts: { key: string; lines: string[] }[] = [{ key: scene[0] ? keyOf(scene[0], names) : names.own, lines: [] }];
  for (const line of text.split('\n')) {
    const mark = MARK.exec(line);
    if (mark) parts.push({ key: mark[1]!.trim(), lines: [line.slice(mark[0].length)] });
    else parts[parts.length - 1]!.lines.push(line);
  }
  const blocks: SceneBlock[] = [];
  let next = 0;
  for (const part of parts) {
    const content = part.lines.join('\n').trim();
    if (!content) continue;
    const kind = part.key === '' ? 'narration' : 'dialogue';
    let at = next;
    while (at < scene.length && keyOf(scene[at]!, names) !== part.key) at += 1;
    if (at < scene.length) {
      blocks.push({ originId: scene[at]!.id, kind, content });
      next = at + 1;
      continue;
    }
    // A new message: a line of someone other than the work's own speaker says
    // whose it is the way a reply does, with their name before it.
    const named = kind === 'dialogue' && part.key !== names.own ? `${part.key}: ${content}` : content;
    blocks.push({ kind, content: named });
  }
  return blocks;
}
