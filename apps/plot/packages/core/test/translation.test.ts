import { describe, expect, it } from 'vitest';
import { authorNoteDue, coerceAuthorNoteSettings } from '../src/authorNote.js';
import {
  applyParts,
  applyTranslationScripts,
  coerceTranslationSettings,
  DEFAULT_TRANSLATOR_PROMPT,
  defaultTranslationMode,
  inputParts,
  markupParts,
  partTexts,
  proseParts,
  recommendsTranslateMode,
  replyLanguageInstruction,
  resolveTranslation,
  splitTranslation,
  translatesMessage,
  translationBatches,
  translationTurns,
  type TextPart,
} from '../src/translation.js';
import { translationScriptsOf, type TriggerScript } from '../src/triggers/scripts.js';

/** What a translator is asked for, and the text with every one of them marked as a stand-in translation. */
const run = (parts: TextPart[]) => {
  const texts = partTexts(parts);
  return { texts, out: applyParts(parts, new Map(texts.map((text) => [text, `«${text}»`]))) };
};

describe('language modes', () => {
  it('defaults by the work language against the reader one', () => {
    expect(defaultTranslationMode('ko', 'ko')).toBe('off');
    expect(defaultTranslationMode('en', 'ko')).toBe('instruct');
    expect(resolveTranslation(null, 'en', 'ko')).toEqual({ mode: 'instruct', language: 'ko', input: false, auto: true });
    expect(resolveTranslation(null, 'ko', 'ko')).toEqual({ mode: 'off', language: 'ko', input: false, auto: true });
    // The chat's own language wins over the UI's.
    expect(resolveTranslation({ language: 'ja' }, 'ko', 'ko').mode).toBe('instruct');
  });

  it('keeps the reader pick, but has nothing to do in the work own language or with no language', () => {
    expect(resolveTranslation({ mode: 'translate', input: true }, 'en', 'ko')).toEqual({
      mode: 'translate',
      language: 'ko',
      input: true,
      auto: false,
    });
    expect(resolveTranslation({ mode: 'off' }, 'en', 'ko').mode).toBe('off');
    expect(resolveTranslation({ mode: 'translate' }, 'ko', 'ko').mode).toBe('off');
    expect(resolveTranslation(null, 'en', undefined).mode).toBe('off');
    // Input translation is the translate mode's alone.
    expect(resolveTranslation({ mode: 'instruct', input: true }, 'en', 'ko').input).toBe(false);
  });

  it('stores only what it knows', () => {
    expect(coerceTranslationSettings({ mode: 'translate', language: 'ja', input: true, extra: 1 })).toEqual({
      mode: 'translate',
      language: 'ja',
      input: true,
    });
    expect(coerceTranslationSettings({ mode: 'google', language: 'zh', input: 'yes' })).toBeNull();
    expect(coerceTranslationSettings('translate')).toBeNull();
  });

  it('translates every message in translate mode, and in instruct mode only what the card wrote', () => {
    expect(translatesMessage('translate', { intro: false })).toBe(true);
    expect(translatesMessage('instruct', { intro: true })).toBe(true);
    // A message the card's scripts wrote is the card's language, like its openings.
    expect(translatesMessage('instruct', { intro: false, scripted: true })).toBe(true);
    // No per-reply call where the model already writes in the reader language.
    expect(translatesMessage('instruct', { intro: false })).toBe(false);
    expect(translatesMessage('off', { intro: true })).toBe(false);
    expect(translatesMessage('off', { intro: false, scripted: true })).toBe(false);
  });

  it('names the language and keeps the speaker prefixes in its trailing line', () => {
    expect(replyLanguageInstruction('ko')).toContain('Korean (한국어)');
    expect(replyLanguageInstruction('ja')).toContain('`Name:`');
  });
});

describe('the translator request', () => {
  it('is RisuAI default prompt with the target in its slot, and the text as the user turn', () => {
    expect(translationTurns(['안녕'], 'en')).toEqual({
      system: DEFAULT_TRANSLATOR_PROMPT.replace('{{slot}}', 'en'),
      user: '안녕',
    });
    const many = translationTurns(['하나', '둘'], 'en');
    expect(many.system.startsWith(DEFAULT_TRANSLATOR_PROMPT.replace('{{slot}}', 'en'))).toBe(true);
    expect(many.user).toBe('하나\n■\n둘');
  });

  it('splits the answer back on the separator, or says the count is off', () => {
    expect(splitTranslation('one\n■\ntwo', 2)).toEqual(['one', 'two']);
    expect(splitTranslation('one two', 2)).toBeNull();
    expect(splitTranslation(' all of it ■ kept ', 1)).toEqual(['all of it ■ kept']);
  });

  it('gathers texts while the request stays under the RisuAI limit', () => {
    const long = 'x'.repeat(3000);
    expect(translationBatches(['a', 'b', 'c'])).toEqual([['a', 'b', 'c']]);
    expect(translationBatches([long, long, 'c'])).toEqual([[long], [long, 'c']]);
    // A text that holds the separator goes alone.
    expect(translationBatches(['a', 'b ■ c', 'd'])).toEqual([['a'], ['b ■ c'], ['d']]);
  });
});

