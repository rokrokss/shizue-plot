import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readRisum, rpackDecode } from '../src/card/risum.js';
import { buildRisum } from './helpers/risum.js';

describe('rpackDecode', () => {
  it("carries RisuAI's decode table", () => {
    const table = rpackDecode(Uint8Array.from({ length: 256 }, (_, i) => i));
    // sha256 of RisuAI src/ts/rpack/rpack_map.bin, bytes 256–511.
    expect(createHash('sha256').update(table).digest('hex')).toBe(
      '541399aa080429e113232c7e33190d61b2c10d3505a7eb4769bd778a84d18989',
    );
  });

  it('undoes the encode half of the same map', () => {
    // '{"type":"risuModule"}' put through rpack_map.bin bytes 0–255, outside this
    // codebase — so a table that only inverts itself cannot pass.
    const encoded = Buffer.from('e6200f6c2c05209720790e48b2db40e2b24c05207b', 'hex');
    expect(new TextDecoder().decode(rpackDecode(encoded))).toBe('{"type":"risuModule"}');
  });
});

describe('readRisum', () => {
  const module = {
    name: 'm',
    description: '',
    id: 'id',
    regex: [{ comment: '', in: 'a', out: 'b', type: 'editdisplay', ableFlag: false }],
    trigger: [{ comment: '', type: 'start', conditions: [], effect: [] }],
    lorebook: [],
  };
  const file = buildRisum({ module, type: 'risuModule' });

  it('reads the regex scripts and triggers, and nothing after the main block', () => {
    const withAssets = buildRisum({ module, type: 'risuModule' }, [Uint8Array.from([1, 2, 3])]);
    expect(readRisum(withAssets)).toEqual({ regex: module.regex, trigger: module.trigger });
  });

  it('returns undefined for anything it cannot read, without throwing', () => {
    const withByte = (at: number, value: number): Uint8Array => {
      const copy = file.slice();
      copy[at] = value;
      return copy;
    };
    expect(readRisum(withByte(0, 112))).toBeUndefined(); // magic
    expect(readRisum(withByte(1, 1))).toBeUndefined(); // version
    expect(readRisum(file.subarray(0, 40))).toBeUndefined(); // main block runs past the end
    expect(readRisum(withByte(6, 0))).toBeUndefined(); // no longer JSON
    expect(readRisum(buildRisum({ module, type: 'risuPreset' }))).toBeUndefined();
    expect(readRisum(buildRisum({ type: 'risuModule' }))).toBeUndefined();
    expect(readRisum(new Uint8Array(0))).toBeUndefined();
  });
});
