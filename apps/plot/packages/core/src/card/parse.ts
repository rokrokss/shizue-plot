import type { NormalizedCard } from '../types.js';
import {
  charxInJpeg,
  isZip,
  MAX_ASSETS,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  noSkippedAssets,
  readCharx,
  type CharxAssetFile,
  type SkippedAssets,
} from './charx.js';
import { MEDIA_SNIFF_BYTES, sniffMedia } from './media.js';
import { CardParseError, normalizeCard } from './normalize.js';
import { isPng, readPngTextChunkBytes } from './png.js';
import { cardWithRisuModule } from './risum.js';
import { risuLoreBookEntry } from './risuModule.js';

export interface ParsedCard {
  card: NormalizedCard;
  /** Avatar bytes when the source carried one (PNG itself, or the charx main icon). */
  iconBuffer?: Uint8Array;
  /** Embedded pictures and music beside the icon: a charx archive's, or a RisuAI PNG's asset chunks. */
  assets?: CharxAssetFile[];
  /** The embedded files the card declares that are not among `assets`, by why; absent when none were. */
  skipped?: SkippedAssets;
}

const anySkipped = (skipped: SkippedAssets): boolean =>
  skipped.unsupported + skipped.missing + skipped.overBudget > 0;

/** tEXt keywords holding a card payload, in priority order. */
const CARD_CHUNKS = ['ccv3', 'chara'];

/**
 * A RisuAI PNG card carries its other files in tEXt chunks `chara-ext-asset_:N`
 * (base64) and names each by the uri `__asset:N`. RisuAI's own reader also takes
 * the keyword without the colon, and so does this.
 */
const PNG_ASSET_CHUNK = 'chara-ext-asset_';
const PNG_ASSET_URI = '__asset:';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const textOf = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

function decodeBase64Json(base64: string): unknown {
  const json = Buffer.from(base64, 'base64').toString('utf-8');
  return JSON.parse(json);
}

interface DeclaredPngAsset {
  name: string;
  uri: string;
  /** One of the card's emotion pictures (`CharxAssetFile.emotion`). */
  emotion?: true;
}

/**
 * The assets a PNG card declares, read from where RisuAI reads them for the
 * card's spec: V3 `data.assets`, V2 `extensions.risuai`'s `emotions`
 * (`[name, uri]`) and `additionalAssets` (`[name, uri, ext]`). The extension
 * each declares is not kept: RisuAI writes `unknown` for pictures it has
 * re-encoded, so the bytes say what each is (`pngAssets`). The main icon is left
 * out: the PNG itself is the icon.
 */
function declaredPngAssets(raw: unknown): DeclaredPngAsset[] {
  if (!isObject(raw) || !isObject(raw['data'])) return [];
  const data = raw['data'];

  if (raw['spec'] === 'chara_card_v3') {
    const assets = Array.isArray(data['assets']) ? data['assets'].filter(isObject) : [];
    return assets
      .filter((asset) => !(asset['type'] === 'icon' && asset['name'] === 'main'))
      .map((asset) => ({
        name: text(asset['name']),
        uri: text(asset['uri']),
        ...(asset['type'] === 'emotion' ? { emotion: true as const } : {}),
      }));
  }
  if (raw['spec'] !== 'chara_card_v2') return [];

  const extensions = isObject(data['extensions']) ? data['extensions'] : {};
  const risu = isObject(extensions['risuai']) ? extensions['risuai'] : {};
  const rows = (list: unknown): unknown[][] =>
    Array.isArray(list) ? list.filter((row): row is unknown[] => Array.isArray(row)) : [];
  return [
    ...rows(risu['emotions']).map((row) => ({
      name: text(row[0]),
      uri: text(row[1]),
      emotion: true as const,
    })),
    ...rows(risu['additionalAssets']).map((row) => ({ name: text(row[0]), uri: text(row[1]) })),
  ];
}

/** Base64 characters that decode to the bytes `sniffMedia` reads. */
const SNIFF_BASE64_CHARS = Math.ceil(MEDIA_SNIFF_BYTES / 3) * 4;

/**
 * The pictures and music a PNG card carries beside itself, in card order, under
 * the charx parse budget. What each is comes from its first bytes, decoded off
 * the front of its chunk, so a chunk that is neither (a voice model, a font) is
 * passed over without paying for the rest of it. Each chunk's decoded size is
 * known from its length, so the budget is checked before the decode too; like a
 * charx pass, reading stops at the first asset over a cap.
 */
