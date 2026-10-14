/**
 * The request the editors read and what comes back of it (`withEditedRequest`
 * in `requestTriggers.ts`), with no database and no scripts: RisuAI's shape
 * out, our provider's back, and the pictures by their data — or, past the
 * budget, by the stand-ins that name them. The generation side is in
 * `api.test.ts` (`editRequest listeners`).
 */
import { assemblePrompt, DEFAULT_LORE_SETTINGS, type AssembledPrompt, type PromptCharacter, type RisuRequestItem } from '@shizue/core';
import { describe, expect, it } from 'vitest';
import { REQUEST_IMAGE_BUDGET, withEditedRequest, type EditedTurn } from '../src/requestTriggers.js';

const aria: PromptCharacter = {
  name: '아리아',
  card: {
    spec: 'v3',
    name: '아리아',
    description: '마녀.',
    personality: '',
    scenario: '',
    firstMes: '',
    alternateGreetings: [],
    mesExample: '<START>\n{{user}}: 예시 질문\n{{char}}: 예시 답변',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    tags: [],
    creator: '',
    characterVersion: '',
    lorebook: [],
    loreSettings: { ...DEFAULT_LORE_SETTINGS },
    extensions: {},
    raw: null,
  },
};
const gif = 'data:image/gif;base64,R0lGODlhAQ==';
const png = 'data:image/png;base64,iVBORw0K';

/** A chat of a greeting and one turn of the reader's carrying `images`, with the memory's summary. */
const promptWith = (images: string[], report = false): AssembledPrompt =>
  assemblePrompt({
    plot: { name: '골짜기', description: '여관.', lorebook: [] },
    characters: [aria],
    history: [
      { role: 'assistant', content: '어서 와.', id: 'greeting' },
      { role: 'user', content: '이거 봐', id: 'm-1', images },
    ],
    userName: '민준',
    memoryText: '[지난 이야기 요약]\n둘은 만났다.',
    branch: { length: 2, greeting: { text: '어서 와.', index: -1 } },
    report,
  });

/** Runs `withEditedRequest` with an editor that does `edit` to the items it is handed, which it keeps. */
async function edited(
  prompt: AssembledPrompt,
  // Whatever JSON an editor leaves; the run checks it (`turnsOf`) before this does.
  edit: (items: RisuRequestItem[]) => object[] | null,
  imageBudget = REQUEST_IMAGE_BUDGET,
): Promise<{ sent: AssembledPrompt; seen: RisuRequestItem[] }> {
  let seen: RisuRequestItem[] = [];
  const sent = await withEditedRequest(
    prompt,
    async (items) => {
      seen = structuredClone(items);
      return edit(structuredClone(items)) as EditedTurn[] | null;
    },
    'test',
    { imageBudget },
  );
  return { sent, seen };
}

