/**
 * Paste migration: what each site's form becomes. Every input here is
 * synthetic — no real platform content — and the expectations are spelled out
 * whole where the shape is the point, so a mapping change shows up as a diff.
 */
import { describe, expect, it } from 'vitest';
import { stripImageMacros } from '../src/macro.js';
import {
  convertToDraft,
  draftFingerprint,
  emptyInput,
  MIGRATION_PLATFORMS_ENABLED,
  SITE_SCHEMAS,
  type MigrationDraft,
  type SiteInput,
} from '../src/migrate/index.js';
import { MAX_INTRO_LENGTH } from '../src/card/intro.js';
import { cutAtSentence, normalizeBraces, normalizeImageRefs, splitKeywords } from '../src/migrate/convert.js';
import { splitCastSections } from '../src/migrate/elyn.js';
import { coercePlotStyle } from '../src/style.js';
import { MAX_INTRO_TEXT_LENGTH, type PlotStyle } from '../src/types.js';

const zeta = (fields: SiteInput): SiteInput => ({ ...emptyInput(SITE_SCHEMAS.zeta!), ...fields });
const elyn = (fields: SiteInput): SiteInput => ({ ...emptyInput(SITE_SCHEMAS.elyn!), ...fields });
const codes = (result: { warnings: { code: string }[] }): string[] => result.warnings.map((w) => w.code);

describe('site schemas', () => {
  it('open Zeta and Elyn, each with a schema', () => {
    expect(MIGRATION_PLATFORMS_ENABLED).toEqual(['zeta', 'elyn']);
    for (const platform of MIGRATION_PLATFORMS_ENABLED) {
      expect(SITE_SCHEMAS[platform]!.platform).toBe(platform);
    }
  });

  it('keep flat field ids unique per site, since a form holds them side by side', () => {
    for (const platform of MIGRATION_PLATFORMS_ENABLED) {
      const schema = SITE_SCHEMAS[platform]!;
      const flat = schema.sections.filter((s) => !s.repeat).flatMap((s) => s.fields.map((f) => f.id));
      const repeated = schema.sections.filter((s) => s.repeat).map((s) => s.id);
      expect(new Set([...flat, ...repeated]).size, platform).toBe(flat.length + repeated.length);
    }
  });

  it('ask the §7 questions', () => {
    expect(SITE_SCHEMAS.zeta!.confirmations.map((c) => c.id)).toEqual(['ownWork', 'secondaryWork']);
    expect(SITE_SCHEMAS.elyn!.confirmations.map((c) => c.id)).toEqual([
      'ownWork',
      'secondaryWork',
      'elynOnly',
    ]);
  });

  it("give Zeta's style picks our own enum values", () => {
    const style = SITE_SCHEMAS.zeta!.sections.find((s) => s.id === 'style')!;
    for (const field of style.fields) {
      if (field.id === 'pov' || field.id === 'statusWindow') continue;
      for (const option of field.options!) {
        const value = field.kind === 'multiChoice' ? [option.value] : option.value;
        expect(coercePlotStyle({ [field.id]: value }), `${field.id}=${option.value}`).toEqual({
          [field.id]: value,
        } satisfies PlotStyle);
      }
    }
  });
});

describe('emptyInput', () => {
  it('puts flat fields at the top level and repeated sections at their minimum rows', () => {
    expect(emptyInput(SITE_SCHEMAS.elyn!)).toEqual({
      name: '',
      intro: '',
      tags: '',
      rating: '',
      prompt: '',
      firstMessages: [{ text: '' }],
      lore: [],
      components: [],
    });
    const input = emptyInput(SITE_SCHEMAS.zeta!);
    expect(input['characters']).toEqual([{ name: '', description: '' }]);
    expect(input['moods']).toEqual([]);
    expect(input['examples']).toEqual([]);
  });

  it('converts to an empty draft that says what is missing', () => {
    const result = convertToDraft('zeta', emptyInput(SITE_SCHEMAS.zeta!));
    expect(result.draft).toEqual({
      platform: 'zeta',
      plot: { name: '', intro: '', description: '', tags: [], intros: [], lorebook: [] },
      members: [],
    });
    expect(codes(result)).toEqual(['nameMissing', 'noMembers']);
    expect(result.preserved).toEqual([]);
  });
});

