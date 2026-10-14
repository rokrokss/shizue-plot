/**
 * MessagePack, decoding only, as far as RisuAI's preset files need it.
 *
 * RisuAI writes `.risup`/`.risupreset` with msgpackr's default `pack`
 * (`useRecords: false`), which is plain MessagePack plus one convention of its
 * own: `undefined` as fixext 1 of type 0. Everything here is the spec's — nil,
 * booleans, integers, floats, str, bin, array, map — and the extension types
 * come back as `undefined` (a timestamp too: nothing a preset import reads is
 * one). Maps become plain objects with own properties, so a `__proto__` key in
 * a file is a key and nothing more.
 *
 * Throws `RangeError` on bytes that are not one whole MessagePack value.
 */

/** Deeper than any preset nests, shallow enough that a hostile file cannot exhaust the stack. */
const MAX_DEPTH = 64;

export function decodeMsgpack(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder('utf-8');
  let at = 0;

  const need = (count: number): number => {
    if (count < 0 || at + count > bytes.length) throw new RangeError('msgpack: truncated');
    const start = at;
    at += count;
    return start;
  };
  const u8 = (): number => bytes[need(1)]!;
  const u16 = (): number => view.getUint16(need(2));
  const u32 = (): number => view.getUint32(need(4));

  const str = (length: number): string => {
    const start = need(length);
    return text.decode(bytes.subarray(start, start + length));
  };
  const bin = (length: number): Uint8Array => {
    const start = need(length);
    return bytes.slice(start, start + length);
  };
  const ext = (length: number): undefined => {
    need(1 + length); // the type byte, then the data — neither is read
    return undefined;
  };

  const array = (length: number, depth: number): unknown[] => {
    const out: unknown[] = [];
    for (let i = 0; i < length; i += 1) out.push(value(depth + 1));
    return out;
  };
  const map = (length: number, depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < length; i += 1) {
      const key = value(depth + 1);
      Object.defineProperty(out, String(key), {
        value: value(depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };

  function value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new RangeError('msgpack: nested too deep');
    const byte = u8();
    if (byte <= 0x7f) return byte;
    if (byte <= 0x8f) return map(byte & 0x0f, depth);
    if (byte <= 0x9f) return array(byte & 0x0f, depth);
    if (byte <= 0xbf) return str(byte & 0x1f);
    if (byte >= 0xe0) return byte - 0x100;
    switch (byte) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return bin(u8());
      case 0xc5:
        return bin(u16());
      case 0xc6:
        return bin(u32());
      case 0xc7:
        return ext(u8());
      case 0xc8:
        return ext(u16());
      case 0xc9:
        return ext(u32());
      case 0xca:
        return view.getFloat32(need(4));
      case 0xcb:
        return view.getFloat64(need(8));
      case 0xcc:
        return u8();
      case 0xcd:
        return u16();
      case 0xce:
        return u32();
      case 0xcf:
        return Number(view.getBigUint64(need(8)));
      case 0xd0:
        return view.getInt8(need(1));
      case 0xd1:
        return view.getInt16(need(2));
      case 0xd2:
        return view.getInt32(need(4));
      case 0xd3:
        return Number(view.getBigInt64(need(8)));
      case 0xd4:
        return ext(1);
      case 0xd5:
        return ext(2);
      case 0xd6:
        return ext(4);
      case 0xd7:
        return ext(8);
      case 0xd8:
        return ext(16);
      case 0xd9:
        return str(u8());
      case 0xda:
        return str(u16());
      case 0xdb:
        return str(u32());
      case 0xdc:
        return array(u16(), depth);
      case 0xdd:
        return array(u32(), depth);
      case 0xde:
        return map(u16(), depth);
      case 0xdf:
        return map(u32(), depth);
      default:
        // 0xc1 is never used.
        throw new RangeError(`msgpack: unknown byte 0x${byte.toString(16)}`);
    }
  }

  const result = value(0);
  if (at !== bytes.length) throw new RangeError('msgpack: trailing bytes');
  return result;
}
