/**
 * A RisuAI module brought into a work on its own (`POST /api/plots/:id/modules`),
 * as RisuAI's `importModule` reads one: a `.risum` file, or the module as JSON.
 *
 * - `.risum` (`exportModuleLegacy`) is the main block `card/risum.ts` reads —
 *   `{type: 'risuModule', module}` — then one block per entry of the module's
 *   `assets` (`[name, '', ext]`, the path blanked): `0x01`, a u32 LE length and
 *   that many RPack-encoded bytes of the picture, until a `0x00`. A charx's
 *   embedded `module.risum` is the same file, read there for its scripts alone.
 * - JSON is the module object itself with `type: 'risuModule'`, and RisuAI takes
 *   it only with a `name` and an `id`. Its asset entries name files in the
 *   exporter's own storage, so none of its pictures come along.
 *
 * RisuAI's current export of a module is a `.charx` of the module made a
 * character (`convertModuleToCharacter`); that is not read here.
 *
 * The lorebook is RisuAI's own entry shape (`loreBook`), turned into ours the
 * way a card's comes in: written out as RisuAI's V3 export writes the
 * character's book (`exportCharacterCard`), then read by the card import's
 * entry mapping (`loreEntryFromBook`), so the decorators, the RisuAI key rules
 * and the folders mean here what they mean in a card. The regex scripts and
 * triggers stay as written, for the readers that already read a card's.
 */

import type { LoreEntry, PlotModule } from '../types.js';
import { loreEntryFromBook } from './bookEntry.js';
import { IMAGE_EXTENSIONS, MAX_ASSETS, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, type CharxAssetFile } from './charx.js';
import {
  backgroundWithoutStyles,
  creatorCssFromExtensions,
  displayScriptsFromExtensions,
  MAX_BACKGROUND_HTML_LENGTH,
} from './risu.js';
import { readRisumMain, rpackDecode } from './risum.js';

/** A file this reader cannot take as a RisuAI module. */
export class ModuleParseError extends Error {}