describe('the request the editors read, and what goes back', () => {
  it('sends the prompt as it was put together when nothing changed, and RisuAI’s shape when something did', async () => {
    const prompt = promptWith([]);
    // Handed back the same, field by field or as a copy: the prompt itself.
    expect((await edited(prompt, () => null)).sent).toBe(prompt);
    expect((await edited(prompt, (items) => structuredClone(items))).sent).toBe(prompt);

    // One word changed: every turn of the view goes, the separators among them, and no `name`.
    const { sent, seen } = await edited(prompt, (items) =>
      items.map((item) => (item.role === 'user' && item.memo === 'm-1' ? { ...item, content: '이것 좀 봐' } : item)),
    );
    expect(seen.map(({ role, memo, name }) => [role, memo ?? null, name ?? null])).toEqual([
      ['system', null, null],
      ['system', 'supaMemory', null],
      ['system', 'NewChatExample', null],
      ['user', null, 'example_user'],
      ['assistant', null, 'example_assistant'],
      ['system', 'NewChat', null],
      ['assistant', null, null],
      ['user', 'm-1', null],
      ['system', null, null],
    ]);
    expect(sent.system).toBe(seen[0]!.content);
    expect(sent.system).not.toContain('둘은 만났다.');
    expect(sent.messages).toEqual([
      { role: 'system', content: '[지난 이야기 요약]\n둘은 만났다.' },
      { role: 'system', content: '[Start a new chat]' },
      { role: 'user', content: '예시 질문' },
      { role: 'assistant', content: '예시 답변' },
      { role: 'system', content: '[Start a new chat]' },
      { role: 'assistant', content: '어서 와.' },
      { role: 'user', content: '이것 좀 봐' },
      seen.at(-1),
    ]);
    expect(sent.sources).toBeUndefined();
    expect(sent.risu).toBeUndefined();
  });

  it('hands the pictures over as their data, and places each by it on the reader’s turn that still holds it', async () => {
    const prompt = promptWith([gif, png, gif]);
    const user = (items: RisuRequestItem[]): RisuRequestItem => items.find((item) => item.memo === 'm-1')!;
    const { seen } = await edited(prompt, () => null);
    expect(user(seen).multimodals).toEqual([gif, png, gif].map((base64) => ({ type: 'image', base64 })));

    // The text changed, the pictures stayed: all three, twice the same one included.
    const kept = await edited(prompt, (items) => items.map((item) => (item.memo === 'm-1' ? { ...item, content: '바뀜' } : item)));
    expect(kept.sent.messages.find((message) => message.role === 'user' && typeof message.content !== 'string')!.content).toEqual([
      { type: 'text', text: '바뀜' },
      { type: 'image', url: gif },
      { type: 'image', url: png },
      { type: 'image', url: gif },
    ]);

    // One copy dropped, the other two moved to a new turn of the reader's; the old turn holds none.
    const moved = await edited(prompt, (items) => {
      const turn = user(items);
      const pictures = turn.multimodals!.slice(1);
      delete turn.multimodals;
      return [...items, { role: 'user', content: '새 턴', multimodals: pictures }];
    });
    expect(moved.sent.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '새 턴' }, { type: 'image', url: png }, { type: 'image', url: gif }],
    });
    expect(moved.sent.messages.filter((message) => typeof message.content !== 'string')).toHaveLength(1);

    // Moved onto an assistant turn, or data we never handed out: nothing is sent.
    const strays = await edited(prompt, (items) =>
      items.map((item) => {
        if (item.memo === 'm-1') return { ...item, multimodals: [{ type: 'image', base64: 'data:image/png;base64,QUFB' }] };
        if (item.role === 'assistant' && !item.name) return { ...item, multimodals: user(items).multimodals };
        return item;
      }),
    );
    expect(strays.sent.messages.some((message) => typeof message.content !== 'string')).toBe(false);
  });

  it('names the pictures instead, for that request alone, when their data is past the budget', async () => {
    const prompt = promptWith([gif, png]);
    const size = gif.length + png.length;
    const user = (items: RisuRequestItem[]): RisuRequestItem => items.find((item) => item.memo === 'm-1')!;
    expect(user((await edited(prompt, () => null, size)).seen).multimodals).toEqual([
      { type: 'image', base64: gif },
      { type: 'image', base64: png },
    ]);
    const { seen, sent } = await edited(
      prompt,
      (items) => {
        // Dropped by its name, the other moved to a turn of its own.
        const turn = user(items);
        const [, second] = turn.multimodals!;
        delete turn.multimodals;
        return [...items, { role: 'user', content: '둘째만', multimodals: [second!] }];
      },
      size - 1,
    );
    expect(user(seen).multimodals).toEqual([
      { type: 'image', base64: 'image:0' },
      { type: 'image', base64: 'image:1' },
    ]);
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: '둘째만' }, { type: 'image', url: png }] });
  });

  it('reports the edited request by what each turn stands for', async () => {
    const prompt = promptWith([], true);
    const { sent } = await edited(prompt, (items) => items.map((item) => (item.memo === 'm-1' ? { ...item, content: '바뀜' } : item)));
    expect(sent.report!.blocks.map((block) => [block.kind, block.label ?? null, block.text])).toEqual([
      ...prompt.report!.blocks
        .slice(0, prompt.report!.blocks.length - prompt.messages.length)
        .filter((block) => block.kind !== 'memory')
        .map((block) => [block.kind, block.label ?? null, block.text]),
      ['memory', null, '[지난 이야기 요약]\n둘은 만났다.'],
      ['examples', '아리아', '[Start a new chat]'],
      ['examples', '아리아', '예시 질문'],
      ['examples', '아리아', '예시 답변'],
      ['request', 'system', '[Start a new chat]'],
      ['history', 'assistant', '어서 와.'],
      ['request', 'user', '바뀜'],
      ['post_history', null, sent.messages.at(-1)!.content],
    ]);
    expect(sent.report!.totals).toEqual(prompt.report!.totals);
  });
});
