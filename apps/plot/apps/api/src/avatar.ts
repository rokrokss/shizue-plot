import { isPng, stripPngTextChunks } from '@shizue/core';
import { avatarKey, readAll, type ObjectStorage } from './storage.js';

/**
 * Cap on an image a creator uploads directly — an avatar or a plot cover. Not a
 * card import: a card PNG carries a whole character and has its own 50MB body
 * limit (ARCHITECTURE §10).
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface ImageType {
  ext: string;
  mime: string;
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
  signature.every((byte, i) => bytes[offset + i] === byte);

/** Sniffs the image type from magic bytes; unknown formats are rejected. */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return { ext: 'png', mime: 'image/png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ext: 'jpg', mime: 'image/jpeg' };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { ext: 'gif', mime: 'image/gif' };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

export function mimeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

/** Bytes ready to be stored, with the type they were sniffed as. */
export interface StorableImage extends ImageType {
  bytes: Uint8Array;
}

/**
 * What an uploaded image becomes on the way to the store: the type it really is,
 * and a PNG with its text chunks removed.
 *
 * A card PNG *is* a card — the definition sits in those chunks — and everything
 * that goes through here is served to every reader of the thing it decorates,
 * while the card definition stays with the owner. So the strip is not the avatar
 * path's business; it belongs to any creator-uploaded image, and both callers
 * (avatar, plot cover) go through this.
 *
 * Returns null for bytes that are not a supported image, and for a PNG whose
 * chunks cannot be walked — an unreadable PNG is refused rather than stored
 * unstripped.
 */
export function storableImage(bytes: Uint8Array): StorableImage | null {
  const type = detectImageType(bytes);
  if (!type) return null;
  const stored = type.ext === 'png' ? stripPngTextChunks(bytes) : bytes;
  if (!stored) return null;
  return { ...type, bytes: stored };
}

/**
 * Stores an avatar. The key is derived from the character row id only —
 * user-supplied names never reach the store.
 * Returns the storage key, or null for unsupported bytes.
 */
export async function saveAvatar(
  storage: ObjectStorage,
  characterId: string,
  bytes: Uint8Array,
): Promise<string | null> {
  const image = storableImage(bytes);
  if (!image) return null;
  const key = avatarKey(characterId, image.ext);
  await storage.put(key, image.bytes, image.mime);
  return key;
}

/**
 * Re-strips an avatar stored before (or despite) `saveAvatar`'s stripping, so no
 * public avatar can carry a card. Idempotent, and cheap enough to run on every
 * publish; an avatar that cannot be sanitized is dropped instead (the GET already
 * answers 404 for a missing object).
 */
export async function sanitizeStoredAvatar(storage: ObjectStorage, key: string): Promise<void> {
  const object = await storage.get(key);
  if (!object) return;
  const bytes = await readAll(object.body);
  if (!isPng(bytes)) return;
  const stripped = stripPngTextChunks(bytes);
  if (!stripped) {
    // Fail closed: if the unwalkable object cannot be removed, the error
    // propagates and the publish aborts — the raw bytes must never become public.
    await storage.delete(key);
    return;
  }
  // Equal length means nothing was removed — leave the object alone.
  if (stripped.length !== bytes.length) await storage.put(key, stripped, mimeForPath(key));
}
