import type { NormalizedCard } from '../types.js';
import {
  archiveOf,
  collectAssets,
  MAX_ASSETS,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  noSkippedAssets,
  readCharxSource,
  type CardAsset,
  type CharxAssetFile,
  type SkippedAssets,
} from './charx.js';
import { MEDIA_SNIFF_BYTES, sniffFont, sniffMedia } from './media.js';
import { CardParseError, normalizeCard } from './normalize.js';
import { isPng } from './png.js';
import { cardWithRisuModule } from './risum.js';
import { risuLoreBookEntry } from './risuModule.js';
import { bytesSource, ChunkReader, MAX_READ_WHOLE_BYTES, type ByteSource } from './source.js';

/** A card read from a file, its embedded files not yet read (`CardAsset.open`). */
export interface ParsedCardSource {
  card: NormalizedCard;
  /**
   * The avatar: a charx's main icon, or a PNG card's own picture — the PNG with
   * its text chunks left out, the card and its assets with them.
   */
  iconBuffer?: Uint8Array;
  /** Embedded pictures, music and web fonts beside the icon, in card order: a charx archive's, or a RisuAI PNG's asset chunks. */
  assets: CardAsset[];
  /** The embedded files the card declares that are not among `assets`, by why — as far as the parse tells. */
  skipped: SkippedAssets;
  /** What the parse already spent of the assets' budget: a charx's icon, read under the same one (`readCardAssets`). */
  spent: number;
}

/** A card read in memory, its files read whole — what the tests look at. */
export interface ParsedCard {
  card: NormalizedCard;
  /** Avatar bytes when the source carried one (the PNG's picture, or the charx main icon). */
  iconBuffer?: Uint8Array;
  /** Embedded pictures, music and web fonts beside the icon: a charx archive's, or a RisuAI PNG's asset chunks. */
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

/** Where one of a PNG's tEXt chunks keeps its text, and the front of that text. */
interface PngText {
  start: number;
  length: number;
  head: Uint8Array;
}

/** Chunk types that can carry a card payload — everything textual — which the picture is kept without. */
const TEXT_CHUNK_TYPES = new Set(['tEXt', 'zTXt', 'iTXt']);
/** How much of a tEXt chunk is read to find its keyword (at most 79 bytes) and the front of its text. */
const KEYWORD_PROBE_BYTES = 2048;

/**
 * A PNG card read front to back in one pass: the card chunks whole, where each
 * asset chunk's text lies (and its first characters, for what the bytes are),
 * and the picture itself — every chunk but the textual ones, through IEND,
 * which is what an avatar of it is (`stripPngTextChunks`). The first chunk of a
 * keyword wins; reading the chunks stops at IEND or at a chunk the file is too
 * short for, and then goes on to the file's end, so a reader that hashes what
 * it streams has seen all of it.
 */
async function scanPng(source: ByteSource): Promise<{
  cards: Map<string, Uint8Array | 'over'>;
  texts: Map<string, PngText>;
  picture: Uint8Array;
}> {
  const reader = new ChunkReader(source.stream(0, source.size));
  const cards = new Map<string, Uint8Array | 'over'>();
  const texts = new Map<string, PngText>();
  const picture: Uint8Array[] = [];
  let pictureBytes = 0;
  const keep = (bytes: Uint8Array): void => {
    pictureBytes += bytes.length;
    if (pictureBytes > MAX_READ_WHOLE_BYTES) {
      throw new CardParseError(`The card's picture is over ${MAX_READ_WHOLE_BYTES / (1024 * 1024)}MB`);
    }
    picture.push(bytes.slice());
  };
  const decoder = new TextDecoder('utf-8');
  try {
    keep(await reader.take(8));
    while (reader.offset + 8 <= source.size) {
      const header = await reader.take(8);
      const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
      const type = decoder.decode(header.subarray(4, 8));
      const dataStart = reader.offset;
      if (dataStart + length > source.size) break;

      if (type === 'tEXt') {
        const probe = await reader.take(Math.min(length, KEYWORD_PROBE_BYTES));
        const separator = probe.indexOf(0);
        const keyword = separator > 0 ? decoder.decode(probe.subarray(0, separator)) : '';
        const rest = length - probe.length;
        if (CARD_CHUNKS.includes(keyword) && !cards.has(keyword)) {
          if (length - separator - 1 > MAX_READ_WHOLE_BYTES) {
            cards.set(keyword, 'over');
            await reader.skip(rest);
          } else {
            const tail = await reader.take(rest);
            const payload = new Uint8Array(length - separator - 1);
            payload.set(probe.subarray(separator + 1), 0);
            payload.set(tail, probe.length - separator - 1);
            cards.set(keyword, payload);
          }
        } else {
          if (keyword.startsWith(PNG_ASSET_CHUNK) && !texts.has(keyword)) {
            texts.set(keyword, {
              start: dataStart + separator + 1,
              length: length - separator - 1,
              head: probe.slice(separator + 1, separator + 1 + SNIFF_BASE64_CHARS),
            });
          }
          await reader.skip(rest);
        }
        await reader.skip(4);
      } else if (TEXT_CHUNK_TYPES.has(type)) {
        await reader.skip(length + 4);
      } else {
        keep(header);
        await reader.pass(length + 4, keep);
      }
      if (type === 'IEND') break;
    }
    await reader.skip(Number.POSITIVE_INFINITY);
  } finally {
    await reader.close();
  }
  const out = new Uint8Array(pictureBytes);
  let at = 0;
  for (const part of picture) {
    out.set(part, at);
    at += part.length;
  }
  return { cards, texts, picture: out };
}

/**
 * Base64 text decoded as it streams, four characters at a time; whitespace
 * between them is passed over, as a whole-string decode passes over it.
 */
async function* base64Decoded(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let carry = '';
  for await (const chunk of chunks) {
    const textual = (carry + Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('latin1')).replace(/\s+/g, '');
    const whole = textual.length - (textual.length % 4);
    carry = textual.slice(whole);
    // Copied off Buffer's shared pool, so each chunk owns its bytes.
    if (whole > 0) yield new Uint8Array(Buffer.from(textual.slice(0, whole), 'base64'));
  }
  if (carry) yield new Uint8Array(Buffer.from(carry, 'base64'));
}

/**
 * The pictures, music and web fonts a PNG card carries beside itself, in card
 * order, under the charx parse budget. What each is comes from its first bytes,
 * decoded off the front of its chunk, so a chunk that is none of them (a voice
 * model) is passed over without reading the rest of it. Each chunk's decoded
 * size is known from its length, so the budget is checked before a byte is
 * read; like a charx pass, taking them stops at the first asset over a cap.
 */
function pngAssets(
  source: ByteSource,
  raw: unknown,
  texts: Map<string, PngText>,
): { assets: CardAsset[]; skipped: SkippedAssets } {
  const assets: CardAsset[] = [];
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

    const chunk = texts.get(`${PNG_ASSET_CHUNK}:${key}`) ?? texts.get(`${PNG_ASSET_CHUNK}${key}`);
    if (!chunk) {
      skipped.missing += 1;
      continue;
    }
    const head = Buffer.from(textOf(chunk.head), 'base64');
    if (!sniffMedia(head) && !sniffFont(head)) {
      skipped.unsupported += 1;
      continue;
    }
    const size = Math.floor((chunk.length * 3) / 4);
    spent += size;
    if (size > MAX_ENTRY_BYTES || spent > MAX_TOTAL_BYTES) {
      over = true;
      skipped.overBudget += 1;
      continue;
    }
    assets.push({
      name: asset.name.trim() || `asset_${key}`,
      size,
      open: () => base64Decoded(source.stream(chunk.start, chunk.length)),
      ...(asset.emotion ? { emotion: true as const } : {}),
    });
  }
  return { assets, skipped };
}

