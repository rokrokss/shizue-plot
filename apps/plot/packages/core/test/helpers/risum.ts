import { rpackDecode } from '../../src/card/risum.js';

let encodeTable: Uint8Array | undefined;

/** RPack's encode direction: the inverse of the decoder's table. */
function rpackEncode(bytes: Uint8Array): Uint8Array {
  if (!encodeTable) {
    const decoded = rpackDecode(Uint8Array.from({ length: 256 }, (_, i) => i));
    encodeTable = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) encodeTable[decoded[i]!] = i;
  }
  return bytes.map((byte) => encodeTable![byte]!);
}

/**
 * Builds a `.risum` file laid out as RisuAI's charx export writes `module.risum`:
 * magic 111, version 0, u32le length, the RPack'd main block (normally
 * `{ module, type: 'risuModule' }`), then asset blocks (`0x01`, u32le length,
 * RPack bytes) and a closing `0x00`.
 */
export function buildRisum(main: unknown, assets: Uint8Array[] = []): Uint8Array {
  const blocks = [rpackEncode(new TextEncoder().encode(JSON.stringify(main, null, 2)))];
  const parts: Uint8Array[] = [Uint8Array.from([111, 0]), u32le(blocks[0]!.length), blocks[0]!];
  for (const asset of assets) parts.push(Uint8Array.from([1]), u32le(asset.length), rpackEncode(asset));
  parts.push(Uint8Array.from([0]));

  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}
