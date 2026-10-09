/**
 * Unlockable plot assets: what a chat has to reach before an image is revealed
 * in it, and what it has reached so far.
 *
 * This is a reward layer, not access control. The bytes stay served by the
 * plot-scoped route to everyone who may read the work (`GET /api/plots/:id/
 * assets/:slug`); what an unlock decides is whether one conversation draws the
 * image or a placeholder in its place. So the checks are cheap and synchronous,
 * and a failure here never costs a turn that is already persisted.
 */

import type { AssetUnlock, AssetUnlockKind } from '@shizue/core';
import {
  chatAssetUnlocks,
  messages,
  plots,
  plotAssets,
  type Chat,
  type ChatRelationship,
  type RelationshipAxes,
} from '@shizue/db';
import { asc, eq } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import { buildPath } from './tree.js';

/** What a reader is told about one of a plot's images, inside their own chat. */
export interface AssetLock {
  assetId: string;
  slug: string;
  locked: boolean;
  /** Which kind of condition it waits on — the hint, never the condition itself. */
  kind: AssetUnlockKind | null;
}

/** An asset row as the lock layer reads it, beside the plot's owner. */
interface UnlockableAsset {
  id: string;
  slug: string;
  unlock: AssetUnlock | null;
  ownerId: string;
}

/**
 * Every asset of the chat's plot, in the order the asset list uses, each with
 * the plot's owner — one query rather than a second read of the plot row, and
 * a plot with no assets answers with nothing at all.
 */
async function plotAssetsOfChat(deps: AppDeps, chat: Chat): Promise<UnlockableAsset[]> {
  return deps.db
    .select({
      id: plotAssets.id,
      slug: plotAssets.slug,
      unlock: plotAssets.unlock,
      ownerId: plots.ownerId,
    })
    .from(plotAssets)
    .innerJoin(plots, eq(plots.id, plotAssets.plotId))
    .where(eq(plotAssets.plotId, chat.plotId))
    .orderBy(asc(plotAssets.createdAt), asc(plotAssets.slug));
}

/** The assets this chat has already opened. */
async function unlockedIds(deps: AppDeps, chatId: string): Promise<Set<string>> {
  const rows = await deps.db
    .select({ assetId: chatAssetUnlocks.assetId })
    .from(chatAssetUnlocks)
    .where(eq(chatAssetUnlocks.chatId, chatId));
  return new Set(rows.map((row) => row.assetId));
}

/** Assistant turns on the branch the chat currently ends on. */
async function assistantDepth(deps: AppDeps, chat: Chat): Promise<number> {
  const all = await deps.db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chat.id))
    .orderBy(asc(messages.createdAt));
  return buildPath(all, chat.headMessageId).filter((message) => message.role === 'assistant').length;
}

/**
 * Whether an axis has reached what an unlock waits for. The one place the
 * comparison lives: a chat whose relationship has never been extracted simply
 * never satisfies one, because the axes are null until the background job first
 * answers — and that job re-asks this question with the numbers it just wrote.
 */
const axisReached = (
  unlock: Extract<AssetUnlock, { kind: 'relationship' }>,
  axes: RelationshipAxes | null,
): boolean => (axes ? axes[unlock.axis] >= unlock.min : false);

/**
 * Whether one condition is met. `text` is the assistant turn that has just been
 * persisted and `depth` the branch's assistant count including it.
 */
function satisfied(
  unlock: AssetUnlock,
  text: string,
  depth: number,
  relationship: ChatRelationship | null,
): boolean {
  switch (unlock.kind) {
    case 'keyword': {
      const haystack = text.toLowerCase();
      return unlock.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
    }
    case 'turns':
      return depth >= unlock.count;
    case 'relationship':
      return axisReached(unlock, relationship?.axes ?? null);
  }
}

/**
 * The assets this chat could still open: the plot's unlockable ones, minus what
 * it has already opened. Empty for the creator's own chats — they see every image
 * of their own work already (`assetLocks`), so there is nothing to open there.
 */
