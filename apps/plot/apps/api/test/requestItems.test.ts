/**
 * The request the editors read and what comes back of it (`withEditedRequest`
 * in `requestTriggers.ts`), with no database and no scripts: RisuAI's shape
 * out, our provider's back, and the pictures by their data — or, past the
 * budget, by the stand-ins that name them. The generation side is in
 * `api.test.ts` (`editRequest listeners`).
 */
import {
  assemblePrompt,
  countTokens,
  DEFAULT_LORE_SETTINGS,
  IMAGE_TOKEN_ESTIMATE,
  type AssembledPrompt,
  type LoreEntry,
  type PromptCharacter,
  type RisuRequestItem,
} from '@shizue/core';
import { describe, expect, it } from 'vitest';
import {
  refitRequest,
  REQUEST_IMAGE_BUDGET,
  RequestTooLongError,
  withEditedRequest,
  type EditedTurn,
} from '../src/requestTriggers.js';

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
/** A lore entry its keyword brings in, at the system string's default place. */
const keyed: LoreEntry = {
  keys: ['등대'],
  secondaryKeys: [],
  selective: false,
  content: '',
  enabled: true,
  constant: false,
  insertionOrder: 0,
  caseSensitive: false,
  useRegex: false,
  position: 'before_char',
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
    memoryText: '[Summary of the story so far]\n둘은 만났다.',
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
      { role: 'system', content: '[Summary of the story so far]\n둘은 만났다.' },
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

  it('sends a picture an editor moved onto a system turn beside its text, as RisuAI’s Responses request does', async () => {
    const prompt = promptWith([gif, png]);
    const user = (items: RisuRequestItem[]): RisuRequestItem => items.find((item) => item.memo === 'm-1')!;

    // Onto the memory's turn: a system message with its pictures, the system string as it was.
    const memory = await edited(prompt, (items) => {
      const pictures = user(items).multimodals;
      delete user(items).multimodals;
      return items.map((item) => (item.memo === 'supaMemory' ? { ...item, multimodals: pictures } : item));
    });
    expect(memory.sent.system).toBe(memory.seen[0]!.content);
    expect(memory.sent.messages[0]).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: '[Summary of the story so far]\n둘은 만났다.' },
        { type: 'image', url: gif },
        { type: 'image', url: png },
      ],
    });

    // Onto the first turn: it is no longer the provider's instructions, which are text, but the first message.
    const lead = await edited(prompt, (items) => {
      const pictures = user(items).multimodals;
      delete user(items).multimodals;
      return items.map((item, at) => (at === 0 ? { ...item, multimodals: pictures } : item));
    });
    expect(lead.sent.system).toBe('');
    expect(lead.sent.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: lead.seen[0]!.content }, { type: 'image', url: gif }, { type: 'image', url: png }],
    });
    expect(lead.sent.messages).toHaveLength(lead.seen.length);
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

  it('hands the editors the keyword lore as a system item of its own, right after the reader’s turn', async () => {
    const lore = { ...aria, card: { ...aria.card, lorebook: [{ ...keyed, content: '등대는 북쪽 끝에 있다.' }] } };
    const prompt = assemblePrompt({
      plot: { name: '골짜기', description: '여관.', lorebook: [] },
      characters: [lore],
      history: [
        { role: 'assistant', content: '어서 와.', id: 'greeting' },
        { role: 'user', content: '등대로 가자', id: 'm-1' },
      ],
      userName: '민준',
      branch: { length: 2, greeting: { text: '어서 와.', index: -1 } },
    });
    const { seen, sent } = await edited(prompt, (items) =>
      items.map((item, at) =>
        item.content === '등대는 북쪽 끝에 있다.' ? { ...item, content: `${item.content} (앞: ${items[at - 1]!.memo})` } : item,
      ),
    );
    const at = seen.findIndex((item) => item.content === '등대는 북쪽 끝에 있다.');
    // Not in the system string: a turn as RisuAI's own system turns are, no memo, never removable.
    expect(seen[0]!.content).not.toContain('등대는');
    expect(seen[at]).toEqual({ role: 'system', content: '등대는 북쪽 끝에 있다.' });
    expect(seen[at - 1]).toMatchObject({ role: 'user', memo: 'm-1' });
    expect(seen[at + 1]!.role).toBe('system');
    // What the editor made of it goes out in its place.
    expect(sent.messages[sent.messages.findIndex((message) => message.content === '등대로 가자') + 1]).toEqual({
      role: 'system',
      content: '등대는 북쪽 끝에 있다. (앞: m-1)',
    });
  });

  it('reports the edited request by what each turn stands for', async () => {
    const prompt = promptWith([], true);
    const { sent } = await edited(prompt, (items) => items.map((item) => (item.memo === 'm-1' ? { ...item, content: '바뀜' } : item)));
    expect(sent.report!.blocks.map((block) => [block.kind, block.label ?? null, block.text])).toEqual([
      ...prompt.report!.blocks
        .slice(0, prompt.report!.blocks.length - prompt.messages.length)
        .filter((block) => block.kind !== 'memory')
        .map((block) => [block.kind, block.label ?? null, block.text]),
      ['memory', null, '[Summary of the story so far]\n둘은 만났다.'],
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

describe('fitting the edited request to the context again (RisuAI’s token recheck)', () => {
  const turn = (role: 'system' | 'user' | 'assistant', content: string, extra: Record<string, unknown> = {}): EditedTurn =>
    ({ role, content, ...extra }) as EditedTurn;
  const tokens = (turns: readonly EditedTurn[]): number => turns.reduce((sum, item) => sum + countTokens(item.content), 0);

  it('leaves a request that fits as it is', () => {
    const turns = [turn('system', '규칙'), turn('user', '안녕', { removable: true }), turn('user', '지금')];
    expect(refitRequest(turns, tokens(turns))).toEqual(turns);
  });

  it('blanks the removable turns from the front until it fits, and drops them unless a picture is on them', () => {
    const big = 'word '.repeat(400);
    const turns = [
      turn('system', '규칙'),
      turn('system', '[Start a new chat]', { memo: 'NewChat', removable: true }),
      turn('assistant', '어서 와.', { removable: true }),
      turn('user', '이거 봐', { memo: 'm-1', removable: true, multimodals: [{ type: 'image', base64: gif }] }),
      turn('assistant', big, { memo: 'm-2', removable: true }),
      turn('user', '늦은 턴', { memo: 'm-3', removable: true }),
      turn('system', '', {}),
      turn('user', '지금'),
    ];
    // The picture's estimate and the long turn have to go: what `tokens` counts, the long turn's text
    // taken off it, and one over — the picture's estimate is on top of that.
    expect(IMAGE_TOKEN_ESTIMATE).toBeGreaterThan(0);
    const limit = tokens(turns) - countTokens(big) + 1;
    const fitted = refitRequest(turns, limit);
    // Everything removable up to and including the long turn went; the picture's turn stays, empty; the
    // empty system turn the editor left goes with the blanked ones; the turns after it stay.
    expect(fitted.map((item) => [item.role, item.content, (item as { memo?: string }).memo ?? null])).toEqual([
      ['system', '규칙', null],
      ['user', '', 'm-1'],
      ['user', '늦은 턴', 'm-3'],
      ['user', '지금', null],
    ]);
    expect((fitted[1] as { multimodals?: unknown }).multimodals).toEqual([{ type: 'image', base64: gif }]);
    // The input is left as it was.
    expect(turns[4]!.content).toBe(big);
  });

  it('refuses to send what still does not fit once nothing removable is left', () => {
    const turns = [turn('system', 'word '.repeat(200)), turn('user', '안녕', { removable: true }), turn('user', '지금')];
    expect(() => refitRequest(turns, 50)).toThrow(RequestTooLongError);
    try {
      refitRequest(turns, 50);
    } catch (error) {
      expect((error as RequestTooLongError).code).toBe('prompt_too_long');
      expect((error as RequestTooLongError).limit).toBe(50);
    }
  });
});
