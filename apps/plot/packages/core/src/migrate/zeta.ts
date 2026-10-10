/**
 * Zeta (zeta-ai.io): a plot of up to ten characters, which is our shape already
 * (design §5.1; fields in KR-PLATFORM-MIGRATION.md §2.3).
 *
 * The style tab is re-picked rather than pasted, and its options carry our own
 * enum values: Zeta's labels are ours, one for one, except 2인칭, which has no
 * narrator point of view here. Field names, order and limits come from public
 * sources, not the logged-in screen — a wrong one is a one-line fix here.
 */

import { MAX_INTRO_LENGTH } from '../card/intro.js';
import { spokenBy } from '../speech.js';
import { coercePlotStyle } from '../style.js';
import {
  MAX_CHARACTERS_PER_PLOT,
  MAX_INTRO_TEXT_LENGTH,
  MAX_PLOT_MOODS,
  MAX_PLOT_PROFILE_DESCRIPTION_LENGTH,
  MAX_PLOT_PROFILE_NAME_LENGTH,
  MAX_PLOT_PROFILES,
  NARRATOR_POVS,
  PLOT_MOODS,
  type LoreEntry,
  type NarratorConfig,
  type NarratorPov,
  type PlotMood,
} from '../types.js';
import {
  capped,
  choices,
  clip,
  cutAtSentence,
  firstSpeaker,
  imageListEntry,
  labelOf,
  limited,
  line,
  loreEntry,
  mainSpeaker,
  plotTags,
  preserve,
  preserveLoreNames,
  prose,
  rowsOf,
  scene,
  splitKeywords,
  text,
  warn,
  type Conversion,
} from './convert.js';
import type { MigrationDraft, SiteInput, SiteSchema } from './types.js';

