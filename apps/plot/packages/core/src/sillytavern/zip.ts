/**
 * A ZIP reader over ranged reads. SillyTavern's "Download Backup" is the user's
 * whole data directory — thumbnails, vectors, chat backups — and can run to
 * gigabytes, so nothing here holds the archive: the central directory is read
 * once, and each entry is read from its own offset when it is wanted. The web
 * wraps `File.slice().arrayBuffer()`.
 *
 * ST writes the archive with `archiver` (`src/users.js` `createBackupArchive`),
 * whose entries carry data descriptors: the local headers say 0 for the sizes and
 * the real ones follow the data. The central directory has them, so sizes always
 * come from there. Past 4 GiB it writes ZIP64 records, which are read here too.
 */

import { Inflate } from 'fflate';

export interface ZipSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ZipEntry {
  /** As stored: '/'-separated, UTF-8. */
  name: string;
  /** Declared uncompressed size — a claim; `readZipEntry` counts what it inflates. */
  size: number;
  compressedSize: number;
  method: number;
  localHeaderOffset: number;
}

/** An archive this reader cannot take apart, or an entry it cannot read. */
export class ZipError extends Error {}

/** A file that turned out bigger than the caller allows. */
export class FileTooLargeError extends Error {
  constructor(
    readonly fileName: string,
    readonly maxBytes: number,
  ) {
    super(`${fileName} is over ${maxBytes} bytes`);
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_EOCD_BYTES = 56;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_EXTRA_ID = 0x0001;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/**
 * The central directory is read in one piece, so it is capped. ~100 bytes an
 * entry puts a backup with hundreds of thousands of files (thumbnails and chat
 * backups pile up) well under it.
 */
export const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 500_000;
/** Compressed bytes per ranged read. */
const READ_CHUNK_BYTES = 1024 * 1024;
/**
 * …and per push into the inflater, which emits output per push: one push can
 * inflate to ~1000× its size, so this bounds how far past the cap a read gets
 * before it stops (the same slicing `card/charx.ts` uses).
 */
const PUSH_CHUNK_BYTES = 16 * 1024;

async function readExact(source: ZipSource, offset: number, length: number): Promise<Uint8Array> {
  if (offset < 0 || length < 0 || offset + length > source.size) {
    throw new ZipError('ZIP record points outside the archive');
  }
  const bytes = await source.read(offset, length);
  if (bytes.length < length) throw new ZipError('ZIP archive ended early');
  return bytes.length === length ? bytes : bytes.subarray(0, length);
}

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** A ZIP64 field; exact while it stays under 2^53, which any real file does. */
const u64 = (view: DataView, at: number): number =>
  view.getUint32(at + 4, true) * 0x1_0000_0000 + view.getUint32(at, true);

interface Directory {
  offset: number;
  size: number;
  count: number;
}

/**
 * Finds the end-of-central-directory record by scanning back from the end: it is
 * the last thing in the file, after a comment of up to 64 KiB. A real record's
 * comment runs exactly to the end, which tells it from the signature turning up
 * by chance inside that comment.
 */
async function findDirectory(source: ZipSource): Promise<Directory> {
  const tailLength = Math.min(source.size, EOCD_BYTES + MAX_COMMENT_BYTES + ZIP64_LOCATOR_BYTES);
  const tailStart = source.size - tailLength;
  const tail = await readExact(source, tailStart, tailLength);
  const view = viewOf(tail);

  for (let at = tail.length - EOCD_BYTES; at >= 0; at -= 1) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    if (at + EOCD_BYTES + view.getUint16(at + 20, true) !== tail.length) continue;

    if (view.getUint16(at + 4, true) !== 0 || view.getUint16(at + 6, true) !== 0) {
      throw new ZipError('Multi-part ZIP archives are not supported');
    }
    const directory: Directory = {
      count: view.getUint16(at + 10, true),
      size: view.getUint32(at + 12, true),
      offset: view.getUint32(at + 16, true),
    };

    // A ZIP64 archive keeps the real values in its own record, which a locator
    // just before this one points at.
    const locator = at - ZIP64_LOCATOR_BYTES;
    if (locator >= 0 && view.getUint32(locator, true) === ZIP64_LOCATOR_SIGNATURE) {
      const record = await readExact(source, u64(view, locator + 8), ZIP64_EOCD_BYTES);
      const zip64 = viewOf(record);
      if (zip64.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
        throw new ZipError('ZIP64 end of central directory not found');
      }
      return { count: u64(zip64, 32), size: u64(zip64, 40), offset: u64(zip64, 48) };
    }
    if (directory.count === U16_MAX || directory.size === U32_MAX || directory.offset === U32_MAX) {
      throw new ZipError('ZIP64 end of central directory not found');
    }
    return directory;
  }
  throw new ZipError('Not a ZIP archive');
}

/** The ZIP64 extra field holds, in order, only the values the header maxed out. */
function applyZip64Extra(entry: ZipEntry, extra: DataView): void {
  for (let at = 0; at + 4 <= extra.byteLength; ) {
    const id = extra.getUint16(at, true);
    const length = extra.getUint16(at + 2, true);
    if (id === ZIP64_EXTRA_ID) {
      let field = at + 4;
      const end = field + length;
      const take = (): number => {
        if (field + 8 > end || end > extra.byteLength) throw new ZipError('Truncated ZIP64 field');
        const value = u64(extra, field);
        field += 8;
        return value;
      };
      if (entry.size === U32_MAX) entry.size = take();
      if (entry.compressedSize === U32_MAX) entry.compressedSize = take();
      if (entry.localHeaderOffset === U32_MAX) entry.localHeaderOffset = take();
      return;
    }
    at += 4 + length;
  }
}

/**
 * The archive's entries, from its central directory, in stored order (folders
 * included — they end in '/'). Names are decoded as UTF-8 whatever the header's
 * language flag says: archiver sets it, and the tools that do not mostly write
 * UTF-8 anyway, which Korean and Japanese names need.
 */
export async function listZip(source: ZipSource): Promise<ZipEntry[]> {
  const directory = await findDirectory(source);
  if (directory.size > MAX_CENTRAL_DIRECTORY_BYTES || directory.count > MAX_ZIP_ENTRIES) {
    throw new ZipError('ZIP archive has too many entries');
  }
  const bytes = await readExact(source, directory.offset, directory.size);
  const view = viewOf(bytes);
  const decoder = new TextDecoder('utf-8');

  const entries: ZipEntry[] = [];
  let at = 0;
  while (at + CENTRAL_BYTES <= bytes.length && entries.length < directory.count) {
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw new ZipError('Corrupt central directory');
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const nameStart = at + CENTRAL_BYTES;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > bytes.length) throw new ZipError('Corrupt central directory');

    const entry: ZipEntry = {
      name: decoder.decode(bytes.subarray(nameStart, extraStart)),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localHeaderOffset: view.getUint32(at + 42, true),
    };
    applyZip64Extra(entry, new DataView(bytes.buffer, bytes.byteOffset + extraStart, extraLength));
    entries.push(entry);
    at = next;
  }
  return entries;
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

/**
 * One entry's bytes, stored (0) or deflated (8). `maxBytes` caps what the
 * inflater actually emits, not what the headers declare — whoever built the
 * archive wrote those — and going over throws `FileTooLargeError` as soon as it
 * happens. Encrypted entries and other methods throw `ZipError`.
 *
 * The data starts after the *local* header's name and extra field, whose lengths
 * need not match the central directory's, so the local header is read first.
 */
export async function readZipEntry(
  source: ZipSource,
  entry: ZipEntry,
  opts: { maxBytes: number },
): Promise<Uint8Array> {
  const header = viewOf(await readExact(source, entry.localHeaderOffset, LOCAL_BYTES));
  if (header.getUint32(0, true) !== LOCAL_SIGNATURE) throw new ZipError(`Corrupt entry ${entry.name}`);
  if (header.getUint16(6, true) & 1) throw new ZipError(`${entry.name} is encrypted`);
  const dataStart =
    entry.localHeaderOffset + LOCAL_BYTES + header.getUint16(26, true) + header.getUint16(28, true);

  if (entry.method === 0) {
    if (entry.compressedSize > opts.maxBytes) throw new FileTooLargeError(entry.name, opts.maxBytes);
    return readExact(source, dataStart, entry.compressedSize);
  }
  if (entry.method !== 8) throw new ZipError(`${entry.name} uses an unsupported compression method`);
  if (entry.compressedSize === 0) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  const inflate = new Inflate((chunk) => {
    total += chunk.length;
    if (total > opts.maxBytes) overflow = true;
    else chunks.push(chunk);
  });
  const end = dataStart + entry.compressedSize;
  for (let offset = dataStart; offset < end; offset += READ_CHUNK_BYTES) {
    const range = await readExact(source, offset, Math.min(READ_CHUNK_BYTES, end - offset));
    for (let at = 0; at < range.length; at += PUSH_CHUNK_BYTES) {
      const last = offset + at + PUSH_CHUNK_BYTES >= end;
      try {
        inflate.push(range.subarray(at, at + PUSH_CHUNK_BYTES), last);
      } catch (error) {
        throw new ZipError(`${entry.name} could not be inflated: ${(error as Error).message}`);
      }
      // The synchronous inflater has no working terminate; leaving is what stops it.
      if (overflow) throw new FileTooLargeError(entry.name, opts.maxBytes);
    }
  }
  return concat(chunks, total);
}
