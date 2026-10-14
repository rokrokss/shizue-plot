/**
 * A RisuAI module brought into a work on its own (`POST /api/plots/:id/modules`),
 * from any file RisuAI's `importModule` takes, each made one module:
 *
 * - `.charx` — RisuAI's current module export (`exportModule`,
 *   `name.module.charx`), or any character's charx: the archive read as a card
 *   import reads it, then made a module as `convertCharacterToModule` makes one
 *   (`moduleOfCharx`).
 * - `.risum` (`exportModuleLegacy`) is the main block `card/risum.ts` reads —
 *   `{type: 'risuModule', module}` — then one block per entry of the module's
 *   `assets` (`[name, '', ext]`, the path blanked): `0x01`, a u32 LE length and
 *   that many RPack-encoded bytes of the picture, until a `0x00`. A charx's
 *   embedded `module.risum` is the same file.
 * - JSON, in the order RisuAI tries it (`moduleOfJson`): the module object
 *   itself with `type: 'risuModule'`, taken only with a `name` and an `id` (its
 *   asset entries name files in the exporter's own storage, so none of its
 *   pictures come along); RisuAI's lorebook export (`type: 'risu'` with an array
 *   `data`); any file with `entries`, an external lorebook such as
 *   SillyTavern's World Info; and RisuAI's regex export (`type: 'regex'`).
 *
 * The lorebook is RisuAI's own entry shape (`loreBook`), turned into ours the
 * way a card's comes in: written out as RisuAI's V3 export writes the
 * character's book (`exportCharacterCard`), then read by the card import's
 * entry mapping (`loreEntryFromBook`), so the decorators, the RisuAI key rules
 * and the folders mean here what they mean in a card. An external lorebook is
 * read as the studio reads a lorebook file (`fromLorebookFile`). The regex
 * scripts and triggers stay as written, for the readers that already read a
 * card's.
 */

import type { LoreEntry, PlotModule } from '../types.js';
import { fromLorebookFile, LorebookFileError } from '../worldInfo.js';
import { loreEntryFromBook } from './bookEntry.js';
import {
  charxInJpeg,
  IMAGE_EXTENSIONS,
  isZip,
  MAX_ASSETS,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  readCharx,
  type CharxAssetFile,
  type CharxContents,
} from './charx.js';
import {
  backgroundHtmlOf,
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
  /** RisuAI's `namespace`: the name a character's module list and `{{moduleenabled}}` find the module by. */
  namespace?: string;
  /** The pictures a `.risum` or a charx carried, in its order, under the charx caps. */
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
  const namespace = text(module['namespace']);
  return {
    name: text(module['name']).trim(),
    description: text(module['description']),
    lorebook: Array.isArray(module['lorebook']) ? module['lorebook'].map(risuLoreBookEntry) : [],
    regex: Array.isArray(module['regex']) ? module['regex'] : [],
    trigger: Array.isArray(module['trigger']) ? module['trigger'] : [],
    lowLevelAccess: module['lowLevelAccess'] === true,
    ...(background.trim() ? { backgroundEmbedding: background } : {}),
    ...(namespace ? { namespace } : {}),
    assets,
  };
}

/** A lore entry in RisuAI's shape, as `convertCharacterToModule` writes its three. */
const indicatorEntry = (comment: string, content: string, alwaysActive: boolean): Json => ({
  key: '',
  secondkey: '',
  insertorder: 0,
  comment,
  content,
  mode: 'constant',
  alwaysActive,
  selective: false,
});

/**
 * What RisuAI's `convertCharacterToModule` adds to a character's lore when it
 * makes the character a module: its description, its first messages and its
 * global-note replacement, each a lore entry marked `@@indicator …` so that
 * `convertModuleToCharacter` can make them fields again. Written here exactly as
 * RisuAI writes them — its entry shape, its text, its order.
 *
 * In a module RisuAI reads them as any other lore: its matcher drops the
 * `@@indicator` line as a decorator it does not know, so the description and
 * the global note, always active, are sent as lore (the note is not put in the
 * global note's place), and the first messages, neither always active nor
 * keyed, are never sent. The card import's mapping does the same with them —
 * `parseDecorators` strips the line — so they need nothing of their own.
 */