describe('Zeta', () => {
  it('maps a whole plot', () => {
    const result = convertToDraft(
      'zeta',
      zeta({
        title: '여름 학원',
        summary: '전학 첫날의 이야기.',
        aboutMe: '두 사람과 보내는 여름.',
        hashtags: '#학원물 #일상, 로맨스',
        description: '{user}는 전학생이다.',
        narrator: '담담한 문체.',
        characters: [
          { name: '하루', description: '밝은 반장.' },
          { name: '유키', description: '조용한 도서부원.' },
        ],
        profiles: [{ name: '전학생', summary: '새로 온 학생', description: '도시에서 온 전학생.' }],
        examples: [{ user: '안녕?', character: '@유키: "응."\n*고개를 끄덕인다*' }],
        lorebook: [{ name: '도서실', keywords: '도서실, 책|서가', content: '3층 끝의 도서실.' }],
        intro: '@: 종이 울린다.\n교실 문이 열린다.\n@하루: "왔어?"\n"늦었네."\n@{{user}}: 미안.',
        pov: 'first',
        tense: 'present',
        replyLength: 'medium',
        delivery: 'dialogue',
        pacing: 'slow',
        difficulty: 'easy',
        moods: ['romance', 'healing'],
        storytelling: 'nostalgia',
        choices: 'sentences',
        statusWindow: 'off',
        plugins: '엔딩: 졸업식',
      }),
    );

    expect(result.draft).toEqual({
      platform: 'zeta',
      plot: {
        name: '여름 학원',
        intro: '전학 첫날의 이야기.\n\n두 사람과 보내는 여름.',
        description: '{{user}}는 전학생이다.',
        tags: ['학원물', '일상', '로맨스'],
        intros: ['종이 울린다.\n교실 문이 열린다.\n하루: "왔어?"\n하루: "늦었네."\n{{user}}: 미안.'],
        lorebook: [
          {
            keys: ['도서실', '책', '서가'],
            secondaryKeys: [],
            selective: false,
            content: '3층 끝의 도서실.',
            enabled: true,
            constant: false,
            insertionOrder: 0,
            caseSensitive: false,
            useRegex: false,
            position: 'before_char',
          },
        ],
        narrator: { voice: '담담한 문체.', pov: 'first' },
        style: {
          tense: 'present',
          replyLength: 'medium',
          delivery: 'dialogue',
          pacing: 'slow',
          difficulty: 'easy',
          moods: ['romance', 'healing'],
          storytelling: 'nostalgia',
          statusWindow: false,
          choices: 'sentences',
        },
        profiles: [{ name: '전학생', description: '도시에서 온 전학생.' }],
      },
      members: [
        { name: '하루', description: '밝은 반장.' },
        {
          name: '유키',
          description: '조용한 도서부원.',
          mesExample: '<START>\n{{user}}: 안녕?\n유키: "응."\n유키: *고개를 끄덕인다*',
        },
      ],
    });
    expect(result.warnings).toEqual([]);
    expect(result.preserved).toEqual([
      { label: '대화 프로필 › 짧은 소개', text: '새로 온 학생' },
      { label: '설정집 › 이름', text: '1. 도서실 (도서실, 책, 서가)' },
      { label: '플러그인 › 플러그인', text: '엔딩: 졸업식' },
    ]);
  });

  it('converts @ turns whatever the mode, and points out names off the roster', () => {
    const intro = '@: 바람이 분다.\n@하루: 안녕.\n잘 지냈어?\n@모모: 누구야?\n@{{user}}: 나야.';
    for (const mode of ['auto', 'character', 'narrator', 'verbatim'] as const) {
      const result = convertToDraft(
        'zeta',
        zeta({ title: 't', characters: [{ name: '하루', description: '' }], intro }),
        { speaker: { 'intro.intro': mode } },
      );
      expect(result.draft.plot.intros, mode).toEqual([
        '바람이 분다.\n하루: 안녕.\n하루: 잘 지냈어?\n모모: 누구야?\n{{user}}: 나야.',
      ]);
      expect(result.warnings, mode).toEqual([
        { code: 'speakerNotInRoster', field: 'intro.intro', detail: { name: '모모' } },
      ]);
    }
  });

  it('gives an example to the member its character turn names, else the first', () => {
    const { draft } = convertToDraft(
      'zeta',
      zeta({
        title: 't',
        characters: [
          { name: '하루', description: '' },
          { name: '유키', description: '' },
        ],
        examples: [
          { user: '어디 가?', character: '"도서실."' },
          { user: '', character: '@유키: 책 읽어.' },
          { user: '같이 가자', character: '"좋아."' },
        ],
      }),
      { mainSpeaker: { 'examples[2].character': 1 } },
    );
    expect(draft.members).toEqual([
      { name: '하루', description: '', mesExample: '<START>\n{{user}}: 어디 가?\n하루: "도서실."' },
      {
        name: '유키',
        description: '',
        mesExample: '<START>\n유키: 책 읽어.\n<START>\n{{user}}: 같이 가자\n유키: "좋아."',
      },
    ]);
  });

  it('warns that 2인칭 has no point of view here, and caps moods at two', () => {
    const result = convertToDraft(
      'zeta',
      zeta({ title: 't', characters: [{ name: '하루' }], pov: 'second', moods: ['angst', 'horror', 'mystery'] }),
    );
    expect(result.draft.plot.narrator).toBeUndefined();
    expect(result.draft.plot.style).toEqual({ moods: ['angst', 'horror'] });
    expect(result.warnings).toEqual([
      { code: 'povUnsupported', field: 'style.pov' },
      { code: 'tooMany', field: 'style.moods', detail: { limit: 2, count: 3 } },
    ]);
  });

  it('cuts the joined intro at a sentence and keeps the 소개글 whole', () => {
    const aboutMe = '여름이 온다. '.repeat(MAX_INTRO_LENGTH / 5).trim();
    const result = convertToDraft(
      'zeta',
      zeta({ title: 't', characters: [{ name: '하루' }], summary: '짧은 소개.', aboutMe }),
    );
    const intro = result.draft.plot.intro;
    expect(intro.length).toBeLessThanOrEqual(MAX_INTRO_LENGTH);
    expect(intro.startsWith('짧은 소개.\n\n여름이 온다.')).toBe(true);
    expect(intro.endsWith('다.')).toBe(true);
    expect(result.warnings).toEqual([
      {
        code: 'truncated',
        field: 'about.aboutMe',
        detail: { limit: MAX_INTRO_LENGTH, length: '짧은 소개.\n\n'.length + aboutMe.length },
      },
    ]);
    expect(result.preserved).toEqual([{ label: '소개 › 나만의 소개글', text: aboutMe }]);
  });

  it('drops rows past our caps, keeping their text', () => {
    const characters = Array.from({ length: 12 }, (_, i) => ({ name: `인물${i}`, description: `설명${i}` }));
    const profiles = Array.from({ length: 6 }, (_, i) => ({ name: `프로필${i}`, description: `소개${i}` }));
    const result = convertToDraft('zeta', zeta({ title: 't', characters, profiles }));
    expect(result.draft.members.map((m) => m.name)).toEqual(characters.slice(0, 10).map((c) => c.name));
    expect(result.draft.plot.profiles).toHaveLength(5);
    expect(result.warnings).toEqual([
      { code: 'tooMany', field: 'characters', detail: { limit: 10, count: 12 } },
      { code: 'tooMany', field: 'profiles', detail: { limit: 5, count: 6 } },
    ]);
    expect(result.preserved).toEqual([
      { label: '캐릭터', text: '인물10\n설명10' },
      { label: '캐릭터', text: '인물11\n설명11' },
      { label: '대화 프로필', text: '프로필5\n소개5' },
    ]);
  });

  it('keeps an unnamed row\'s text and drops a keyword-less entry\'s trigger only', () => {
    const result = convertToDraft(
      'zeta',
      zeta({
        title: 't',
        characters: [{ name: '', description: '이름 없는 설정' }, { name: '하루' }],
        lorebook: [{ name: '', keywords: '', content: '키워드 없음' }],
      }),
    );
    expect(result.draft.members).toEqual([{ name: '하루', description: '' }]);
    expect(result.draft.plot.lorebook.map((e) => e.content)).toEqual(['키워드 없음']);
    expect(result.warnings).toEqual([
      { code: 'nameMissing', field: 'characters[0].name' },
      { code: 'loreNoKeys', field: 'lorebook[0].keywords' },
    ]);
    expect(result.preserved).toEqual([{ label: '캐릭터 › 설명', text: '이름 없는 설정' }]);
  });
});