/** What a module brings, read: everything the work keeps of it but its id and record. */
export interface ParsedRisuModule {
  name: string;
  description: string;
  lorebook: LoreEntry[];
  /** `regex`, every type, as the module wrote it. */
  regex: unknown[];
  /** `trigger`, as the module wrote it. */
  trigger: unknown[];
  lowLevelAccess: boolean;
  /** The HTML RisuAI draws behind the chat for the module, `<style>` and all. */
  backgroundEmbedding?: string;
  /** The pictures a `.risum` carried, in its order, under the charx caps. */
  assets: CharxAssetFile[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const splitKeys = (keys: string): string[] => keys.split(',').map((key) => key.trim());

/**
 * One of RisuAI's lore entries (`loreBook`) as ours: as RisuAI's V3 export
 * writes it into a card's book, then read as the card import reads that.
 */
export function risuLoreBookEntry(raw: unknown): LoreEntry {
  const lore = isObject(raw) ? raw : {};
  const extensions: Json = isObject(lore['extentions']) ? { ...lore['extentions'] } : {}; // sic
  const selective = lore['selective'] === true;
  return loreEntryFromBook({
    keys: splitKeys(text(lore['key'])),
    ...(selective ? { secondary_keys: splitKeys(text(lore['secondkey'])) } : {}),
    content: text(lore['content']),
    extensions,
    enabled: true,
    insertion_order: typeof lore['insertorder'] === 'number' ? lore['insertorder'] : 0,
    constant: lore['alwaysActive'] === true,
    selective,
    name: text(lore['comment']),
    comment: text(lore['comment']),
    case_sensitive: extensions['risu_case_sensitive'] === true,
    use_regex: lore['useRegex'] === true,
  });
}

/**
 * The pictures after a `.risum`'s main block, paired with the module's `assets`
 * by position. Read as far as the file holds well-formed blocks and the charx
 * caps allow — a count, a size per picture and a total — stopping at the first
 * that breaks either, as a charx's asset pass does. A block whose entry names a
 * type that is not an image is passed over; one named without a type is tried,
 * and the store skips bytes that are not an image.
 */
function risumAssets(bytes: Uint8Array, start: number, declared: unknown): CharxAssetFile[] {
  const entries = Array.isArray(declared) ? declared : [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const assets: CharxAssetFile[] = [];
  let spent = 0;
  let at = start;
  for (let index = 0; at < bytes.length; index += 1) {
    if (bytes[at] !== 1 || at + 5 > bytes.length) break;
    const length = view.getUint32(at + 1, true);
    const from = at + 5;
    at = from + length;
    if (at > bytes.length || length > MAX_ENTRY_BYTES) break;
    spent += length;
    if (spent > MAX_TOTAL_BYTES || assets.length >= MAX_ASSETS) break;
    const entry = Array.isArray(entries[index]) ? (entries[index] as unknown[]) : [];
    const ext = text(entry[2]).toLowerCase();
    if (ext && !IMAGE_EXTENSIONS.has(ext)) continue;
    assets.push({ name: text(entry[0]).trim() || `asset_${index}`, bytes: rpackDecode(bytes.subarray(from, at)) });
  }
  return assets;
}

function moduleOf(module: Json, assets: CharxAssetFile[]): ParsedRisuModule {
  const background = text(module['backgroundEmbedding']);
  return {
    name: text(module['name']).trim(),
    description: text(module['description']),
    lorebook: Array.isArray(module['lorebook']) ? module['lorebook'].map(risuLoreBookEntry) : [],
    regex: Array.isArray(module['regex']) ? module['regex'] : [],
    trigger: Array.isArray(module['trigger']) ? module['trigger'] : [],
    lowLevelAccess: module['lowLevelAccess'] === true,
    ...(background.trim() ? { backgroundEmbedding: background } : {}),
    assets,
  };
}

/**
 * The record a work keeps of a module (`PlotModule`), by the card import's
 * rules for the same parts of a card: its `editdisplay` regex as display scripts
 * in the sequence RisuAI runs them (`displayScriptsFromExtensions` — a pattern
 * this build will not run comes in switched off), and its background embedding
 * split as a card's `backgroundHTML` is, the `<style>` elements the stylesheet
 * and the rest the background — each left out past the plot's cap, as a card's
 * is. The lore, the regex and the triggers are kept whole.
 */
export function plotModuleOf(
  parsed: Omit<ParsedRisuModule, 'assets'>,
  record: Pick<PlotModule, 'id' | 'name' | 'description' | 'lorebook' | 'assets' | 'importedFrom'>,
): PlotModule {
  const extensions = {
    risuai: { customScripts: parsed.regex, ...(parsed.backgroundEmbedding ? { backgroundHTML: parsed.backgroundEmbedding } : {}) },
  };
  const displayScripts = displayScriptsFromExtensions(extensions);
  const css = creatorCssFromExtensions(extensions);
  const shown = parsed.backgroundEmbedding ? backgroundWithoutStyles(parsed.backgroundEmbedding) : '';
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    lorebook: record.lorebook,
    regex: parsed.regex,
    trigger: parsed.trigger,
    ...(parsed.lowLevelAccess ? { lowLevelAccess: true as const } : {}),
    ...(displayScripts ? { displayScripts } : {}),
    ...(css ? { css } : {}),
    ...(shown && shown.length <= MAX_BACKGROUND_HTML_LENGTH ? { backgroundHtml: shown } : {}),
    assets: record.assets,
    importedFrom: record.importedFrom,
  };
}

/**
 * A RisuAI module file — `.risum` or JSON, told apart by the bytes. Throws
 * `ModuleParseError` for anything else, and for JSON RisuAI itself would turn
 * away (no `name` or no `id`).
 */
export function parseRisuModule(bytes: Uint8Array): ParsedRisuModule {
  const main = readRisumMain(bytes);
  if (main) return moduleOf(main.module, risumAssets(bytes, main.end, main.module['assets']));

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ModuleParseError('Not a RisuAI module: neither a .risum file nor module JSON');
  }
  if (!isObject(json) || json['type'] !== 'risuModule') {
    throw new ModuleParseError('Not a RisuAI module: the JSON is not of type risuModule');
  }
  if (!text(json['name']).trim() || !text(json['id'])) {
    throw new ModuleParseError('A RisuAI module needs a name and an id');
  }
  return moduleOf(json, []);
}
