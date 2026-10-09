import { describe, expect, it } from 'vitest';
import { coercePlotProfiles } from '../src/profiles.js';
import {
  MAX_PLOT_PROFILE_DESCRIPTION_LENGTH,
  MAX_PLOT_PROFILE_NAME_LENGTH,
  MAX_PLOT_PROFILES,
} from '../src/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('coercePlotProfiles', () => {
  it('keeps the rows the creator wrote, in their order', () => {
    const profiles = [
      { id: 'a3f1c2d4-0000-4000-8000-000000000001', name: '기사', description: '왕국의 기사.' },
      { id: 'a3f1c2d4-0000-4000-8000-000000000002', name: '도적', description: '' },
    ];
    expect(coercePlotProfiles(profiles)).toEqual(profiles);
  });

  it('mints an id for a row that carries none', () => {
    const [minted] = coercePlotProfiles([{ name: '기사', description: '왕국의 기사.' }]);
    expect(minted!.id).toMatch(UUID_RE);
    // Two rows of the same shape are still two profiles.
    const two = coercePlotProfiles([{ name: '기사' }, { name: '기사' }]);
    expect(two[0]!.id).not.toBe(two[1]!.id);
  });

  it('drops a row with no usable name, and anything that is not a row', () => {
    expect(
      coercePlotProfiles([
        { name: '   ', description: '이름이 없다' },
        { description: '이름이 아예 없다' },
        { name: 42 },
        null,
        '기사',
        ['기사'],
        { name: ' 기사 ', description: ' 왕국의 기사. ' },
      ]),
    ).toEqual([{ id: expect.stringMatching(UUID_RE), name: '기사', description: '왕국의 기사.' }]);
  });

  it('trims the text to its caps rather than refusing it', () => {
    const [long] = coercePlotProfiles([
      { name: '가'.repeat(MAX_PLOT_PROFILE_NAME_LENGTH + 10), description: '나'.repeat(MAX_PLOT_PROFILE_DESCRIPTION_LENGTH + 10) },
    ]);
    expect(long!.name).toHaveLength(MAX_PLOT_PROFILE_NAME_LENGTH);
    expect(long!.description).toHaveLength(MAX_PLOT_PROFILE_DESCRIPTION_LENGTH);
  });

  it('keeps at most five, and answers with none for anything that is not a list', () => {
    const many = Array.from({ length: MAX_PLOT_PROFILES + 3 }, (_, index) => ({ name: `프로필${index}` }));
    expect(coercePlotProfiles(many).map((profile) => profile.name)).toEqual([
      '프로필0',
      '프로필1',
      '프로필2',
      '프로필3',
      '프로필4',
    ]);
    for (const value of [null, undefined, {}, '기사', 42]) {
      expect(coercePlotProfiles(value), JSON.stringify(value) ?? 'undefined').toEqual([]);
    }
  });
});
