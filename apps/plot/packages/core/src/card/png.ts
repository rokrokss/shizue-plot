import { zlibSync } from 'fflate';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

/** Chunk types that can carry a card payload — everything textual. */
const TEXT_CHUNK_TYPES = new Set(['tEXt', 'zTXt', 'iTXt']);

/**
 * Returns the PNG without its textual chunks (tEXt/zTXt/iTXt). Every other chunk
 * is copied byte for byte, so the CRCs stay valid and the image is untouched.
 *
 * Returns null when the chunk stream cannot be walked to IEND: bytes we cannot
 * take apart cannot be shown to be free of an embedded card either, and a card
 * PNG doubles as its own avatar.
 */
export function stripPngTextChunks(bytes: Uint8Array): Uint8Array | null {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');
  const kept: Array<[number, number]> = [[0, PNG_SIGNATURE.length]];

  let offset = PNG_SIGNATURE.length;
  let sawEnd = false;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length; // length + type + data + CRC
    if (end > bytes.length) return null;

    if (!TEXT_CHUNK_TYPES.has(type)) kept.push([offset, end]);
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) return null;

  const size = kept.reduce((sum, [start, end]) => sum + (end - start), 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const [start, end] of kept) {
    out.set(bytes.subarray(start, end), at);
    at += end - start;
  }
  return out;
}

/**
 * Reads tEXt chunks as keyword -> text. Length-driven traversal; the signature
 * and chunk CRCs are not verified.
 */
export function readPngTextChunks(bytes: Uint8Array): Map<string, string> {
  const chunks = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');

  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) break;

    if (type === 'tEXt') {
      const data = bytes.subarray(dataStart, dataEnd);
      const separator = data.indexOf(0);
      if (separator > 0) {
        const keyword = decoder.decode(data.subarray(0, separator));
        if (!chunks.has(keyword)) {
          chunks.set(keyword, decoder.decode(data.subarray(separator + 1)));
        }
      }
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4; // skip CRC
  }

  return chunks;
}

let crcTable: Uint32Array | undefined;

/** CRC-32 as PNG uses it (ISO 3309), over a chunk's type and data. */
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** Byte offset of the IEND chunk, or null when the chunk stream cannot be walked to it. */
function iendOffset(bytes: Uint8Array): number | null {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    if (decoder.decode(bytes.subarray(offset + 4, offset + 8)) === 'IEND') return offset;
    offset += 12 + view.getUint32(offset);
  }
  return null;
}

/**
 * Returns the PNG with `tEXt` chunks for the given keyword/text pairs inserted
 * right before IEND, where readers look for a card. The text goes in as its
 * UTF-8 bytes; a card payload is base64, so it is plain ASCII either way.
 * Existing chunks are kept: strip first to replace a card.
 *
 * Throws when the bytes are not a PNG whose chunks can be walked to IEND.
 */
export function insertPngTextChunks(
  bytes: Uint8Array,
  chunks: ReadonlyArray<readonly [keyword: string, text: string]>,
): Uint8Array {
  const at = iendOffset(bytes);
  if (at === null) throw new Error('Not a PNG that can be written to');
  const encoder = new TextEncoder();
  const inserted = chunks.map(([keyword, text]) => {
    const name = encoder.encode(keyword);
    const body = encoder.encode(text);
    const data = new Uint8Array(name.length + 1 + body.length);
    data.set(name, 0);
    data.set(body, name.length + 1);
    return pngChunk('tEXt', data);
  });

  const out = new Uint8Array(bytes.length + inserted.reduce((sum, chunk) => sum + chunk.length, 0));
  out.set(bytes.subarray(0, at), 0);
  let cursor = at;
  for (const chunk of inserted) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  out.set(bytes.subarray(at), cursor);
  return out;
}

/**
 * A plain cream square (the app canvas, #F6F3DC) for a card exported without a
 * picture of its own. Built rather than embedded: an image a browser will draw
 * needs a real IDAT, and fflate is already here for charx.
 */
export function placeholderPng(): Uint8Array {
  const size = 64;
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, size);
  new DataView(header.buffer).setUint32(4, size);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit truecolor, no interlace

  const row = 1 + size * 3; // a filter byte, then RGB
  const pixels = new Uint8Array(row * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) pixels.set([0xf6, 0xf3, 0xdc], y * row + 1 + x * 3);
  }

  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlibSync(pixels)),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
