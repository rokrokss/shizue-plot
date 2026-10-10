/**
 * RisuAI's legacy module file (`.risum`), as far as a card import needs it.
 *
 * RisuAI's charx export takes `customScripts` and `triggerscript` out of
 * `card.json`'s `extensions.risuai` and ships them in a root entry `module.risum`
 * instead; its import puts them back. Without this file a charx from RisuAI
 * arrives with none of its regex scripts and none of its triggers.
 *
 * Layout: byte 111 (magic), byte 0 (version), a u32 little-endian length, then
 * that many bytes of RPack-encoded UTF-8 JSON `{ type: 'risuModule', module }`.
 * Asset blocks (`0x01`, u32le length, RPack bytes) follow until a `0x00`; a card
 * import has no use for them, so reading stops after the main block.
 */

const MAGIC = 111;
const VERSION = 0;
const HEADER_BYTES = 6;

/**
 * RPack's decode table. RPack is a byte-wise substitution, `out[i] = table[in[i]]`.
 *
 * Source: RisuAI `src/ts/rpack/rpack_map.bin`, bytes 256–511 (bytes 0–255 are the
 * matching encode table). RPack's LICENSE says that use outside RisuAI falls under
 * AGPL-3.0; the owner decided on 2026-10-10 to carry the table as data, with a
 * decoder of our own, regardless.
 */
const RPACK_DECODE_HEX =
  '2cf7848bc965fbb69faeb3032d0169741fe4a3ecee5c3421934a0f6ae262029e' +
  '229cfd3cfc71c7c6ad596705706d8a4412fa24865fafd17a47cefe5063dd5106' +
  '6f18e052a8099d56734cb8536cc3a00e19cf3e0d7e07326846ea48f9992eaba4' +
  '49205e5535380cbcd3b1581679280a1ae1f2cdc439dba2ba6072767d95ef7fc8' +
  'c0de3794bfb51481922545ace7f566a72b365ac113e34b3ae88d831b7c27b09a' +
  '42eb87aadc548e7826d25729d4b7f82f8f8975f04177c21effd81511e5049717' +
  'f331d09b00d7cab44f2a3bd9b26bda5da13f3061bd913d4ee6dfbe4d828c1d23' +
  '109864f485337b9043bba988f1d6a51cf6cc6eb95b0b96edd5e9c5cb08a68040';

let decodeTable: Uint8Array | undefined;

/** Undoes RPack. Exported for the tests, which invert the table to encode. */
export function rpackDecode(bytes: Uint8Array): Uint8Array {
  decodeTable ??= Uint8Array.from({ length: 256 }, (_, i) =>
    Number.parseInt(RPACK_DECODE_HEX.slice(i * 2, i * 2 + 2), 16),
  );
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = decodeTable[bytes[i]!]!;
  return out;
}

/**
 * What a card import takes from a module. The module's lorebook is not among it:
 * RisuAI's export writes the same entries as the card's `character_book`.
 */
export interface RisuModuleScripts {
  /** Goes back to `extensions.risuai.customScripts`. */
  regex?: unknown[];
  /** Goes back to `extensions.risuai.triggerscript`. */
  trigger?: unknown[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Reads a module's regex scripts and triggers. Never throws: anything that is not
 * a module this reader understands comes back undefined, and the caller goes on
 * without it — a module must never cost a card its import.
 */
export function readRisum(bytes: Uint8Array): RisuModuleScripts | undefined {
  if (bytes.length < HEADER_BYTES || bytes[0] !== MAGIC || bytes[1] !== VERSION) return undefined;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true);
  if (HEADER_BYTES + length > bytes.length) return undefined;

  let main: unknown;
  try {
    const json = rpackDecode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length));
    main = JSON.parse(new TextDecoder('utf-8').decode(json));
  } catch {
    return undefined;
  }
  if (!isObject(main) || main['type'] !== 'risuModule' || !isObject(main['module'])) return undefined;

  const module = main['module'];
  return {
    ...(Array.isArray(module['regex']) ? { regex: module['regex'] as unknown[] } : {}),
    ...(Array.isArray(module['trigger']) ? { trigger: module['trigger'] as unknown[] } : {}),
  };
}

/**
 * Puts a module's scripts back on the card, as RisuAI's own import does. Only a
 * list card.json does not carry itself is filled in — a card that has one keeps
 * it — and on a copy: the input is left as it arrived.
 */
export function cardWithRisuModule(raw: unknown, module: RisuModuleScripts): unknown {
  if (!isObject(raw) || !isObject(raw['data'])) return raw;
  const data = raw['data'];
  const extensions = isObject(data['extensions']) ? data['extensions'] : {};
  const risu = isObject(extensions['risuai']) ? { ...extensions['risuai'] } : {};

  let filled = false;
  if (module.regex && !Array.isArray(risu['customScripts'])) {
    risu['customScripts'] = module.regex;
    filled = true;
  }
  if (module.trigger && !Array.isArray(risu['triggerscript'])) {
    risu['triggerscript'] = module.trigger;
    filled = true;
  }
  return filled ? { ...raw, data: { ...data, extensions: { ...extensions, risuai: risu } } } : raw;
}