describe('speaker modes', () => {
  const opening = '*창밖을 본다.*\n"비가 오네."\n“우산 있어?”\n유키: 없어.\n\n조용하다.';
  const convert = (mode: 'auto' | 'character' | 'narrator' | 'verbatim', main?: number): string =>
    convertToDraft(
      'elyn',
      elyn({
        name: '하루',
        prompt: '# 캐릭터\n## 하루\n반장.\n## 유키\n도서부원.',
        firstMessages: [{ text: `${opening}\n{user}` }],
      }),
      {
        splitSections: true,
        speaker: { 'firstMessages[0].text': mode },
        ...(main === undefined ? {} : { mainSpeaker: { 'firstMessages[0].text': main } }),
      },
    ).draft.plot.intros[0]!;

  it('auto gives quoted lines to the main speaker and leaves the rest to the narrator', () => {
    expect(convert('auto')).toBe(
      '*창밖을 본다.*\n하루: "비가 오네."\n하루: “우산 있어?”\n유키: 없어.\n\n조용하다.\n{{user}}',
    );
  });

  it('character gives every line with text to the main speaker, roster lines kept', () => {
    expect(convert('character', 1)).toBe(
      '유키: *창밖을 본다.*\n유키: "비가 오네."\n유키: “우산 있어?”\n유키: 없어.\n\n유키: 조용하다.\n유키: {{user}}',
    );
  });

  it('narrator leaves lines alone, and verbatim also leaves spellings alone', () => {
    expect(convert('narrator')).toBe(`${opening}\n{{user}}`);
    expect(convert('verbatim')).toBe(`${opening}\n{user}`);
  });
});

