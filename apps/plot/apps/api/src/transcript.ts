import { transcriptLine, type ReaderMember } from '@shizue/core';
import type { Character, Message } from '@shizue/db';

/**
 * A stretch of the branch as the sidecar models read it (memory, relationship,
 * suggestions), one `transcriptLine` (@shizue/core) per message: a group turn's
 * reply under its speaker's name, and the lines the reader wrote as a member or
 * as the narrator under them. `members` is the roster, by whose ids the replies
 * name their speakers; a speaker no longer on it leaves the reply as it reads.
 */
export function transcriptOf(
  path: readonly Pick<Message, 'role' | 'content' | 'speakerMemberId'>[],
  userName: string,
  members: readonly Pick<Character, 'id' | 'name' | 'card'>[],
): string {
  const readers: ReaderMember[] = members.map((member) => ({
    id: member.id,
    names: [member.name, ...(member.card.nickname?.trim() ? [member.card.nickname.trim()] : [])],
  }));
  const names = new Map(members.map((member) => [member.id, member.name]));
  return path
    .map((message) =>
      transcriptLine(
        message,
        userName,
        message.speakerMemberId !== null ? names.get(message.speakerMemberId) : undefined,
        readers,
      ),
    )
    .join('\n');
}
