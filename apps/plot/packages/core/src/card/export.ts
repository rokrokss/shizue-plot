import { CCardLib, type CharacterCardV3, type LorebookEntry } from '@risuai/ccardlib';
import { zipSync } from 'fflate';
import type { LoreEntry, NarratorConfig, NormalizedCard, PlotCustomUi } from '../types.js';
import { BOOK_MARK, bookExtensionsOf, FOREVER_MESSAGES, keysForSillyTavern } from './bookEntry.js';
import { extensionsWithComponentCode } from './componentCode.js';
import { extensionsWithIntro } from './intro.js';
import { extensionsWithNarrator } from './narrator.js';
import { insertPngTextChunks, placeholderPng, stripPngTextChunks } from './png.js';
import { extensionsWithCustomUi } from './risu.js';
import { extensionsWithDepthPrompt } from './sillyTavern.js';

/**
 * depth/role have no V3 field of their own, so they go back out as decorators,
 * and so does a sticky or cooldown long enough to be the "after match" ones. A
 * switched-off entry says so as `@@dont_activate` too: RisuAI lore has no
 * `enabled`, so that line is the only off switch it reads.
 */
function toContent(entry: LoreEntry): string {
  const decorators: string[] = [];
  if (entry.depth !== undefined) {
    decorators.push(`@@depth ${entry.depth}`);
    if (entry.role) decorators.push(`@@role ${entry.role}`);
  }
  if ((entry.sticky ?? 0) >= FOREVER_MESSAGES) decorators.push('@@keep_activate_after_match');
  if ((entry.cooldown ?? 0) >= FOREVER_MESSAGES) decorators.push('@@dont_activate_after_match');
  if (!entry.enabled) decorators.push('@@dont_activate');
  return decorators.length > 0 ? `${decorators.join('\n')}\n${entry.content}` : entry.content;
}

/**
 * Everything V3 has no field for also goes out as SillyTavern's per-entry
 * extensions, which is where ST reads it and where our own import reads it back;
 * only the settings `toContent` names are decorators too, so the content stays
 * clean. A regex entry's
 * keys are spelled `/source/flags`, the one form ST reads as a regex.
 */
function toLorebookEntry(entry: LoreEntry, index: number): LorebookEntry {
  const { keys, secondaryKeys } = keysForSillyTavern(entry);
  return {
    // Both, as RisuAI writes them: ST reads `comment`, the spec names `name`.
    ...(entry.name ? { name: entry.name, comment: entry.name } : {}),
    keys,
    secondary_keys: secondaryKeys,
    selective: entry.selective,
    content: toContent(entry),
    extensions: bookExtensionsOf(entry),
    enabled: entry.enabled,
    constant: entry.constant,
    insertion_order: entry.insertionOrder,
    case_sensitive: entry.caseSensitive,
    use_regex: entry.useRegex,
    // V3 knows two positions. SillyTavern's others go out in its extensions,
    // where ST and our import read them; a reader that knows only V3 reads the
    // `after_` ones as after the character and the rest as before it.
    position: entry.position.startsWith('after_') ? 'after_char' : 'before_char',
    id: index,
  };
}

/**
 * What the import lifted off the card and onto the plot — the narrator, the
 * custom UI, the openings — and the plot's own lorebook, which belong to the work
 * rather than to one of its members. Export writes them back so a card
 * round-trips: import wraps a card into a plot, export unwraps that plot's member
 * back into a card.
 */
export interface CardPlotOverlay {
  narrator?: NarratorConfig;
  customUi?: PlotCustomUi;
  /**
   * The plot's openings: the first becomes `first_mes`, the rest the alternates.
   * One that is also among the card's group-only greetings is left out — an
   * import into a cast made it an opening (`NormalizedCard.groupOnlyGreetings`),
   * and it goes back out once, in the field it came from.
   */
  intros?: string[];
  /** The plot's lorebook, appended after the card's own entries. */
  lorebook?: LoreEntry[];
  /**
   * RisuAI's `backgroundHTML` to write in place of the card's own: the charx
   * export's, which carries the work's stylesheet and background with their
   * assets in the archive (`toRisuAssetRefs`). '' writes none. Absent, the
   * card's own goes out as it came.
   */
  backgroundHtml?: string;
}