describe('normalization', () => {
  it('doubles single braces and leaves ours alone, unless turned off', () => {
    expect(normalizeBraces('{user}와 {char}, {{user}}와 {{char}}, {User}')).toBe(
      '{{user}}와 {{char}}, {{user}}와 {{char}}, {{user}}',
    );
    const draft = (normalizeBraces?: boolean) =>
      convertToDraft('elyn', elyn({ name: 'n', prompt: '{char}는 {user}를 안다.' }), { normalizeBraces })
        .draft.plot.description;
    expect(draft()).toBe('{{char}}는 {{user}}를 안다.');
    expect(draft(false)).toBe('{char}는 {user}를 안다.');
  });

  it('points out Guest and 사용자 without replacing them', () => {
    const result = convertToDraft(
      'elyn',
      elyn({ name: 'n', prompt: 'Guest가 온다. Guest와 사용자.', firstMessages: [{ text: 'Guestbook' }] }),
    );
    expect(result.draft.plot.description).toBe('Guest가 온다. Guest와 사용자.');
    expect(result.warnings).toEqual([
      { code: 'placeholderName', field: 'prompt.prompt', detail: { name: 'Guest', count: 2 } },
      { code: 'placeholderName', field: 'prompt.prompt', detail: { name: '사용자', count: 1 } },
    ]);
  });

  it('writes image references in one spelling', () => {
    expect(normalizeImageRefs('img:[smile] {{img: 웃음 }} {{IMG:a.png}} {{img::그대로}}')).toBe(
      '{{img::smile}} {{img::웃음}} {{img::a.png}} {{img::그대로}}',
    );
    const { draft } = convertToDraft('elyn', elyn({ name: 'n', firstMessages: [{ text: '{{img: 웃음}}' }] }));
    expect(draft.plot.intros).toEqual(['{{img::웃음}}']);
  });

  it('splits keywords on commas, bars and newlines, trimmed and de-duplicated', () => {
    expect(splitKeywords(' 학교, 교실 |학교\n\n 복도 ,, ')).toEqual(['학교', '교실', '복도']);
    expect(splitKeywords(42)).toEqual([]);
  });

  it('reads tags with # as a separator, within our caps', () => {
    const result = convertToDraft(
      'elyn',
      elyn({ name: 'n', tags: `#가 #나, 가\n${'긴'.repeat(25)}|${Array.from({ length: 10 }, (_, i) => `t${i}`).join(',')}` }),
    );
    expect(result.draft.plot.tags).toEqual(['가', '나', '긴'.repeat(20), 't0', 't1', 't2', 't3', 't4', 't5', 't6']);
    expect(result.warnings).toEqual([
      { code: 'truncated', field: 'profile.tags', detail: { limit: 20, length: 25 } },
      { code: 'tooMany', field: 'profile.tags', detail: { limit: 10, count: 13 } },
    ]);
  });
});