export const ZETA_SCHEMA: SiteSchema = {
  platform: 'zeta',
  sections: [
    {
      id: 'prompt',
      label: '프롬프트',
      fields: [
        {
          id: 'description',
          label: '설명',
          aliases: ['기본 설정 › 설명', '플롯 프롬프트'],
          kind: 'text',
          visibility: 'ai',
          sourceLimit: { chars: 2400, unverified: true },
        },
        {
          id: 'narrator',
          label: '내레이터',
          aliases: ['고급 설정 › 내레이터'],
          kind: 'text',
          visibility: 'ai',
          sourceLimit: { chars: 2400, unverified: true },
        },
      ],
    },
    {
      id: 'characters',
      label: '캐릭터',
      repeat: { min: 1, max: 10 },
      fields: [
        { id: 'name', label: '이름', kind: 'line', visibility: 'public' },
        {
          id: 'description',
          label: '설명',
          kind: 'text',
          visibility: 'ai',
          sourceLimit: { chars: 2400, unverified: true },
        },
      ],
    },
    {
      id: 'profiles',
      label: '대화 프로필',
      repeat: { min: 0, max: 5 },
      fields: [
        { id: 'name', label: '이름', kind: 'line', visibility: 'both' },
        { id: 'summary', label: '짧은 소개', kind: 'line', visibility: 'public' },
        { id: 'description', label: '설명', kind: 'text', visibility: 'ai', sourceLimit: { chars: 1000 } },
      ],
    },
    {
      id: 'examples',
      label: '상황 예시',
      repeat: { min: 0, max: 20 },
      fields: [
        { id: 'user', label: '유저 턴', kind: 'text', visibility: 'ai' },
        { id: 'character', label: '캐릭터 턴', kind: 'turns', visibility: 'ai' },
      ],
    },
    {
      id: 'lorebook',
      label: '설정집',
      repeat: { min: 0, max: 250 },
      fields: [
        { id: 'name', label: '이름', kind: 'line', visibility: 'meta' },
        { id: 'keywords', label: '키워드', kind: 'keywords', visibility: 'ai' },
        { id: 'content', label: '내용', kind: 'text', visibility: 'ai', sourceLimit: { chars: 500 } },
      ],
    },
    {
      id: 'style',
      label: '스타일',
      fields: [
        {
          id: 'pov',
          label: '시점',
          kind: 'choice',
          visibility: 'ai',
          options: [
            { value: 'first', label: '1인칭' },
            // No narrator point of view here; picking it is a warning, not a value.
            { value: 'second', label: '2인칭' },
            { value: 'third', label: '3인칭' },
          ],
        },
        {
          id: 'tense',
          label: '시제',
          kind: 'choice',
          visibility: 'ai',
          options: [
            { value: 'past', label: '과거' },
            { value: 'present', label: '현재' },
          ],
        },
        {
          id: 'replyLength',
          label: '응답 길이',
          kind: 'choice',
          visibility: 'ai',
          options: [
            { value: 'short', label: '짧게' },
            { value: 'medium', label: '보통' },
            { value: 'long', label: '길게' },
            { value: 'auto', label: '자동' },
          ],
        },
        {
          id: 'delivery',
          label: '표현 방식',
          kind: 'choice',
          visibility: 'ai',
          options: [
            { value: 'dialogue', label: '대사 중심' },
            { value: 'balanced', label: '균형' },
            { value: 'action', label: '행동 중심' },
          ],
        },
        {
          id: 'pacing',
          label: '전개 속도',
          kind: 'choice',
          visibility: 'ai',
          options: [
            { value: 'fast', label: '빠르게' },
            { value: 'natural', label: '자연스럽게' },
            { value: 'slow', label: '천천히' },
          ],
        },
        {
          id: 'difficulty',
          label: '난이도',
          kind: 'choice',
          visibility: 'ai',
          options: [
            { value: 'easy', label: '쉬움' },
            { value: 'normal', label: '보통' },
            { value: 'hard', label: '어려움' },
            { value: 'nightmare', label: '악몽' },
          ],
        },
        {
          id: 'moods',
          label: '분위기',
          kind: 'multiChoice',
          visibility: 'ai',
          maxChoices: MAX_PLOT_MOODS,
          options: [
            { value: 'romance', label: '로맨스' },
            { value: 'healing', label: '힐링' },
            { value: 'angst', label: '앙스트' },
            { value: 'yandere', label: '얀데레' },
            { value: 'fantasy', label: '판타지' },
            { value: 'action', label: '액션' },
            { value: 'mystery', label: '미스터리' },
            { value: 'horror', label: '호러' },
          ],
        },
        {
          id: 'storytelling',
          label: '스토리텔링',
          kind: 'choice',
          visibility: 'ai',
          options: [
            { value: 'highSociety', label: '하이 소사이어티' },
            { value: 'noir', label: '느와르' },
            { value: 'afterDark', label: '애프터 다크' },
            { value: 'nostalgia', label: '노스탤지어' },
            { value: 'blockbuster', label: '블록버스터' },
            { value: 'arcane', label: '아케인' },
            { value: 'manga', label: '망가' },
            { value: 'dread', label: '드레드' },
          ],
        },
        {
          id: 'choices',
          label: '선택지',
          kind: 'choice',
          visibility: 'ai',
          options: [
            { value: 'off', label: '끄기' },
            { value: 'keywords', label: '키워드형' },
            { value: 'sentences', label: '문장형' },
          ],
        },
        {
          id: 'statusWindow',
          label: '상태창',
          kind: 'choice',
          visibility: 'ai',
          options: [
            { value: 'on', label: '사용' },
            { value: 'off', label: '사용 안 함' },
          ],
        },
      ],
    },
    {
      id: 'intro',
      label: '인트로',
      fields: [
        { id: 'intro', label: '인트로', kind: 'turns', visibility: 'public', sourceLimit: { chars: 1500 } },
      ],
    },
    {
      id: 'about',
      label: '소개',
      fields: [
        { id: 'title', label: '제목', kind: 'line', visibility: 'public', sourceLimit: { chars: 20 } },
        { id: 'summary', label: '짧은 소개', kind: 'line', visibility: 'public', sourceLimit: { chars: 40 } },
        { id: 'hashtags', label: '해시태그', kind: 'keywords', visibility: 'public' },
        {
          id: 'aboutMe',
          label: '나만의 소개글',
          kind: 'text',
          visibility: 'public',
          sourceLimit: { chars: 10000 },
        },
      ],
    },
    {
      id: 'plugins',
      label: '플러그인',
      fields: [
        {
          id: 'plugins',
          label: '플러그인',
          aliases: ['퀘스트', '돌발 이벤트', '러브라인', '이벤트 컷', '게시판', '엔딩', 'BGM', '티어', '주사위'],
          kind: 'text',
          visibility: 'meta',
        },
      ],
    },
  ],
  confirmations: [{ id: 'ownWork' }, { id: 'secondaryWork' }],
};

