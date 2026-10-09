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
