import { describe, expect, it } from 'vitest';
import { turnBlocks, turnText, type TurnMessage, type TurnNames } from '../src/lib/turnText';

const names: TurnNames = {
  member: (id) => ({ m1: '헤이즈', m2: '바네사' })[id],
  own: '아카데미',
};

/** A round: the narrator's line, then two members' replies, as Zeta's turn in the recording. */
const round: TurnMessage[] = [
  { id: 'n1', content: '@: *계약식장이 또 한번 술렁인다.*' },
  { id: 'r1', content: '*고개를 젓는다.* 안 됩니다. 팀워크 없이는 못 이겨요.', speakerMemberId: 'm2' },
  { id: 'r2', content: '*이를 악문다.* …씨발.', speakerMemberId: 'm1' },
];

describe('turnText', () => {
  it('writes a scene as Zeta’s editor holds it: a mark per message, actions parted from words', () => {
    expect(turnText(round, names)).toBe(
      [
        '@: *계약식장이 또 한번 술렁인다.*',
        '@바네사: *고개를 젓는다.*\n\n안 됩니다. 팀워크 없이는 못 이겨요.',
        '@헤이즈: *이를 악문다.*\n\n…씨발.',
      ].join('\n\n'),
    );
  });

  it('writes a scene of one reply as its text alone', () => {
    expect(turnText([{ id: 'r', content: '*웃는다* 어서 와.' }], names)).toBe('*웃는다*\n\n어서 와.');
  });
});

describe('turnBlocks', () => {
  it('reads an edit back onto the messages it came from, in order', () => {
    const edited = turnText(round, names).replace('…씨발.', '…두고 봐.');
    expect(turnBlocks(edited, round, names)).toEqual([
      { originId: 'n1', kind: 'narration', content: '*계약식장이 또 한번 술렁인다.*' },
      { originId: 'r1', kind: 'dialogue', content: '*고개를 젓는다.*\n\n안 됩니다. 팀워크 없이는 못 이겨요.' },
      { originId: 'r2', kind: 'dialogue', content: '*이를 악문다.*\n\n…두고 봐.' },
    ]);
  });

  it('drops a part left empty, and makes a new message of a part no message matches', () => {
    const edited = '@: *술렁인다.*\n\n@헤이즈: 됐어.\n\n@카이: *잔을 든다.*\n\n@바네사:';
    expect(turnBlocks(edited, round, names)).toEqual([
      { originId: 'n1', kind: 'narration', content: '*술렁인다.*' },
      // 바네사's reply was emptied, so 헤이즈's is matched past it.
      { originId: 'r2', kind: 'dialogue', content: '됐어.' },
      // Nobody in the scene: a new reply that names its speaker as a reply does.
      { kind: 'dialogue', content: '카이: *잔을 든다.*' },
    ]);
  });

  it('gives the text before any mark to the first message, as a scene of one shows it', () => {
    const one: TurnMessage[] = [{ id: 'r', content: '*웃는다* 어서 와.' }];
    expect(turnBlocks('*웃는다*\n\n어서 오세요.', one, names)).toEqual([
      { originId: 'r', kind: 'dialogue', content: '*웃는다*\n\n어서 오세요.' },
    ]);
  });
});
