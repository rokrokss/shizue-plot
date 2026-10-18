import { describe, expect, it } from 'vitest';
import { addTag, MAX_TAGS, normalizeTags } from '../src/lib/tags';

describe('addTag', () => {
  it('trims, caps the length and refuses duplicates', () => {
    expect(addTag([], '  판타지  ')).toEqual(['판타지']);
    expect(addTag([], 'ㄱ'.repeat(30))).toEqual(['ㄱ'.repeat(20)]);
    expect(addTag(['판타지'], '판타지')).toEqual(['판타지']);
  });

  it('ignores empty input and returns the same array when nothing changes', () => {
    const tags = ['판타지'];
    expect(addTag(tags, '   ')).toBe(tags);
    expect(addTag(tags, '판타지')).toBe(tags);
  });

  it('stops at the server-side cap', () => {
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(addTag(full, '하나 더')).toBe(full);
  });
});

describe('normalizeTags', () => {
  it('applies the same rules the server stores the tag column with', () => {
    expect(normalizeTags([' 판타지 ', '판타지', '', 'ㄱ'.repeat(30)])).toEqual([
      '판타지',
      'ㄱ'.repeat(20),
    ]);
    expect(normalizeTags(Array.from({ length: 12 }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS);
  });
});
