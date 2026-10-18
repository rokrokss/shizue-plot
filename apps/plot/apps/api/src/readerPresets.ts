/**
 * Reader presets (docs/ARCHITECTURE.md §5, §6 프리셋): a reader's own prompt
 * presets in RisuAI's shape, kept on the account and picked per chat
 * (`chats.reader_preset_id`), where one replaces the built-in default.
 *
 * Only ever the reader's own text: a row holds what its owner wrote or imported,
 * nothing of any work, and every read is scoped by its owner — the chat's, when
 * a generation reads the one its chat points at.
 */
import { presetDefaultVariables, readerPromptPreset, type PromptPreset, type Variables } from '@shizue/core';
import { readerPresets, type Chat, type Plot, type ReaderPreset } from '@shizue/db';
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
 * The prompt preset a generation on this chat runs in place of the built-in
 * default: the chat's reader preset, read under the chat owner's id — a pointer
 * at anyone else's row is no preset.
 */
export async function loadReaderPreset(deps: AppDeps, chat: Chat): Promise<PromptPreset | undefined> {
  if (!chat.readerPresetId) return undefined;
  const [preset] = await deps.db
    .select({
      main: readerPresets.main,
      globalNote: readerPresets.globalNote,
      jailbreak: readerPresets.jailbreak,
      formatingOrder: readerPresets.formatingOrder,
      promptTemplate: readerPresets.promptTemplate,
      groupTemplate: readerPresets.groupTemplate,
      groupOtherBotRole: readerPresets.groupOtherBotRole,
    })
    .from(readerPresets)
    .where(and(eq(readerPresets.id, chat.readerPresetId), eq(readerPresets.userId, chat.userId)))
    .limit(1);
  return preset ? readerPromptPreset(preset) : undefined;
}

/**
 * The variables a chat reads where nothing set one: its work's defaults, then
 * its reader preset's (RisuAI's `templateDefaultVariables`, `presetDefaultVariables`)
 * — the preset read under the chat owner's id, as `loadReaderPreset` reads it.
 */
export async function chatDefaultVariables(
  deps: AppDeps,
  chat: Pick<Chat, 'userId' | 'readerPresetId'>,
  plot: Pick<Plot, 'customUi'> | null | undefined,
): Promise<Variables | undefined> {
  const work = plot?.customUi?.defaultVariables;
  if (!chat.readerPresetId) return work;
  const [preset] = await deps.db
    .select({ defaultVariables: readerPresets.defaultVariables })
    .from(readerPresets)
    .where(and(eq(readerPresets.id, chat.readerPresetId), eq(readerPresets.userId, chat.userId)))
    .limit(1);
  return presetDefaultVariables(work, preset?.defaultVariables);
}
