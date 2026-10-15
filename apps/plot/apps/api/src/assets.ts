import { sniffFont, sniffMedia, stripPngTextChunks } from '@shizue/core';
import type { Context } from 'hono';
import { badRequest, notFound } from './errors.js';
import { assetKey, byteRangeOf, type ObjectStorage } from './storage.js';

/** Assets a single plot may hold. */
export const MAX_ASSETS_PER_PLOT = 1000;
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
 *
 * What the bytes are decides what is stored, never a name or a declared type
 * (`sniffMedia`). A picture always; music only where `audio` says so, and video
 * only where `video` does — what a card brings, which RisuAI plays
 * (`{{audio::…}}`, `{{bgm::…}}`, `{{video::…}}`). The studio's own upload takes
 * pictures alone. A web font only where `font` says so — what a stylesheet the
 * import localized names (`localizeAssets.ts`, `sniffFont`). Returns null for
 * bytes that are not a supported image (or music, with `audio`; or a video, with
 * `video`; or a font, with `font`).
 */
export async function saveAsset(
  storage: ObjectStorage,
  assetId: string,
  bytes: Uint8Array,
  {
    audio = false,
    video = false,
    font = false,
  }: { audio?: boolean; video?: boolean; font?: boolean } = {},
): Promise<StoredAsset | null> {
  const type = sniffMedia(bytes) ?? (font ? sniffFont(bytes) : null);
  if (!type) return null;
  if ('kind' in type && ((type.kind === 'audio' && !audio) || (type.kind === 'video' && !video))) return null;
  const stored = type.ext === 'png' ? stripPngTextChunks(bytes) : bytes;
  if (!stored) return null;
  const key = assetKey(assetId, type.ext);
  await storage.put(key, stored, type.mime);
  return { key, mime: type.mime };
}

/**
 * An asset's bytes as the answer to its GET: the whole, or — when a `Range`
 * names a span the object has — that span alone (206), which is what lets a
 * browser seek a card's video or music without fetching all of it first. A
 * range is honoured only without `If-Range`: no asset answer carries a
 * validator for one to match.
 */
export async function assetResponse(
  storage: ObjectStorage,
  c: Context,
  asset: { path: string; mime: string },
): Promise<Response> {
  const range = c.req.header('if-range') === undefined ? byteRangeOf(c.req.header('range')) : undefined;
  const object = await storage.get(asset.path, range);
  if (!object) throw notFound('Asset file is missing');
  const headers: Record<string, string> = {
    'Content-Type': asset.mime,
    'Content-Length': String(object.size),
    'Cache-Control': 'private, max-age=3600',
    'Accept-Ranges': 'bytes',
  };
  if (!object.part) return new Response(object.body, { headers });
  const { start, end, total } = object.part;
  return new Response(object.body, {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}` },
  });
}
