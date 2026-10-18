/**
 * The tar format, as much of it as a backup needs (`backup.ts`): POSIX ustar
 * headers, with a pax header (`x`) in front of an entry whose path does not fit
 * the header's 100 bytes or whose size does not fit its 11 octal digits. Written
 * as a stream and read as one — a backup is the whole app folder, gigabytes
 * where a reader has many pictures, and neither side holds more than a chunk of
 * it. Only regular files and directories: a backup holds nothing else, and the
 * reader refuses anything else as not one.
 */

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A file the reader found to be no tar, or a tar cut short. */
export class TarError extends Error {}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function writeField(header: Uint8Array, offset: number, length: number, text: string): void {
  const bytes = encoder.encode(text);
  header.set(bytes.subarray(0, length), offset);
}

function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let at = 0; at < BLOCK; at += 1) sum += at >= 148 && at < 156 ? 0x20 : header[at]!;
  return sum;
}

function ustarHeader(name: string, size: number, type: '0' | '5' | 'x', mtime: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  writeField(header, 0, 100, name);
  writeField(header, 100, 8, octal(type === '5' ? 0o755 : 0o644, 8));
  writeField(header, 108, 8, octal(0, 8));
  writeField(header, 116, 8, octal(0, 8));
  writeField(header, 124, 12, octal(size, 12));
  writeField(header, 136, 12, octal(Math.floor(mtime / 1000), 12));
  writeField(header, 156, 1, type);
  writeField(header, 257, 6, 'ustar\0');
  writeField(header, 263, 2, '00');
  writeField(header, 148, 8, `${checksum(header).toString(8).padStart(6, '0')}\0 `);
  return header;
}

/** A pax record, `<length> <key>=<value>\n`, whose length counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).length;
  let digits = 1;
  while (String(bodyLength + digits).length !== digits) digits += 1;
  return `${bodyLength + digits}${body}`;
}

/** The largest size the ustar header holds: 11 octal digits. */
const MAX_USTAR_SIZE = 0o77777777777;

/** The header blocks for one entry: a pax header first where the path or the size needs one. */
export function entryHeader(path: string, size: number, type: 'file' | 'dir' = 'file', mtime = Date.now()): Uint8Array {
  const name = type === 'dir' && !path.endsWith('/') ? `${path}/` : path;
  const long = encoder.encode(name).length > 100;
  const big = size > MAX_USTAR_SIZE;
  const flag = type === 'dir' ? '5' : '0';
  if (!long && !big) return ustarHeader(name, size, flag, mtime);
  const records = encoder.encode((long ? paxRecord('path', name) : '') + (big ? paxRecord('size', String(size)) : ''));
  const shortName = long ? name.slice(0, 90).replace(/[^\x20-\x7e]/g, '_') : name;
  return concat([
    ustarHeader('PaxHeader', records.length, 'x', mtime),
    records,
    padding(records.length),
    ustarHeader(shortName, big ? 0 : size, flag, mtime),
  ]);
}

/** The zeros after an entry's data, up to the next block. */
export const padding = (size: number): Uint8Array => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** The two zero blocks a tar ends with. */
export const END_OF_ARCHIVE = new Uint8Array(BLOCK * 2);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An entry as the reader hands it on: its body must be read through (or skipped by the next) before the next. */
export interface TarEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
  body: AsyncGenerator<Uint8Array>;
}

/** Pulls exact spans off a byte stream. */
class Bytes {
  private buffer: Uint8Array = new Uint8Array(0);
  private done = false;
  constructor(private readonly source: AsyncIterator<Uint8Array>) {}

  private async fill(length: number): Promise<boolean> {
    while (this.buffer.length < length && !this.done) {
      const next = await this.source.next();
      if (next.done) this.done = true;
      else this.buffer = this.buffer.length === 0 ? next.value : concat([this.buffer, next.value]);
    }
    return this.buffer.length >= length;
  }