/** The narrator's point of view a style pick names; 2인칭 is warned about and dropped. */
function povOf(c: Conversion, value: unknown): NarratorPov | undefined {
  if (value === 'second') warn(c, 'povUnsupported', 'style.pov');
  return NARRATOR_POVS.includes(value as NarratorPov) ? (value as NarratorPov) : undefined;
}

export function zetaToDraft(c: Conversion, input: SiteInput): MigrationDraft {
  const name = line(input['title']);
  if (!name) warn(c, 'nameMissing', 'about.title');

  // 짧은 소개 first, then 나만의 소개글, in our 500 (D15).
  const parts = [
    { field: 'summary', text: prose(c, 'about.summary', input['summary']) },
    { field: 'aboutMe', text: prose(c, 'about.aboutMe', input['aboutMe']) },
  ].filter((part) => part.text);
  const joined = parts.map((part) => part.text).join('\n\n');
  const intro = cutAtSentence(joined, MAX_INTRO_LENGTH);
  // Every part that did not make it whole is kept — the 소개글, as a rule.
  for (const part of parts) {
    if (intro.includes(part.text)) continue;
    warn(c, 'truncated', `about.${part.field}`, { limit: MAX_INTRO_LENGTH, length: joined.length });
    preserve(c, labelOf(c, 'about', part.field), part.text);
  }

  // Members first: every scene below is spoken by them.
  const characters = rowsOf(input, 'characters').flatMap((row, i) => {
    const memberName = line(row['name']);
    const description = prose(c, `characters[${i}].description`, row['description']);
    if (!memberName && description) {
      warn(c, 'nameMissing', `characters[${i}].name`);
      preserve(c, labelOf(c, 'characters', 'description'), description);
    }
    return memberName ? [{ name: memberName, description }] : [];
  });
  const members = capped(c, 'characters', characters, MAX_CHARACTERS_PER_PLOT, (m) =>
    `${m.name}\n${m.description}`.trim(),
  ).map((m) => ({ ...m, mesExample: '' }));
  const roster = members.map((m) => m.name);

  // 상황 예시 → the member the character turn names, else the first.
  rowsOf(input, 'examples').forEach((row, i) => {
    const field = `examples[${i}].character`;
    const raw = text(row['character']);
    const owner = mainSpeaker(c, field, roster, Math.max(firstSpeaker(raw, roster), 0));
    const character = scene(c, field, raw, roster, owner, true);
    const user = spokenBy(prose(c, `examples[${i}].user`, row['user']), '{{user}}');
    if (!character && !user) return;
    const member = members.find((m) => m.name === owner);
    if (!member) {
      preserve(c, labelOf(c, 'examples'), [user, character].filter(Boolean).join('\n'));
      return;
    }
    const block = ['<START>', user, character].filter(Boolean).join('\n');
    member.mesExample = member.mesExample ? `${member.mesExample}\n${block}` : block;
  });

  const opening = scene(c, 'intro.intro', input['intro'], roster, mainSpeaker(c, 'intro.intro', roster), true);
  const intros = opening
    ? [limited(c, 'intro.intro', labelOf(c, 'intro', 'intro'), opening, MAX_INTRO_TEXT_LENGTH)]
    : [];

  const profiles = capped(
    c,
    'profiles',
    rowsOf(input, 'profiles').flatMap((row, i) => {
      const profileName = line(row['name']);
      const summary = prose(c, `profiles[${i}].summary`, row['summary']);
      const description = prose(c, `profiles[${i}].description`, row['description']);
      // The public one-liner has no place: ours are copied into the prompt (§5.1).
      preserve(c, labelOf(c, 'profiles', 'summary'), summary);
      if (!profileName) {
        if (description) {
          warn(c, 'nameMissing', `profiles[${i}].name`);
          preserve(c, labelOf(c, 'profiles', 'description'), description);
        }
        return [];
      }
      if (profileName.length > MAX_PLOT_PROFILE_NAME_LENGTH) {
        warn(c, 'truncated', `profiles[${i}].name`, {
          limit: MAX_PLOT_PROFILE_NAME_LENGTH,
          length: profileName.length,
        });
      }
      return [
        {
          name: clip(profileName, MAX_PLOT_PROFILE_NAME_LENGTH),
          description: limited(
            c,
            `profiles[${i}].description`,
            labelOf(c, 'profiles', 'description'),
            description,
            MAX_PLOT_PROFILE_DESCRIPTION_LENGTH,
          ),
        },
      ];
    }),
    MAX_PLOT_PROFILES,
    (p) => `${p.name}\n${p.description}`.trim(),
  );

  const lorebook: LoreEntry[] = [];
  const loreNames: { name: string; keys: string[]; order: number }[] = [];
  rowsOf(input, 'lorebook').forEach((row, i) => {
    const content = prose(c, `lorebook[${i}].content`, row['content']);
    if (!content) return;
    const keys = splitKeywords(row['keywords']);
    if (keys.length === 0) warn(c, 'loreNoKeys', `lorebook[${i}].keywords`);
    loreNames.push({ name: line(row['name']), keys, order: lorebook.length });
    lorebook.push(loreEntry(keys, content, lorebook.length));
  });
  preserveLoreNames(c, labelOf(c, 'lorebook', 'name'), loreNames);
  if (c.options.imageListLore ?? true) {
    const images = imageListEntry(c, lorebook.length);
    if (images) lorebook.push(images);
  }

  const voice = prose(c, 'prompt.narrator', input['narrator']);
  const pov = povOf(c, input['pov']);
  const narrator: NarratorConfig = { ...(voice ? { voice } : {}), ...(pov ? { pov } : {}) };

  const moods = [...new Set(choices(input['moods']).filter((m) => PLOT_MOODS.includes(m as PlotMood)))];
  if (moods.length > MAX_PLOT_MOODS) {
    warn(c, 'tooMany', 'style.moods', { limit: MAX_PLOT_MOODS, count: moods.length });
  }
  const statusWindow = input['statusWindow'];
  const style = coercePlotStyle({
    tense: input['tense'],
    replyLength: input['replyLength'],
    delivery: input['delivery'],
    pacing: input['pacing'],
    difficulty: input['difficulty'],
    moods,
    storytelling: input['storytelling'],
    choices: input['choices'],
    ...(statusWindow === 'on' || statusWindow === 'off' ? { statusWindow: statusWindow === 'on' } : {}),
  });

  preserve(c, labelOf(c, 'plugins', 'plugins'), text(input['plugins']).trim());

  return {
    platform: 'zeta',
    plot: {
      name,
      intro,
      description: prose(c, 'prompt.description', input['description']),
      tags: plotTags(c, 'about.hashtags', input['hashtags']),
      intros,
      lorebook,
      ...(Object.keys(narrator).length > 0 ? { narrator } : {}),
      ...(Object.keys(style).length > 0 ? { style } : {}),
      ...(profiles.length > 0 ? { profiles } : {}),
    },
    members: members.map(({ mesExample, ...m }) => ({ ...m, ...(mesExample ? { mesExample } : {}) })),
  };
}

