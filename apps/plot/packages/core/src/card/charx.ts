import { FileTooLargeError, listZip, streamZipEntry, ZipError, type ZipEntry } from '../sillytavern/zip.js';
import { MAX_CARD_IMPORT_BYTES } from '../types.js';
import { AUDIO_EXTENSIONS, FONT_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from './media.js';
import { CardParseError } from './normalize.js';
import { readRisumMainFrom, type RisuModuleScripts } from './risum.js';
import { ByteSourceError, collectBytes, MAX_READ_WHOLE_BYTES, sliceSource, type ByteSource } from './source.js';

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const EMBEDDED_PREFIX = 'embeded://'; // sic — the CCv3 spec spells it this way.
export { MAX_READ_WHOLE_BYTES } from './source.js';
/**
 * Budget for the bytes the icon and the assets inflate to. The per-entry cap
 * bounds one entry; this bounds the work: an archive can name dozens of entries
 * that each stop just under it.
 *
 * As large as the file an import takes: images are stored rather than deflated,
 * so a card under that cap holds about this much of them, and a smaller budget
 * would quietly drop the rest of a big card's pictures.
 */
export const MAX_TOTAL_BYTES = MAX_CARD_IMPORT_BYTES;
/**
 * Decompressed-size cap per asset. An asset is streamed into the store, never
 * held, so nothing but the budget bounds it: a card's 300MB video comes in, as
 * RisuAI plays it (2026-10-17 — until then 100MB, and an asset over it ended
 * the asset pass).
 */
export const MAX_ENTRY_BYTES = MAX_TOTAL_BYTES;
/**
 * Embedded assets kept per archive — a parse budget, at the plot's asset cap
 * (`MAX_ASSETS_PER_PLOT` in the API): Realm's popular cards carry a few hundred
 * images and the largest well over a thousand, and one card is allowed to fill
 * a plot.
 */
export const MAX_ASSETS = 10_000;
/** Pictures, music, video and web fonts become the plot's assets; the declared type is not restricted. */
export { IMAGE_EXTENSIONS };

export function isZip(bytes: Uint8Array): boolean {
  return ZIP_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const EOCD_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
/** End-of-central-directory record without its comment, which is at most 64KiB. */
const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

export const isJpeg = (bytes: Uint8Array): boolean => JPEG_SIGNATURE.every((byte, i) => bytes[i] === byte);

/**
 * Where the charx inside a JPEG starts — RisuAI's "charx jpeg" export writes the
 * picture and then streams a whole archive after it — read off the file's last
 * bytes: `tail` is the file from `tailStart` to its end. Undefined when there is
 * no archive.
 *
 * The archive is found from its end-of-central-directory record rather than by
 * looking for a local header, since `PK\x03\x04` can turn up in JPEG data by
 * chance. The offsets in that record count from the archive's own first byte —
 * RisuAI does not shift them for the picture in front — so the archive starts
 * where its central directory really is, minus where it claims to be.
 */
function archiveStartIn(tail: Uint8Array, tailStart: number): number | undefined {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const last = tail.length - EOCD_BYTES;
  for (let at = last; at >= 0 && at >= last - MAX_COMMENT_BYTES; at -= 1) {
    if (!EOCD_SIGNATURE.every((byte, i) => tail[at + i] === byte)) continue;
    // A real record's comment runs exactly to the end of the file.
    if (at + EOCD_BYTES + view.getUint16(at + 20, true) !== tail.length) continue;
    const start = tailStart + at - view.getUint32(at + 12, true) - view.getUint32(at + 16, true);
    return start >= 0 ? start : undefined;
  }
  return undefined;
}

/** The charx inside a JPEG, in memory (`archiveOf` reads the same off a source). */
export function charxInJpeg(bytes: Uint8Array): Uint8Array | undefined {
  if (!isJpeg(bytes)) return undefined;
  const start = archiveStartIn(bytes, 0);
  return start !== undefined && isZip(bytes.subarray(start)) ? bytes.subarray(start) : undefined;
}

/**
 * The charx a file is or carries: the file itself when it is a ZIP, the archive
 * behind the picture when it is a JPEG with one (`charxInJpeg`), else undefined.
 * `head` is the file's first bytes.
 */
export async function archiveOf(source: ByteSource, head: Uint8Array): Promise<ByteSource | undefined> {
  if (isZip(head)) return source;
  if (!isJpeg(head)) return undefined;
  const tailLength = Math.min(source.size, EOCD_BYTES + MAX_COMMENT_BYTES);
  const tailStart = source.size - tailLength;
  const start = archiveStartIn(await source.read(tailStart, tailLength), tailStart);
  if (start === undefined || !isZip(await source.read(start, ZIP_SIGNATURE.length))) return undefined;
  return sliceSource(source, start);
}

interface CharxAsset {
  type?: string;
  name?: string;
  uri?: string;
  ext?: string;
}

/**
 * An embedded picture, piece of music, video or web font, read whole — what a
 * parse in memory (`readCard`, the tests) hands back for each `CardAsset`.
 */
export interface CharxAssetFile {
  /** Asset name as the card declares it; falls back to the entry file name. */
  name: string;
  bytes: Uint8Array;
  /**
   * Declared one of the card's emotion pictures (RisuAI's `emotionImages` — a
   * V3 asset of type `emotion`, a V2 card's `extensions.risuai.emotions`).
   */
  emotion?: true;
  /**
   * Declared one of RisuAI's `additionalAssets` (a V3 asset of type
   * `x-risu-asset`): the only pictures RisuAI keeps when it makes a card a
   * module (`convertCharacterToModule`).
   */
  additional?: true;
}

/**
 * An embedded file a card or module carries, not yet read: the import streams
 * each into the store from its own offset (`readCardAssets`), sniffed, slugged
 * and stored by the caller (`sniffMedia`).
 */
export interface CardAsset extends Omit<CharxAssetFile, 'bytes'> {
  /**
   * Its decoded size, where the file says it before a byte of it is read — a PNG
   * card's chunk, a `.risum` block. A ZIP's own figure is the archive builder's
   * claim and is not used: what an entry inflates to is counted as it is read.
   */
  size?: number;
  /** Its bytes, decoded, as a stream; leaving the loop early stops the read. */
  open(): AsyncIterable<Uint8Array>;
}

/**
 * The embedded files a card declares that a read did not bring back, by why —
 * what an import tells its creator it left behind (`ParsedCard.skipped`).
 * Pictures, music, video and web fonts only become assets, so a declared model is
 * `unsupported`; one the file does not hold is `missing` (the card's own fault —
 * RisuAI refuses such a card); one past a parse cap is `overBudget`.
 */
export interface SkippedAssets {
  unsupported: number;
  missing: number;
  overBudget: number;
}

export const noSkippedAssets = (): SkippedAssets => ({ unsupported: 0, missing: 0, overBudget: 0 });

export interface CharxContents {
  /** `card.json` as it arrived — the module's scripts are not merged in. */
  raw: unknown;
  /** The scripts RisuAI's export moved out of `card.json`, when the archive has a readable module. */
  module?: RisuModuleScripts;
  iconBuffer?: Uint8Array;
  /** Embedded pictures, music, video and web fonts other than the main icon, in card order. */
  assets: CardAsset[];
  /** The declared embedded files not among `assets`, by why — as far as the archive's directory tells. */
  skipped: SkippedAssets;
}

/** ZIP entry an asset points at, or undefined when it is not embedded. */
const entryOf = (asset: CharxAsset | undefined): string | undefined =>
  asset?.uri?.startsWith(EMBEDDED_PREFIX) ? asset.uri.slice(EMBEDDED_PREFIX.length) : undefined;

const extensionOf = (entry: string): string => entry.slice(entry.lastIndexOf('.') + 1).toLowerCase();

const fileNameOf = (entry: string): string =>
  entry.slice(entry.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');

/**
 * Whether an extension names a picture, music, a video or a web font — what is
 * worth inflating. A hint only: the bytes are sniffed by the caller anyway.
 */
export const isMediaExtension = (ext: string): boolean =>
  IMAGE_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || FONT_EXTENSIONS.has(ext);
/**
 * Whether an entry is worth inflating: media by its declared extension or its
 * uri's. Both are consulted — cards in the wild carry `ext: 'unknown'`.
 */
const looksLikeMedia = (asset: CharxAsset, entry: string): boolean =>
  isMediaExtension((asset.ext ?? '').toLowerCase()) || isMediaExtension(extensionOf(entry));

/** Where RisuAI's charx export puts the scripts it takes out of `card.json`. */
const MODULE_ENTRY = 'module.risum';

/** Errors of the store under the parse go through as they are; the rest is the file's doing. */
const rethrowSourceErrors = (error: unknown): void => {
  if (error instanceof ByteSourceError) throw error;
};

/**
 * An entry read whole, under `MAX_READ_WHOLE_BYTES`, counted on what it
 * inflates to — the sizes in the ZIP's headers are the archive builder's word.
 * Past the cap is a `CardParseError`: what is read whole is what the card is.
 */
async function readWhole(source: ByteSource, entry: ZipEntry): Promise<Uint8Array> {
  const tooLarge = (): Error =>
    new CardParseError(`charx entry exceeds the ${MAX_READ_WHOLE_BYTES / (1024 * 1024)}MB limit: ${entry.name}`);
  try {
    return await collectBytes(streamZipEntry(source, entry, { maxBytes: MAX_READ_WHOLE_BYTES }), MAX_READ_WHOLE_BYTES, tooLarge);
  } catch (error) {
    if (error instanceof FileTooLargeError) throw tooLarge();
    throw error;
  }
}

/**
 * The archive's RisuAI module: only its main block, read off the front of the
 * entry — the asset blocks after it are a module's own pictures, which a card
 * import has no use for. Nothing about the module may fail the import, so an
 * unreadable or oversized one is no module.
 */
async function readModule(source: ByteSource, entry: ZipEntry | undefined): Promise<RisuModuleScripts | undefined> {
  if (!entry) return undefined;
  try {
    const main = await readRisumMainFrom(streamZipEntry(source, entry));
    if (!main) return undefined;
    const module = main.module;
    return {
      ...(Array.isArray(module['regex']) ? { regex: module['regex'] as unknown[] } : {}),
      ...(Array.isArray(module['trigger']) ? { trigger: module['trigger'] as unknown[] } : {}),
      ...(Array.isArray(module['lorebook']) ? { lorebook: module['lorebook'] as unknown[] } : {}),
    };
  } catch (error) {
    rethrowSourceErrors(error);
    return undefined;
  }
}

/**
 * Opens a .charx archive from its central directory: `card.json`, RisuAI's
 * `module.risum`, the main icon read whole, and the embedded pictures, music,
 * video and web fonts the card declares as streams not yet read. Nothing else
 * is ever inflated. The directory's sizes are trusted for nothing but where an
 * entry's bytes lie: RisuAI's export writes data descriptors, so a local header
 * says 0. The first entry bearing a name is the one read; a repeated name
 * cannot multiply the work.
 */
export async function readCharxSource(source: ByteSource): Promise<CharxContents> {
  let entries: ZipEntry[];
  try {
    entries = await listZip(source);
  } catch (error) {
    if (error instanceof ZipError) throw new CardParseError(`Unreadable charx archive: ${error.message}`);
    throw error;
  }
  const byName = new Map<string, ZipEntry>();
  for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry);

  const cardEntry = byName.get('card.json');
  if (!cardEntry) throw new CardParseError('charx archive has no card.json');
  const raw: unknown = JSON.parse(new TextDecoder('utf-8').decode(await readWhole(source, cardEntry)));
  const module = await readModule(source, byName.get(MODULE_ENTRY));
  const declared = (raw as { data?: { assets?: CharxAsset[] } }).data?.assets ?? [];
  const iconEntry = entryOf(declared.find((asset) => asset.type === 'icon' && asset.name === 'main'));

  const assets: CardAsset[] = [];
  const skipped = noSkippedAssets();
  const seen = new Set<string>();
  for (const asset of declared) {
    const name = entryOf(asset);
    if (!name || name === iconEntry || seen.has(name)) continue;
    seen.add(name);
    if (!looksLikeMedia(asset, name)) {
      skipped.unsupported += 1;
      continue;
    }
    if (assets.length >= MAX_ASSETS) {
      skipped.overBudget += 1;
      continue;
    }
    const entry = byName.get(name);
    if (!entry) {
      skipped.missing += 1;
      continue;
    }
    assets.push({
      name: asset.name?.trim() || fileNameOf(name),
      open: () => streamZipEntry(source, entry),
      ...(asset.type === 'emotion' ? { emotion: true as const } : {}),
      ...(asset.type === 'x-risu-asset' ? { additional: true as const } : {}),
    });
  }

  const icon = iconEntry ? byName.get(iconEntry) : undefined;
  const iconBuffer = icon ? await readWhole(source, icon) : undefined;
  return { raw, ...(module ? { module } : {}), ...(iconBuffer ? { iconBuffer } : {}), assets, skipped };
}

/** The asset that took the read past a cap: it and every asset after it are counted, never read. */
class AssetOverBudget extends Error {}

/**
 * Reads the assets in order under the parse caps, handing each to `visit` as a
 * stream: an asset's own (`MAX_ENTRY_BYTES`) and the budget they share with
 * what was read before them (`MAX_TOTAL_BYTES`, `spent` — a charx's icon). The
 * caps count what the bytes decode to, and the first asset past one ends the
 * pass: `visit`'s read of it throws, and it and every asset after it come back
 * as `overBudget` rather than failing the import. `visit` answers false to stop
 * (the plot is full), and may leave a stream unread (bytes that are none of the
 * kinds it keeps).
 */
export async function readCardAssets(
  assets: readonly CardAsset[],
  visit: (asset: CardAsset, body: AsyncIterable<Uint8Array>, index: number) => Promise<boolean>,
  { spent = 0 }: { spent?: number } = {},
): Promise<{ overBudget: number }> {
  let total = spent;
  for (const [index, asset] of assets.entries()) {
    if (asset.size !== undefined && (asset.size > MAX_ENTRY_BYTES || total + asset.size > MAX_TOTAL_BYTES)) {
      return { overBudget: assets.length - index };
    }
    async function* counted(): AsyncGenerator<Uint8Array> {
      let entry = 0;
      for await (const chunk of asset.open()) {
        entry += chunk.length;
        total += chunk.length;
        if (entry > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new AssetOverBudget(asset.name);
        yield chunk;
      }
    }
    try {
      if (!(await visit(asset, counted(), index))) break;
    } catch (error) {
      if (isOverBudget(error)) return { overBudget: assets.length - index };
      throw error;
    }
  }
  return { overBudget: 0 };
}

/** Whether a failure is the read past a cap, however the writer it went through wrapped it. */
function isOverBudget(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at && depth < 5; depth += 1) {
    if (at instanceof AssetOverBudget) return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/** The assets read whole, as a parse in memory hands them back (`readCard`, the tests). */
export async function collectAssets(
  assets: readonly CardAsset[],
  options: { spent?: number } = {},
): Promise<{ assets: CharxAssetFile[]; overBudget: number }> {
  const files: CharxAssetFile[] = [];
  const { overBudget } = await readCardAssets(
    assets,
    async (asset, body) => {
      const { open: _open, size: _size, ...rest } = asset;
      files.push({ ...rest, bytes: await collectBytes(body, Number.POSITIVE_INFINITY, () => new Error()) });
      return true;
    },
    options,
  );
  return { assets: files, overBudget };
}
