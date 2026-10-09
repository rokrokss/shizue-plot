import { Unzip, UnzipInflate, type UnzipFile } from 'fflate';
import { CardParseError } from './normalize.js';

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const EMBEDDED_PREFIX = 'embeded://'; // sic — the CCv3 spec spells it this way.
/** Decompressed-size cap per entry, so a hostile archive cannot exhaust memory. */
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
/**
 * Budget for the pass that reads the icon and the assets. The per-entry cap bounds
 * memory but not work: an archive can name dozens of entries that each stop just
 * under it. `card.json` is read by its own earlier pass — its name is not known
 * from the card, it *is* the card — so the worst case for one archive is this
 * budget plus one entry.
 */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/**
 * The archive is fed in small slices rather than one push: the inflater emits
 * output per slice, so an oversized entry trips the cap after a few MB instead
 * of being fully materialized first.
 */
const PUSH_CHUNK_BYTES = 16 * 1024;
/**
 * Embedded assets kept per archive — a parse budget, deliberately below the
 * plot's 100-asset cap (uploads can reach the rest).
 */
const MAX_ASSETS = 50;
/** Only images become character assets; the declared type is not restricted. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export function isZip(bytes: Uint8Array): boolean {
  return ZIP_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

interface CharxAsset {
  type?: string;
  name?: string;
  uri?: string;
  ext?: string;
}

/** An embedded image asset, ready to be slugged and stored by the caller. */
export interface CharxAssetFile {
  /** Asset name as the card declares it; falls back to the entry file name. */
  name: string;
  bytes: Uint8Array;
}

export interface CharxContents {
  raw: unknown;
  iconBuffer?: Uint8Array;
  /** Embedded image assets other than the main icon, in card order. */
  assets: CharxAssetFile[];
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

interface WantedEntry {
  name: string;
  /** Blowing the per-entry cap fails the parse instead of dropping the entry. */
  required: boolean;
}

/**
 * Inflates the named entries and nothing else, in one pass over the archive with
 * one shared byte budget. The caps count bytes the inflater actually emits — the
 * sizes declared in the ZIP headers are supplied by whoever built the archive and
 * can understate the real payload.
 *
 * A `required` entry over the per-entry cap fails the parse. Any other overrun —
 * an optional entry over the per-entry cap, or the archive budget running out —
 * **ends the pass** and returns whatever completed before it. Stopping is the only
 * way to stop paying: `file.terminate()` is a no-op for fflate's synchronous
 * inflater (it forwards to a decoder that has no terminate), so an archive whose
 * next entry inflates to gigabytes would keep burning CPU if the pass continued.
 * It is called anyway — the interface documents it as ending the stream, and an
 * async decoder would honour it — but the loop break is what bounds the work.
 */
function extractEntries(bytes: Uint8Array, wanted: WantedEntry[]): Map<string, Uint8Array> {
  const names = new Set(wanted.map((entry) => entry.name));
  const required = new Set(wanted.filter((entry) => entry.required).map((entry) => entry.name));
  const entries = new Map<string, Uint8Array>();
  const started = new Set<string>();
  let pending = names.size;
  let emitted = 0;
  let oversized: string | undefined;
  let failure: Error | undefined;
  let stopped = false;

  const stop = (file: UnzipFile): void => {
    stopped = true;
    file.terminate();
  };

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    // Only the first entry bearing a wanted name is read; later duplicates are
    // skipped so a repeated name cannot multiply the decompression work.
    const name = file.name;
    if (stopped || !names.has(name) || started.has(name)) return;
    started.add(name);

    const chunks: Uint8Array[] = [];
    let total = 0;
    file.ondata = (err, data, final) => {
      if (oversized || failure || stopped) return;
      if (err) {
        failure = err;
        return;
      }
      // Counted before anything may decide to drop: emitted bytes are work
      // already done, kept or not, and the budget exists to bound that work.
      total += data.length;
      emitted += data.length;
      if (total > MAX_ENTRY_BYTES) {
        if (required.has(name)) oversized = name;
        else stop(file);
        return;
      }
      if (emitted > MAX_TOTAL_BYTES) {
        stop(file);
        return;
      }
      chunks.push(data);
      if (final) {
        entries.set(name, concat(chunks, total));
        pending -= 1;
      }
    };
    file.start();
  };

