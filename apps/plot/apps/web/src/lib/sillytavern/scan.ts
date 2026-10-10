/**
 * The core's SillyTavern reader, wired to what the reader picked. The one place
 * the wizard calls `@shizue/core/sillytavern` itself — the run takes the same
 * converters through `IMPORT_DEPS`.
 */
import {
  convertSillyTavernChat,
  listZip,
  regexScriptsToDisplayScripts,
  scanSillyTavern,
  stFilesFromFolder,
  stFilesFromZip,
  type StFile,
  type StManifest,
} from '@shizue/core/sillytavern';
import { fromLorebookFile } from '@shizue/core/world-info';
import { ApiError } from '../api';
import { folderFiles, guardFiles, zipSourceOf } from './files';
import type { ImportDeps } from './import';

export type LibrarySource = { kind: 'zip'; file: File } | { kind: 'folder'; files: File[] };

/**
 * Lists the picked backup or folder and scans it. What the scanner opens is
 * settings.json, the character cards and the group files; chats and worlds are
 * only listed, and read later one by one when they are imported.
 */
export async function scanLibrary(source: LibrarySource): Promise<StManifest> {
  let files: StFile[];
  if (source.kind === 'zip') {
    const zip = zipSourceOf(source.file);
    try {
      files = stFilesFromZip(zip, await listZip(zip));
    } catch (caught) {
      throw new ApiError(0, 'st_zip_unreadable', caught instanceof Error ? caught.message : 'Unreadable zip');
    }
  } else {
    files = stFilesFromFolder(folderFiles(source.files));
  }
  const manifest = await scanSillyTavern(guardFiles(files));
  if (manifest.characters.length + manifest.groups.length + manifest.personas.length === 0) {
    throw new ApiError(0, 'st_not_sillytavern', 'No SillyTavern characters, groups or personas found');
  }
  return manifest;
}

export const IMPORT_DEPS: ImportDeps = {
  // A wrapper, not `window.fetch`: the run calls it as a method of this object.
  fetch: (input, init) => fetch(input, init),
  convertChat: convertSillyTavernChat,
  lorebookEntries: fromLorebookFile,
  displayScripts: regexScriptsToDisplayScripts,
};
