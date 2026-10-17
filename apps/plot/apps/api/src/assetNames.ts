/**
 * The names a plot's images go by in a chat's prompt — what `{{assetlist}}`,
 * `{{emotionlist}}`, `{{moduleenabled}}` and `{{moduleassetlist}}` read.
 */

import { isLocalizedAssetName, type PlotModule } from '@shizue/core';
import { plotAssets } from '@shizue/db';
import { asc, eq } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import { cbsModulesOf } from './plots.js';

/**
 * The plot's images in the asset list's order, each by the card's own name where
 * it had one and the slug otherwise, without what the import fetched from another
 * host for the card's markup (`isLocalizedAssetName`): RisuAI loads that from
 * there, and its list names the card's own.
 */
async function namedAssets(deps: AppDeps, plotId: string): Promise<{ id: string; name: string }[]> {
  const rows = await deps.db
    .select({ id: plotAssets.id, slug: plotAssets.slug, name: plotAssets.name })
    .from(plotAssets)
    .where(eq(plotAssets.plotId, plotId))
    .orderBy(asc(plotAssets.createdAt), asc(plotAssets.slug));
  return rows
    .filter((asset) => !isLocalizedAssetName(asset.name))
    .map((asset) => ({ id: asset.id, name: asset.name ?? asset.slug }));
}

/** What `{{assetlist}}` reads in the prompt: the same list the chat page gives the display scripts. */
export async function plotAssetNames(deps: AppDeps, plotId: string): Promise<string[]> {
  return (await namedAssets(deps, plotId)).map((asset) => asset.name);
}

/**
 * The work's modules as `{{moduleenabled}}` and `{{moduleassetlist}}` read them
 * in a chat's prompt (`cbsModulesOf`). The assets are read only when a module has
 * a namespace.
 */
export async function plotModuleAssets(
  deps: AppDeps,
  plotId: string,
  modules: readonly PlotModule[] | undefined,
): Promise<{ namespace: string; assets: string[] }[]> {
  if (!modules?.some((module) => module.namespace)) return [];
  const assets = await namedAssets(deps, plotId);
  return cbsModulesOf(modules, new Map(assets.map((asset) => [asset.id, asset.name])));
}