describe('what a message translates', () => {
  it('reads the text of markup and never its tags, attributes, styles or scripts', () => {
    const markup =
      '<div class="status" style="color:red" title="체력">체력: <b>30</b> / 100<br>기분이 좋다</div>' +
      '<style>.status::after { content: "상태" }</style><script>alert("안녕")</script><!-- 메모 -->';
    const { texts, out } = run(markupParts(markup));
    expect(texts).toEqual(['체력:', '기분이 좋다']);
    expect(out).toBe(markup.replace('>체력: <b>', '>«체력:» <b>').replace('기분이 좋다</div>', '«기분이 좋다»</div>'));
  });

  it('leaves alone what an element marked translate="no" holds, and a quoted > in an attribute', () => {
    const markup = '<p>말한다 <span translate="no">고유명사</span> 끝<img alt="a > b" src="x.png">그림 뒤</p>';
    expect(partTexts(markupParts(markup))).toEqual(['말한다', '끝', '그림 뒤']);
    expect(applyParts(markupParts(markup), new Map())).toBe(markup);
  });

  it('reads a prose block as RisuAI pretranslate text, keeping pictures, addresses, code and macros', () => {
    const block = '그는 웃었다.\n"안녕" ![웃음](/api/a/smile.png) 그리고 `code` https://x.y/z {{button::가자::go}}';
    const { texts } = run(proseParts(block));
    expect(texts).toEqual(['그는 웃었다.\n"안녕"', '그리고']);
    expect(applyParts(proseParts(block), new Map())).toBe(block);
  });

  it('passes asset lines and empty lines through and cuts the text at them, as runTranslator does', () => {
    const block = '첫 줄\n둘째 줄\n{{img::smile}}\n\n셋째 줄';
    expect(partTexts(proseParts(block))).toEqual(['첫 줄\n둘째 줄', '셋째 줄']);
    expect(run(proseParts(block)).out).toBe('«첫 줄\n둘째 줄»\n{{img::smile}}\n\n«셋째 줄»');
    expect(partTexts(proseParts('```js\nconst 이름 = 1\n```'))).toEqual([]);
  });

  it('keeps the reader writing-as prefix and translates the rest', () => {
    const text = '문을 연다.\n@리안: 누구야?\n@: 바람이 분다.';
    expect(partTexts(inputParts(text))).toEqual(['문을 연다.', '누구야?', '바람이 분다.']);
    expect(applyParts(inputParts(text), new Map([['누구야?', "Who's there?"]]))).toBe(
      "문을 연다.\n@리안: Who's there?\n@: 바람이 분다.",
    );
  });

  it('does not ask about text with no letters in it', () => {
    expect(partTexts(markupParts('<td>30</td><td>/</td><td>♥ 12</td>'))).toEqual([]);
  });
});

describe('the translate-mode recommendation', () => {
  const trigger = (type: TriggerScript['type'], effect: TriggerScript['effect'] = []): TriggerScript => ({
    comment: '',
    type,
    conditions: [],
    effect,
  });
  const lua = (code: string) => trigger('start', [{ type: 'triggerlua', code }]);

  it('is made for a card whose scripts read what the model writes', () => {
    expect(recommendsTranslateMode({ displayScripts: [{ in: '\\[상태\\]', enabled: true }] })).toBe(true);
    expect(
      recommendsTranslateMode({ scripts: [{ triggers: [], editScripts: [{ type: 'editoutput', in: 'HP: (\\d+)' }] }] }),
    ).toBe(true);
    expect(recommendsTranslateMode({ scripts: [{ triggers: [trigger('output')], editScripts: [] }] })).toBe(true);
    expect(
      recommendsTranslateMode({ scripts: [{ triggers: [lua("listenEdit('editDisplay', function(t) end)")], editScripts: [] }] }),
    ).toBe(true);
    expect(recommendsTranslateMode({ scripts: [{ triggers: [lua('function onOutput(id) end')], editScripts: [] }] })).toBe(true);
  });

  it('is not made for a plain card, or one whose scripts only read the reader', () => {
    expect(recommendsTranslateMode({})).toBe(false);
    expect(recommendsTranslateMode({ displayScripts: [{ in: 'x', enabled: false }, { in: '', enabled: true }] })).toBe(false);
    expect(
      recommendsTranslateMode({
        scripts: [
          {
            triggers: [trigger('input'), lua("listenEdit('editInput', function(t) end)")],
            editScripts: [{ type: 'editinput', in: 'x' }],
          },
        ],
      }),
    ).toBe(false);
  });
});