/** One of a plot's assets, as a charx export names it (`toRisuAssetRefs`). */
export interface RisuAssetName {
  slug: string;
  /** The card's own name for it, or the address it was fetched from (`localizedName`); null for an upload. */
  name: string | null;
}

/** What a `{{raw::…}}` may hold and still be read as one name, by RisuAI's asset pattern and by ours. */
const SAFE_ASSET_NAME = /^[^{}<>"'`\\\n\r]+$/;

/** The name an asset is reached by in an exported card: its own when that reads as one, else its slug — both are declared (`exportCardCharx`). */
const nameInCard = (asset: RisuAssetName): string =>
  asset.name && SAFE_ASSET_NAME.test(asset.name) && !asset.name.includes('::') ? asset.name : asset.slug;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A text of the work with every address of one of the plot's assets written as
 * RisuAI reaches an asset a card carries: `{{raw::name}}`, which its
 * `parseAdditionalAssets` answers with the file's address — in a greeting, a
 * script's output and the background alike, `url(…)` and `src` included — and
 * which this app's own import reads back the same way (`assetResolver` by name;
 * a stylesheet's are resolved at import, `rewriteAssetAddresses`).
 *
 * - `/api/plots/<plot>/assets/<slug>` names the asset by its own name, or its
 *   slug where the name would not read as one (`nameInCard`). A fetched asset's
 *   name is the address it came from, so the card names it by that.
 * - `/api/plots/<plot>/assets/by-name/<host>/<path>` is a template's
 *   (`localizeAssets.ts`): the slot in it — a capture, a draw — is filled when
 *   the text is drawn, and the address it then reads is the name of the asset
 *   fetched for that value, so it becomes `{{raw::https://<host>/<path>}}`.
 *
 * Only this plot's addresses change; anything else is left as written.
 */
export function toRisuAssetRefs(text: string, plotId: string, assets: readonly RisuAssetName[]): string {
  const base = `/api/plots/${plotId}/assets/`;
  if (!text.includes(base)) return text;
  const bySlug = new Map(assets.map((asset) => [asset.slug, asset]));
  const prefix = escapeRegExp(base);
  return text
    .replace(new RegExp(`${prefix}by-name/([^"'()\\s<>]+)`, 'g'), (_match, rest: string) => `{{raw::https://${rest}}}`)
    .replace(new RegExp(`${prefix}([a-z0-9_-]+)(?![\\w/-])`, 'g'), (match, slug: string) => {
      const asset = bySlug.get(slug);
      return asset ? `{{raw::${nameInCard(asset)}}}` : match;
    });
}

/** The extensions with RisuAI's `backgroundHTML` set to `html` ('' for none), or as they were when `html` is absent. */
function extensionsWithBackground(extensions: Record<string, unknown>, html: string | undefined): Record<string, unknown> {
  if (html === undefined) return extensions;
  const previous = extensions['risuai'];
  const risu: Record<string, unknown> =
    previous !== null && typeof previous === 'object' ? { ...(previous as Record<string, unknown>) } : {};
  if (html) risu['backgroundHTML'] = html;
  else delete risu['backgroundHTML'];
  const next = { ...extensions };
  if (Object.keys(risu).length > 0) next['risuai'] = risu;
  else delete next['risuai'];
  return next;
}

/**
 * Exports to a CCv3 JSON card.
 *
 * The overlay wins over whatever the stored card still carries: the plot is
 * where those fields are edited, so the card's copies are the import's leftovers.
 */
export function exportCardV3(card: NormalizedCard, overlay: CardPlotOverlay = {}): CharacterCardV3 {
  const narrator = overlay.narrator ?? card.narrator;
  const customUi = overlay.customUi;
  const displayScripts = customUi ? customUi.displayScripts : card.displayScripts;
  const defaultVariables = customUi ? customUi.defaultVariables : card.defaultVariables;
  const componentCode = customUi ? customUi.componentCode : card.componentCode;
  const componentCapabilities = customUi
    ? customUi.componentCapabilities
    : card.componentCapabilities;
  const groupOnlyGreetings = card.groupOnlyGreetings ?? [];
  const plotIntros = overlay.intros?.filter((intro) => !groupOnlyGreetings.includes(intro));
  // A plot with no openings has nothing to say about them, so the card's stand.
  const intros = plotIntros?.length ? plotIntros : undefined;
  // The character's note goes back to `extensions.depth_prompt`, where ST keeps it.
  const lorebook = [...card.lorebook.filter((entry) => !entry.depthPrompt), ...(overlay.lorebook ?? [])];

  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: card.name,
      nickname: card.nickname ?? '',
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: intros ? intros[0]! : card.firstMes,
      alternate_greetings: intros ? intros.slice(1) : card.alternateGreetings,
      group_only_greetings: groupOnlyGreetings,
      mes_example: card.mesExample,
      system_prompt: card.systemPrompt,
      post_history_instructions: card.postHistoryInstructions,
      creator_notes: card.creatorNotes,
      tags: card.tags,
      creator: card.creator,
      character_version: card.characterVersion,
      character_book: {
        // What RisuAI's own exporter writes on every book, and how our import
        // tells a RisuAI book from the rest — so its key matching survives the
        // trip — and our own mark, which tells our ST-shaped entries from ST's
        // own (`BOOK_MARK`).
        extensions: {
          ...(card.loreSettings.risuMatching ? { risu_fullWordMatching: false } : {}),
          [BOOK_MARK]: true,
        },
        scan_depth: card.loreSettings.scanDepth,
        // An automatic budget is no number to write down; the importer picks its own.
        ...(card.loreSettings.tokenBudget !== undefined
          ? { token_budget: card.loreSettings.tokenBudget }
          : {}),
        recursive_scanning: card.loreSettings.recursiveScanning,
        entries: lorebook.map(toLorebookEntry),
      },
      // Display scripts and default variables live in the RisuAI extension block,
      // which is where an importing client expects to find them; the component
      // code, the narrator and the reader-facing intro have no prior art anywhere,
      // so they go under our own namespace, which they share.
      extensions: extensionsWithIntro(
        extensionsWithNarrator(
          extensionsWithComponentCode(
            extensionsWithBackground(
              extensionsWithCustomUi(
                extensionsWithDepthPrompt(card.extensions, card.lorebook),
                displayScripts,
                defaultVariables,
              ),
              overlay.backgroundHtml,
            ),
            componentCode,
            componentCapabilities,
          ),
          narrator,
        ),
        card.intro,
      ),
    },
  };
}

