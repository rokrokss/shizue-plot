import { describe, expect, it } from 'vitest';
import {
  convertRisuChat,
  readRisuChatFile,
  risuAllChatsFile,
  risuChatFile,
  risuChatHtml,
  risuChatOf,
  risuChatText,
  risuExportFileName,
  MAX_RISU_CHATS_PER_FILE,
} from '../src/risuChat.js';
import type { LoreEntry } from '../src/types.js';
import { emptyRisuChat, risuAllChatsV1, risuAllChatsV2, risuChat, risuChatV1, risuChatV2 } from './fixtures/risuChats.js';

const solo = { members: [{ id: 'member-1', name: '세라' }] };

describe('reading a RisuAI chat file', () => {
  it('takes each shape importChat takes', () => {
    expect(readRisuChatFile(risuChatV2)).toEqual([risuChat]);
    expect(readRisuChatFile(risuAllChatsV2)).toEqual([risuChat, emptyRisuChat]);
    expect(readRisuChatFile(risuAllChatsV1)).toEqual([risuChat]);
    expect(readRisuChatFile(risuChatV1)).toEqual([risuChat]);
    // v2 takes `data` whole, one chat or several, whatever `type` says.
    expect(readRisuChatFile({ type: 'risuChat', ver: 2, data: [risuChat] })).toEqual([risuChat]);
  });

  it('refuses what RisuAI says holds nothing', () => {
    expect(readRisuChatFile({ type: 'risuAllChats', ver: 1, data: [] })).toBeNull();
    // v1 needs the four fields; an empty note is still a note.
    const { localLore: _localLore, ...noLore } = risuChat;
    expect(readRisuChatFile({ type: 'risuChat', ver: 1, data: noLore })).toBeNull();
    expect(readRisuChatFile({ type: 'risuChat', ver: 1, data: { ...risuChat, note: '' } })).toEqual([{ ...risuChat, note: '' }]);
    expect(readRisuChatFile({ type: 'risuChat', ver: 3, data: risuChat })).toBeNull();
    expect(readRisuChatFile({ spec: 'chara_card_v3', data: {} })).toBeNull();
    expect(readRisuChatFile([risuChat])).toBeNull();
    expect(readRisuChatFile('risuChat')).toBeNull();
    // A chat without its message list is passed over; one left is still read.
    expect(readRisuChatFile({ type: 'risuAllChats', ver: 2, data: [{ name: 'x' }, risuChat] })).toEqual([risuChat]);
    expect(readRisuChatFile({ type: 'risuAllChats', ver: 2, data: [{ name: 'x' }] })).toBeNull();
  });

  it('reads at most so many chats from one file', () => {
    const many = Array.from({ length: MAX_RISU_CHATS_PER_FILE + 3 }, () => emptyRisuChat);
    expect(readRisuChatFile({ type: 'risuAllChats', ver: 2, data: many })).toHaveLength(MAX_RISU_CHATS_PER_FILE);
  });
});