  /** Exactly `length` bytes, or null at a clean end of the stream. Cut short mid-span is an error. */
  async take(length: number): Promise<Uint8Array | null> {
    if (!(await this.fill(length))) {
      if (this.buffer.length === 0) return null;
      throw new TarError('The archive ends in the middle of an entry');
    }
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }

  /** `length` bytes as they arrive, in chunks. */
  async *stream(length: number): AsyncGenerator<Uint8Array> {
    let left = length;
    while (left > 0) {
      if (this.buffer.length === 0 && !(await this.fill(1))) throw new TarError('The archive ends in the middle of an entry');
      const take = Math.min(left, this.buffer.length);
      const out = this.buffer.subarray(0, take);
      this.buffer = this.buffer.subarray(take);
      left -= take;
      yield out;
    }
  }
}

function text(header: Uint8Array, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  try {
    return decoder.decode(end === -1 ? field : field.subarray(0, end));
  } catch {
    throw new TarError('A header name is not UTF-8');
  }
}

function number(header: Uint8Array, offset: number, length: number): number {
  const raw = text(header, offset, length).trim();
  if (!/^[0-7]*$/.test(raw)) throw new TarError('A header number is not octal');
  return raw === '' ? 0 : parseInt(raw, 8);
}

function readPax(records: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let rest: string;
  try {
    rest = decoder.decode(records);
  } catch {
    throw new TarError('A pax header is not UTF-8');
  }
  while (rest.length > 0) {
    const match = /^(\d+) ([^=]+)=/.exec(rest);
    if (!match) throw new TarError('A pax header is malformed');
    const length = Number(match[1]);
    const record = encoder.encode(rest).subarray(0, length);
    const line = decoder.decode(record);
    if (!line.endsWith('\n')) throw new TarError('A pax header is malformed');
    out.set(match[2]!, line.slice(match[0].length, -1));
    rest = rest.slice(line.length);
  }
  return out;
}

/** The longest pax header the reader takes; a backup writes a path and a size. */
const MAX_PAX_BYTES = 64 * 1024;

/**
 * The entries of a tar stream, in order. Each header's checksum is checked;
 * a pax header (`x`) gives the next entry its path and size, a global one (`g`)
 * is passed over, and any other kind — a link, a device — is refused, as is a
 * stream that ends without its closing zero blocks or mid-entry. An entry's body
 * must be read to its end, or left: the next entry skips what is left of it.
 */
export async function* readTar(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarEntry> {
  const bytes = new Bytes(source[Symbol.asyncIterator]());
  let pax = new Map<string, string>();
  for (;;) {
    const header = await bytes.take(BLOCK);
    if (!header) throw new TarError('The archive ends without its end blocks');
    if (header.every((byte) => byte === 0)) return;
    if (number(header, 148, 8) !== checksum(header)) throw new TarError('A header checksum does not match');
    const flag = String.fromCharCode(header[156]!);
    let size = number(header, 124, 12);
    if (flag === 'x' || flag === 'g') {
      if (size > MAX_PAX_BYTES) throw new TarError('A pax header is too long');
      const records = await bytes.take(size + padding(size).length);
      if (!records) throw new TarError('The archive ends in the middle of an entry');
      if (flag === 'x') pax = readPax(records.subarray(0, size));
      continue;
    }
    if (flag !== '0' && flag !== '\0' && flag !== '5') throw new TarError('The archive holds something other than files and folders');
    const prefix = text(header, 345, 155);
    const name = pax.get('path') ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    if (pax.has('size')) {
      size = Number(pax.get('size'));
      if (!Number.isSafeInteger(size) || size < 0) throw new TarError('A pax size is not a size');
    }
    pax = new Map();
    const type = flag === '5' ? 'dir' : 'file';
    if (type === 'dir') size = 0;
    const body = bytes.stream(size);
    yield { path: type === 'dir' ? name.replace(/\/+$/, '') : name, type, size, body };
    // Whatever the reader left of the body, and the padding after it.
    for await (const _ of body) void _;
    if (size % BLOCK !== 0 && !(await bytes.take(padding(size).length))) {
      throw new TarError('The archive ends in the middle of an entry');
    }
  }
}
