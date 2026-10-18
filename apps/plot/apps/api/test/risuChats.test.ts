/**
 * RisuAI's chat files through the API: a chat converted as the browser converts
 * it (`convertRisuChat`) and sent through the chat import onto the work's own
 * openings, and the chats written back out as RisuAI writes them — JSON, text,
 * HTML and every chat of a work — with the round trip into another work.
 *
 * Its own PGlite in memory, as every API suite's (`api.test.ts`).
 */
import { convertRisuChat, readRisuChatFile, type RisuCast } from '@shizue/core';
import { chats, messages, migrateDb, openDb, type Db, type OpenedDb } from '@shizue/db';
import { asc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { risuChat } from '../../../packages/core/test/fixtures/risuChats.js';
import { createApp } from '../src/app.js';
import type { AppDeps, AppEnv } from '../src/deps.js';
import { ensureOwner } from '../src/session.js';
import { createLocalStorage, type ObjectStorage } from '../src/storage.js';

let db: Db;
let client: OpenedDb['client'];
let close: () => Promise<void>;
let storage: ObjectStorage;
let app: Hono<AppEnv>;

beforeAll(async () => {
  ({ db, client, close } = await openDb());
  await migrateDb(db);
  storage = createLocalStorage(await mkdtemp(join(tmpdir(), 'shizue-risu-chats-')));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await client.exec(`TRUNCATE TABLE messages, chats, characters, plots, "user" RESTART IDENTITY CASCADE`);
  const deps: AppDeps = {
    db,
    storage,
    env: {},
    generating: new Set(),
    generationStreams: new Set(),
    refreshingMemory: new Set(),
    detectingEmotion: new Set(),
    embeddingVectors: new Map(),
    suggesting: new Set(),
  };
  app = createApp(deps);
  await ensureOwner(db);
});

const send = (path: string, method = 'GET', body?: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  );

async function ok(res: Response, status = 200): Promise<any> {
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json();
}

/** A work of one member, `세라`, on two openings — a first message and an alternate greeting. */
async function work(name = '비 오는 카페'): Promise<{ id: string; cast: RisuCast }> {
  const plot = await ok(await send('/api/plots', 'POST', { name, intros: ['어서 와, {{user}}.', '오늘은 비가 오네.'] }), 201);
  const member = await ok(await send(`/api/plots/${plot.id}/characters`, 'POST', { name: '세라' }), 201);
  return { id: plot.id, cast: { members: [{ id: member.id, name: '세라' }] } };
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A RisuAI chat brought into a work as the chat list's import brings it: created, then completed. */
async function importRisu(plotId: string, cast: RisuCast, chat: Record<string, unknown>, fileName = 'chat.json'): Promise<string> {
  const converted = convertRisuChat(chat, cast);
  const created = await ok(
    await send('/api/chats/import', 'POST', {
      plotId,
      fileName,
      sha256: sha(JSON.stringify(chat)),
      ...(converted.name ? { title: converted.name } : {}),
      openingIndex: converted.openingIndex,
      messages: converted.messages,
    }),
    201,
  );
  await ok(
    await send(`/api/chats/${created.chat.id}/import/complete`, 'POST', {
      backfillMemory: false,
      ...(converted.variables ? { variables: converted.variables } : {}),
      ...(converted.note ? { note: converted.note } : {}),
      localLore: converted.localLore,
    }),
  );
  return created.chat.id;
}

const branchOf = async (chatId: string) => (await ok(await send(`/api/chats/${chatId}`))).path as any[];

describe('a RisuAI chat brought into a work', () => {
  it("opens on the work's own greeting at fmIndex, keeps its messages, times and hidden ones, and what the chat keeps", async () => {
    const { id, cast } = await work();
    const chatId = await importRisu(id, cast, risuChat);
    const path = await branchOf(chatId);
    expect(path.map((message) => [message.role, message.content, message.hiddenFromPrompt ?? false])).toEqual([
      ['assistant', '오늘은 비가 오네.', false],
      ['user', '안녕, {{char}}.', false],
      ['assistant', '어서 와, {{user}}. 오늘은 비가 오네.', false],
      ['user', '(OOC: 짧게 써 줘)', true],
      ['assistant', '알았어.', false],
      ['user', '우산 있어?', false],
    ]);
    const rows = await db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.createdAt));
    // Both openings are roots, the swipe between them as on a chat started here.
    expect(rows.filter((row) => row.parentId === null).map((row) => row.content)).toEqual(['어서 와, 유저.', '오늘은 비가 오네.']);
    // The conversation keeps RisuAI's times; the openings come just before them.
    expect(rows.slice(2).map((row) => row.createdAt.getTime())).toEqual(
      risuChat.message.filter((message) => message.data).map((message) => message.time),
    );
    const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
    expect(chat).toMatchObject({ title: '비 오는 날', note: '비 오는 오후의 분위기를 유지할 것.', importing: false });
    expect(chat!.localLore).toEqual([expect.objectContaining({ name: '우산', keys: ['우산', 'umbrella'] })]);
    // The variables start every opening's branch, as a SillyTavern chat's do.
    for (const root of rows.filter((row) => row.parentId === null)) {
      expect(root.variableDelta).toEqual({ affection: '12', met: 'true', place: '카페' });
    }
  });

  it('opens on no greeting where the work has none at that index, and refuses an index that is not one', async () => {
    const { id, cast } = await work();
    const chatId = await importRisu(id, cast, { ...risuChat, fmIndex: 5 });
    expect((await branchOf(chatId))[0]).toMatchObject({ role: 'user', content: '안녕, {{char}}.' });
    const refused = await send('/api/chats/import', 'POST', {
      plotId: id, fileName: 'x.json', sha256: sha('x'), openingIndex: -1, messages: [],
    });
    expect(refused.status).toBe(400);
  });
});

