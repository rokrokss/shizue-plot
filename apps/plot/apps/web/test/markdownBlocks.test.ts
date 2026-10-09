/**
 * The block splitter.
 *
 * Two properties carry the whole memoization scheme, and both are about what the
 * splitter must *not* do: it must not lose a character, and it must not change
 * its mind about a block that is already behind the cursor.
 */
import { describe, expect, it } from 'vitest';
import { splitBlocks } from '../src/lib/markdown/blocks';

describe('splitBlocks', () => {
  it('has nothing to split in an empty message', () => {
    expect(splitBlocks('')).toEqual([]);
  });

  it('gives the separator to the block it ended', () => {
    expect(splitBlocks('첫 문단\n\n둘째 문단')).toEqual(['첫 문단\n\n', '둘째 문단']);
  });

  it('keeps a run of blank lines whole', () => {
    expect(splitBlocks('가\n\n\n\n나')).toEqual(['가\n\n\n\n', '나']);
  });

  it('does not split inside a fence', () => {
    const md = '설명\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n끝';
    expect(splitBlocks(md)).toEqual([
      '설명\n\n',
      '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n',
      '끝',
    ]);
  });

  it('treats an unterminated fence as one block, however long', () => {
    const md = '앞\n\n~~~\n한 줄\n\n또 한 줄\n';
    expect(splitBlocks(md)).toEqual(['앞\n\n', '~~~\n한 줄\n\n또 한 줄\n']);
  });

  it('does not let ``` be closed by ~~~', () => {
    expect(splitBlocks('```\na\n~~~\n\nb')).toEqual(['```\na\n~~~\n\nb']);
  });

  it('keeps a list together and a table together', () => {
    const md = '- 하나\n- 둘\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
    expect(splitBlocks(md)).toEqual(['- 하나\n- 둘\n\n', '| a | b |\n| - | - |\n| 1 | 2 |\n']);
  });
});

/**
 * Every prefix of a message, split, must agree with every longer prefix about
 * the blocks they share. This is the property the memo compares strings on.
 */
describe('as the message grows', () => {
  const grown = [
    '아리아가 웃었다.\n\n"그럴 리가 없어."\n\n```py\nprint(1)\n\nprint(2)\n```\n\n그리고 침묵.\n',
    '# 제목\n\n본문 한 줄\n> 인용\n\n\n- 목록\n- 둘\n\n마지막',
    '\n\n앞이 비어 있다\n\n끝\n\n\n',
  ];

  it('never loses a character', () => {
    for (const md of grown) {
      for (let n = 0; n <= md.length; n += 1) {
        const prefix = md.slice(0, n);
        expect(splitBlocks(prefix).join('')).toBe(prefix);
      }
    }
  });

  it('never moves a boundary it has already passed', () => {
    for (const md of grown) {
      let previous: string[] = [];
      for (let n = 0; n <= md.length; n += 1) {
        const blocks = splitBlocks(md.slice(0, n));
        // Everything but the block being written is settled, and settled is final.
        const settled = previous.slice(0, Math.max(previous.length - 1, 0));
        expect(blocks.slice(0, settled.length)).toEqual(settled);
        previous = blocks;
      }
    }
  });
});