describe('author note settings', () => {
  it('stores what differs from SillyTavern defaults, clamped to its range', () => {
    expect(coerceAuthorNoteSettings({ depth: 4, frequency: 1, role: 'system' })).toBeNull();
    expect(coerceAuthorNoteSettings({ depth: -3, frequency: 12000.4, role: 'user', other: true })).toEqual({
      depth: 0,
      frequency: 9999,
      role: 'user',
    });
    expect(coerceAuthorNoteSettings({ role: 'narrator', depth: '2' })).toBeNull();
  });

  it('is due as SillyTavern setFloatingPrompt decides', () => {
    expect(authorNoteDue(1, 0)).toBe(true);
    expect(authorNoteDue(0, 4)).toBe(false);
    expect(authorNoteDue(4, 0)).toBe(false);
    expect(authorNoteDue(4, 3)).toBe(false);
    expect(authorNoteDue(4, 8)).toBe(true);
  });
});

describe('edittrans scripts', () => {
  it('reads them off the modules first, then the card, apart from every other kind', () => {
    const card = {
      extensions: {
        risuai: {
          customScripts: [
            { type: 'edittrans', in: '레이안', out: '리안' },
            { type: 'editoutput', in: 'x', out: 'y' },
            { type: 'edittrans', in: '', out: 'never' },
          ],
        },
      },
    };
    const modules = [{ regex: [{ type: 'edittrans', in: 'A', out: 'B', flag: 'gi', ableFlag: true }] }];
    expect(translationScriptsOf(card, modules)).toEqual([
      { in: 'A', out: 'B', flag: 'gi', ableFlag: true },
      { in: '레이안', out: '리안' },
    ]);
    expect(translationScriptsOf({ extensions: {} })).toEqual([]);
  });

  it('runs on the translation as RisuAI does: a plain replacement, its flags, its order and its moves', () => {
    expect(applyTranslationScripts('레이안이 웃었다. 레이안!', [{ in: '레이안', out: '리안' }])).toBe('리안이 웃었다. 리안!');
    // `$1` is the pattern's own, never CBS; `$n` is a line break.
    expect(applyTranslationScripts('HP 30', [{ in: 'HP (\\d+)', out: '체력$n$1 {{getvar::x}}' }])).toBe('체력\n30 {{getvar::x}}');
    // Without `ableFlag` the flag field is not read: `g` alone, case kept.
    expect(applyTranslationScripts('a A', [{ in: 'a', out: 'b', flag: 'i' }])).toBe('b A');
    expect(applyTranslationScripts('a A', [{ in: 'a', out: 'b', flag: 'gi', ableFlag: true }])).toBe('b b');
    // `<order N>`: highest first once any script has one.
    const ordered = [
      { in: 'x', out: 'y' },
      { in: 'y', out: 'z', flag: 'g<order 5>', ableFlag: true },
    ];
    expect(applyTranslationScripts('x', ordered)).toBe('y');
    expect(applyTranslationScripts('x', [ordered[0]!, { ...ordered[1]!, flag: 'g' }])).toBe('z');
    expect(applyTranslationScripts('본문 [상태] 끝', [{ in: '\\[(.+?)\\] ', out: '<$1>', flag: '<move_top>', ableFlag: true }])).toBe(
      '<상태>\n본문 끝',
    );
    // A pattern that does not compile is passed over; `cbs` reads the pattern first.
    expect(applyTranslationScripts('ab', [{ in: '(', out: '' }, { in: 'b', out: 'c' }])).toBe('ac');
    expect(
      applyTranslationScripts('Rian', [{ in: '{{char}}', out: '리안', flag: '<cbs>', ableFlag: true }], {
        cbs: (pattern) => pattern.replace('{{char}}', 'Rian'),
      }),
    ).toBe('리안');
  });
});