describe('converting a RisuAI chat', () => {
  it('keeps the messages as RisuAI stored them, and what the chat keeps as a whole', () => {
    const converted = convertRisuChat(risuChat, solo);
    expect(converted.name).toBe('비 오는 날');
    // fmIndex 0 is the first alternate greeting: the work's second opening.
    expect(converted.openingIndex).toBe(1);
    expect(converted.messages).toEqual([
      { role: 'user', versions: ['안녕, {{char}}.'], selected: 0, createdAt: new Date(1_760_000_000_000).toISOString() },
      {
        role: 'assistant',
        versions: ['어서 와, {{user}}. 오늘은 비가 오네.'],
        selected: 0,
        createdAt: new Date(1_760_000_060_000).toISOString(),
      },
      // Left out of the prompt in RisuAI: hidden from the AI here.
      { role: 'user', versions: ['(OOC: 짧게 써 줘)'], selected: 0, createdAt: new Date(1_760_000_120_000).toISOString(), hidden: true },
      { role: 'assistant', versions: ['알았어.'], selected: 0, createdAt: new Date(1_760_000_180_000).toISOString() },
      { role: 'user', versions: ['우산 있어?'], selected: 0, createdAt: new Date(1_760_000_240_000).toISOString() },
    ]);
    expect(converted.note).toBe('비 오는 오후의 분위기를 유지할 것.');
    // `$` names a chat variable, read back with toString(); the rest is not one.
    expect({ ...converted.variables }).toEqual({ affection: '12', met: 'true', place: '카페' });
    expect(converted.localLore).toHaveLength(1);
    expect(converted.localLore[0]).toMatchObject({
      name: '우산',
      keys: ['우산', 'umbrella'],
      content: '{{char}}의 우산은 파란색이다.',
      constant: false,
      insertionOrder: 100,
    });
    expect(converted.skipped).toEqual({ empty: 1, malformed: 0, unknownSpeaker: 0, variables: 0, bookmarks: 1, overLimit: 0 });
  });

  it("hides a message RisuAI left out with everything above it ('allBefore')", () => {
    const chat = {
      ...risuChat,
      message: [
        { role: 'char', data: 'a' },
        { role: 'user', data: 'b', disabled: 'allBefore' },
        { role: 'char', data: 'c' },
        { role: 'user', data: 'd', disabled: true },
        { role: 'char', data: 'e' },
      ],
    };
    expect(convertRisuChat(chat, solo).messages.map((message) => [message.versions[0], message.hidden ?? false])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
      ['d', true],
      ['e', false],
    ]);
  });

  it('tags a reply in a work of several by the member its saying or its name names, and counts the rest', () => {
    const cast = { members: [{ id: 'a', name: '세라' }, { id: 'b', name: '리안' }] };
    const chat = {
      ...risuChat,
      message: [
        { role: 'char', data: '1', saying: 'b' },
        { role: 'char', data: '2', saying: 'unknown-cha-id', name: '세라' },
        { role: 'char', data: '3', saying: 'unknown-cha-id' },
        { role: 'user', data: '4', saying: 'a' },
      ],
    };
    const converted = convertRisuChat(chat, cast);
    expect(converted.messages.map((message) => message.speakerId)).toEqual(['b', 'a', undefined, undefined]);
    expect(converted.skipped.unknownSpeaker).toBe(1);
    // A work of one member has no one to tag.
    expect(convertRisuChat(chat, solo).messages.every((message) => message.speakerId === undefined)).toBe(true);
  });

  it('passes over what is not a RisuAI message, and reads an fmIndex it cannot as the first greeting', () => {
    const converted = convertRisuChat(
      { message: [{ role: 'system', data: 'x' }, { role: 'user', data: 42 }, 'text', { role: 'user', data: 'ok\r\nyes\u0000' }], fmIndex: 'two' },
      solo,
    );
    expect(converted.messages).toEqual([{ role: 'user', versions: ['ok\nyes'], selected: 0 }]);
    expect(converted.skipped.malformed).toBe(3);
    expect(converted.openingIndex).toBe(0);
    expect(converted.name).toBe('');
    expect(converted.variables).toBeNull();
    expect(converted.localLore).toEqual([]);
  });

  it('leaves out a variable a stored delta cannot hold', () => {
    const converted = convertRisuChat({ message: [], scriptstate: { $ok: 'yes', ['$' + 'x'.repeat(300)]: '1', $obj: { a: 1 } } }, solo);
    expect({ ...converted.variables }).toEqual({ ok: 'yes' });
    expect(converted.skipped.variables).toBe(2);
  });
});