export function indicatorLore(character: {
  desc: string;
  firstMessage: string;
  alternateGreetings: readonly string[];
  replaceGlobalNote: string;
}): Json[] {
  const entries: Json[] = [];
  if (character.desc) {
    entries.push(indicatorEntry('From Character Description', `@@indicator character_desc\n\n${character.desc}`, true));
  }
  if (character.firstMessage || character.alternateGreetings.length > 0) {
    let firstMessages = `<FM>\n${character.firstMessage}\n</FM>`;
    for (const greeting of character.alternateGreetings) firstMessages += `\n<FM_alt>\n${greeting}\n</FM_alt>`;
    entries.push(indicatorEntry('From First Messages', `@@indicator character_first_message\n\n${firstMessages}`, false));
  }
  if (character.replaceGlobalNote) {
    entries.push(
      indicatorEntry(
        'From Global Note Replacement',
        `@@indicator replace_global_note\n\n${character.replaceGlobalNote}`,
        true,
      ),
    );
  }
  return entries;
}

/**
 * A charx made a module, as RisuAI's `importModule` makes one: the archive read
 * as its character import reads it (`importCharacterProcess`), and the
 * character then turned into a module (`convertCharacterToModule`).
 *
 * - The card must be V3, as RisuAI's charx import asks.
 * - The name, and the creator notes as the description.
 * - The lore: the embedded `module.risum`'s lorebook, which RisuAI's charx
 *   import takes over the card's book, or else the card's `character_book`;
 *   then the `@@indicator` entries (`indicatorLore`) for the description, the
 *   first messages and the global-note replacement (`post_history_instructions`).
 * - The regex scripts and triggers: the module's when the archive has one, as
 *   RisuAI's import puts them in place of the card's, or else the card's.
 * - `lowLevelAccess`, the background HTML as the background embedding, and the
 *   module namespace, from `extensions.risuai`.
 * - The pictures RisuAI keeps, its `additionalAssets` (`x-risu-asset`) — not
 *   the icon, where RisuAI's module export puts a stand-in for a module with
 *   none (`moduleNoneImage`), nor emotion or other pictures.
 *
 * What RisuAI's module has and ours does not keep — the icon, `hideIcon`, the
 * toggles — is left behind, as for a `.risum`. Whatever the archive's reader
 * throws is the file's doing, so it is a `ModuleParseError`.
 */
