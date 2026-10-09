import { describe, expect, it } from 'vitest';
import { parseAssistantSpeech, parseUserSpeech, type SpeechBlock } from '../src/speech.js';

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
});
