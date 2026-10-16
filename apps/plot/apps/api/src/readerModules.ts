/**
 * The reader's own RisuAI modules (ARCHITECTURE §6 RisuAI 모듈 — 독자의 모듈): a
 * library per account, as RisuAI keeps one per app (`db.modules`), each module
 * on for every chat of the reader's (`enabled_globally`, RisuAI's
 * `enabledModules`), for every chat of the works it lists (`plot_ids`, RisuAI's
 * character `modules`), for the chats that list it (`chats.modules`, RisuAI's
 * chat `modules`), or for a chat whose reader preset names it in its module
 * integration (RisuAI's preset `moduleIntergration`).
 *
 * What a chat runs is RisuAI's `getModules()`: the set those lists name, read
 * over the library in the order it was filled (`getModuleByIds` filters
 * `db.modules`, so the library's order is the modules' order whatever list
 * turned one on). A name on a list finds a module by its id or by its
 * namespace — every module sharing the namespace — which only the integration's
 * names can be here, the other lists holding ids. The work's own modules — what RisuAI would call the
 * character's — come first; RisuAI has no module a creator ships with a
 * character, so where they stand against the reader's is ours to say.
 *
 * Nothing here writes the work: a reader's module is laid over their chats
 * the way the work's are, in every consumer that reads `PlotModule[]`.
 */
import {
  chatToggleText,
  moduleIntegrationNames,
  readCardAssets,
  type CardAsset,
  type NormalizedCard,
  type PlotModule,
  type ReaderModuleAsset,
} from '@shizue/core';
import { readerModules, readerPresets, type Chat, type Plot, type ReaderModule } from '@shizue/db';
import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { saveAssetStream } from './assets.js';
import type { AppDeps } from './deps.js';
import type { ImportHooks } from './fileImports.js';
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

/** The fields of a chat that say which of its owner's library modules are on it. */
export type ChatModuleSwitches = Pick<Chat, 'userId' | 'plotId' | 'modules' | 'readerPresetId'>;

/**
 * The module integration of the chat's reader preset, as names
 * (`moduleIntegrationNames`) — read under the chat owner's id, so a pointer at
 * anyone else's preset names nothing.
 */
async function integrationNames(deps: AppDeps, chat: Pick<Chat, 'userId' | 'readerPresetId'>): Promise<string[]> {
  if (!chat.readerPresetId) return [];
  const [preset] = await deps.db
    .select({ moduleIntegration: readerPresets.moduleIntegration })
    .from(readerPresets)
    .where(and(eq(readerPresets.id, chat.readerPresetId), eq(readerPresets.userId, chat.userId)))
    .limit(1);
  return moduleIntegrationNames(preset?.moduleIntegration);
}

/**
 * RisuAI's `getModuleByIds` over the lists that turn a library module on, as a
 * condition: on everywhere, on for one of `plotIds`' works, one of `ids`, or —
 * the integration's `names` — a module whose namespace or id is one of them.
 */
function switchedOn(plotIds: readonly string[], ids: readonly string[], names: readonly string[]): SQL {
  const namespace = sql<string>`${readerModules.module}->>'namespace'`;
  return or(
    eq(readerModules.enabledGlobally, true),
    ...plotIds.map((plotId) => sql`${readerModules.plotIds} ? ${plotId}::text`),
    ...(ids.length > 0 ? [inArray(readerModules.id, [...ids])] : []),
    ...(names.length > 0 ? [inArray(namespace, [...names]), inArray(sql<string>`${readerModules.id}::text`, [...names])] : []),
  )!;
}

/**
 * The library modules on a chat, in the library's order — RisuAI's
 * `getModuleByIds` over `enabledModules`, the character's `modules` (the work's
 * list, `plot_ids`), the chat's `modules` and the preset's
 * `moduleIntergration`. A listed id that is gone, or not the chat owner's,
 * matches nothing.
 */
