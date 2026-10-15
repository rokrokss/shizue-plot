import { MAX_CARD_IMPORT_BYTES, ModuleParseError, parseRisuModule, plotModuleOf } from '@shizue/core';
import { cardScripts } from '@shizue/core/triggers';
import { chats, readerModules, user, type ReaderModule } from '@shizue/db';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { assetResponse } from '../assets.js';
import { coerceLorebook } from '../card.js';
import type { AppDeps, AppEnv } from '../deps.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import {
  deleteReaderModuleAssets,
  MAX_READER_MODULES,
  readerLibrary,
  readerModuleAssetUrl,
  storeReaderModuleAssets,
} from '../readerModules.js';
import { readJsonBody, requireUuidParam } from '../util.js';

/** As a work's module: names and descriptions are cut to what the studio's are. */
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_FILE_NAME_LENGTH = 255;

/**
 * A library module as its owner lists it: what it is and what it brought, not
 * its scripts — and whether it is on everywhere.
 */
export const toReaderModuleJson = (row: ReaderModule) => {
  const module = row.module;
  return {
    id: row.id,
    name: module.name,
    description: module.description,
    enabledGlobally: row.enabledGlobally,
    loreCount: module.lorebook.length,
    regexCount: module.regex.length,
    triggerCount: module.trigger.length,
    displayScriptCount: module.displayScripts?.length ?? 0,
    assetCount: row.assets.length,
    background: Boolean(module.css || module.backgroundHtml),
    toggles: Boolean(module.toggles?.trim()),
    lowLevelAccess: module.lowLevelAccess === true,
    scripts: cardScripts({ extensions: {} }, [module]) !== null,
    importedFrom: module.importedFrom,
    createdAt: row.createdAt.toISOString(),
  };
};

async function loadOwnedReaderModule(deps: AppDeps, id: string, userId: string): Promise<ReaderModule> {
  const [row] = await deps.db
    .select()
    .from(readerModules)
    .where(and(eq(readerModules.id, id), eq(readerModules.userId, userId)))
    .limit(1);
  if (!row) throw notFound('Module not found');
  return row;
}

/**
 * The reader's module library (§10): RisuAI's module list, the reader's side of
 * it. Import any file RisuAI's module import takes (`parseRisuModule`, the same
 * reader the studio's module import uses), turn one on everywhere or off, take
 * one out, and read a picture one brought. Which chats run a module that is not
 * on everywhere is the chat's own list (`PATCH /api/chats/:id` `modules`).
 */
