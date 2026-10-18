// @vitest-environment jsdom
/**
 * A chat file read from a work's chat list (`lib/chatFiles.ts`): every shape
 * RisuAI's chat import reads — its JSON in four kinds and its HTML page — and a
 * SillyTavern `.jsonl`, each as those apps write them, and what is sent for them
 * through the chat import.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyRisuChat,
  risuAllChatsV1,
  risuAllChatsV2,
  risuChat,
  risuChatHtmlPage,
  risuChatV1,
  risuChatV2,
} from '../../../packages/core/test/fixtures/risuChats';
import { ChatFileError, importChatFile, prepareChatFile } from '../src/lib/chatFiles';

const cast = { members: [{ id: 'member-1', name: '세라' }] };

/** What the fixture's chat converts to, as every RisuAI shape should give it. */
const expectRisuChat = (chat: Awaited<ReturnType<typeof prepareChatFile>>[number]) => {
  expect(chat.title).toBe('비 오는 날');
  expect(chat.openingIndex).toBe(1);
  expect(chat.messages.map((message) => [message.role, message.versions[0], message.hidden ?? false])).toEqual([
    ['user', '안녕, {{char}}.', false],
    ['assistant', '어서 와, {{user}}. 오늘은 비가 오네.', false],
    ['user', '(OOC: 짧게 써 줘)', true],
    ['assistant', '알았어.', false],
    ['user', '우산 있어?', false],
  ]);
  expect(chat.note).toBe('비 오는 오후의 분위기를 유지할 것.');
  expect({ ...chat.variables }).toEqual({ affection: '12', met: 'true', place: '카페' });
  expect(chat.localLore).toEqual([expect.objectContaining({ name: '우산' })]);
  expect(chat.dropped).toEqual({ bookmarks: 1, swipes: 0, unknownSpeaker: 0 });
  expect(chat.sha256).toMatch(/^[0-9a-f]{64}$/);
};

describe('reading a chat file', () => {
  it('reads each JSON shape RisuAI writes or still reads, leaving out a chat with nothing in it', async () => {
    for (const file of [risuChatV2, risuAllChatsV2, risuAllChatsV1, risuChatV1]) {
      const chats = await prepareChatFile('세라_chat.json', JSON.stringify(file), cast);
      expect(chats).toHaveLength(1);
      expectRisuChat(chats[0]!);
    }
  });

  it("reads RisuAI's HTML export from its .idat element", async () => {
    const chats = await prepareChatFile('세라_chat.html', risuChatHtmlPage(), cast);
    expect(chats).toHaveLength(1);
    expectRisuChat(chats[0]!);
  });

  it('reads a SillyTavern chat as the migration reads one', async () => {
    const jsonl = [
      JSON.stringify({ user_name: 'unused', character_name: 'unused', chat_metadata: { note_prompt: '비가 온다', variables: { hp: 3 } } }),
      JSON.stringify({ name: '세라', is_user: false, mes: '왔구나.', swipes: ['어서 와.', '왔구나.'], swipe_id: 1, send_date: '2024-07-12T01:31:37.123Z' }),
      JSON.stringify({ name: '민수', is_user: true, mes: '안녕' }),
    ].join('\n');
    const [chat] = await prepareChatFile('세라 - 2024-07-12.jsonl', jsonl, cast);
    expect(chat!.title).toBe('세라 - 2024-07-12');
    expect(chat!.openingIndex).toBeUndefined();
    expect(chat!.messages).toEqual([
      expect.objectContaining({ role: 'assistant', versions: ['세라: 어서 와.', '세라: 왔구나.'], selected: 1 }),
      expect.objectContaining({ role: 'user', versions: ['안녕'] }),
    ]);
    expect(chat!.note).toBe('비가 온다');
    expect({ ...chat!.variables }).toEqual({ hp: '3' });
  });

  it('refuses a file RisuAI would say holds nothing', async () => {
    await expect(prepareChatFile('card.json', JSON.stringify({ spec: 'chara_card_v3', data: {} }), cast)).rejects.toBeInstanceOf(ChatFileError);
    await expect(prepareChatFile('broken.json', '{"type":', cast)).rejects.toBeInstanceOf(ChatFileError);
    await expect(prepareChatFile('page.html', '<html><body>hi</body></html>', cast)).rejects.toBeInstanceOf(ChatFileError);
    await expect(
      prepareChatFile('empty.json', JSON.stringify({ type: 'risuAllChats', ver: 2, data: [emptyRisuChat], folders: [] }), cast),
    ).rejects.toBeInstanceOf(ChatFileError);
  });
});

describe('sending a chat file', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the chat on the work's opening, then completes it with what the chat keeps", async () => {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url === '/api/chats/import') return new Response(JSON.stringify({ chat: { id: 'chat-1' }, ids: [] }), { status: 201 });
      return new Response(JSON.stringify({ chat: { id: 'chat-1' }, memoryBackfill: 'not_needed' }), { status: 200 });
    });
    const chats = await prepareChatFile('세라_chat.json', JSON.stringify(risuChatV2), cast);
    const results = await importChatFile('plot-1', '세라_chat.json', chats);
    expect(results).toEqual([{ status: 'done', chatId: 'chat-1', title: '비 오는 날', dropped: chats[0]!.dropped }]);
    expect(calls.map((call) => call.url)).toEqual(['/api/chats/import', '/api/chats/chat-1/import/complete']);
    expect(calls[0]!.body).toMatchObject({ plotId: 'plot-1', fileName: '세라_chat.json', title: '비 오는 날', openingIndex: 1 });
    expect(calls[0]!.body.messages).toHaveLength(5);
    expect(calls[1]!.body).toMatchObject({
      backfillMemory: false,
      note: '비 오는 오후의 분위기를 유지할 것.',
      variables: { affection: '12', met: 'true', place: '카페' },
      localLore: [expect.objectContaining({ name: '우산' })],
    });
  });

  it('skips a chat brought in before, and stops where no model is set', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ code: 'already_imported', chatId: 'old', error: 'x' }), { status: 409 }),
    );
    const two = await prepareChatFile('all.json', JSON.stringify({ ...risuAllChatsV2, data: [risuChat, { ...risuChat, name: '둘째' }] }), cast);
    expect((await importChatFile('plot-1', 'all.json', two)).map((result) => result.status)).toEqual(['already_imported', 'already_imported']);

    let asked = 0;
    vi.stubGlobal('fetch', async () => {
      asked += 1;
      return new Response(JSON.stringify({ code: 'model_unavailable', error: 'no model' }), { status: 400 });
    });
    const results = await importChatFile('plot-1', 'all.json', two);
    expect(results).toEqual([expect.objectContaining({ status: 'failed', title: '비 오는 날' })]);
    expect(asked).toBe(1);
  });
});