function pngAssets(
  raw: unknown,
  chunks: Map<string, Uint8Array>,
): { assets: CharxAssetFile[]; skipped: SkippedAssets } {
  const assets: CharxAssetFile[] = [];
  const skipped = noSkippedAssets();
  const seen = new Set<string>();
  let spent = 0;
  /** Set once a cap is reached: everything after it is counted, never read. */
  let over = false;
  for (const asset of declaredPngAssets(raw)) {
    if (!asset.uri.startsWith(PNG_ASSET_URI)) continue;
    const key = asset.uri.slice(PNG_ASSET_URI.length);
    if (seen.has(key)) continue;
    seen.add(key);
    if (over || assets.length >= MAX_ASSETS) {
      skipped.overBudget += 1;
      continue;
    }

    const base64 = chunks.get(`${PNG_ASSET_CHUNK}:${key}`) ?? chunks.get(`${PNG_ASSET_CHUNK}${key}`);
    if (!base64) {
      skipped.missing += 1;
      continue;
    }
    if (!sniffMedia(Buffer.from(textOf(base64.subarray(0, SNIFF_BASE64_CHARS)), 'base64'))) {
      skipped.unsupported += 1;
      continue;
    }
    const size = Math.floor((base64.length * 3) / 4);
    spent += size;
    if (size > MAX_ENTRY_BYTES || spent > MAX_TOTAL_BYTES) {
      over = true;
      skipped.overBudget += 1;
      continue;
    }
    // Copied off Buffer's shared pool, so each asset owns its bytes.
    const bytes = new Uint8Array(Buffer.from(textOf(base64), 'base64'));
    assets.push({
      name: asset.name.trim() || `asset_${key}`,
      bytes,
      ...(asset.emotion ? { emotion: true as const } : {}),
    });
  }
  return { assets, skipped };
}

function parsePngCard(bytes: Uint8Array): ParsedCard {
  const chunks = readPngTextChunkBytes(bytes);
  for (const keyword of CARD_CHUNKS) {
    const payload = chunks.get(keyword);
    if (!payload?.length) continue;
    const raw = decodeBase64Json(textOf(payload));
    const card = normalizeCard(raw);
    const { assets, skipped } = pngAssets(raw, chunks);
    return {
      card,
      iconBuffer: bytes,
      ...(assets.length > 0 ? { assets } : {}),
      ...(anySkipped(skipped) ? { skipped } : {}),
    };
  }
  throw new CardParseError('PNG has no ccv3 or chara tEXt chunk');
}

/**
 * A charx archive. The scripts RisuAI's export moves into `module.risum` are put
 * back on a copy of `card.json` before normalizing, so that copy becomes `raw`:
 * it is the card the archive carried, split over two entries. A module that
 * carries a `lorebook` — even an empty one — gives the card its entries in
 * place of `character_book`'s, read as a module import reads them
 * (`risuLoreBookEntry`), as RisuAI's charx import takes the module's book over
 * the card's (`overrideLorebook`); the book's settings stay the card's.
 */
function parseCharx(bytes: Uint8Array): ParsedCard {
  const { raw, module, iconBuffer, assets, skipped } = readCharx(bytes);
  const lorebook = module?.lorebook?.map(risuLoreBookEntry);
  const card = normalizeCard(module ? cardWithRisuModule(raw, module) : raw, lorebook ? { lorebook } : {});
  return { card, ...(iconBuffer ? { iconBuffer } : {}), assets, ...(anySkipped(skipped) ? { skipped } : {}) };
}

/** Parses a character card from raw bytes (PNG / charx / JPEG with a charx / JSON) or a JSON value. */
export function parseCard(input: Uint8Array | string | object): ParsedCard {
  if (typeof input === 'string') {
    return { card: normalizeCard(JSON.parse(input)) };
  }
  if (!(input instanceof Uint8Array)) {
    return { card: normalizeCard(input) };
  }
  if (isPng(input)) {
    return parsePngCard(input);
  }
  // RisuAI imports its JPEG export through the archive alone, icon included, and
  // so does this: the picture in front is not the avatar.
  const archive = isZip(input) ? input : charxInJpeg(input);
  if (archive) {
    return parseCharx(archive);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8').decode(input));
  } catch {
    throw new CardParseError('Unsupported card file: not PNG, charx, or JSON');
  }
  return { card: normalizeCard(raw) };
}