export function readerModuleRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => c.json((await readerLibrary(deps, c.get('userId'))).map(toReaderModuleJson)));

  /**
   * A module file into the library, the end of it: RisuAI's `importModule`. One
   * that asks for `lowLevelAccess` comes in only on the reader's word
   * (`confirmLowLevelAccess`), as RisuAI asks (`lowLevelAccessConfirm`) — 409
   * `low_level_access_unconfirmed` otherwise, before anything is stored. RisuAI
   * asks it of a module JSON and a charx but not of a `.risum`; here every file
   * is asked alike. Unreadable is a 400 `invalid_module`.
   */
  app.post('/', async (c) => {
    const userId = c.get('userId');
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw badRequest('invalid_request', 'Expected multipart/form-data with a file field');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('invalid_request', 'file field is required');
    if (file.size > MAX_CARD_IMPORT_BYTES) {
      throw new ApiError(413, 'payload_too_large', `A module file is at most ${MAX_CARD_IMPORT_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let parsed: ReturnType<typeof parseRisuModule>;
    try {
      parsed = parseRisuModule(bytes);
    } catch (error) {
      if (error instanceof ModuleParseError) throw badRequest('invalid_module', error.message);
      throw error;
    }
    if (parsed.lowLevelAccess && form.get('confirmLowLevelAccess') !== 'true') {
      throw new ApiError(409, 'low_level_access_unconfirmed', 'This module asks for low-level access; confirm to import it');
    }
    const full = (): ApiError =>
      badRequest('reader_module_limit', `A library holds at most ${MAX_READER_MODULES} modules`);
    const [counted] = await deps.db
      .select({ value: sql<number>`count(*)::int` })
      .from(readerModules)
      .where(eq(readerModules.userId, userId));
    if ((counted?.value ?? 0) >= MAX_READER_MODULES) throw full();

    const assets = await storeReaderModuleAssets(deps, parsed.assets);
    const id = randomUUID();
    const module = plotModuleOf(parsed, {
      id,
      name: (parsed.name || file.name.replace(/\.[^.]+$/, '').trim() || 'Module').slice(0, MAX_NAME_LENGTH),
      description: parsed.description.trim().slice(0, MAX_DESCRIPTION_LENGTH),
      lorebook: coerceLorebook(parsed.lorebook),
      assets: [],
      importedFrom: {
        fileName: file.name.slice(0, MAX_FILE_NAME_LENGTH),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        importedAt: new Date().toISOString(),
      },
    });
    let created: ReaderModule;
    try {
      // The cap is a count: queue on the account row, as the reader's presets do.
      created = await deps.db.transaction(async (tx) => {
        await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update');
        const [again] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(readerModules)
          .where(eq(readerModules.userId, userId));
        if ((again?.value ?? 0) >= MAX_READER_MODULES) throw full();
        const [row] = await tx.insert(readerModules).values({ id, userId, module, assets: assets.stored }).returning();
        return row!;
      });
    } catch (error) {
      await deleteReaderModuleAssets(deps, assets.stored);
      throw error;
    }
    const importWarnings = [
      ...(assets.unsupported > 0 ? [{ code: 'assets_unsupported', count: assets.unsupported }] : []),
      ...(assets.overLimit > 0 ? [{ code: 'assets_over_limit', count: assets.overLimit }] : []),
    ];
    return c.json({ ...toReaderModuleJson(created), importWarnings }, 201);
  });

  /** `{ enabledGlobally }`: on for every chat of the reader's, or back to the chats that list it. */
  app.patch('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadOwnedReaderModule(deps, id, userId);
    const body = await readJsonBody(c);
    const enabledGlobally = body['enabledGlobally'];
    if (typeof enabledGlobally !== 'boolean') throw badRequest('invalid_request', 'enabledGlobally must be a boolean');
    const [row] = await deps.db
      .update(readerModules)
      .set({ enabledGlobally, updatedAt: new Date() })
      .where(and(eq(readerModules.id, id), eq(readerModules.userId, userId)))
      .returning();
    return c.json(toReaderModuleJson(row!));
  });

  /** Takes a module out of the library: its record, its pictures, and its place on every chat's list. */
  app.delete('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const row = await loadOwnedReaderModule(deps, id, userId);
    await deps.db.transaction(async (tx) => {
      await tx.delete(readerModules).where(and(eq(readerModules.id, id), eq(readerModules.userId, userId)));
      await tx
        .update(chats)
        .set({ modules: sql`nullif(${chats.modules} - ${id}::text, '[]'::jsonb)` })
        .where(and(eq(chats.userId, userId), sql`${chats.modules} ? ${id}::text`));
    });
    await deleteReaderModuleAssets(deps, row.assets);
    return c.body(null, 204);
  });

  /** A picture the module brought, to its owner alone, as a persona's picture is served. */
  app.get('/:id/assets/:assetId', async (c) => {
    const row = await loadOwnedReaderModule(deps, requireUuidParam(c), c.get('userId'));
    const assetId = c.req.param('assetId');
    const asset = row.assets.find((one) => one.id === assetId);
    if (!asset) throw notFound('Asset not found');
    // In parts where the browser asks for them, as a work's assets are: a video seeks.
    return assetResponse(deps.storage, c, asset);
  });

  return app;
}

/** Where each picture of the library's modules on a chat is served from, by the module's name for it. */
export const readerModuleAssetsJson = (row: ReaderModule) =>
  row.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    url: readerModuleAssetUrl(row.id, asset.id),
    mime: asset.mime,
  }));
