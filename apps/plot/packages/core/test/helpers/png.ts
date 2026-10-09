const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Builds a PNG carrying the given tEXt chunks (IHDR + tEXt* + IEND). */
export function buildPngWithTextChunks(chunks: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from(PNG_SIGNATURE)];
  parts.push(makeChunk('IHDR', Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])));
  for (const [keyword, text] of Object.entries(chunks)) {
    const kw = new TextEncoder().encode(keyword);
    const body = new TextEncoder().encode(text);
    const data = new Uint8Array(kw.length + 1 + body.length);
    data.set(kw, 0);
    data[kw.length] = 0;
    data.set(body, kw.length + 1);
    parts.push(makeChunk('tEXt', data));
  }
  parts.push(makeChunk('IEND', new Uint8Array(0)));

  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

let crcTable: Uint32Array | undefined;

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
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