export async function activeReaderModules(deps: AppDeps, chat: ChatModuleSwitches): Promise<ReaderModule[]> {
  const names = await integrationNames(deps, chat);
  return deps.db
    .select()
    .from(readerModules)
    .where(and(eq(readerModules.userId, chat.userId), switchedOn([chat.plotId], chatModuleIds(chat), names)))
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
  chat: ChatModuleSwitches,
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

/**
 * RisuAI's `HideIconStore` for a chat (`moduleUpdate`): the character's
 * `hideChatIcon` or any module on the chat with `hideIcon`. A card brings its
 * flag in `extensions.risuai.hideChatIcon`; a work of several members is
 * RisuAI's group, which no card speaks for, so only a work of one member reads
 * its card's. A work no RisuAI card or module came into hides nothing.
 */
export function hidesChatIcons(
  modules: readonly Pick<PlotModule, 'hideIcon'>[],
  members: readonly { card: Pick<NormalizedCard, 'extensions'> }[],
): boolean {
  if (modules.some((module) => module.hideIcon === true)) return true;
  if (members.length !== 1) return false;
  const risu = members[0]!.card.extensions?.['risuai'];
  return risu !== null && typeof risu === 'object' && (risu as Record<string, unknown>)['hideChatIcon'] === true;
}

/** A member card's own toggles — RisuAI's character `customModuleToggle`, imported from `extensions.risuai.toggles`. */
export function cardToggles(card: Pick<NormalizedCard, 'extensions'>): string {
  const risu = card.extensions?.['risuai'];
  const toggles = risu !== null && typeof risu === 'object' ? (risu as Record<string, unknown>)['toggles'] : undefined;
  return typeof toggles === 'string' ? toggles : '';
}

/**
 * The toggle text a chat's settings draw (`chatToggleText`): its reader
 * preset's (RisuAI's preset toggles), the modules' on it, in their order, then
 * the members' own — each distinct text once, as a work of several imported
 * from one card would otherwise list it twice.
 */
export function chatToggles(
  modules: readonly PlotModule[],
  members: readonly { card: Pick<NormalizedCard, 'extensions'> }[],
  preset = '',
): string {
  const own = [...new Set(members.map((member) => cardToggles(member.card)).filter((text) => text.trim()))];
  return chatToggleText(modules, own, preset);
}

/** The chat's reader preset's toggles (RisuAI's `customPromptTemplateToggle`), read under its owner. */
export async function presetToggles(deps: AppDeps, chat: Pick<Chat, 'userId' | 'readerPresetId'>): Promise<string> {
  if (!chat.readerPresetId) return '';
  const [preset] = await deps.db
    .select({ toggles: readerPresets.toggles })
    .from(readerPresets)
    .where(and(eq(readerPresets.id, chat.readerPresetId), eq(readerPresets.userId, chat.userId)))
    .limit(1);
  return preset?.toggles ?? '';
}

/**
 * Stores the pictures a library module brought as a plot's are stored
 * (`saveAssetStream`) — read by their bytes, never their names: an image, music
 * or any other media the chat plays, PNGs stripped of their text chunks — under
 * `reader-modules/`, up to `MAX_READER_MODULE_ASSETS`, streamed one at a time
 * under the parse's caps (`readCardAssets`). What is not media is skipped and
 * counted, as an import counts it; so is what the caps cut off.
 */
export async function storeReaderModuleAssets(
  deps: AppDeps,
  assets: readonly CardAsset[],
  hooks: ImportHooks,
): Promise<{ stored: ReaderModuleAsset[]; unsupported: number; overLimit: number; overBudget: number }> {
  const stored: ReaderModuleAsset[] = [];
  /** Keys written to, named by a row or not yet: what a failure takes back. */
  const keys: string[] = [];
  let unsupported = 0;
  let overLimit = 0;
  let overBudget = 0;
  try {
    hooks.progress('assets', 0, assets.length);
    ({ overBudget } = await readCardAssets(assets, async (asset, body, index) => {
      if (stored.length >= MAX_READER_MODULE_ASSETS) {
        overLimit = assets.length - index;
        return false;
      }
      const id = randomUUID();
      const saved = await saveAssetStream(deps.storage, id, body, {
        audio: true,
        video: true,
        key: readerModuleAssetKey,
        onKey: async (key) => {
          keys.push(key);
          await hooks.wrote({ keys: [key] });
        },
      });
      hooks.progress('assets', index + 1, assets.length);
      if (!saved) {
        unsupported += 1;
        return true;
      }
      stored.push({ id, name: asset.name, path: saved.key, mime: saved.mime });
      return true;
    }));
  } catch (error) {
    for (const key of keys) await deleteQuietly(deps.storage, key);
    throw error;
  }
  return { stored, unsupported, overLimit, overBudget };
}

export async function deleteReaderModuleAssets(deps: AppDeps, assets: readonly ReaderModuleAsset[]): Promise<void> {
  for (const asset of assets) await deleteQuietly(deps.storage, asset.path);
}