  for (
    let at = 0;
    at < bytes.length && pending > 0 && !stopped && !oversized && !failure;
    at += PUSH_CHUNK_BYTES
  ) {
    const end = Math.min(at + PUSH_CHUNK_BYTES, bytes.length);
    unzip.push(bytes.subarray(at, end), end === bytes.length);
  }

  if (oversized) {
    throw new CardParseError(
      `charx entry exceeds the ${MAX_ENTRY_BYTES / (1024 * 1024)}MB limit: ${oversized}`,
    );
  }
  if (failure) throw failure;
  return entries;
}

/** ZIP entry an asset points at, or undefined when it is not embedded. */
const entryOf = (asset: CharxAsset | undefined): string | undefined =>
  asset?.uri?.startsWith(EMBEDDED_PREFIX) ? asset.uri.slice(EMBEDDED_PREFIX.length) : undefined;

const extensionOf = (entry: string): string => entry.slice(entry.lastIndexOf('.') + 1).toLowerCase();

const fileNameOf = (entry: string): string =>
  entry.slice(entry.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');

/**
 * Whether an entry is worth inflating. Both the declared extension and the uri
 * are consulted — cards in the wild carry `ext: 'unknown'` — and the bytes are
 * sniffed by the caller anyway.
 */
const looksLikeImage = (asset: CharxAsset, entry: string): boolean =>
  IMAGE_EXTENSIONS.has((asset.ext ?? '').toLowerCase()) || IMAGE_EXTENSIONS.has(extensionOf(entry));

/**
 * Unpacks a .charx archive: `card.json`, the main icon, and the embedded images
 * the card declares. Nothing else is ever inflated.
 *
 * Two passes, and only two: the card has to be read before the other names are
 * known, and everything it names is then read together so icon and assets share
 * one budget. An archive that exhausts it keeps whatever completed first — the
 * icon is best-effort there, like any other entry, since `required` governs the
 * per-entry cap and nothing else.
 */
export function readCharx(bytes: Uint8Array): CharxContents {
  const cardJson = extractEntries(bytes, [{ name: 'card.json', required: true }]).get('card.json');
  if (!cardJson) {
    throw new CardParseError('charx archive has no card.json');
  }

  const raw: unknown = JSON.parse(new TextDecoder('utf-8').decode(cardJson));
  const declared = (raw as { data?: { assets?: CharxAsset[] } }).data?.assets ?? [];
  const iconEntry = entryOf(declared.find((asset) => asset.type === 'icon' && asset.name === 'main'));

  // The names to inflate are picked before anything is read, so the cap bounds
  // the work rather than the result.
  const wanted: WantedEntry[] = iconEntry ? [{ name: iconEntry, required: true }] : [];
  const declaredAssets: { name: string; entry: string }[] = [];
  for (const asset of declared) {
    const entry = entryOf(asset);
    if (!entry || entry === iconEntry || !looksLikeImage(asset, entry)) continue;
    if (declaredAssets.some((item) => item.entry === entry)) continue;
    declaredAssets.push({ name: asset.name?.trim() || fileNameOf(entry), entry });
    wanted.push({ name: entry, required: false });
    if (declaredAssets.length >= MAX_ASSETS) break;
  }

  const inflated =
    wanted.length > 0 ? extractEntries(bytes, wanted) : new Map<string, Uint8Array>();
  const assets: CharxAssetFile[] = [];
  for (const item of declaredAssets) {
    const entry = inflated.get(item.entry);
    if (entry) assets.push({ name: item.name, bytes: entry });
  }

  const iconBuffer = iconEntry ? inflated.get(iconEntry) : undefined;
  return iconBuffer ? { raw, iconBuffer, assets } : { raw, assets };
}
