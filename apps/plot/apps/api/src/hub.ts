import { MAX_TAG_LENGTH, MAX_TAGS, stripImageMacros, stripVariableMacros } from '@shizue/core';
import { characters, type Character, type Db, type Plot } from '@shizue/db';
import { asc, eq } from 'drizzle-orm';
import type { Tx } from './deps.js';

/**
 * A member's avatar, addressed under the plot it belongs to: a character has no
 * address of its own, so every route that serves one goes through its work.
 */
export const avatarUrl = (
  character: Pick<Character, 'id' | 'plotId' | 'avatarPath'>,
): string | null =>
  character.avatarPath
    ? `/api/plots/${character.plotId}/characters/${character.id}/avatar`
    : null;

/** The plot's cover; the route serves the bytes, exactly as an avatar's does. */
export const coverUrl = (plot: Pick<Plot, 'id' | 'coverPath'>): string | null =>
  plot.coverPath ? `/api/plots/${plot.id}/cover` : null;

/** A plot's tags: trimmed, de-duped and capped. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const trimmed = tag.trim().slice(0, MAX_TAG_LENGTH);
    if (trimmed) seen.add(trimmed);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

/**
 * An opening as the work page previews it. Image macros go because they are
 * references a preview does not resolve, variable macros because they are
 * protocol the model reads rather than prose. Stripping happens before any
 * cut: slicing first can leave half a reference behind.
 */
export const introPreview = (text: string): string => stripVariableMacros(stripImageMacros(text));

/** A plot's roster, in the creator's order — the order the prompt is written in. */
export async function loadMembers(db: Db | Tx, plotId: string): Promise<Character[]> {
  return db
    .select()
    .from(characters)
    .where(eq(characters.plotId, plotId))
    .orderBy(asc(characters.orderIndex), asc(characters.createdAt));
}

/**
 * A member as the play view names one: a face and a name — and the nickname its
 * card goes by, or null. A RisuAI card's `{{char}}` is that nickname, so the
 * model writes the member's lines under it as well, and the screen needs it to
 * tell whose lines they are.
 */
export const toPlayMemberJson = (member: Character) => ({
  id: member.id,
  name: member.name,
  nickname: member.card.nickname?.trim() || null,
  avatarUrl: avatarUrl(member),
});
