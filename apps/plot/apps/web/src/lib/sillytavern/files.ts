/**
 * The reader's SillyTavern data as the scanner reads it: a backup zip or the
 * `default-user` folder, both read here in the browser and only ever a slice at
 * a time. Nothing in this file sends anything anywhere.
 *
 * `secrets.json` holds the reader's API keys. The scanner has no use for it, so
 * it never reaches the scanner: a folder pick drops it before the list is built,
 * and every file handed on refuses to read under that name regardless.
 */
import type { StFile, ZipSource } from '@shizue/core/sillytavern';

/** The one file in an ST user directory nothing of ours may open. */
const SECRETS = 'secrets.json';

const baseName = (path: string): string => path.split('/').pop() ?? path;

/** True for the reader's key store, wherever in the tree it sits. */
export const isSecretsFile = (path: string): boolean =>
  baseName(path.replaceAll('\\', '/')).toLowerCase() === SECRETS;

const refuse = (): Promise<never> =>
  Promise.reject(new Error(`${SECRETS} is never read`));

/**
 * A zip read in slices off the picked file: the central directory first, then
 * each entry only when the scanner or the import asks for it, so a backup that
 * carries hundreds of megabytes of backgrounds costs what is actually opened.
 */
export function zipSourceOf(file: Blob): ZipSource {
  return {
    size: file.size,
    read: async (offset, length) =>
      new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

/**
 * Wraps the scanner's files so the key store stays shut whatever the scanner's
 * own allowlist says. A zip entry named `secrets.json` is still listed (the
 * listing is the zip's), it just cannot be opened.
 */
export function guardFiles(files: StFile[]): StFile[] {
  return files.map((file) => (isSecretsFile(file.path) ? { ...file, read: refuse } : file));
}

/** A picked file as the folder scanner takes one: the path under the picked folder. */
export interface FolderFile {
  relativePath: string;
  size: number;
  read(): Promise<Uint8Array>;
}

/**
 * The files of a `webkitdirectory` pick, by the path the browser gives each one
 * (`default-user/characters/…`). Nothing is read here — a File is a handle until
 * `read` is called — and the key store is left out of the list altogether.
 */
export function folderFiles(files: Iterable<File>): FolderFile[] {
  const out: FolderFile[] = [];
  for (const file of files) {
    const relativePath = file.webkitRelativePath || file.name;
    if (isSecretsFile(relativePath)) continue;
    out.push({
      relativePath,
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    });
  }
  return out;
}
