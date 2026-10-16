/**
 * The `ObjectStorage` contract, run against every driver there is.
 *
 * The local driver always runs. The S3 driver runs against the RustFS from
 * `docker-compose.yml` when it answers on localhost:19000, and is skipped —
 * loudly, by name — when it does not, because a store this thin is exactly the
 * thing a mock would agree with while the real one disagreed.
 *
 * Both are resolved at module load rather than in `beforeAll`: vitest decides
 * what to skip while it collects, which is before any hook has run.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assetKey,
  avatarKey,
  coverKey,
  createLocalStorage,
  deleteQuietly,
  readAll,
  attachmentKey,
  importFileKey,
  PartSizeMismatch,
  type ObjectStorage,
} from '../src/storage.js';
import { connectS3Server } from './s3Server.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const localDir = await mkdtemp(join(tmpdir(), 'shizue-storage-test-'));
const local = createLocalStorage(localDir);
const s3 = await connectS3Server();

/** The contract itself: everything below holds for any driver that implements it. */
function contractOf(name: string, storage: ObjectStorage | null): void {
  // Skipped as a block rather than per test, so a missing S3 server reads as one line.
  describe.runIf(storage !== null)(`${name} driver`, () => {
    const store = storage!;

    it('round-trips bytes, with the size the reader needs', async () => {
      const key = assetKey(randomUUID(), 'png');
      const bytes = bytesOf('some image bytes');
      await store.put(key, bytes, 'image/png');

      const object = await store.get(key);
      expect(object).not.toBeNull();
      expect(object!.size).toBe(bytes.length);
      expect(new Uint8Array(await readAll(object!.body))).toEqual(bytes);
    });

    it('answers null for a key that was never written', async () => {
      expect(await store.get(assetKey(randomUUID(), 'png'))).toBeNull();
    });

    it('overwrites in place', async () => {
      const key = avatarKey(randomUUID(), 'png');
      await store.put(key, bytesOf('first'), 'image/png');
      await store.put(key, bytesOf('second and longer'), 'image/png');

      const object = await store.get(key);
      expect(new Uint8Array(await readAll(object!.body))).toEqual(bytesOf('second and longer'));
      expect(object!.size).toBe('second and longer'.length);
    });

    it('deletes, and treats a key that is already gone as deleted', async () => {
      const key = attachmentKey(randomUUID(), 'png');
      await store.put(key, bytesOf('attachment'), 'image/png');
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
      // Idempotent, so a retried cleanup is not an error.
      await expect(store.delete(key)).resolves.toBeUndefined();
      await expect(deleteQuietly(store, key)).resolves.toBeUndefined();
    });

    it('keeps the namespaces apart under one id', async () => {
      // The same uuid in all of them: only the namespace tells the objects apart,
      // which is the property that lets one bucket hold everything.
      const id = randomUUID();
      const keys = [avatarKey(id, 'png'), assetKey(id, 'png'), attachmentKey(id, 'png'), coverKey(id, 'png')];
      expect(keys).toEqual([
        `avatars/${id}.png`,
        `assets/${id}.png`,
        `attachments/${id}.png`,
        `covers/${id}.png`,
      ]);

      for (const [index, key] of keys.entries()) {
        await store.put(key, bytesOf(`body ${index}`), 'text/plain');
      }
      for (const [index, key] of keys.entries()) {
        const object = await store.get(key);
        expect(new Uint8Array(await readAll(object!.body))).toEqual(bytesOf(`body ${index}`));
      }

      // Deleting one leaves the others standing.
      await store.delete(keys[1]!);
      expect(await store.get(keys[0]!)).not.toBeNull();
      expect(await store.get(keys[1]!)).toBeNull();
      expect(await store.get(keys[2]!)).not.toBeNull();
      expect(await store.get(keys[3]!)).not.toBeNull();
    });
  });
}

/** Bytes 0..255 over and over, so a part out of place or a byte lost shows. */
const patterned = (size: number, salt = 0): Uint8Array => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i + salt) & 0xff;
  return bytes;
};

/** Bytes as a stream of `piece`-sized chunks, as a parse hands an asset over. */
async function* inPieces(bytes: Uint8Array, piece: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += piece) yield bytes.subarray(at, at + piece);
}

/** Sends a part as a reader's browser does: to the store's address, or to this API. */
async function sendPart(store: ObjectStorage, key: string, uploadId: string, part: number, bytes: Uint8Array): Promise<Response | void> {
  const url = await store.uploads.partUrl(key, uploadId, part, bytes.length);
  if (url) return fetch(url, { method: 'PUT', body: Buffer.from(bytes) });
  await store.uploads.write(key, uploadId, part, inPieces(bytes, 4096), bytes.length);
}

