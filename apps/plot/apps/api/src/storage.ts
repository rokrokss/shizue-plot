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
const PERSONAS = 'personas';
const READER_MODULES = 'reader-modules';

export const avatarKey = (characterId: string, ext: string): string => `${AVATARS}/${characterId}.${ext}`;
export const assetKey = (assetId: string, ext: string): string => `${ASSETS}/${assetId}.${ext}`;
export const attachmentKey = (attachmentId: string, ext: string): string =>
  `${ATTACHMENTS}/${attachmentId}.${ext}`;
export const coverKey = (plotId: string, ext: string): string => `${COVERS}/${plotId}.${ext}`;
/** A persona's picture — its own namespace, since unlike `avatars/` it is served to its owner only. */
export const personaAvatarKey = (personaId: string, ext: string): string => `${PERSONAS}/${personaId}.${ext}`;
/** A picture a module in a reader's library brought — served to that reader only, as a persona's is. */
export const readerModuleAssetKey = (assetId: string, ext: string): string => `${READER_MODULES}/${assetId}.${ext}`;

/**
 * One span of an object, as a `Range: bytes=…` header asks for it: from `start`
 * to `end` inclusive — to the object's end without `end` — or its last `suffix`
 * bytes.
 */
export type ByteRange = { start: number; end?: number } | { suffix: number };

/** Where a part read for a range lies in its object: first and last byte, inclusive, of `total`. */
export interface ObjectPart {
  start: number;
  end: number;
  total: number;
}

/** A stored object opened for reading. */
export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  /** Bytes in `body`. */
  size: number;
  /**
   * Set when `body` is the part a range asked for. Absent when it is the whole
   * object — no range was asked, or the object has no such part (a start past
   * its end), which is answered as if none had been asked.
   */
  part?: ObjectPart;
}

/** Storage for avatars, plot assets, covers, persona pictures and chat attachments. */
export interface ObjectStorage {
  /** Writes bytes under a key the caller built with one of the `*Key` helpers. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /**
   * Opens an object, or null when there is nothing under the key — only the
   * part `range` names, where it names one the object has (a video seeking).
   */
  get(key: string, range?: ByteRange): Promise<StoredObject | null>;
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

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/**
 * The one span a `Range` header asks for (`bytes=a-b`, `bytes=a-`, `bytes=-n`),
 * or undefined — for no header, a malformed one, or several spans, each of
 * which is answered with the whole object, as HTTP lets a server do.
 */
export function byteRangeOf(header: string | undefined): ByteRange | undefined {
  const match = header ? RANGE_RE.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) return { suffix: Number(match[2]) };
  const start = Number(match[1]);
  if (!match[2]) return { start };
  const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start ? { start, end } : undefined;
}

/** The part of an object of `total` bytes a range names, or undefined when it has none. */
export function partOf(range: ByteRange, total: number): ObjectPart | undefined {
  if ('suffix' in range) {
    return range.suffix > 0 && total > 0 ? { start: Math.max(0, total - range.suffix), end: total - 1, total } : undefined;
  }
  if (!(range.start < total)) return undefined;
  return { start: range.start, end: Math.min(range.end ?? total - 1, total - 1), total };
}

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
    async get(key, range) {
      const path = pathFor(key);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        return null;
      }
      const part = range ? partOf(range, size) : undefined;
      const stream = createReadStream(path, part ? { start: part.start, end: part.end } : {});
      const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      return part ? { body, size: part.end - part.start + 1, part } : { body, size };
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