async function parsePngCard(source: ByteSource): Promise<ParsedCardSource> {
  const { cards, texts, picture } = await scanPng(source);
  for (const keyword of CARD_CHUNKS) {
    const payload = cards.get(keyword);
    if (payload === 'over') {
      throw new CardParseError(`The card's ${keyword} chunk is over ${MAX_READ_WHOLE_BYTES / (1024 * 1024)}MB`);
    }
    if (!payload?.length) continue;
    const raw = decodeBase64Json(textOf(payload));
    const card = normalizeCard(raw);
    const { assets, skipped } = pngAssets(source, raw, texts);
    return { card, iconBuffer: picture, assets, skipped, spent: 0 };
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
async function parseCharx(archive: ByteSource): Promise<ParsedCardSource> {
  const { raw, module, iconBuffer, assets, skipped } = await readCharxSource(archive);
  const lorebook = module?.lorebook?.map(risuLoreBookEntry);
  const card = normalizeCard(module ? cardWithRisuModule(raw, module) : raw, lorebook ? { lorebook } : {});
  return { card, ...(iconBuffer ? { iconBuffer } : {}), assets, skipped, spent: iconBuffer?.length ?? 0 };
}

/**
 * Reads a character card from a file — PNG, charx, a JPEG with a charx behind
 * it, or JSON — told apart by its first bytes. What a card is made of is read
 * whole (`MAX_READ_WHOLE_BYTES`); its embedded files are left as streams for
 * the import to store one at a time (`readCardAssets`).
 */
export async function readCardSource(source: ByteSource): Promise<ParsedCardSource> {
  const head = await source.read(0, Math.min(source.size, 8));
  if (isPng(head)) return parsePngCard(source);
  // RisuAI imports its JPEG export through the archive alone, icon included, and
  // so does this: the picture in front is not the avatar.
  const archive = await archiveOf(source, head);
  if (archive) return parseCharx(archive);

  const unsupported = `Unsupported card file: not PNG, charx, or JSON of at most ${MAX_READ_WHOLE_BYTES / (1024 * 1024)}MB`;
  if (source.size > MAX_READ_WHOLE_BYTES) throw new CardParseError(unsupported);
  const bytes = await source.read(0, source.size);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch {
    throw new CardParseError(unsupported);
  }
  return { card: normalizeCard(raw), assets: [], skipped: noSkippedAssets(), spent: 0 };
}

/** A card file in memory, its embedded files read whole — for the tests. */
export async function readCard(bytes: Uint8Array): Promise<ParsedCard> {
  const parsed = await readCardSource(bytesSource(bytes));
  const read = await collectAssets(parsed.assets, { spent: parsed.spent });
  const skipped = { ...parsed.skipped, overBudget: parsed.skipped.overBudget + read.overBudget };
  // A charx always answers its list, a PNG only when it carried something.
  const archive = !isPng(bytes) && (await archiveOf(bytesSource(bytes), bytes.subarray(0, 8))) !== undefined;
  return {
    card: parsed.card,
    ...(parsed.iconBuffer ? { iconBuffer: parsed.iconBuffer } : {}),
    ...(archive || read.assets.length > 0 ? { assets: read.assets } : {}),
    ...(anySkipped(skipped) ? { skipped } : {}),
  };
}

/**
 * Parses a character card from its JSON — as text or as the value. A file's
 * bytes are `readCard`'s (or `readCardSource`'s), which the type refuses here.
 */
export function parseCard<T extends string | object>(input: T extends ArrayBufferView ? never : T): ParsedCard {
  return { card: normalizeCard(typeof input === 'string' ? JSON.parse(input) : input) };
}
