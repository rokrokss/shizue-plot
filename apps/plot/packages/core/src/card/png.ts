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
