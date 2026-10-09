/**
 * Lorebooks as files: SillyTavern's World Info JSON out, and in, the three shapes
 * a lorebook usually travels in — a World Info file, a CCv2/CCv3 `character_book`,
 * or a whole character card carrying one.
 *
 * Dependency-free (`@shizue/core/world-info`), so the studio converts in the
 * browser and the result goes through the ordinary save.
 */

import { loreEntryFromBook, loreEntryFromWorldInfo, worldInfoFieldsOf } from './card/bookEntry.js';
import type { LoreEntry } from './types.js';

/** A file none of the accepted shapes describes. */
export class LorebookFileError extends Error {}

/** SillyTavern's World Info file: entries keyed by their uid. */
export interface WorldInfoFile {
  entries: Record<string, Record<string, unknown>>;
}

/**
 * The entries as a SillyTavern World Info file. Each carries the settings ST
 * reads, under its own names; the uid is the entry's position, which is also its
 * display order there.
 */
export function toWorldInfo(entries: LoreEntry[]): WorldInfoFile {
  return {
    entries: Object.fromEntries(
      entries.map((entry, uid) => [
        String(uid),
        { uid, ...worldInfoFieldsOf(entry), displayIndex: uid },
      ]),
    ),
  };
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Reads the lorebook out of parsed JSON. Accepts a World Info file (`entries` is
 * an object), a character_book (`entries` is an array), a CCv3 lorebook file
 * (`spec: 'lorebook_v3'`, the book under `data`) and a card whose `data` carries
 * a character_book. Anything else throws `LorebookFileError`.
 */
export function fromLorebookFile(json: unknown): LoreEntry[] {
  if (!isObject(json)) throw new LorebookFileError('A lorebook file must be a JSON object');

  const entries = json['entries'];
  if (isObject(entries)) {
    return Object.values(entries).filter(isObject).map(loreEntryFromWorldInfo);
  }
  if (Array.isArray(entries)) return entries.map((entry) => loreEntryFromBook(entry));

  const data = json['data'];
  if (json['spec'] === 'lorebook_v3' && isObject(data) && Array.isArray(data['entries'])) {
    return data['entries'].map((entry) => loreEntryFromBook(entry));
  }
  const book = isObject(data) ? data['character_book'] : undefined;
  if (isObject(book) && Array.isArray(book['entries'])) {
    return book['entries'].map((entry) => loreEntryFromBook(entry));
  }
  throw new LorebookFileError('No lorebook entries in this file');
}
