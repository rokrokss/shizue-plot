import { stripPngTextChunks } from '@shizue/core';
import { detectImageType } from './avatar.js';
import { badRequest } from './errors.js';
import { assetKey, type ObjectStorage } from './storage.js';

/** Assets a single plot may hold. */
export const MAX_ASSETS_PER_PLOT = 100;
/** `{{img::slug}}` only ever carries `[a-z0-9-_]{1,40}`. */
const MAX_SLUG_LENGTH = 40;
/** Past this the measurement is wrong, not the image. */
const MAX_IMAGE_DIMENSION = 20000;
/** A thumbhash is at most 25 bytes, so its base64 never comes near this. */
const MAX_THUMBHASH_LENGTH = 64;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Folds arbitrary text into a slug the `{{img::slug}}` syntax can carry: lower
 * case, every run of unsupported characters collapsed to a dash. Returns null
 * when nothing usable is left (a name written entirely in Hangul, say) — the
 * caller decides whether that is a rejection or a fallback.
 */
export function normalizeSlug(raw: string): string | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

/** Appends -2, -3, … until the slug is free, staying inside the length cap. */
export function uniqueSlug(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) {
    const suffix = `-${n}`;
    candidate = base.slice(0, MAX_SLUG_LENGTH - suffix.length) + suffix;
  }
  return candidate;
}

/** What the uploader measured off the image before it sent the bytes. */
export interface AssetPreview {
  width: number;
  height: number;
  /** base64 thumbhash — the blurred placeholder the reader sees first. */
  thumbhash: string;
}

/**
 * Reads that measurement off an upload. The three fields travel together or not
 * at all: half a measurement would reserve the wrong box, and there is no old
 * client to be lenient towards — the only uploader is our own web app, and an
 * image it could not decode sends nothing rather than a guess.
 *
 * Returns null when nothing was sent; anything malformed is a bad request. None
 * of it is trusted for more than layout, but it is stored, so it is bounded.
 */
export function coerceAssetPreview(
  width: unknown,
  height: unknown,
  thumbhash: unknown,
): AssetPreview | null {
  const raw = [width, height, thumbhash].map((value) =>
    value === null || value === undefined ? '' : String(value),
  ) as [string, string, string];
  if (raw.every((value) => value === '')) return null;
  if (raw.some((value) => value === '')) {
    throw badRequest('invalid_asset', 'width, height and thumbhash must be sent together');
  }

  const [w, h] = [Number(raw[0]), Number(raw[1])];
  for (const value of [w, h]) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_IMAGE_DIMENSION) {
      throw badRequest('invalid_asset', `width and height must be integers in 1..${MAX_IMAGE_DIMENSION}`);
    }
  }
  if (raw[2].length > MAX_THUMBHASH_LENGTH || !BASE64_RE.test(raw[2])) {
    throw badRequest('invalid_asset', `thumbhash must be base64 of at most ${MAX_THUMBHASH_LENGTH} characters`);
  }
  return { width: w, height: h, thumbhash: raw[2] };
}

/** Same-origin path an asset is served from; the slug is its only public handle. */
export const assetUrl = (plotId: string, slug: string): string =>
  `/api/plots/${plotId}/assets/${slug}`;

interface StoredAsset {
  /** The storage key, held by `plot_assets.path`. */
  key: string;
  mime: string;
}

/**
 * Stores an asset. The key comes from the row id, so no user-supplied name
 * reaches the store, and PNGs are stripped exactly like avatars: an asset is
 * served to everyone who can see the plot.
 * Returns null for bytes that are not a supported image.
 */
export async function saveAsset(
  storage: ObjectStorage,
  assetId: string,
  bytes: Uint8Array,
): Promise<StoredAsset | null> {
  const type = detectImageType(bytes);
  if (!type) return null;
  const stored = type.ext === 'png' ? stripPngTextChunks(bytes) : bytes;
  if (!stored) return null;
  const key = assetKey(assetId, type.ext);
  await storage.put(key, stored, type.mime);
  return { key, mime: type.mime };
}
