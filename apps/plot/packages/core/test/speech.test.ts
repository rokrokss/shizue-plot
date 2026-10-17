import { describe, expect, it } from 'vitest';
import {
  lineSpeaker,
  parseAssistantSpeech,
  parseUserSpeech,
  readerLine,
  readerRuns,
  spokenBy,
  type SpeechBlock,
} from '../src/speech.js';

const roster = ['아리아', '민수'] as const;

/** Blocks as `speaker → kind:text | kind:text`, which reads as the rendered chat. */
const shape = (blocks: SpeechBlock[]): string[] =>
  blocks.map((block) => {
    const who =
      block.speaker.kind === 'character' ? `character(${block.speaker.name})` : block.speaker.kind;
    return `${who} → ${block.parts.map((part) => `${part.kind}:${part.text}`).join(' | ')}`;
  });

describe('parseAssistantSpeech', () => {
  it('reads a roster-prefixed line as that character and everything else as the narrator', () => {
    expect(
      shape(parseAssistantSpeech('눈이 그치고 문이 열렸다.\n아리아: 늦었네요.', roster)),
    ).toEqual([
      'narrator → description:눈이 그치고 문이 열렸다.',
      'character(아리아) → dialogue:늦었네요.',
    ]);
  });

  it('splits a character line into dialogue and its *…* 상황묘사', () => {
    expect(shape(parseAssistantSpeech('아리아: *문틈을 살피며* 누구세요? *한 걸음 물러선다*', roster))).toEqual(
      [
        'character(아리아) → description:문틈을 살피며 | dialogue:누구세요? | description:한 걸음 물러선다',
      ],
    );
  });

  it('leaves a prefix that names nobody on the roster as narrator text, colon and all', () => {
    expect(shape(parseAssistantSpeech('그때: 종이 울렸다.', roster))).toEqual([
      'narrator → description:그때: 종이 울렸다.',
    ]);
    // A member who is not on this plot's roster is a stranger like any other.
    expect(shape(parseAssistantSpeech('세라: 안녕.', roster))).toEqual([
      'narrator → description:세라: 안녕.',
    ]);
  });

  it('merges consecutive lines with the same speaker and keeps their line breaks', () => {
    expect(
      shape(parseAssistantSpeech('바람이 분다.\n문이 닫혔다.\n아리아: 앉으세요.\n아리아: 곧 시작해요.', roster)),
    ).toEqual([
      'narrator → description:바람이 분다.\n문이 닫혔다.',
      'character(아리아) → dialogue:앉으세요.\n곧 시작해요.',
    ]);
  });

  it('treats a blank line as spacing, so it neither starts nor ends a block', () => {
    expect(shape(parseAssistantSpeech('아리아: 앉으세요.\n\n아리아: 곧 시작해요.', roster))).toEqual([
      'character(아리아) → dialogue:앉으세요.\n곧 시작해요.',
    ]);
    expect(parseAssistantSpeech('\n  \n', roster)).toEqual([]);
  });

  it('interleaves several members and the narrator inside one message, in order', () => {
    expect(
      shape(
        parseAssistantSpeech(
          '난롯불이 흔들렸다.\n아리아: 늦었네요.\n민수: *모자를 벗으며* 눈이 심해서요.\n둘 사이에 침묵이 앉았다.',
          roster,
        ),
      ),
    ).toEqual([
      'narrator → description:난롯불이 흔들렸다.',
      'character(아리아) → dialogue:늦었네요.',
      'character(민수) → description:모자를 벗으며 | dialogue:눈이 심해서요.',
      'narrator → description:둘 사이에 침묵이 앉았다.',
    ]);
  });

  it('matches the roster name verbatim after trimming the prefix', () => {
    expect(shape(parseAssistantSpeech('  아리아 : 안녕.', roster))).toEqual([
      'character(아리아) → dialogue:안녕.',
    ]);
    // Verbatim: a different name is a different speaker, however close it looks.
    expect(shape(parseAssistantSpeech('아리아씨: 안녕.', roster))).toEqual([
      'narrator → description:아리아씨: 안녕.',
    ]);
  });

  it('reads a whole-turn @: as the narrator, the way the narration convention does', () => {
    expect(shape(parseAssistantSpeech('@: 눈이 그쳤다.', roster))).toEqual([
      'narrator → description:눈이 그쳤다.',
    ]);
  });

  it('tolerates a partial last line, which parses as what it currently says', () => {
    // Mid-stream the prefix is not yet a prefix, so the line is narrator text…
    expect(shape(parseAssistantSpeech('아리아', roster))).toEqual([
      'narrator → description:아리아',
    ]);
    // …and an unclosed span is literal text until its closing star arrives.
    expect(shape(parseAssistantSpeech('아리아: 늦었네요. *문을', roster))).toEqual([
      'character(아리아) → dialogue:늦었네요. *문을',
    ]);
    expect(shape(parseAssistantSpeech('아리아: 늦었네요. *문을 닫으며*', roster))).toEqual([
      'character(아리아) → dialogue:늦었네요. | description:문을 닫으며',
    ]);
  });

  it('never pairs stars across a line break', () => {
    expect(shape(parseAssistantSpeech('아리아: 하나 *둘\n아리아: 셋* 넷', roster))).toEqual([
      'character(아리아) → dialogue:하나 *둘\n셋* 넷',
    ]);
  });

  it('reads only a single-star span as 상황묘사, never the stars of **bold** or ***both***', () => {
    expect(shape(parseAssistantSpeech('아리아: 비가 **많이** 오네.', roster))).toEqual([
      'character(아리아) → dialogue:비가 **많이** 오네.',
    ]);
    expect(shape(parseAssistantSpeech('아리아: ***확실히*** 그래.', roster))).toEqual([
      'character(아리아) → dialogue:***확실히*** 그래.',
    ]);
    expect(shape(parseAssistantSpeech('아리아: *웃는다* 그리고 **정말**', roster))).toEqual([
      'character(아리아) → description:웃는다 | dialogue:그리고 **정말**',
    ]);
  });
});