describe("a work's chats written out as RisuAI writes them", () => {
  it('writes risuChat v2, which another work imports to the same messages', async () => {
    const first = await work();
    const chatId = await importRisu(first.id, first.cast, risuChat);
    const res = await send(`/api/chats/${chatId}/export/risu`);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename=".*_chat\.json"; filename\*=UTF-8''%EC%84%B8%EB%9D%BC_/);
    const file = await ok(res);
    expect(file).toMatchObject({ type: 'risuChat', ver: 2, folders: [] });
    expect(file.data).toMatchObject({
      name: '비 오는 날',
      note: '비 오는 오후의 분위기를 유지할 것.',
      fmIndex: 0,
      id: chatId,
      scriptstate: { $affection: '12', $met: 'true', $place: '카페' },
      localLore: [expect.objectContaining({ key: '우산, umbrella', comment: '우산', mode: 'normal' })],
    });
    expect(file.data.message.map((message: any) => [message.role, message.data, message.disabled ?? false])).toEqual([
      ['user', '안녕, {{char}}.', false],
      ['char', '어서 와, {{user}}. 오늘은 비가 오네.', false],
      ['user', '(OOC: 짧게 써 줘)', true],
      ['char', '알았어.', false],
      ['user', '우산 있어?', false],
    ]);

    const second = await work('같은 카드의 둘째 작품');
    const [read] = readRisuChatFile(file)!;
    const copyId = await importRisu(second.id, second.cast, read!, 'exported.json');
    const strip = (path: any[]) => path.map((message) => [message.role, message.content, message.hiddenFromPrompt ?? false]);
    expect(strip(await branchOf(copyId))).toEqual(strip(await branchOf(chatId)));
    const [copy] = await db.select().from(chats).where(eq(chats.id, copyId));
    expect(copy).toMatchObject({ title: '비 오는 날', note: '비 오는 오후의 분위기를 유지할 것.' });
    expect(copy!.localLore).toEqual([expect.objectContaining({ name: '우산', keys: ['우산', 'umbrella'] })]);
    const again = await ok(await send(`/api/chats/${copyId}/export/risu`));
    expect(again.data.scriptstate).toEqual(file.data.scriptstate);
    expect(again.data.message.map((message: any) => message.data)).toEqual(file.data.message.map((message: any) => message.data));
  });

  it('writes the text and the page, and every chat of the work', async () => {
    const { id, cast } = await work();
    const chatId = await importRisu(id, cast, risuChat);
    const text = await send(`/api/chats/${chatId}/export/risu?format=txt`);
    expect(text.headers.get('content-type')).toContain('text/plain');
    expect(await text.text()).toBe(
      ['--세라\n오늘은 비가 오네.', '--유저\n안녕, {{char}}.', '--세라\n어서 와, {{user}}. 오늘은 비가 오네.', '--유저\n(OOC: 짧게 써 줘)', '--세라\n알았어.', '--유저\n우산 있어?'].join('\n\n'),
    );
    const page = await send(`/api/chats/${chatId}/export/risu?format=html`);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-disposition')).toMatch(/_chat\.html"/);
    const html = await page.text();
    const idat = /<div class="idat">([^<]*)<\/div>/.exec(html)![1]!;
    const json = await ok(await send(`/api/chats/${chatId}/export/risu`));
    const decoded = idat.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    expect({ ...JSON.parse(decoded), lastDate: 0 }).toEqual({ ...json.data, lastDate: 0 });
    expect((await send(`/api/chats/${chatId}/export/risu?format=pdf`)).status).toBe(400);

    // A chat an import is still filling is not one of the work's yet.
    await ok(await send('/api/chats/import', 'POST', { plotId: id, fileName: 'half.json', sha256: sha('half'), messages: [] }), 201);
    const all = await send(`/api/chats/export/risu?plotId=${id}`);
    expect(all.headers.get('content-disposition')).toMatch(/_all_chats_.*\.json"/);
    const file = await ok(all);
    expect(file).toMatchObject({ type: 'risuAllChats', ver: 2, folders: [] });
    expect(file.data.map((chat: any) => chat.id)).toEqual([chatId]);
    expect(readRisuChatFile(file)).toHaveLength(1);
  });

  it("writes a group reply's member, and a chat that opens on no greeting whole", async () => {
    const plot = await ok(await send('/api/plots', 'POST', { name: '둘', intros: [] }), 201);
    const a = await ok(await send(`/api/plots/${plot.id}/characters`, 'POST', { name: '세라' }), 201);
    const b = await ok(await send(`/api/plots/${plot.id}/characters`, 'POST', { name: '리안' }), 201);
    const cast = { members: [{ id: a.id, name: '세라' }, { id: b.id, name: '리안' }] };
    const chatId = await importRisu(plot.id, cast, {
      message: [
        { role: 'char', data: '먼저 왔어.', saying: b.id },
        { role: 'user', data: '안녕' },
      ],
      note: '', name: '', localLore: [], fmIndex: -1,
    });
    const file = await ok(await send(`/api/chats/${chatId}/export/risu`));
    expect(file.data.fmIndex).toBe(-1);
    expect(file.data.message).toEqual([
      expect.objectContaining({ role: 'char', data: '먼저 왔어.', saying: b.id, name: '리안' }),
      expect.objectContaining({ role: 'user', data: '안녕' }),
    ]);
  });
});