describe('cutAtSentence', () => {
  it('cuts at the last boundary inside the limit, else at the limit', () => {
    expect(cutAtSentence('하나. 둘! 셋넷', 8)).toBe('하나. 둘!');
    expect(cutAtSentence('첫 줄\n둘째 줄', 7)).toBe('첫 줄');
    expect(cutAtSentence('경계없는긴문장', 4)).toBe('경계없는');
    expect(cutAtSentence('짧다.', 10)).toBe('짧다.');
  });

  it('never splits a surrogate pair', () => {
    expect(cutAtSentence('ab😀cd', 3)).toBe('ab');
  });
});

describe('image list lore', () => {
  const assets = [
    { name: '웃음', description: '웃는 얼굴' },
    { name: '울음', description: '' },
    { name: '화남', description: '찡그린\n얼굴' },
  ];

  it('is on by default for Zeta and off for Elyn', () => {
    const zetaBook = convertToDraft('zeta', zeta({ title: 't', characters: [{ name: '하루' }] }), { assets })
      .draft.plot.lorebook;
    const elynBook = convertToDraft('elyn', elyn({ name: 'n' }), { assets }).draft.plot.lorebook;
    expect(zetaBook).toEqual([
      {
        keys: [],
        secondaryKeys: [],
        selective: false,
        content: expect.stringMatching(/^\[이미지\] .+\n- 웃음: 웃는 얼굴\n- 화남: 찡그린 얼굴$/),
        enabled: true,
        constant: true,
        insertionOrder: 0,
        caseSensitive: false,
        useRegex: false,
        position: 'after_char',
      },
    ]);
    expect(elynBook).toEqual([]);
  });

  it('turns on for Elyn when its text tells the model to output an image', () => {
    // The instruction itself is stripped before the model sees it; the list says it in words.
    const fromPrompt = convertToDraft('elyn', elyn({ name: 'n', prompt: '기쁠 때 {{img::웃음}}을 출력한다.' }), {
      assets,
    });
    const fromLore = convertToDraft(
      'elyn',
      elyn({ name: 'n', lore: [{ content: '화나면 {{ img :: 화남 }}', keys: '분노' }] }),
      { assets },
    );
    for (const result of [fromPrompt, fromLore]) {
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'imageInstructionsStripped' }));
      expect(result.draft.plot.lorebook.some((entry) => entry.constant && entry.content.startsWith('[이미지]'))).toBe(
        true,
      );
    }
    const optedOut = convertToDraft('elyn', elyn({ name: 'n', prompt: '{{img::웃음}}' }), {
      assets,
      imageListLore: false,
    });
    expect(optedOut.draft.plot.lorebook).toEqual([]);
  });

  it('follows the toggle either way, after the pasted entries', () => {
    const zetaBook = convertToDraft('zeta', zeta({ title: 't' }), { assets, imageListLore: false }).draft.plot
      .lorebook;
    const elynBook = convertToDraft(
      'elyn',
      elyn({ name: 'n', lore: [{ content: '설정', keys: '열쇠' }] }),
      { assets, imageListLore: true },
    ).draft.plot.lorebook;
    expect(zetaBook).toEqual([]);
    expect(elynBook.map((e) => [e.insertionOrder, e.constant])).toEqual([
      [0, false],
      [1, true],
    ]);
  });

  it('survives prompt assembly, which strips every asset macro', () => {
    const [entry] = convertToDraft('zeta', zeta({ title: 't' }), { assets }).draft.plot.lorebook;
    expect(stripImageMacros(entry!.content)).toBe(entry!.content);
    expect(entry!.content).toContain('img::');
  });
});

