import type { NormalizedCard } from '../types.js';
import {
  charxInJpeg,
  IMAGE_EXTENSIONS,
  isZip,
  MAX_ASSETS,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  readCharx,
  type CharxAssetFile,
} from './charx.js';
import { CardParseError, normalizeCard } from './normalize.js';
import { isPng, readPngTextChunkBytes } from './png.js';
import { cardWithRisuModule } from './risum.js';

export interface ParsedCard {
  card: NormalizedCard;
  /** Avatar bytes when the source carried one (PNG itself, or the charx main icon). */
  iconBuffer?: Uint8Array;
  /** Embedded images beside the icon: a charx archive's, or a RisuAI PNG's asset chunks. */
  assets?: CharxAssetFile[];
}

/** tEXt keywords holding a card payload, in priority order. */
const CARD_CHUNKS = ['ccv3', 'chara'];

/**
 * A RisuAI PNG card carries its other images in tEXt chunks `chara-ext-asset_:N`
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
  ext: string;
}

/**
 * The assets a PNG card declares, read from where RisuAI reads them for the
 * card's spec: V3 `data.assets`, V2 `extensions.risuai`'s `emotions`
 * (`[name, uri]`) and `additionalAssets` (`[name, uri, ext]`). The V2 lists take
 * RisuAI's own defaults — an emotion is a png, and so is an additional asset
 * without an ext. The main icon is left out: the PNG itself is the icon.
 */
function declaredPngAssets(raw: unknown): DeclaredPngAsset[] {
  if (!isObject(raw) || !isObject(raw['data'])) return [];
  const data = raw['data'];

  if (raw['spec'] === 'chara_card_v3') {
    const assets = Array.isArray(data['assets']) ? data['assets'].filter(isObject) : [];
    return assets
      .filter((asset) => !(asset['type'] === 'icon' && asset['name'] === 'main'))
      .map((asset) => ({ name: text(asset['name']), uri: text(asset['uri']), ext: text(asset['ext']) }));
  }
  if (raw['spec'] !== 'chara_card_v2') return [];

  const extensions = isObject(data['extensions']) ? data['extensions'] : {};
  const risu = isObject(extensions['risuai']) ? extensions['risuai'] : {};
  const rows = (list: unknown): unknown[][] =>
    Array.isArray(list) ? list.filter((row): row is unknown[] => Array.isArray(row)) : [];
  return [
    ...rows(risu['emotions']).map((row) => ({ name: text(row[0]), uri: text(row[1]), ext: 'png' })),
    ...rows(risu['additionalAssets']).map((row) => ({
      name: text(row[0]),
      uri: text(row[1]),
      ext: text(row[2]) || 'png',
    })),
  ];
}

/**
 * The images a PNG card carries beside itself, in card order, under the charx
 * parse budget. Each chunk's decoded size is known from its length, so the
 * check comes before the decode and nothing is paid for an asset that is then
 * dropped; like a charx pass, reading stops at the first asset over a cap.
 */
function pngAssets(raw: unknown, chunks: Map<string, Uint8Array>): CharxAssetFile[] {
  const assets: CharxAssetFile[] = [];
  const seen = new Set<string>();
  let spent = 0;
  for (const asset of declaredPngAssets(raw)) {
    if (assets.length >= MAX_ASSETS) break;
    if (!asset.uri.startsWith(PNG_ASSET_URI) || !IMAGE_EXTENSIONS.has(asset.ext.toLowerCase())) continue;
    const key = asset.uri.slice(PNG_ASSET_URI.length);
    if (seen.has(key)) continue;
    seen.add(key);

    const base64 = chunks.get(`${PNG_ASSET_CHUNK}:${key}`) ?? chunks.get(`${PNG_ASSET_CHUNK}${key}`);
    if (!base64) continue;
    const size = Math.floor((base64.length * 3) / 4);
    spent += size;
    if (size > MAX_ENTRY_BYTES || spent > MAX_TOTAL_BYTES) break;
    // Copied off Buffer's shared pool, so each asset owns its bytes.
    const bytes = new Uint8Array(Buffer.from(textOf(base64), 'base64'));
    assets.push({ name: asset.name.trim() || `asset_${key}`, bytes });
  }
  return assets;
}

function parsePngCard(bytes: Uint8Array): ParsedCard {
  const chunks = readPngTextChunkBytes(bytes);
  for (const keyword of CARD_CHUNKS) {
    const payload = chunks.get(keyword);
    if (!payload?.length) continue;
    const raw = decodeBase64Json(textOf(payload));
    const card = normalizeCard(raw);
    const assets = pngAssets(raw, chunks);
    return assets.length > 0 ? { card, iconBuffer: bytes, assets } : { card, iconBuffer: bytes };
  }
  throw new CardParseError('PNG has no ccv3 or chara tEXt chunk');
}

/**
 * A charx archive. The scripts RisuAI's export moves into `module.risum` are put
 * back on a copy of `card.json` before normalizing, so that copy becomes `raw`:
 * it is the card the archive carried, split over two entries.
 */
function parseCharx(bytes: Uint8Array): ParsedCard {
  const { raw, module, iconBuffer, assets } = readCharx(bytes);
  const card = normalizeCard(module ? cardWithRisuModule(raw, module) : raw);
  return iconBuffer ? { card, iconBuffer, assets } : { card, assets };
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
