import {
  MAX_READER_PRESETS,
  READER_PRESET_INTEGRATION_MAX,
  READER_PRESET_NAME_MAX,
  READER_PRESET_TEXT_MAX,
} from '@shizue/core';
import { readerPresets, user, type ReaderPreset } from '@shizue/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps.js';
import { badRequest } from '../errors.js';
import { loadOwnedReaderPreset } from '../readerPresets.js';
import { optionalString, readJsonBody, requireUuidParam } from '../util.js';

/** A preset as its owner sees it — their own text, and nothing else. */
const toReaderPresetJson = (preset: ReaderPreset) => ({
  id: preset.id,
  name: preset.name,
  main: preset.main,
  globalNote: preset.globalNote,
  /** RisuAI's preset toggles (`customPromptTemplateToggle`), drawn first among a chat's toggles. */
  toggles: preset.toggles,
  /** RisuAI's `moduleIntergration`: the namespaces whose library modules a chat on it turns on. */
  moduleIntegration: preset.moduleIntegration,
  createdAt: preset.createdAt.toISOString(),
  updatedAt: preset.updatedAt.toISOString(),
});

interface PresetFields {
  name?: string;
  main?: string;
  globalNote?: string;
  toggles?: string;
  moduleIntegration?: string;
}

/** The fields a body may set, each checked against its cap; `name` may not be blank. */
function presetFields(body: Record<string, unknown>): PresetFields {
  const name = optionalString(body, 'name')?.trim();
  const main = optionalString(body, 'main');
  const globalNote = optionalString(body, 'globalNote');
  const toggles = optionalString(body, 'toggles');
  const moduleIntegration = optionalString(body, 'moduleIntegration');
  if (name === '') throw badRequest('invalid_request', 'name must not be blank');
  if (name !== undefined && name.length > READER_PRESET_NAME_MAX) {
    throw badRequest('reader_preset_limit', `name must be at most ${READER_PRESET_NAME_MAX} characters`);
  }
  for (const [key, text] of [['main', main], ['globalNote', globalNote], ['toggles', toggles]] as const) {
    if (text !== undefined && text.length > READER_PRESET_TEXT_MAX) {
      throw badRequest('reader_preset_limit', `${key} must be at most ${READER_PRESET_TEXT_MAX} characters`);
    }
  }
  if (moduleIntegration !== undefined && moduleIntegration.length > READER_PRESET_INTEGRATION_MAX) {
    throw badRequest(
      'reader_preset_limit',
      `moduleIntegration must be at most ${READER_PRESET_INTEGRATION_MAX} characters`,
    );
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(main !== undefined ? { main } : {}),
    ...(globalNote !== undefined ? { globalNote } : {}),
    ...(toggles !== undefined ? { toggles } : {}),
    ...(moduleIntegration !== undefined ? { moduleIntegration } : {}),
  };
}

/**
 * The reader's own presets (§10): list, create, edit, delete. There is no
 * export — a preset is the reader's text, and the import that fills one runs in
 * the browser (`@shizue/core/reader-preset`), which sends only what it took.
 */
export function readerPresetRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const rows = await deps.db
      .select()
      .from(readerPresets)
      .where(eq(readerPresets.userId, c.get('userId')))
      .orderBy(asc(readerPresets.createdAt), asc(readerPresets.id));
    return c.json(rows.map(toReaderPresetJson));
  });

  app.post('/', async (c) => {
    const userId = c.get('userId');
    const fields = presetFields(await readJsonBody(c));
    if (fields.name === undefined) throw badRequest('invalid_request', 'name must be a string');

    // The cap is a count: queue on the account row, as the notes do, so two
    // requests racing at the last slot cannot both see room.
    const created = await deps.db.transaction(async (tx) => {
      await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update');
      const [counted] = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(readerPresets)
        .where(eq(readerPresets.userId, userId));
      if ((counted?.value ?? 0) >= MAX_READER_PRESETS) {
        throw badRequest('reader_preset_limit', `A user may keep at most ${MAX_READER_PRESETS} reader presets`);
      }
      const [row] = await tx
        .insert(readerPresets)
        .values({
          userId,
          name: fields.name!,
          main: fields.main ?? '',
          globalNote: fields.globalNote ?? '',
          toggles: fields.toggles ?? '',
          moduleIntegration: fields.moduleIntegration ?? '',
        })
        .returning();
      return row!;
    });
    return c.json(toReaderPresetJson(created), 201);
  });

  app.put('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadOwnedReaderPreset(deps, id, userId);
    const fields = presetFields(await readJsonBody(c));
    const [updated] = await deps.db
      .update(readerPresets)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(readerPresets.id, id), eq(readerPresets.userId, userId)))
      .returning();
    return c.json(toReaderPresetJson(updated!));
  });

  app.delete('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadOwnedReaderPreset(deps, id, userId);
    // Chats that picked it go back to none: chats.reader_preset_id is set null.
    await deps.db.delete(readerPresets).where(and(eq(readerPresets.id, id), eq(readerPresets.userId, userId)));
    return c.body(null, 204);
  });

  return app;
}