describe('Elyn', () => {
  it('maps a whole character', () => {
    const intro = `${'소개 문장이다. '.repeat(MAX_INTRO_LENGTH / 5).trim()}`;
    const result = convertToDraft(
      'elyn',
      elyn({
        name: '하루',
        intro,
        tags: '일상, 학원',
        rating: 'adult',
        prompt: '{{char}}는 반장이다.',
        firstMessages: [{ text: '*손을 흔든다*\n"안녕!"' }, { text: '' }, { text: '비가 온다.' }],
        lore: [
          {
            name: '학교',
            content: '언덕 위의 학교.',
            keys: '학교|교정',
            scanRange: '3',
            onMatch: 'activate',
            group: '장소',
            priority: '9',
            dependencies: '',
          },
          { name: '비밀', content: '숨겨진 방.', keys: '방', scanRange: '0', onMatch: 'deactivate' },
          { name: '전역', content: '항상.', keys: '항상', scanRange: 'all', dependencies: '학교, 비밀' },
        ],
        components: [{ code: 'function Card() { return <div>hi</div>; }' }],
      }),
    );
    const cut = result.draft.plot.intro;
    expect(cut.length).toBeLessThanOrEqual(MAX_INTRO_LENGTH);
    expect(cut.endsWith('다.')).toBe(true);

    const base = { secondaryKeys: [], selective: false, constant: false, caseSensitive: false, useRegex: false };
    expect(result.draft).toEqual({
      platform: 'elyn',
      plot: {
        name: '하루',
        intro: cut,
        description: '{{char}}는 반장이다.',
        tags: ['일상', '학원'],
        intros: ['*손을 흔든다*\n하루: "안녕!"', '비가 온다.'],
        lorebook: [
          {
            ...base,
            keys: ['학교', '교정'],
            content: '언덕 위의 학교.',
            enabled: true,
            insertionOrder: 0,
            position: 'before_char',
            scanDepth: 6,
            group: '장소',
            groupWeight: 10,
          },
          {
            ...base,
            keys: ['방'],
            content: '숨겨진 방.',
            enabled: false,
            insertionOrder: 1,
            position: 'before_char',
            scanDepth: 1,
          },
          {
            ...base,
            keys: ['항상'],
            content: '항상.',
            enabled: true,
            insertionOrder: 2,
            position: 'before_char',
            scanDepth: 1000,
          },
        ],
        customUi: { componentCode: 'function Card() { return <div>hi</div>; }' },
      },
      members: [{ name: '하루', intro: cut, description: '' }],
    });
    expect(result.warnings).toEqual([
      { code: 'adultOnly', field: 'profile.rating' },
      { code: 'truncated', field: 'profile.intro', detail: { limit: MAX_INTRO_LENGTH, length: intro.length } },
      { code: 'loreGroupApprox', field: 'lore[0].group' },
      { code: 'loreInverted', field: 'lore[1].onMatch' },
      { code: 'loreDependencyDropped', field: 'lore[2].dependencies' },
    ]);
    expect(result.preserved).toEqual([
      { label: '기본 정보 › 캐릭터 소개말', text: intro },
      { label: '로어 › 이름', text: '1. 학교 (학교, 교정)\n2. 비밀 (방)\n3. 전역 (항상)' },
    ]);
  });

  it('cuts a first message past our limit and keeps the original', () => {
    const text = `${'가'.repeat(MAX_INTRO_TEXT_LENGTH - 10)}. ${'나'.repeat(50)}`;
    const result = convertToDraft('elyn', elyn({ name: 'n', firstMessages: [{ text }] }), {
      speaker: { 'firstMessages[0].text': 'narrator' },
    });
    expect(result.draft.plot.intros).toEqual([`${'가'.repeat(MAX_INTRO_TEXT_LENGTH - 10)}.`]);
    expect(result.preserved).toEqual([{ label: '첫 메시지 › 첫 메시지', text }]);
    expect(codes(result)).toEqual(['truncated']);
  });

  it('reports components outside the subset and still brings them', () => {
    const result = convertToDraft(
      'elyn',
      elyn({
        name: 'n',
        components: [
          { code: 'function A() { setTimeout(() => {}, 1); return <b />; }' },
          { code: '' },
          { code: 'function B() { const [x] = useReducer(); return <i className="x" />; }' },
        ],
      }),
    );
    expect(result.draft.plot.customUi?.componentCode).toBe(
      'function A() { setTimeout(() => {}, 1); return <b />; }\n\nfunction B() { const [x] = useReducer(); return <i className="x" />; }',
    );
    expect(result.warnings).toEqual([
      { code: 'componentSubset', field: 'components[0].code', detail: { violation: 'timer' } },
      { code: 'componentSubset', field: 'components[2].code', detail: { violation: 'class_name' } },
      { code: 'componentSubset', field: 'components[2].code', detail: { violation: 'unknown_hook' } },
    ]);
  });

  it('leaves out components past the size cap, keeping their code', () => {
    const code = `function A() { return <b>${'x'.repeat(25_000)}</b>; }`;
    const result = convertToDraft('elyn', elyn({ name: 'n', components: [{ code }, { code }] }));
    expect(result.draft.plot.customUi).toBeUndefined();
    expect(result.warnings).toEqual([
      { code: 'componentTooLong', field: 'components', detail: { limit: 40_000, length: code.length * 2 + 2 } },
    ]);
    expect(result.preserved).toEqual([
      { label: 'JSX 컴포넌트 › 코드', text: code },
      { label: 'JSX 컴포넌트 › 코드', text: code },
    ]);
  });

  it('splits ## blocks under # 캐릭터 into members when asked', () => {
    const prompt = [
      '# 세계관',
      '바닷가 마을.',
      '',
      '# 캐릭터',
      '## 유키',
      '도서부원.',
      '### 말투',
      '존댓말.',
      '## **하루**',
      '반장.',
      '```',
      '# 캐릭터',
      '## 코드 속 제목',
      '```',
      '# 규칙',
      '대사는 짧게.',
    ].join('\n');
    const result = convertToDraft(
      'elyn',
      elyn({ name: '하루', intro: '소개.', prompt, firstMessages: [{ text: '"왔구나."' }] }),
      { splitSections: true },
    );
    expect(result.draft.plot.description).toBe('# 세계관\n바닷가 마을.\n\n# 규칙\n대사는 짧게.');
    expect(result.draft.members).toEqual([
      { name: '유키', description: '도서부원.\n### 말투\n존댓말.' },
      { name: '하루', description: '반장.\n```\n# 캐릭터\n## 코드 속 제목\n```' },
    ]);
    // The first messages still speak for the character Elyn named.
    expect(result.draft.plot.intros).toEqual(['하루: "왔구나."']);
    expect(result.warnings).toEqual([]);
  });

  it('keeps a roster heading that still has text of its own, and says when nothing split', () => {
    expect(splitCastSections('# 등장인물\n모두 학생이다.\n## 하루\n반장.')).toEqual({
      rest: '# 등장인물\n모두 학생이다.',
      members: [{ name: '하루', description: '반장.' }],
    });
    const result = convertToDraft('elyn', elyn({ name: '하루', prompt: '## 하루\n반장.' }), {
      splitSections: true,
    });
    expect(result.draft.plot.description).toBe('## 하루\n반장.');
    expect(result.draft.members).toEqual([{ name: '하루', description: '' }]);
    expect(codes(result)).toEqual(['splitNoSections']);
  });
});

