/**
 * The reader's own RisuAI modules (ARCHITECTURE §6 RisuAI 모듈 — 독자의 모듈): a
 * library per account, as RisuAI keeps one per app (`db.modules`), each module
 * on for every chat of the reader's (`enabled_globally`, RisuAI's
 * `enabledModules`) or for the chats that list it (`chats.modules`, RisuAI's
 * chat `modules`).
 *
 * What a chat runs is RisuAI's `getModules()`: the set those lists name, read
 * over the library in the order it was filled (`getModuleByIds` filters
 * `db.modules`, so the library's order is the modules' order whatever list
 * turned one on). The work's own modules — what RisuAI would call the
 * character's — come first; RisuAI has no module a creator ships with a
 * character, so where they stand against the reader's is ours to say.
 *
 * Nothing here writes the work: a reader's module is laid over their chats
 * the way the work's are, in every consumer that reads `PlotModule[]`.
 */
import {
  chatToggleText,
  sniffMedia,
  stripPngTextChunks,
  type CharxAssetFile,
  type NormalizedCard,
  type PlotModule,
  type ReaderModuleAsset,
} from '@shizue/core';
import { readerModules, type Chat, type Plot, type ReaderModule } from '@shizue/db';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AppDeps } from './deps.js';
import { deleteQuietly, readerModuleAssetKey } from './storage.js';
import { isUuid } from './util.js';

/** Modules one reader's library holds at most. */
export const MAX_READER_MODULES = 100;
/** Pictures one library module keeps at most — a work's cap (`MAX_ASSETS_PER_PLOT`). */
export const MAX_READER_MODULE_ASSETS = 1000;

/** Same-origin path a library module's picture is served from; only its owner may read it. */
export const readerModuleAssetUrl = (moduleId: string, assetId: string): string =>
  `/api/reader-modules/${moduleId}/assets/${assetId}`;

/** The reader's library in the order it was filled — RisuAI's `db.modules`. */
export async function readerLibrary(deps: AppDeps, userId: string): Promise<ReaderModule[]> {
  return deps.db
    .select()
    .from(readerModules)
    .where(eq(readerModules.userId, userId))
    .orderBy(asc(readerModules.createdAt), asc(readerModules.id));
}

/** The chat's own list (`chats.modules`), held to ids. */
export const chatModuleIds = (chat: Pick<Chat, 'modules'>): string[] =>
  (chat.modules ?? []).filter((id) => typeof id === 'string' && isUuid(id));

/**
 * The library modules on a chat: those on everywhere and those its list names,
 * in the library's order — RisuAI's `getModuleByIds` over `enabledModules` and
 * the chat's `modules`. A listed id that is gone, or not the chat owner's,
 * matches nothing.
 */
export async function activeReaderModules(
  deps: AppDeps,
  chat: Pick<Chat, 'userId' | 'modules'>,
): Promise<ReaderModule[]> {
  const ids = chatModuleIds(chat);
  return deps.db
    .select()
    .from(readerModules)
    .where(
      and(
        eq(readerModules.userId, chat.userId),
        ids.length > 0 ? or(eq(readerModules.enabledGlobally, true), inArray(readerModules.id, ids)) : eq(readerModules.enabledGlobally, true),
      ),
    )
    .orderBy(asc(readerModules.createdAt), asc(readerModules.id));
}

/** A library module as every consumer reads a work's: its pictures are its own (`ReaderModuleAsset`), not the plot's. */
export const asPlotModule = (row: ReaderModule): PlotModule => ({ ...row.module, id: row.id, assets: [] });

/** The modules on a chat: the work's, then the reader's that are on (`activeReaderModules`). */
export interface ChatModules {
  modules: PlotModule[];
  reader: ReaderModule[];
}

export async function chatModulesOf(
  deps: AppDeps,
  chat: Pick<Chat, 'userId' | 'modules'>,
  plot: Pick<Plot, 'customUi'>,
): Promise<ChatModules> {
  const reader = await activeReaderModules(deps, chat);
  return { modules: [...(plot.customUi?.modules ?? []), ...reader.map(asPlotModule)], reader };
}

/**
 * The library modules as `{{moduleenabled}}` and `{{moduleassetlist}}` find
 * them (`CbsHostData.modules`): each with a namespace, its pictures by the
 * module's names for them.
 */
export const readerCbsModules = (reader: readonly ReaderModule[]): { namespace: string; assets: string[] }[] =>
  reader.flatMap((row) =>
    row.module.namespace ? [{ namespace: row.module.namespace, assets: row.assets.map((asset) => asset.name) }] : [],
  );

/** A member card's own toggles — RisuAI's character `customModuleToggle`, imported from `extensions.risuai.toggles`. */
export function cardToggles(card: Pick<NormalizedCard, 'extensions'>): string {
  const risu = card.extensions?.['risuai'];
  const toggles = risu !== null && typeof risu === 'object' ? (risu as Record<string, unknown>)['toggles'] : undefined;
  return typeof toggles === 'string' ? toggles : '';
}

/**
 * The toggle text a chat's settings draw (`chatToggleText`): the modules' on
 * it, in their order, then the members' own — each distinct text once, as a
 * work of several imported from one card would otherwise list it twice.
 */
export function chatToggles(modules: readonly PlotModule[], members: readonly { card: Pick<NormalizedCard, 'extensions'> }[]): string {
  const own = [...new Set(members.map((member) => cardToggles(member.card)).filter((text) => text.trim()))];
  return chatToggleText(modules, own);
}

/**
 * Stores the pictures a library module brought — read by their bytes, never
 * their names (`sniffMedia`): an image, music or any other media the chat
 * plays, PNGs stripped of their text chunks as every stored picture is — under
 * `reader-modules/`, up to `MAX_READER_MODULE_ASSETS`. What is not media is
 * skipped and counted, as an import counts it.
 */
export async function storeReaderModuleAssets(
  deps: AppDeps,
  assets: readonly CharxAssetFile[],
): Promise<{ stored: ReaderModuleAsset[]; unsupported: number; overLimit: number }> {
  const stored: ReaderModuleAsset[] = [];
  let unsupported = 0;
  let overLimit = 0;
  try {
    for (const [index, asset] of assets.entries()) {
      if (stored.length >= MAX_READER_MODULE_ASSETS) {
        overLimit = assets.length - index;
        break;
      }
      const type = sniffMedia(asset.bytes);
      const bytes = type?.ext === 'png' ? stripPngTextChunks(asset.bytes) : asset.bytes;
      if (!type || !bytes) {
        unsupported += 1;
        continue;
      }
      const id = randomUUID();
      const path = readerModuleAssetKey(id, type.ext);
      await deps.storage.put(path, bytes, type.mime);
      stored.push({ id, name: asset.name, path, mime: type.mime });
    }
  } catch (error) {
    await deleteReaderModuleAssets(deps, stored);
    throw error;
  }
  return { stored, unsupported, overLimit };
}

export async function deleteReaderModuleAssets(deps: AppDeps, assets: readonly ReaderModuleAsset[]): Promise<void> {
  for (const asset of assets) await deleteQuietly(deps.storage, asset.path);
}
