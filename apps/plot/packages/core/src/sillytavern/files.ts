/**
 * The files of a SillyTavern user-data directory (`data/<handle>/`) this import
 * reads, wherever they arrive from: the backup zip or a picked folder. Only an
 * allowlist of paths ever becomes a file here — `secrets.json` and everything
 * else in the directory stay where they are — and every read is capped.
 */

import { FileTooLargeError, readZipEntry, type ZipEntry, type ZipSource } from './zip.js';

/** A file under the user-data root; `path` is relative to it and '/'-separated. */
export interface StFile {
  path: string;
  /** Declared size: the zip's claim, or the picked file's. `read` enforces the cap. */
  size: number;
  read(): Promise<Uint8Array>;
}

export type StFileKind = 'settings' | 'character' | 'chat' | 'group' | 'world';

/**
 * Largest file read, by kind, in bytes. A character card's limit is the card
 * import's own (`MAX_CARD_IMPORT_BYTES`); settings.json grows with every
 * extension's settings; a chat of tens of thousands of messages fits in 64 MiB.
 */
export interface StCaps {
  settings: number;
  character: number;
  chat: number;
  group: number;
  world: number;
}

const MIB = 1024 * 1024;

export const ST_CAPS: StCaps = {
  settings: 32 * MIB,
  character: 50 * MIB,
  chat: 64 * MIB,
  group: 1 * MIB,
  world: 16 * MIB,
};

/**
 * What a path under the root is, or undefined when the import leaves it alone.
 * The shapes are ST's own directories (`USER_DIRECTORY_TEMPLATE` in
 * `src/constants.js`) and the extensions ST itself lists by: a character is a
 * `.png` directly in `characters/`, its chats are `chats/<avatar stem>/*.jsonl`,
 * a group's are `group chats/<chat id>.jsonl`.
 */
export function stFileKind(path: string): StFileKind | undefined {
  const parts = path.split('/');
  const [dir, name] = parts;
  if (parts.length === 1) return dir === 'settings.json' ? 'settings' : undefined;
  if (parts.length === 2) {
    if (dir === 'characters' && name!.endsWith('.png')) return 'character';
    if (dir === 'group chats' && name!.endsWith('.jsonl')) return 'chat';
    if (dir === 'groups' && name!.endsWith('.json')) return 'group';
    if (dir === 'worlds' && name!.endsWith('.json')) return 'world';
    return undefined;
  }
  if (parts.length === 3 && dir === 'chats' && parts[2]!.endsWith('.jsonl')) return 'chat';
  return undefined;
}

/** '/'-separated, no leading `./` or `/`; undefined for a folder or a path that climbs out. */
function normalizePath(path: string): string | undefined {
  const parts = path.replaceAll('\\', '/').split('/');
  while (parts[0] === '.' || parts[0] === '') parts.shift();
  if (parts.length === 0 || parts.at(-1) === '' || parts.some((part) => part === '..' || part === '.')) {
    return undefined;
  }
  return parts.join('/');
}

/**
 * Most segments a root may sit under: a backup zip has the user directory at its
 * own root, a re-zipped one inside a folder, and a picked folder starts with its
 * own name — `default-user/…`, `data/default-user/…`, `SillyTavern/data/default-user/…`.
 */
const MAX_ROOT_DEPTH = 3;

/**
 * The user-data root: the prefix in front of the most character cards (and
 * settings.json). One user per import — a picked `data/` holding several users'
 * directories resolves to the one with the most characters, the shallowest on a
 * tie. Pre-1.12 installs kept the same layout under `public/`, so a picked
 * install of that age resolves to `…/public` the same way. Undefined when
 * nothing looks like a user directory.
 */
function findRoot(paths: string[]): string | undefined {
  const votes = new Map<string, { count: number; depth: number }>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let depth = 0; depth <= MAX_ROOT_DEPTH && depth < parts.length; depth += 1) {
      const kind = stFileKind(parts.slice(depth).join('/'));
      if (kind !== 'character' && kind !== 'settings') continue;
      const root = parts.slice(0, depth).join('/');
      const vote = votes.get(root) ?? { count: 0, depth };
      vote.count += 1;
      votes.set(root, vote);
    }
  }
  let best: { root: string; count: number; depth: number } | undefined;
  for (const [root, { count, depth }] of votes) {
    if (!best || count > best.count || (count === best.count && depth < best.depth)) {
      best = { root, count, depth };
    }
  }
  return best?.root;
}

interface Located<T> {
  path: string;
  kind: StFileKind;
  item: T;
}

/** The allowlisted items under the root, by root-relative path; a later duplicate wins, as in unzip. */
function locate<T>(items: T[], pathOf: (item: T) => string): Located<T>[] {
  const normalized = items.flatMap((item) => {
    const path = normalizePath(pathOf(item));
    return path === undefined ? [] : [{ path, item }];
  });
  const root = findRoot(normalized.map(({ path }) => path));
  if (root === undefined) return [];
  const prefix = root ? `${root}/` : '';

  const located = new Map<string, Located<T>>();
  for (const { path, item } of normalized) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    const kind = stFileKind(relative);
    if (kind) located.set(relative, { path: relative, kind, item });
  }
  return [...located.values()];
}

/** The allowlisted files of a backup zip. Reads inflate one entry each, under its kind's cap. */
export function stFilesFromZip(
  source: ZipSource,
  entries: ZipEntry[],
  caps: Partial<StCaps> = {},
): StFile[] {
  const limits = { ...ST_CAPS, ...caps };
  return locate(entries, (entry) => entry.name).map(({ path, kind, item }) => ({
    path,
    size: item.size,
    read: () => readZipEntry(source, item, { maxBytes: limits[kind] }),
  }));
}

/**
 * The allowlisted files of a picked folder (`webkitRelativePath` starts with the
 * folder's own name). A picked file's size is the real one, so an oversized file
 * is refused before it is read.
 */
export function stFilesFromFolder(
  files: { relativePath: string; size: number; read(): Promise<Uint8Array> }[],
  caps: Partial<StCaps> = {},
): StFile[] {
  const limits = { ...ST_CAPS, ...caps };
  return locate(files, (file) => file.relativePath).map(({ path, kind, item }) => ({
    path,
    size: item.size,
    read: async () => {
      if (item.size > limits[kind]) throw new FileTooLargeError(path, limits[kind]);
      const bytes = await item.read();
      if (bytes.length > limits[kind]) throw new FileTooLargeError(path, limits[kind]);
      return bytes;
    },
  }));
}
