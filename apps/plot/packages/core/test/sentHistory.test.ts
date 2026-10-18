import { describe, expect, it } from 'vitest';
import { sentHistoryTexts, type HistoryMessage, type PromptCharacter, type SentHistoryInput } from '../src/prompt.js';
import type { NormalizedCard } from '../src/types.js';

const member: PromptCharacter = {
  id: 'm1',
  name: '리안',
  card: { name: '리안', description: '사서', personality: '', scenario: '', firstMes: '', mesExample: '' } as NormalizedCard,
};

const input = (history: HistoryMessage[], extra: Partial<SentHistoryInput> = {}): SentHistoryInput => ({
  plot: { name: '도서관', description: '밤의 도서관' },
  characters: [member],
  history,
  userName: '유저',
  personaText: '',
  variables: {},
  ...extra,
});

describe('sentHistoryTexts', () => {
  it('leaves a turn with no prompt script and no macro exactly as stored', () => {
    const history: HistoryMessage[] = [
      { role: 'assistant', content: '서가 사이로 걸어간다.\n\n```status\n위치: 도서관\n```' },
      { role: 'user', content: '@리안: 안녕\n@내레이터: 바람이 분다.' },
      { role: 'assistant', content: '@: 촛불이 흔들린다. {{img::smile}}' },
      { role: 'user', content: '  공백도 그대로  ' },
    ];
    expect(sentHistoryTexts(input(history))).toEqual(history.map((turn) => turn.content));
  });

  it('sends what the prompt scripts left of a turn, its macros read as the prompt reads them', () => {
    const history: HistoryMessage[] = [
      { role: 'assistant', content: '{{#when::route::vis::2}}둘째 길{{/when}}{{#when::route::vis::3}}셋째 길{{/when}}' },
      { role: 'user', content: '{{user}}가 {{char}}에 들어선다. {{getvar::mood}}' },
      { role: 'assistant', content: '원문', promptContent: '스크립트가 바꾼 글' },
    ];
    expect(sentHistoryTexts(input(history, { variables: { route: '3', mood: '설렘' } }))).toEqual([
      '셋째 길',
      // RisuAI's {{char}}: the work's one member.
      '유저가 리안에 들어선다. 설렘',
      '스크립트가 바꾼 글',
    ]);
  });

  it('reads each turn’s own index where it stands on the branch, as a status-window script asks', () => {
    // RisuAI's Parma Knights card keeps its panel in the prompt only near the end of the chat.
    const keepNearEnd = '{{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-2}}}}}}<panel>HP 10</panel>{{/if}}';
    const turns: HistoryMessage[] = Array.from({ length: 4 }, (_, at) => ({
      role: at % 2 === 0 ? 'assistant' : 'user',
      content: `장면 ${at}<panel>HP 10</panel>`,
      promptContent: `장면 ${at}${keepNearEnd}`,
    }));
    // The newest four of a branch of ten, the greeting first.
    const texts = sentHistoryTexts(input(turns, { branch: { length: 10, greeting: { text: '인사', index: -1 } } }));
    // Indices 5–8 after the greeting; the last message is 8, so 6 on keep the panel.
    expect(texts).toEqual(['장면 0', '장면 1<panel>HP 10</panel>', '장면 2<panel>HP 10</panel>', '장면 3<panel>HP 10</panel>']);
    // An early stretch read alone keeps its place: the turns after it are only counted.
    expect(sentHistoryTexts(input(turns, { branch: { length: 10, greeting: { text: '인사', index: -1 } }, upTo: 2 }))).toEqual(texts.slice(0, 2));
  });
});