const base64Json = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');

/**
 * The card as a PNG: `image` with its text chunks stripped (or a placeholder when
 * there is none, it is not a PNG, or it cannot be walked), carrying the card the
 * way every reader looks for it — `ccv3` with the V3 JSON, and `chara` with the
 * V2 backfill for readers that predate V3. The backfill is ccardlib's, which also
 * removes the decorators from entry content, as the V3 spec asks of a backfill;
 * depth and role survive it in the SillyTavern entry extensions.
 */
export function exportCardPng(card: CharacterCardV3, image?: Uint8Array): Uint8Array {
  const stripped = image ? stripPngTextChunks(image) : null;
  const v2 = CCardLib.character.convert(card, { from: 'v3', to: 'v2' });
  return insertPngTextChunks(stripped ?? placeholderPng(), [
    ['chara', base64Json(v2)],
    ['ccv3', base64Json(card)],
  ]);
}

/** An image a charx export carries. */
export interface CharxExportImage {
  /** Extension without the dot, as the image was sniffed when it was stored (`png`, `jpg`, …). */
  ext: string;
  bytes: Uint8Array;
}

/** A plot asset on its way into a charx. */
export interface CharxExportAsset extends CharxExportImage {
  /** Names the file inside the archive and nothing else, so it must be unique and path-safe — a slug is. */
  slug: string;
  /** The card's own name for the image; null (an upload without one) goes out as the slug. */
  name: string | null;
  /**
   * The name it goes by among the member's emotion pictures, when it is one
   * (`NormalizedCard.emotionImages`): declared as RisuAI's `emotion` too.
   */
  emotion?: string;
}

