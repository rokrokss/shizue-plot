import { describe, expect, it } from 'vitest';
import {
  MAX_UNLOCK_KEYWORD_LENGTH,
  MAX_UNLOCK_KEYWORDS,
  MAX_UNLOCK_RELATIONSHIP,
  MAX_UNLOCK_TURNS,
  UNLOCK_AXES,
} from '../src/types.js';
import { coerceAssetUnlock } from '../src/unlock.js';

describe('coerceAssetUnlock', () => {
  it('keeps each of the three conditions this build can check', () => {
    expect(coerceAssetUnlock({ kind: 'keyword', keywords: ['첫 키스', '고백'] })).toEqual({
      kind: 'keyword',
      keywords: ['첫 키스', '고백'],
    });
    expect(coerceAssetUnlock({ kind: 'turns', count: 20 })).toEqual({ kind: 'turns', count: 20 });
    for (const axis of UNLOCK_AXES) {
      expect(coerceAssetUnlock({ kind: 'relationship', axis, min: 70 })).toEqual({
        kind: 'relationship',
        axis,
        min: 70,
      });
    }
  });

  it('trims and deduplicates the keywords, and keeps at most five', () => {
    expect(
      coerceAssetUnlock({
        kind: 'keyword',
        keywords: [' 고백 ', '고백', '', '   ', 42, null, '가'.repeat(MAX_UNLOCK_KEYWORD_LENGTH + 5)],
      }),
    ).toEqual({ kind: 'keyword', keywords: ['고백', '가'.repeat(MAX_UNLOCK_KEYWORD_LENGTH)] });

    const many = Array.from({ length: MAX_UNLOCK_KEYWORDS + 2 }, (_, index) => `단어${index}`);
    const unlock = coerceAssetUnlock({ kind: 'keyword', keywords: many });
    expect(unlock).toEqual({ kind: 'keyword', keywords: many.slice(0, MAX_UNLOCK_KEYWORDS) });
  });

  it('clamps the numbers into their bounds rather than refusing them', () => {
    expect(coerceAssetUnlock({ kind: 'turns', count: 0 })).toEqual({ kind: 'turns', count: 1 });
    expect(coerceAssetUnlock({ kind: 'turns', count: 9000 })).toEqual({
      kind: 'turns',
      count: MAX_UNLOCK_TURNS,
    });
    expect(coerceAssetUnlock({ kind: 'turns', count: 3.6 })).toEqual({ kind: 'turns', count: 4 });
    expect(coerceAssetUnlock({ kind: 'relationship', axis: 'trust', min: 400 })).toEqual({
      kind: 'relationship',
      axis: 'trust',
      min: MAX_UNLOCK_RELATIONSHIP,
    });
  });

  it('answers with null for a condition it could never open', () => {
    for (const value of [
      null,
      undefined,
      42,
      'keyword',
      [],
      {},
      { kind: 'mood', value: 'romance' },
      { kind: 'keyword' },
      { kind: 'keyword', keywords: [] },
      { kind: 'keyword', keywords: ['  '] },
      { kind: 'keyword', keywords: '고백' },
      { kind: 'turns' },
      { kind: 'turns', count: '20' },
      { kind: 'turns', count: Number.NaN },
      { kind: 'relationship', min: 50 },
      { kind: 'relationship', axis: 'respect', min: 50 },
      { kind: 'relationship', axis: 'trust' },
    ]) {
      expect(coerceAssetUnlock(value), JSON.stringify(value) ?? 'undefined').toBeNull();
    }
  });
});