/** What streams and staged uploads hold for any driver. */
function streamingContractOf(name: string, storage: ObjectStorage | null): void {
  describe.runIf(storage !== null)(`${name} driver: streams and uploads`, () => {
    const store = storage!;
    const MiB = 1024 * 1024;

    it('writes a stream of any length, past one part of it, and says its size', async () => {
      const key = assetKey(randomUUID(), 'mp4');
      const bytes = patterned(9 * MiB + 17);
      await store.putStream(key, inPieces(bytes, 64 * 1024), 'video/mp4');
      expect(await store.size(key)).toBe(bytes.length);
      const object = await store.get(key);
      expect(Buffer.from(await readAll(object!.body)).equals(bytes)).toBe(true);
      expect(await store.size(assetKey(randomUUID(), 'mp4'))).toBeNull();
    });

    it('leaves nothing under the key for a stream that throws, and rejects with its error', async () => {
      const key = assetKey(randomUUID(), 'mp4');
      const cut = new Error('cut');
      async function* failing(): AsyncGenerator<Uint8Array> {
        yield* inPieces(patterned(9 * MiB), 64 * 1024);
        throw cut;
      }
      const rejected = await store.putStream(key, failing(), 'video/mp4').then(
        () => undefined,
        (error: unknown) => error,
      );
      // However the driver wraps it, the stream's own error is in the chain.
      let found = false;
      for (let at: unknown = rejected; at; at = (at as { cause?: unknown }).cause) if (at === cut) found = true;
      expect(found).toBe(true);
      expect(await store.get(key)).toBeNull();
    });

    it('joins an upload\'s parts in order, whatever order they came in', async () => {
      const key = importFileKey(randomUUID(), 'file');
      const first = patterned(5 * MiB, 1);
      const second = patterned(123_457, 2);
      const uploadId = await store.uploads.create(key, 'application/octet-stream');
      await sendPart(store, key, uploadId, 2, second);
      await sendPart(store, key, uploadId, 1, first);

      const parts = await store.uploads.parts(key, uploadId);
      expect(parts.map(({ part, size }) => [part, size])).toEqual([
        [1, first.length],
        [2, second.length],
      ]);
      // Before the join there is nothing under the key.
      expect(await store.size(key)).toBeNull();
      await store.uploads.complete(key, uploadId, parts);
      expect(await store.size(key)).toBe(first.length + second.length);
      const tail = await store.get(key, { start: first.length - 3, end: first.length + 2 });
      expect([...(await readAll(tail!.body))]).toEqual([...first.subarray(-3), ...second.subarray(0, 3)]);
      await store.delete(key);
    });

    it('drops an upload with its parts, and an upload already gone is no error', async () => {
      const key = importFileKey(randomUUID(), 'file');
      const uploadId = await store.uploads.create(key, 'application/octet-stream');
      await sendPart(store, key, uploadId, 1, patterned(1000));
      await store.uploads.abort(key, uploadId);
      await expect(store.uploads.abort(key, uploadId)).resolves.toBeUndefined();
      expect(await store.size(key)).toBeNull();
    });

    it('keeps no part of another size than it was sent as', async () => {
      const key = importFileKey(randomUUID(), 'file');
      const uploadId = await store.uploads.create(key, 'application/octet-stream');
      const url = await store.uploads.partUrl(key, uploadId, 1, 1000);
      if (url) {
        // The size is in the signature: the store itself refuses the PUT.
        const res = await fetch(url, { method: 'PUT', body: Buffer.from(patterned(1001)) });
        expect(res.ok).toBe(false);
      } else {
        await expect(store.uploads.write(key, uploadId, 1, inPieces(patterned(1001), 100), 1000)).rejects.toThrow(
          PartSizeMismatch,
        );
      }
      expect(await store.uploads.parts(key, uploadId)).toEqual([]);
      await store.uploads.abort(key, uploadId);
    });
  });
}

streamingContractOf('local', local);
streamingContractOf('s3 (RustFS)', s3);

contractOf('local', local);
contractOf('s3 (RustFS)', s3);

describe('local driver', () => {
  it('lays the namespaces out as directories under one root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shizue-storage-layout-'));
    const storage = createLocalStorage(dir);
    const id = randomUUID();
    await storage.put(avatarKey(id, 'png'), bytesOf('a'), 'image/png');
    await storage.put(assetKey(id, 'gif'), bytesOf('b'), 'image/gif');
    await storage.put(attachmentKey(id, 'png'), bytesOf('c'), 'image/png');
    await storage.put(coverKey(id, 'png'), bytesOf('d'), 'image/png');

    expect((await readdir(dir)).sort()).toEqual(['assets', 'attachments', 'avatars', 'covers']);
    expect(await readdir(join(dir, 'avatars'))).toEqual([`${id}.png`]);
    expect(await readFile(join(dir, 'attachments', `${id}.png`), 'utf-8')).toBe('c');
  });

  it('resolves files put there by anything else, so an existing tree keeps working', async () => {
    // What the migration leaves behind: bytes already on disk under the key the
    // database names, written by a `mv` rather than by `put`.
    const dir = await mkdtemp(join(tmpdir(), 'shizue-storage-existing-'));
    const id = randomUUID();
    await mkdir(join(dir, 'avatars'), { recursive: true });
    await writeFile(join(dir, 'avatars', `${id}.png`), 'migrated');

    const object = await createLocalStorage(dir).get(avatarKey(id, 'png'));
    expect(await readAll(object!.body)).toEqual(Buffer.from('migrated'));
  });

});