function moduleOfCharx(archive: Uint8Array): ParsedRisuModule {
  let contents: CharxContents;
  try {
    contents = readCharx(archive);
  } catch (error) {
    throw new ModuleParseError(`The charx could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const card = isObject(contents.raw) ? contents.raw : {};
  if (card['spec'] !== 'chara_card_v3') throw new ModuleParseError('A charx module must hold a V3 card');
  const data = isObject(card['data']) ? card['data'] : {};
  const extensions = isObject(data['extensions']) ? data['extensions'] : {};
  const risu = isObject(extensions['risuai']) ? extensions['risuai'] : {};
  const book = isObject(data['character_book']) ? data['character_book'] : {};
  const module = contents.module;
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

  const ownLore = module?.lorebook
    ? module.lorebook.map(risuLoreBookEntry)
    : list(book['entries']).map((entry) => loreEntryFromBook(entry));
  const indicators = indicatorLore({
    desc: text(data['description']),
    firstMessage: text(data['first_mes']),
    alternateGreetings: list(data['alternate_greetings']).map(text),
    replaceGlobalNote: text(data['post_history_instructions']),
  });
  const background = backgroundHtmlOf(extensions);
  const namespace = text(risu['moduleNamespace']);
  return {
    name: text(data['name']).trim(),
    description: text(data['creator_notes']),
    lorebook: [...ownLore, ...indicators.map(risuLoreBookEntry)],
    regex: module ? (module.regex ?? []) : list(risu['customScripts']),
    trigger: module ? (module.trigger ?? []) : list(risu['triggerscript']),
    lowLevelAccess: risu['lowLevelAccess'] === true,
    ...(background ? { backgroundEmbedding: background } : {}),
    ...(namespace ? { namespace } : {}),
    assets: contents.assets.filter((asset) => asset.additional),
  };
}

/** A module of one kind of thing, named as RisuAI names it when the file says nothing. */
function convertedModule(
  json: Json,
  defaults: { name: string; description: string },
  parts: Partial<Pick<ParsedRisuModule, 'lorebook' | 'regex'>>,
): ParsedRisuModule {
  return {
    name: text(json['name']).trim() || defaults.name,
    description: text(json['description']) || defaults.description,
    lorebook: parts.lorebook ?? [],
    regex: parts.regex ?? [],
    trigger: [],
    lowLevelAccess: false,
    assets: [],
  };
}

/**
 * The JSON RisuAI's `importModule` takes, tried in its order. The defaults are
 * RisuAI's own words, kept as data. A module without its name or id is turned
 * away, as RisuAI turns it away, rather than read as one of the others; the
 * lorebook export needs its `data` to be an array, which is what tells it from
 * a HypaV3 preset export of the same `type`.
 */
function moduleOfJson(json: Json): ParsedRisuModule {
  if (json['type'] === 'risuModule') {
    if (!text(json['name']).trim() || !text(json['id'])) {
      throw new ModuleParseError('A RisuAI module needs a name and an id');
    }
    return moduleOf(json, []);
  }
  if (json['type'] === 'risu' && Array.isArray(json['data'])) {
    return convertedModule(
      json,
      { name: 'Imported Lorebook', description: 'Converted from risu lorebook' },
      { lorebook: json['data'].map(risuLoreBookEntry) },
    );
  }
  if (json['entries']) {
    let lorebook: LoreEntry[];
    try {
      lorebook = fromLorebookFile({ entries: json['entries'] });
    } catch (error) {
      if (error instanceof LorebookFileError) throw new ModuleParseError(error.message);
      throw error;
    }
    return convertedModule(
      json,
      { name: 'Imported Lorebook', description: 'Converted from external lorebook' },
      { lorebook },
    );
  }
  if (json['type'] === 'regex' && Array.isArray(json['data'])) {
    return convertedModule(
      json,
      { name: 'Imported Regex', description: 'Converted from risu regex' },
      { regex: json['data'] },
    );
  }
  throw new ModuleParseError('Not a RisuAI module: no module, lorebook or regex scripts in this JSON');
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
    ...(parsed.namespace ? { namespace: parsed.namespace } : {}),
    ...(displayScripts ? { displayScripts } : {}),
    ...(css ? { css } : {}),
    ...(shown && shown.length <= MAX_BACKGROUND_HTML_LENGTH ? { backgroundHtml: shown } : {}),
    assets: record.assets,
    importedFrom: record.importedFrom,
  };
}

/**
 * A file RisuAI's module import takes — a charx (also one behind a JPEG, which
 * RisuAI's charx reader takes too), a `.risum` or JSON, told apart by the bytes
 * rather than the name — as one module. Throws `ModuleParseError` for anything
 * else, and for what RisuAI itself would turn away.
 */
export function parseRisuModule(bytes: Uint8Array): ParsedRisuModule {
  const archive = isZip(bytes) ? bytes : charxInJpeg(bytes);
  if (archive) return moduleOfCharx(archive);

  const main = readRisumMain(bytes);
  if (main) return moduleOf(main.module, risumAssets(bytes, main.end, main.module['assets']));

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ModuleParseError('Not a RisuAI module: neither a charx, a .risum file nor JSON');
  }
  if (!isObject(json)) throw new ModuleParseError('Not a RisuAI module: the JSON is not an object');
  return moduleOfJson(json);
}