async function openableAssets(deps: AppDeps, chat: Chat): Promise<UnlockableAsset[]> {
  const assets = await plotAssetsOfChat(deps, chat);
  if (assets.length === 0 || assets[0]!.ownerId === chat.userId) return [];
  const unlockable = assets.filter((asset) => asset.unlock !== null);
  if (unlockable.length === 0) return [];

  const already = await unlockedIds(deps, chat.id);
  return unlockable.filter((asset) => !already.has(asset.id));
}

/**
 * Writes the reveals and answers with the ids that were not open before. The
 * insert is `on conflict do nothing`, so two evaluations landing on the same
 * condition write one row and only the first of them reports it — which is what
 * lets the turn path and the relationship path below both ask freely.
 */
async function open(deps: AppDeps, chatId: string, assets: UnlockableAsset[]): Promise<string[]> {
  if (assets.length === 0) return [];
  const inserted = await deps.db
    .insert(chatAssetUnlocks)
    .values(assets.map((asset) => ({ chatId, assetId: asset.id })))
    .onConflictDoNothing()
    .returning({ assetId: chatAssetUnlocks.assetId });
  return inserted.map((row) => row.assetId);
}

/**
 * Opens whatever the turn just persisted opened, and answers with the ids that
 * were not open before. Called once per persisted assistant turn, from the one
 * place every generation mode passes through.
 */
export async function unlockAssets(deps: AppDeps, chat: Chat, text: string): Promise<string[]> {
  const candidates = await openableAssets(deps, chat);
  if (candidates.length === 0) return [];

  // Only walked when something is actually waiting on the branch's depth.
  const depth = candidates.some((asset) => asset.unlock?.kind === 'turns')
    ? await assistantDepth(deps, chat)
    : 0;
  return open(
    deps,
    chat.id,
    candidates.filter((asset) => satisfied(asset.unlock!, text, depth, chat.relationship)),
  );
}

/**
 * Opens what the axes just extracted opened, and nothing else.
 *
 * The relationship layer is written by a background job that runs **after** the
 * turn's `done` event, so the numbers a turn produced are not on the row while
 * that turn is being evaluated. Without this second pass the very turn that
 * pushes an axis over its threshold could never open the asset waiting on it, and
 * a reader who then stopped chatting would keep it shut forever with the
 * condition long since met.
 *
 * There is no event to announce it on — the stream is closed by now — so the
 * reveal simply lands on the chat's next state read. Only relationship-kind
 * unlocks are considered: nothing else moved.
 */
export async function unlockByRelationship(
  deps: AppDeps,
  chat: Chat,
  axes: RelationshipAxes,
): Promise<string[]> {
  const candidates = await openableAssets(deps, chat);
  return open(
    deps,
    chat.id,
    candidates.filter((asset) => {
      const unlock = asset.unlock;
      return unlock?.kind === 'relationship' && axisReached(unlock, axes);
    }),
  );
}

/**
 * What this chat may show of its plot's images. Every asset is listed, so the
 * gallery can draw the locked ones as silhouettes, and the condition itself never
 * travels — only its `kind`, which is the hint the placeholder carries.
 *
 * The plot's owner sees their own work whole: nothing is locked in the creator's
 * own chats.
 */
export async function assetLocks(deps: AppDeps, chat: Chat): Promise<AssetLock[]> {
  const assets = await plotAssetsOfChat(deps, chat);
  if (assets.length === 0) return [];
  const owner = assets[0]!.ownerId === chat.userId;
  const unlocked =
    owner || assets.every((asset) => asset.unlock === null)
      ? new Set<string>()
      : await unlockedIds(deps, chat.id);

  return assets.map((asset) => ({
    assetId: asset.id,
    slug: asset.slug,
    locked: asset.unlock !== null && !owner && !unlocked.has(asset.id),
    kind: asset.unlock?.kind ?? null,
  }));
}
