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

import { ChunkReader, MAX_READ_WHOLE_BYTES, type ByteSource } from './source.js';

const MAGIC = 111;
const VERSION = 0;
const HEADER_BYTES = 6;
/** An asset block's head: `0x01` and a u32 LE length. */
const BLOCK_HEADER_BYTES = 5;

/** Whether a file's first bytes are a `.risum`'s. */
export const isRisum = (head: Uint8Array): boolean => head[0] === MAGIC && head[1] === VERSION;

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
 * What an import takes from a charx's module. A card import puts the scripts
 * back (`cardWithRisuModule`) and, as a module import (`card/risuModule.ts`)
 * does, takes the lorebook over the entries of the card's book, as RisuAI's
 * charx import does (`parseCharx`).
 */
export interface RisuModuleScripts {
  /** Goes back to `extensions.risuai.customScripts`. */
  regex?: unknown[];
  /** Goes back to `extensions.risuai.triggerscript`. */
  trigger?: unknown[];
  /** The module's `lorebook`, RisuAI's own entry shape (`loreBook`). */
  lorebook?: unknown[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A `.risum`'s main block, decoded: the module as JSON, or undefined for bytes that are not one. */
function mainOf(packed: Uint8Array): Record<string, unknown> | undefined {
  let main: unknown;
  try {
    main = JSON.parse(new TextDecoder('utf-8').decode(rpackDecode(packed)));
  } catch {
    return undefined;
  }
  return isObject(main) && main['type'] === 'risuModule' && isObject(main['module']) ? main['module'] : undefined;
}

/**
 * A `.risum`'s main block: the module RisuAI wrote, as JSON, and where the asset
 * blocks after it begin. Undefined for bytes that are not one. Never throws.
 */
export function readRisumMain(bytes: Uint8Array): { module: Record<string, unknown>; end: number } | undefined {
  if (bytes.length < HEADER_BYTES || bytes[0] !== MAGIC || bytes[1] !== VERSION) return undefined;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true);
  if (HEADER_BYTES + length > bytes.length) return undefined;
  const module = mainOf(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length));
  return module ? { module, end: HEADER_BYTES + length } : undefined;
}

/** A `.risum` whose main block is past `MAX_READ_WHOLE_BYTES`, which is read whole to be parsed. */
export class RisumTooLargeError extends Error {}

/**
 * The same, read off the front of a stream: the header, then the main block,
 * and nothing after it is asked for — the asset blocks are read from their own
 * offsets when they are wanted. Undefined for what is not one; a main block past
 * the cap throws `RisumTooLargeError`.
 */
export async function readRisumMainFrom(
  chunks: AsyncIterable<Uint8Array>,
): Promise<{ module: Record<string, unknown>; end: number } | undefined> {
  const reader = new ChunkReader(chunks);
  try {
    const header = await reader.take(HEADER_BYTES);
    if (header.length < HEADER_BYTES || header[0] !== MAGIC || header[1] !== VERSION) return undefined;
    const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(2, true);
    if (length > MAX_READ_WHOLE_BYTES) {
      throw new RisumTooLargeError(`A module's main block is at most ${MAX_READ_WHOLE_BYTES / (1024 * 1024)}MB`);
    }
    const packed = await reader.take(length);
    if (packed.length < length) return undefined;
    const module = mainOf(packed);
    return module ? { module, end: HEADER_BYTES + length } : undefined;
  } finally {
    await reader.close();
  }
}

/** Where one of a `.risum`'s asset blocks lies: its RPack bytes, from `start`. */
export interface RisumBlock {
  start: number;
  length: number;
}

/**
 * A `.risum` file read front to back in one pass: the main block decoded, and
 * where each asset block after it lies, as long as the blocks are well formed
 * and inside the file — the blocks' bytes are passed over, to be read from their
 * offsets when wanted. Undefined for what is not one; the read goes on to the
 * file's end, so a reader that hashes what it streams has seen all of it.
 */
export async function scanRisum(
  source: ByteSource,
): Promise<{ module: Record<string, unknown>; blocks: RisumBlock[] } | undefined> {
  const reader = new ChunkReader(source.stream(0, source.size));
  try {
    const header = await reader.take(HEADER_BYTES);
    if (header.length < HEADER_BYTES || !isRisum(header)) return undefined;
    const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(2, true);
    if (HEADER_BYTES + length > source.size) return undefined;
    if (length > MAX_READ_WHOLE_BYTES) {
      throw new RisumTooLargeError(`A module's main block is at most ${MAX_READ_WHOLE_BYTES / (1024 * 1024)}MB`);
    }
    const module = mainOf(await reader.take(length));
    if (!module) return undefined;
    const blocks: RisumBlock[] = [];
    for (;;) {
      const head = await reader.take(BLOCK_HEADER_BYTES);
      if (head.length < BLOCK_HEADER_BYTES || head[0] !== 1) break;
      const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(1, true);
      const start = reader.offset;
      if (start + size > source.size) break;
      blocks.push({ start, length: size });
      await reader.skip(size);
    }
    await reader.skip(Number.POSITIVE_INFINITY);
    return { module, blocks };
  } finally {
    await reader.close();
  }
}

/** RPack undone over a stream, a chunk at a time. */
export async function* rpackDecodeStream(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) yield rpackDecode(chunk);
}

/**
 * Reads a module's regex scripts, triggers and lorebook. Never throws: anything that is not
 * a module this reader understands comes back undefined, and the caller goes on
 * without it — a module must never cost a card its import.
 */
export function readRisum(bytes: Uint8Array): RisuModuleScripts | undefined {
  const module = readRisumMain(bytes)?.module;
  if (!module) return undefined;
  return {
    ...(Array.isArray(module['regex']) ? { regex: module['regex'] as unknown[] } : {}),
    ...(Array.isArray(module['trigger']) ? { trigger: module['trigger'] as unknown[] } : {}),
    ...(Array.isArray(module['lorebook']) ? { lorebook: module['lorebook'] as unknown[] } : {}),
  };
}

/**
 * Puts a module's scripts back on the card, as RisuAI's own charx import does
 * (`importCharacter`): the module's `regex` and `trigger` become the card's
 * `customScripts` and `triggerscript` whatever card.json carries — a list the
 * module does not have becomes an empty one — since RisuAI's export moved them
 * there and its import reads them from nowhere else. On a copy: the input is
 * left as it arrived.
 */
export function cardWithRisuModule(raw: unknown, module: RisuModuleScripts): unknown {
  if (!isObject(raw) || !isObject(raw['data'])) return raw;
  const data = raw['data'];
  const extensions = isObject(data['extensions']) ? data['extensions'] : {};
  const risu = isObject(extensions['risuai']) ? { ...extensions['risuai'] } : {};
  risu['customScripts'] = module.regex ?? [];
  risu['triggerscript'] = module.trigger ?? [];
  return { ...raw, data: { ...data, extensions: { ...extensions, risuai: risu } } };
}
