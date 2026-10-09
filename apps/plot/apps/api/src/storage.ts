import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createS3Storage, type S3Config } from './s3.js';

/** Image keys include their namespace so one bucket can store every chat image. */
const AVATARS = 'avatars';
const ASSETS = 'assets';
const ATTACHMENTS = 'attachments';
const COVERS = 'covers';

export const avatarKey = (characterId: string, ext: string): string => `${AVATARS}/${characterId}.${ext}`;
export const assetKey = (assetId: string, ext: string): string => `${ASSETS}/${assetId}.${ext}`;
export const attachmentKey = (attachmentId: string, ext: string): string =>
  `${ATTACHMENTS}/${attachmentId}.${ext}`;
export const coverKey = (plotId: string, ext: string): string => `${COVERS}/${plotId}.${ext}`;

/** A stored object opened for reading. */
export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  size: number;
}

/** Storage for avatars, plot assets, covers and chat attachments. */
export interface ObjectStorage {
  /** Writes bytes under a key the caller built with one of the `*Key` helpers. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Opens an object, or null when there is nothing under the key. */
  get(key: string): Promise<StoredObject | null>;
  /**
   * Removes an object. A key that is already gone is not an error; anything else
   * throws, so a caller that must fail closed (`sanitizeStoredAvatar`) can, and
   * one that must not takes `deleteQuietly`.
   */
  delete(key: string): Promise<void>;
}

/** Deletion that must not fail the request that triggered it. */
export const deleteQuietly = (storage: ObjectStorage, key: string): Promise<void> =>
  storage.delete(key).catch(() => undefined);

/** Drains an opened object. Only for the small ones — an avatar being re-stripped. */
export async function readAll(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Files under one root directory, laid out by the key. The default driver, and
 * the behaviour this repo has always had: a developer who configures nothing
 * gets exactly the same files in exactly the same places.
 *
 * Read back as a stream so image responses need not be buffered.
 */
export function createLocalStorage(root: string): ObjectStorage {
  const pathFor = (key: string): string => join(root, key);
  return {
    async put(key, bytes) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    async get(key) {
      const path = pathFor(key);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        return null;
      }
      return { body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, size };
    },
    async delete(key) {
      // `force` makes a missing file a no-op; every other failure still throws.
      await rm(pathFor(key), { force: true });
    },
  };
}

/** Which driver the process runs on, read once from the environment (env.ts). */
export type StorageConfig = { driver: 'local'; dir: string } | ({ driver: 's3' } & S3Config);

/**
 * The single decision, made once at startup. Nothing downstream asks which driver
 * it got — the routes hold an `ObjectStorage` and that is all they know.
 */
export function createStorage(config: StorageConfig): ObjectStorage {
  return config.driver === 's3' ? createS3Storage(config) : createLocalStorage(config.dir);
}
