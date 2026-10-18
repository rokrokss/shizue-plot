/**
 * RisuAI chat files as RisuAI main (e773240) writes them: `exportChat`'s JSON
 * (`risuChat` v2), `exportAllChats`' (`risuAllChats` v2), the two older shapes
 * `importChat` still reads, and `exportChat`'s HTML page — each built the way
 * `src/ts/characters.ts` builds it, around chats shaped as RisuAI keeps them
 * (`Chat`, `Message`, `loreBook` in `src/ts/storage/database.svelte.ts`).
 */

const CHA_ID = '6d3a3f0e-6a4b-4f31-9a55-4c3c7f2f9b10';

/** One chat as a RisuAI character keeps it, a few turns in. */
export const risuChat = {
  message: [
    { role: 'user', data: '안녕, {{char}}.', chatId: 'm-1', time: 1_760_000_000_000 },
    {
      role: 'char',
      data: '어서 와, {{user}}. 오늘은 비가 오네.',
      chatId: 'm-2',
      time: 1_760_000_060_000,
      saying: CHA_ID,
      generationInfo: { model: 'gemini-2.5-pro', inputTokens: 1200, outputTokens: 80 },
    },
    { role: 'user', data: '(OOC: 짧게 써 줘)', chatId: 'm-3', time: 1_760_000_120_000, disabled: true },
    { role: 'char', data: '알았어.', chatId: 'm-4', time: 1_760_000_180_000, saying: CHA_ID, isComment: false },
    { role: 'user', data: '', chatId: 'm-5', time: 1_760_000_200_000 },
    { role: 'user', data: '우산 있어?', chatId: 'm-6', time: 1_760_000_240_000 },
  ],
  note: '비 오는 오후의 분위기를 유지할 것.',
  name: '비 오는 날',
  localLore: [
    {
      key: '우산, umbrella',
      secondkey: '',
      insertorder: 100,
      comment: '우산',
      content: '{{char}}의 우산은 파란색이다.',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
      extentions: { risu_case_sensitive: false },
      useRegex: false,
    },
  ],
  fmIndex: 0,
  id: 'c-original',
  scriptstate: { $affection: 12, $met: true, $place: '카페', luaState: 'x' },
  lastDate: 1_760_000_240_000,
  bookmarks: ['m-2'],
  bookmarkNames: { 'm-2': '첫 인사' },
  folderId: 'f-1',
  hypaV3Data: { summaries: [] },
  modules: ['module-1'],
};

/** A chat RisuAI made a new one of, with nothing in it yet. */
export const emptyRisuChat = { message: [], note: '', name: 'Chat 2', localLore: [], fmIndex: -1, id: 'c-empty' };

/** `exportChat` mode 0. */
export const risuChatV2 = { type: 'risuChat', ver: 2, data: risuChat, folders: [{ id: 'f-1', name: '폴더', folded: false }] };

/** `exportAllChats`. */
export const risuAllChatsV2 = { type: 'risuAllChats', ver: 2, data: [risuChat, emptyRisuChat], folders: [] };

/** The shapes `importChat` still reads. */
export const risuAllChatsV1 = { type: 'risuAllChats', ver: 1, data: [risuChat] };
export const risuChatV1 = { type: 'risuChat', ver: 1, data: risuChat };

/** `exportChat` mode 2: the page, its `.idat` the chat with `<` and `>` escaped as RisuAI escapes them. */
export function risuChatHtmlPage(chat: Record<string, unknown> = risuChat): string {
  return `
                <!DOCTYPE html>
                <html>
                    <head>
                        <title>세라 Chat</title>
                    </head>
                    <body>
                        <div class="container">
                            <div class="chat">
                                <h2>세라</h2>
                                <div><p>비가 온다.</p></div>
                            </div>
                        </div>
                        <div class="idat">${JSON.stringify(chat).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                    </body>
            `;
}