describe('never throws', () => {
  it('reads a malformed form as an emptier one', () => {
    for (const input of [null, undefined, 42, 'x', [], { characters: 'x', lore: [null, 3, 'y'], moods: 'romance' }]) {
      for (const platform of MIGRATION_PLATFORMS_ENABLED) {
        expect(() =>
          convertToDraft(platform, input as SiteInput, {
            assets: 'x',
            speaker: 3,
            mainSpeaker: null,
          } as never),
        ).not.toThrow();
      }
    }
  });

  it('answers a platform without a mapper with an empty draft', () => {
    const result = convertToDraft('crack', {});
    expect(result.draft.members).toEqual([]);
    expect(codes(result)).toEqual(['platformUnsupported']);
  });
});

describe('draftFingerprint', () => {
  const draft: MigrationDraft = {
    platform: 'zeta',
    plot: {
      name: '플롯',
      intro: '',
      description: '설정',
      tags: ['a', 'b'],
      intros: ['하나'],
      lorebook: [
        {
          keys: ['k'],
          secondaryKeys: [],
          selective: false,
          content: 'c',
          enabled: true,
          constant: false,
          insertionOrder: 0,
          caseSensitive: false,
          useRegex: false,
          position: 'before_char',
          group: 'g',
        },
      ],
      style: { tense: 'past', moods: ['romance'] },
    },
    members: [{ name: '하루', description: 'd', mesExample: '<START>' }],
  };

  /** The same value with every object's keys in reverse order. */
  const reversed = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reversed)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
        : value;

  it('does not depend on key order, at any depth', () => {
    expect(draftFingerprint(reversed(draft) as MigrationDraft)).toBe(draftFingerprint(draft));
    expect(draftFingerprint(structuredClone(draft))).toBe(draftFingerprint(draft));
  });

  it('is canonical JSON with absent and undefined members alike', () => {
    const fingerprint = draftFingerprint(draft);
    expect(JSON.parse(fingerprint)).toEqual(draft);
    expect(fingerprint.startsWith('{"members":[{"description":"d","mesExample":"<START>","name":"하루"}]')).toBe(true);
    const withUndefined = { ...draft, plot: { ...draft.plot, narrator: undefined } };
    expect(draftFingerprint(withUndefined)).toBe(fingerprint);
  });

  it('changes with the content, and with array order', () => {
    const renamed = { ...draft, plot: { ...draft.plot, name: '다른 플롯' } };
    const reordered = { ...draft, plot: { ...draft.plot, tags: ['b', 'a'] } };
    expect(draftFingerprint(renamed)).not.toBe(draftFingerprint(draft));
    expect(draftFingerprint(reordered)).not.toBe(draftFingerprint(draft));
  });
});
