/**
 * Reader presets (docs/ARCHITECTURE.md §5, §6 프리셋): a reader's own additions
 * to the prompt preset — a main-instruction addition and a global note — kept on
 * the account and picked per chat (`chats.reader_preset_id`).
 *
 * Only ever the reader's own text: a row holds what its owner wrote or imported,
 * nothing of any work, and every read is scoped by its owner — the chat's, when
 * a generation reads the one its chat points at.
 */
import type { ReaderAdditions } from '@shizue/core';
import { readerPresets, type Chat, type ReaderPreset } from '@shizue/db';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import { badRequest, notFound } from './errors.js';
import { isUuid } from './util.js';

/** A preset of this user, or 404 — the same rule as every other owned resource. */
export async function loadOwnedReaderPreset(deps: AppDeps, id: string, userId: string): Promise<ReaderPreset> {
  const [preset] = await deps.db
    .select()
    .from(readerPresets)
    .where(and(eq(readerPresets.id, id), eq(readerPresets.userId, userId)))
    .limit(1);
  if (!preset) throw notFound('Reader preset not found');
  return preset;
}

/** `PATCH /api/chats/:id`'s `readerPresetId`: null, or one of the caller's presets. */
export async function resolveReaderPresetId(deps: AppDeps, userId: string, value: unknown): Promise<string | null> {
  if (value === null) return null;
  if (typeof value !== 'string') throw badRequest('invalid_request', 'readerPresetId must be a string or null');
  if (!isUuid(value)) throw notFound('Reader preset not found');
  return (await loadOwnedReaderPreset(deps, value, userId)).id;
}

/**
 * What a generation on this chat adds to its preset: the chat's reader preset,
 * read under the chat owner's id — a pointer at anyone else's row adds nothing.
 */
export async function loadReaderAdditions(deps: AppDeps, chat: Chat): Promise<ReaderAdditions | undefined> {
  if (!chat.readerPresetId) return undefined;
  const [preset] = await deps.db
    .select({ main: readerPresets.main, globalNote: readerPresets.globalNote })
    .from(readerPresets)
    .where(and(eq(readerPresets.id, chat.readerPresetId), eq(readerPresets.userId, chat.userId)))
    .limit(1);
  return preset;
}