const EMBEDDED_PREFIX = 'embeded://'; // sic — the CCv3 spec spells it this way.

/**
 * The folder under `assets/<type>/` RisuAI's charx export files an asset in, by
 * its extension (`exportCharacterCard`): pictures, audio, video and fonts each
 * their own, anything else `other`.
 */
function charxAssetKind(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'avif':
      return 'image';
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'flac':
      return 'audio';
    case 'mp4':
    case 'webm':
    case 'mov':
    case 'avi':
    case 'mkv':
      return 'video';
    case 'otf':
    case 'ttf':
    case 'woff':
    case 'woff2':
      return 'fonts';
    default:
      return 'other';
  }
}

/**
 * The card as a .charx archive with its images in it — the one export that
 * carries a plot's assets, so the `{{img::…}}` references in it still resolve
 * once the card is somewhere else.
 *
 * Laid out the way RisuAI's charx export lays it out (characterCards.ts,
 * `exportCharacterCard` and `createBaseV3`), since RisuAI is the reader that
 * matters: the main icon as `{type: 'icon', name: 'main'}` under
 * `assets/icon/image/`, and every asset as `x-risu-asset` under
 * `assets/other/<kind>/` — the type RisuAI's import files into
 * `additionalAssets`, the list its `{{img::name}}` looks names up in (without
 * case), and the folder RisuAI's export picks by the file's extension
 * (`charxAssetKind`). An `emotion` would only answer `{{emotion::…}}`. The files are named by
 * slug rather than by name as RisuAI names them: a card's names can hold a `/`,
 * a `..` or Hangul, and the path is only ever looked up through the `uri`, so
 * the name rides in `name` alone. RisuAI's `x_meta/` sidecars and its
 * `module.risum` are left out — its import reads the scripts from `card.json`
 * when there is no module, and a module would replace them.
 *
 * Every entry `data.assets` declares is in the archive: RisuAI's import throws
 * on an `embeded://` it cannot find, so a caller with an image missing leaves
 * it out of `assets` rather than passing something empty. Nothing is
 * compressed, as RisuAI does not compress either — the images already are — and
 * every local header carries its sizes, so a streaming reader takes exact byte
 * counts instead of looking for the next signature inside the picture.
 */
export function exportCardCharx(
  card: CharacterCardV3,
  assets: CharxExportAsset[],
  icon?: CharxExportImage,
): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const declared: NonNullable<CharacterCardV3['data']['assets']> = [];
  const embed = (type: string, name: string, path: string, image: CharxExportImage): void => {
    files[path] = image.bytes;
    declared.push({ type, uri: `${EMBEDDED_PREFIX}${path}`, name, ext: image.ext });
  };

  if (icon) embed('icon', 'main', `assets/icon/image/main.${icon.ext}`, icon);
  for (const asset of assets) {
    const name = asset.name?.trim() ? asset.name : asset.slug;
    const path = `assets/other/${charxAssetKind(asset.ext)}/${asset.slug}.${asset.ext}`;
    // One of the member's emotion pictures goes in as RisuAI's `emotion` first —
    // what its import puts in `emotionImages`, and the declaration our own import
    // keeps for the file — and as an asset as well, for `{{img::…}}`.
    if (asset.emotion !== undefined) {
      declared.push({ type: 'emotion', uri: `${EMBEDDED_PREFIX}${path}`, name: asset.emotion, ext: asset.ext });
    }
    embed('x-risu-asset', name, path, asset);
    // The studio hands creators `{{img::slug}}`, and RisuAI knows an image only
    // by its names — so one imported under a name of its own (any Korean one)
    // is declared a second time under the slug, pointing at the same file.
    // Our own import reads each file once and keeps the first name.
    if (name.toLowerCase() !== asset.slug.toLowerCase()) {
      declared.push({ type: 'x-risu-asset', uri: `${EMBEDDED_PREFIX}${path}`, name: asset.slug, ext: asset.ext });
    }
  }
  // Last, as RisuAI writes it: the card is the one entry that names the others.
  files['card.json'] = new TextEncoder().encode(
    JSON.stringify({ ...card, data: { ...card.data, assets: declared } }),
  );
  return zipSync(files, { level: 0 });
}
