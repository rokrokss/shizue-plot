/** Client-side helpers for plot images and the `{{img::slug}}` reference. */

import { rgbaToThumbHash } from 'thumbhash';
import type { AssetLock, AssetUnlock, AssetUnlockKind, ChatAttachment } from './types';

/** Mirrors MAX_ASSETS_PER_PLOT in apps/api/src/assets.ts. */
export const MAX_ASSETS = 100;
const MAX_SLUG_LENGTH = 40;

export interface PlotAsset {
  slug: string;
  /** URL served by the API. */
  url: string;
  mime: string;
  /** Intrinsic size and blurred placeholder; null together for older uploads. */
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  /**
   * What a chat has to reach before this image is revealed in it; null means it
   * always is. Only the owner's own reads carry it — the condition is the
   * creator's, and its keywords are the spoiler the reveal is worth having.
   */
  unlock?: AssetUnlock | null;
  createdAt: string;
}

/** What an uploader measures off an image, and what the renderer reads back. */
export interface AssetPreview {
  width: number;
  height: number;
  /** base64 thumbhash. */
  thumbhash: string;
}

/**
 * Keystroke-level fold, safe to run on every one of them: edge dashes survive,
 * because trimming them mid-typing makes "a-b" impossible to type.
 */
export const foldSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH);

/** What the API stores for a given input. */
export const normalizeSlug = (raw: string): string => foldSlug(raw.trim()).replace(/^-+|-+$/g, '');

/** Slug proposed for a picked file: its name without the extension. */
export const slugFromFileName = (name: string): string => normalizeSlug(name.replace(/\.[^.]+$/, ''));

/**
 * Deliberately as permissive as the stripper in @shizue/core: whatever the model
 * never sees must not survive on screen either, however the slug is written.
 */
const IMAGE_TOKEN_RE = /\{\{\s*img\s*::([^{}]*)\}\}/gi;

/**
 * Rewrites every reference into a markdown image, so the message still goes
 * through a single markdown pass. A slug the plot has no asset for renders as
 * nothing — the same thing that reaches the model.
 */
export function renderImageTokens(content: string, assets: ReadonlyMap<string, string>): string {
  return content.replace(IMAGE_TOKEN_RE, (_token, slug: string) => {
    const url = assets.get(slug.trim());
    return url ? `![${slug.trim()}](${url})` : '';
  });
}

/** Drops every reference, for surfaces that show plain text rather than markdown. */
export const stripImageTokens = (content: string): string => content.replace(IMAGE_TOKEN_RE, '');

/**
 * What a locked asset resolves to instead of its URL.
 *
 * A reference to an image this chat has not opened yet still has to become
 * something — a card saying what it waits on, not a hole and not the picture —
 * and the one place it can carry that is the src the map answers with. A
 * fragment is what markdown lets through untouched (`defaultUrlTransform` keeps
 * anything whose colon comes after a `#`), and the message body reads the kind
 * back off it before ever asking for bytes.
 */
const LOCK_SRC_PREFIX = '#shizue-lock:';

export const lockedSrc = (kind: AssetUnlockKind): string => `${LOCK_SRC_PREFIX}${kind}`;

/** The kind `lockedSrc` wrote, or null for an ordinary image. */
export function readLockKind(src: string): AssetUnlockKind | null {
  if (!src.startsWith(LOCK_SRC_PREFIX)) return null;
  const kind = src.slice(LOCK_SRC_PREFIX.length);
  return kind === 'keyword' || kind === 'turns' || kind === 'relationship' ? kind : null;
}

/** One of the plot's images, as the chat's gallery draws it. */
export interface Illustration {
  slug: string;
  /** The image itself; null while this chat has not opened it. */
  src: string | null;
  /** Which kind of condition it waits on — the hint, never the condition. */
  kind: AssetUnlockKind | null;
  locked: boolean;
}

/**
 * The plot's images as one conversation sees them: open ones with their bytes,
 * locked ones with nothing but the kind of condition they wait on. An asset the
 * lock list says nothing about is one the server did not answer for (an older
 * state, a read that has not landed) and is simply shown.
 */
export function illustrations(
  assets: readonly PlotAsset[],
  locks: readonly AssetLock[],
): Illustration[] {
  const bySlug = new Map(locks.map((lock) => [lock.slug, lock]));
  return assets.map((asset) => {
    const lock = bySlug.get(asset.slug);
    const locked = lock?.locked ?? false;
    return {
      slug: asset.slug,
      src: locked ? null : assetSrc(asset),
      kind: lock?.kind ?? null,
      locked,
    };
  });
}

/** The same list with the named assets opened — what a `done` event reports. */
export function openAssetLocks(
  locks: readonly AssetLock[] | undefined,
  assetIds: readonly string[],
): AssetLock[] {
  const opened = new Set(assetIds);
  return (locks ?? []).map((lock) =>
    opened.has(lock.assetId) ? { ...lock, locked: false } : lock,
  );
}

/**
 * The measurement, carried in the URL fragment.
 *
 * `{{img::slug}}` becomes a markdown image and markdown has nowhere else to put
 * it: there are no attributes to hang data on, and the asset map a message is
 * rendered with is a map of strings all the way down to the display scripts and
 * the component islands. A fragment is never sent to the server, so the src is
 * still the same request it always was, and every other reader of the map keeps
 * working with a URL it can simply use.
 */
const META_RE = /#shizue=(\d+)x(\d+):([A-Za-z0-9+/]+={0,2})$/;

/**
 * The src to render an asset from: its URL, plus its measurement if it has one.
 * A chat attachment carries the same four fields and is drawn by the same
 * component, so it goes through here too.
 */
export const assetSrc = (asset: PlotAsset | ChatAttachment): string =>
  asset.width && asset.height && asset.thumbhash
    ? `${asset.url}#shizue=${asset.width}x${asset.height}:${asset.thumbhash}`
    : asset.url;

/** The measurement `assetSrc` wrote, or null for an image that carries none. */
export function readAssetMeta(src: string): AssetPreview | null {
  const found = META_RE.exec(src);
  if (!found) return null;
  return { width: Number(found[1]), height: Number(found[2]), thumbhash: found[3]! };
}

/** The plain URL again — what a download link should point at. */
export const assetHref = (src: string): string => src.replace(META_RE, '');

/** Longest edge of the bitmap a thumbhash is encoded from; the format caps it at 100. */
const THUMBHASH_SIZE = 100;

/**
 * Measures an image the reader picked, in their browser, before it is uploaded.
 *
 * Returns null for anything that will not decode — a file the browser has no
 * codec for, a canvas the page is not allowed to read back. The upload then goes
 * ahead unmeasured, because a picture without a placeholder is still a picture.
 */
export async function measureImage(file: File): Promise<AssetPreview | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(THUMBHASH_SIZE / bitmap.width, THUMBHASH_SIZE / bitmap.height, 1);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, w, h);
    const hash = rgbaToThumbHash(w, h, context.getImageData(0, 0, w, h).data);
    // After close() the bitmap reports 0×0, so the size is read while it is open.
    const { width, height } = bitmap;
    bitmap.close();
    return { width, height, thumbhash: btoa(String.fromCharCode(...hash)) };
  } catch {
    return null;
  }
}