describe('writing a RisuAI chat', () => {
  const lore: LoreEntry = {
    name: '우산',
    keys: ['우산'],
    secondaryKeys: [],
    selective: false,
    content: '파란 우산.',
    enabled: true,
    constant: false,
    insertionOrder: 100,
    caseSensitive: false,
    useRegex: false,
    position: 'before_char',
  };
  const written = risuChatOf({
    id: 'chat-1',
    name: '비 오는 날',
    note: '노트',
    fmIndex: 0,
    messages: [
      { id: 'm1', role: 'user', content: '안녕', createdAt: new Date(1000) },
      { id: 'm2', role: 'assistant', content: '세라: 응.\n*웃는다*', createdAt: new Date(2000), hidden: true },
      { id: 'm3', role: 'assistant', content: '반가워 <b>&</b>', createdAt: new Date(3000), speaker: { id: 'member-2', name: '리안' } },
    ],
    localLore: [lore],
    variables: { affection: '12' },
    lastDate: new Date(4000),
  });

  it("writes RisuAI's Chat, which RisuAI's import and this one read back", () => {
    expect(written).toEqual({
      message: [
        { role: 'user', data: '안녕', chatId: 'm1', time: 1000 },
        { role: 'char', data: '세라: 응.\n*웃는다*', chatId: 'm2', time: 2000, disabled: true },
        { role: 'char', data: '반가워 <b>&</b>', chatId: 'm3', time: 3000, saying: 'member-2', name: '리안' },
      ],
      note: '노트',
      name: '비 오는 날',
      localLore: [
        {
          key: '우산',
          secondkey: '',
          insertorder: 100,
          comment: '우산',
          content: '파란 우산.',
          mode: 'normal',
          alwaysActive: false,
          selective: false,
          useRegex: false,
          extentions: { risu_case_sensitive: false },
        },
      ],
      fmIndex: 0,
      id: 'chat-1',
      scriptstate: { $affection: '12' },
      lastDate: 4000,
    });
    expect(risuChatFile(written)).toEqual({ type: 'risuChat', ver: 2, data: written, folders: [] });
    expect(risuAllChatsFile([written])).toEqual({ type: 'risuAllChats', ver: 2, data: [written], folders: [] });
    // RisuAI's v1 check passes on what this writes, and the round trip gives the conversation back.
    expect(readRisuChatFile({ type: 'risuChat', ver: 1, data: written })).toEqual([written]);
    const back = convertRisuChat(readRisuChatFile(risuChatFile(written))![0]!, {
      members: [{ id: 'other-1', name: '세라' }, { id: 'other-2', name: '리안' }],
    });
    expect(back.messages.map((message) => [message.role, message.versions[0], message.hidden ?? false, message.speakerId])).toEqual([
      ['user', '안녕', false, undefined],
      ['assistant', '세라: 응.\n*웃는다*', true, undefined],
      ['assistant', '반가워 <b>&</b>', false, 'other-2'],
    ]);
    expect(back.openingIndex).toBe(1);
    expect(back.note).toBe('노트');
    expect({ ...back.variables }).toEqual({ affection: '12' });
    expect(back.localLore[0]).toMatchObject({ name: '우산', keys: ['우산'], content: '파란 우산.', insertionOrder: 100 });
  });

  it("writes RisuAI's text, the greeting first for a character", () => {
    const names = { char: '세라', user: '민수', greeting: '어서 와.', group: false };
    expect(risuChatText(written, names)).toBe(
      '--세라\n어서 와.\n\n--민수\n안녕\n\n--세라\n세라: 응.\n*웃는다*\n\n--리안\n반가워 <b>&</b>',
    );
    // A group writes no greeting; a chat on no opening writes none either.
    expect(risuChatText(written, { ...names, group: true }).startsWith('--민수\n안녕')).toBe(true);
    const { greeting: _greeting, ...none } = names;
    expect(risuChatText(written, none).startsWith('--민수\n안녕')).toBe(true);
  });

  it("writes RisuAI's page, the text escaped and the chat in .idat", () => {
    const page = risuChatHtml(written, { char: '세라', user: '민수', greeting: '<script>alert(1)</script>', group: false });
    expect(page).not.toContain('<script>');
    expect(page).toContain('<h2>세라</h2>\n<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>');
    expect(page).toContain('<div>세라: 응.<br>*웃는다*</div>');
    expect(page).toContain('<h2>리안</h2>\n<div>반가워 &lt;b&gt;&amp;&lt;/b&gt;</div>');
    const idat = /<div class="idat">([^<]*)<\/div>/.exec(page)![1]!;
    const decoded = idat.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    expect(JSON.parse(decoded)).toEqual(written);
  });

  it('names a file as RisuAI does', () => {
    expect(risuExportFileName('세라_2026-10-19T12:34:56.789Z_chat', 'json')).toBe('세라_2026-10-19T123456789Z_chat.json');
    expect(risuExportFileName('a/b:c, d.e', 'txt')).toBe('abc de.txt');
  });
});
