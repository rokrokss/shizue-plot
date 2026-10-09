/**
 * Reusable user notes (see docs/ARCHITECTURE.md, Phase 4 / Chunk 11).
 *
 * A note belongs to the account and is attached to any number of chats. The
 * contents of the attached notes are merged into the author's note slot behind
 * the chat's own note, so one prompt sees `chats.note` first and then every
 * attached note, bodies only.
 */
import { chatNoteLinks, userNotes, type Chat, type UserNote } from '@shizue/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import { notFound } from './errors.js';

/** Notes one account may keep. */
export const MAX_USER_NOTES = 100;
/** Characters one note may hold. */
export const MAX_NOTE_LENGTH = 2000;
/** Notes one chat may have attached. */
export const MAX_CHAT_NOTES = 10;

/**
 * The notes attached to a chat, oldest note first — the order the prompt uses.
 * The link carries no ordering of its own, so creation order is the stable one.
 */
async function loadAttachedNotes(deps: AppDeps, chatId: string): Promise<UserNote[]> {
  return deps.db
    .select({ note: userNotes })
    .from(chatNoteLinks)
    .innerJoin(userNotes, eq(chatNoteLinks.noteId, userNotes.id))
    .where(eq(chatNoteLinks.chatId, chatId))
    .orderBy(asc(userNotes.createdAt), asc(userNotes.id))
    .then((rows) => rows.map((row) => row.note));
}

export async function attachedNoteIds(deps: AppDeps, chatId: string): Promise<string[]> {
  return (await loadAttachedNotes(deps, chatId)).map((note) => note.id);
}

/** The same ids for several chats at once, so a chat list stays one query. */
export async function attachedNoteIdsByChat(
  deps: AppDeps,
  chatIds: string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (chatIds.length === 0) return grouped;

  const rows = await deps.db
    .select({ chatId: chatNoteLinks.chatId, noteId: chatNoteLinks.noteId })
    .from(chatNoteLinks)
    .innerJoin(userNotes, eq(chatNoteLinks.noteId, userNotes.id))
    .where(inArray(chatNoteLinks.chatId, chatIds))
    .orderBy(asc(userNotes.createdAt), asc(userNotes.id));
  for (const row of rows) {
    grouped.set(row.chatId, [...(grouped.get(row.chatId) ?? []), row.noteId]);
  }
  return grouped;
}

/** The chat's own note followed by the attached bodies, blank-line separated. */
function buildAuthorNote(chat: Chat, notes: UserNote[]): string {
  return [chat.note, ...notes.map((note) => note.content)]
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/** The author's note slot for one generation: chat note plus attached notes. */
export async function loadAuthorNote(deps: AppDeps, chat: Chat): Promise<string> {
  return buildAuthorNote(chat, await loadAttachedNotes(deps, chat.id));
}

/** A note of this user, or 404 — the same rule as every other owned resource. */
export async function loadOwnedNote(deps: AppDeps, id: string, userId: string): Promise<UserNote> {
  const [note] = await deps.db
    .select()
    .from(userNotes)
    .where(and(eq(userNotes.id, id), eq(userNotes.userId, userId)))
    .limit(1);
  if (!note) throw notFound('Note not found');
  return note;
}