describe('parseUserSpeech', () => {
  it('reads a plain turn as the user, with *…* as their own 상황묘사', () => {
    expect(shape(parseUserSpeech('*문을 밀며* 들어가도 될까요?'))).toEqual([
      'user → description:문을 밀며 | dialogue:들어가도 될까요?',
    ]);
  });

  it('reads a whole @: turn as the reader writing narrator 상황묘사', () => {
    expect(shape(parseUserSpeech('@: 문이 열리고 바람이 들이쳤다.'))).toEqual([
      'narrator → description:문이 열리고 바람이 들이쳤다.',
    ]);
  });

  it('is never split by speaker — one turn is one voice', () => {
    expect(shape(parseUserSpeech('아리아: 안녕.\n잘 지냈어?'))).toEqual([
      'user → dialogue:아리아: 안녕.\n잘 지냈어?',
    ]);
  });

  it('has nothing to say about an empty turn', () => {
    expect(parseUserSpeech('   ')).toEqual([]);
    expect(parseUserSpeech('@:  ')).toEqual([]);
  });

  const readers = [
    { id: 'aria', names: ['아리아', '아리'] },
    { id: 'minsu', names: ['민수'] },
  ];

  it('gives the lines the reader wrote as a member to that member, and narration lines to the narrator', () => {
    expect(
      shape(parseUserSpeech('*문을 연다* 왔어.\n@아리: 늦었네요.\n@내레이터: 바람이 분다.\n그래?', readers)),
    ).toEqual([
      'user → description:문을 연다 | dialogue:왔어.',
      'character(아리아) → dialogue:늦었네요.',
      'narrator → description:바람이 분다.',
      'user → dialogue:그래?',
    ]);
  });

  it('reads a turn with no marker, and a whole @: turn, exactly as without the members', () => {
    for (const content of ['아리아: 안녕.\n잘 지냈어?', '*문을 밀며* 들어가도 될까요?', '@: 문이 열린다.\n@아리아: 응', '   ']) {
      expect(parseUserSpeech(content, readers)).toEqual(parseUserSpeech(content));
    }
  });
});

describe('readerRuns', () => {
  const readers = [
    { id: 'aria', names: ['아리아', '아리'] },
    { id: 'rin', names: ['凛', 'Rin'] },
  ];

  it('cuts a turn into who the reader wrote each stretch as, in ko, en and ja', () => {
    expect(
      readerRuns('안녕.\n\n@아리아: 늦었네요.\n@아리：*웃는다*\n@rin: Hi.\n@凛: やあ\n@ナレーター：夜だ\n@: 비\n끝', readers),
    ).toEqual([
      { kind: 'user', text: '안녕.' },
      { kind: 'member', memberId: 'aria', text: '늦었네요.\n*웃는다*' },
      { kind: 'member', memberId: 'rin', text: 'Hi.\nやあ' },
      { kind: 'narration', text: '夜だ\n비' },
      { kind: 'user', text: '끝' },
    ]);
  });

  it('keeps a blank line inside a stretch and leaves a marker naming nobody as the reader’s', () => {
    expect(readerRuns('@아리아: 하나\n\n@아리아: 둘\n@유령: 셋', readers)).toEqual([
      { kind: 'member', memberId: 'aria', text: '하나\n\n둘' },
      { kind: 'user', text: '@유령: 셋' },
    ]);
  });

  it('takes a whole-turn @: as narration whole, and drops what has no text', () => {
    expect(readerRuns('@: 문이 열린다.\n@아리아: 응', readers)).toEqual([
      { kind: 'narration', text: '문이 열린다.\n@아리아: 응' },
    ]);
    expect(readerRuns('@아리아:\n  ', readers)).toEqual([]);
    expect(readerRuns('평범한 말.\n둘째 줄.', readers)).toEqual([{ kind: 'user', text: '평범한 말.\n둘째 줄.' }]);
  });

  it('reads a line split off CRLF text the same as one split off LF', () => {
    expect(readerLine('@아리: 안녕\r', readers)).toEqual({ kind: 'member', member: readers[0], text: '안녕' });
    expect(readerRuns('안녕\r\n@아리아: 응\r\n', readers)).toEqual([
      { kind: 'user', text: '안녕' },
      { kind: 'member', memberId: 'aria', text: '응' },
    ]);
  });
});

describe('parseAssistantSpeech - aliases', () => {
  const members = [{ name: '아리아 블랑', aliases: ['아리'] }, '민수'];

  it("reads a member's alias as that member, under the roster name", () => {
    expect(shape(parseAssistantSpeech('아리: 안녕.\n아리아 블랑: 또 보네.\n민수: 응.', members))).toEqual([
      'character(아리아 블랑) → dialogue:안녕.\n또 보네.',
      'character(민수) → dialogue:응.',
    ]);
  });

  it("lets a roster name win over another member's alias of the same spelling", () => {
    const clashing = [{ name: '아리아', aliases: ['민수'] }, '민수'];
    expect(shape(parseAssistantSpeech('민수: 응.', clashing))).toEqual(['character(민수) → dialogue:응.']);
  });

  it('reads the same lines with a plain list of names as it always has', () => {
    expect(lineSpeaker('아리: 안녕', roster)).toBeUndefined();
    expect(lineSpeaker('아리: 안녕', members)).toBe('아리아 블랑');
    expect(spokenBy('안녕\n아리: 응', '민수', members)).toBe('민수: 안녕\n아리: 응');
  });
});
