/**
 * A reply, cut into its speakers' runs.
 *
 * The parser is `@shizue/core`'s and has its own tests; what is tested here is the
 * one thing the web adds to it — putting a character's 상황묘사 back into the
 * marks markdown reads, so a line with a description inside it is still one line.
 */
import { describe, expect, it } from 'vitest';
import { speechRuns } from '../src/lib/speechRuns';

const ROSTER = ['아리아', '카이'];

describe('a reply with more than one voice in it', () => {
  it('is cut where the speaker changes, in the order it was written', () => {
    const runs = speechRuns('비가 그치지 않았다.\n아리아: 아직도 안 그쳤네.\n카이: 조금만 더.', ROSTER);

    expect(runs).toEqual([
      { name: null, text: '비가 그치지 않았다.' },
      { name: '아리아', text: '아직도 안 그쳤네.' },
      { name: '카이', text: '조금만 더.' },
    ]);
  });

  it('keeps a description inside the line it was written in', () => {
    const runs = speechRuns('아리아: *문틈으로 밖을 살피며* 아직도 안 그쳤네.', ROSTER);
    expect(runs).toEqual([{ name: '아리아', text: '*문틈으로 밖을 살피며* 아직도 안 그쳤네.' }]);
  });

  it('keeps the narrator\'s own line breaks, which are its paragraphs', () => {
    const runs = speechRuns('비가 그쳤다.\n\n문이 열렸다.', ROSTER);
    expect(runs).toEqual([{ name: null, text: '비가 그쳤다.\n문이 열렸다.' }]);
  });

  it('leaves a name nobody on the roster answers to as the narrator\'s text', () => {
    const runs = speechRuns('지나가던 사람: 여기 아무도 없어요.', ROSTER);
    expect(runs).toEqual([{ name: null, text: '지나가던 사람: 여기 아무도 없어요.' }]);
  });

  it('reads a half-written line as what it currently says', () => {
    expect(speechRuns('아리', ROSTER)).toEqual([{ name: null, text: '아리' }]);
    expect(speechRuns('아리아: 아직', ROSTER)).toEqual([{ name: '아리아', text: '아직' }]);
  });
});
