import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createS3Storage, type S3Config } from './s3.js';

/** Image keys include their namespace so one bucket can store every chat image. */
const AVATARS = 'avatars';
const ASSETS = 'assets';
const ATTACHMENTS = 'attachments';
const COVERS = 'covers';
const PERSONAS = 'personas';
const READER_MODULES = 'reader-modules';
const IMPORTS = 'imports';

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
 * A file a reader is importing, as their browser uploaded it (`fileImports.ts`),
 * until the import has read it: `file` the card or module, `world-info` the
 * World Info file beside a card. Its own namespace so a store's lifecycle rule
 * can expire whatever an import left behind (ARCHITECTURE §9.2).
 */
export const importFileKey = (importId: string, name: 'file' | 'world-info'): string => `${IMPORTS}/${importId}/${name}`;

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

/** One part of a multipart upload, as the store holds it. */
export interface UploadedPart {
  part: number;
  size: number;
  /** The store's tag for it, which joining the parts names (S3's ETag). */
  etag?: string;
}

/**
 * The multipart uploads a reader's browser sends an import's file through
 * (`fileImports.ts`): opened and joined by this API, the parts sent by the
 * browser — straight to the store where it can take them (S3, at a presigned
 * address), or to this API, which writes them (the local driver).
 */
export interface StagedUploads {
  /** Opens an upload that will land under `key`; answers its id. */
  create(key: string, contentType: string): Promise<string>;
  /**
   * Where the browser PUTs part `part`, exactly `size` bytes of it: an address on
   * the store, good for an hour and for that size alone — or null, when the part
   * goes to this API (`write`).
   */
  partUrl(key: string, uploadId: string, part: number, size: number): Promise<string | null>;
  /**
   * Takes a part this API received, streamed, and keeps it only when it is the
   * `size` it should be. Only where `partUrl` answers null.
   */
  write(key: string, uploadId: string, part: number, body: AsyncIterable<Uint8Array>, size: number): Promise<void>;
  /** The parts stored so far. */
  parts(key: string, uploadId: string): Promise<UploadedPart[]>;
  /** Joins `parts`, in order, into the object under `key`, and ends the upload. */
  complete(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  /** Drops the upload and every part of it. One that is already gone is not an error. */
  abort(key: string, uploadId: string): Promise<void>;
}

/** Thrown by `StagedUploads.write` for a part that was not the size it was sent as. */
export class PartSizeMismatch extends Error {}

/** Storage for avatars, plot assets, covers, persona pictures, chat attachments and import files. */
export interface ObjectStorage {
  /** Writes bytes under a key the caller built with one of the `*Key` helpers. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /**
   * Writes a stream under a key, never holding it whole — an imported card's
   * picture or video, of any size. A stream that throws leaves nothing under the
   * key, and its error is what this rejects with.
   */
  putStream(key: string, body: AsyncIterable<Uint8Array>, contentType: string): Promise<void>;
  /** The size of the object under a key, or null when there is none. */
  size(key: string): Promise<number | null>;
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
  uploads: StagedUploads;
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
  /** Where an upload's parts wait until they are joined: beside the namespaces, never under a key. */
  const partsDir = (uploadId: string): string => {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error('Not an upload id');
    return join(root, '.uploads', uploadId);
  };
  /** Writes a stream to a temporary file and moves it into place, so a stream that throws leaves no file. */
  async function writeAtomically(path: string, body: AsyncIterable<Uint8Array>, size?: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await pipeline(Readable.from(body), createWriteStream(temporary));
      if (size !== undefined && (await stat(temporary)).size !== size) throw new PartSizeMismatch('Part size mismatch');
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  const uploads: StagedUploads = {
    async create() {
      const uploadId = randomUUID();
      await mkdir(partsDir(uploadId), { recursive: true });
      return uploadId;
    },
    async partUrl() {
      return null;
    },
    async write(_key, uploadId, part, body, size) {
      const dir = partsDir(uploadId);
      await stat(dir);
      await writeAtomically(join(dir, String(part)), body, size);
    },
    async parts(_key, uploadId) {
      let names: string[];
      try {
        names = await readdir(partsDir(uploadId));
      } catch {
        return [];
      }
      const parts: UploadedPart[] = [];
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        parts.push({ part: Number(name), size: (await stat(join(partsDir(uploadId), name))).size });
      }
      return parts.sort((a, b) => a.part - b.part);
    },
    async complete(key, uploadId, parts) {
      const dir = partsDir(uploadId);
      async function* joined(): AsyncGenerator<Uint8Array> {
        for (const { part } of parts) yield* createReadStream(join(dir, String(part)));
      }
      await writeAtomically(pathFor(key), joined());
      await rm(dir, { recursive: true, force: true });
    },
    async abort(_key, uploadId) {
      await rm(partsDir(uploadId), { recursive: true, force: true });
    },
  };
  return {
    async put(key, bytes) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    async putStream(key, body) {
      await writeAtomically(pathFor(key), body);
    },
    async size(key) {
      try {
        return (await stat(pathFor(key))).size;
      } catch {
        return null;
      }
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
    uploads,
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
