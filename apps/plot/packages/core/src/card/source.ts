/**
 * Bytes read by offset — a card or module file wherever it lies: an object in
 * storage the import job reads by ranges (apps/api `fileImports.ts`), or bytes
 * already in memory (`bytesSource`). The parsers read through this so a large
 * file is never held whole: only what is parsed whole (`MAX_READ_WHOLE_BYTES`)
 * is, and every asset is a stream from its own offset (`CardAsset.open`).
 */

/**
 * What is read whole, to be parsed or kept: `card.json`, the main block of
 * `module.risum`, the icon, a PNG card's card chunk, a JSON card or module, a
 * World Info file. Everything else a card carries is streamed from its offset
 * and never held (`CardAsset.open`), so this is the one cap an import's memory
 * follows; the owner set it on 2026-10-17, where `card.json` already stood.
 */
export const MAX_READ_WHOLE_BYTES = 100 * 1024 * 1024;

export interface ByteSource {
  readonly size: number;
  /** `length` bytes from `offset`, at once — for the small reads: headers, a directory, a card's JSON. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** The same span as a stream of chunks, for what may be large. Leaving the loop early ends the read. */
  stream(offset: number, length: number): AsyncIterable<Uint8Array>;
}

/**
 * What a source throws when its bytes cannot be read at all — the store is
 * unreachable — as against bytes that are not a card. The parsers never take it
 * for an unreadable file: the places that swallow a part's failure (a charx's
 * module) let it through, and the import job tells it from `CardParseError`.
 */
export class ByteSourceError extends Error {}

/** A source over bytes in memory. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  const span = (offset: number, length: number): Uint8Array =>
    bytes.subarray(Math.max(0, offset), Math.min(bytes.length, offset + length));
  return {
    size: bytes.length,
    read: async (offset, length) => span(offset, length),
    async *stream(offset, length) {
      const part = span(offset, length);
      for (let at = 0; at < part.length; at += STREAM_CHUNK_BYTES) yield part.subarray(at, at + STREAM_CHUNK_BYTES);
    },
  };
}

/** What `bytesSource` hands out per chunk, about what a store's stream does. */
const STREAM_CHUNK_BYTES = 64 * 1024;

/** A span of a source as a source of its own, its offsets counted from `start` — an archive behind a picture. */
export function sliceSource(source: ByteSource, start: number): ByteSource {
  return {
    size: source.size - start,
    read: (offset, length) => source.read(start + offset, length),
    stream: (offset, length) => source.stream(start + offset, length),
  };
}

/**
 * Collects a stream into one array, refusing past `max` bytes: `onOver` makes
 * the error, thrown as soon as the count passes — the rest is never read.
 */
export async function collectBytes(
  chunks: AsyncIterable<Uint8Array>,
  max: number,
  onOver: () => Error,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.length;
    if (total > max) throw onOver();
    parts.push(chunk);
  }
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Reads a stream by counts — a header, then a length it names, then a skip —
 * holding only what is asked for. `offset` is how many bytes have been taken or
 * skipped so far.
 */
export class ChunkReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private pending: Uint8Array[] = [];
  private pendingLength = 0;
  private ended = false;
  offset = 0;

  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.iterator = chunks[Symbol.asyncIterator]();
  }

  /** Pulls until `n` bytes are pending or the stream ends. */
  private async fill(n: number): Promise<void> {
    while (this.pendingLength < n && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      if (next.value.length === 0) continue;
      this.pending.push(next.value);
      this.pendingLength += next.value.length;
    }
  }

  /** The next `n` bytes, or fewer only where the stream ends. */
  async take(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const count = Math.min(n, this.pendingLength);
    const out = this.pending.length === 1 || count === 0 ? undefined : new Uint8Array(count);
    let taken = 0;
    let single: Uint8Array | undefined;
    while (taken < count) {
      const head = this.pending[0]!;
      const part = head.subarray(0, count - taken);
      if (out) out.set(part, taken);
      else single = part;
      taken += part.length;
      if (part.length === head.length) this.pending.shift();
      else this.pending[0] = head.subarray(part.length);
    }
    this.pendingLength -= count;
    this.offset += count;
    return out ?? single ?? new Uint8Array(0);
  }

  /** Passes the next `n` bytes to `each` as they come, holding none of them; answers how many there were. */
  async pass(n: number, each: (chunk: Uint8Array) => void): Promise<number> {
    let left = n;
    while (left > 0) {
      if (this.pendingLength === 0) await this.fill(1);
      if (this.pendingLength === 0) break;
      const head = this.pending[0]!;
      const part = head.subarray(0, left);
      each(part);
      if (part.length === head.length) this.pending.shift();
      else this.pending[0] = head.subarray(part.length);
      this.pendingLength -= part.length;
      this.offset += part.length;
      left -= part.length;
    }
    return n - left;
  }

  /** Skips the next `n` bytes; answers how many there were. */
  skip(n: number): Promise<number> {
    return this.pass(n, () => undefined);
  }

  /** Ends the read: what the stream had not yet sent is never asked for. */
  async close(): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      await this.iterator.return?.();
    }
  }
}
