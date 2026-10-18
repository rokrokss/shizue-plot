/**
 * Migration 0033 folds what a card's scripts rewrote of a work for its owner
 * (`plot_reader_overlays`) into the work itself before the table goes, as
 * RisuAI's scripts rewrite the character: the cards and the roster's names, a
 * work of one member's name, the work's background and first opening, every
 * chat's first greeting, and the personas its chats use. Rehearsed on an
 * in-memory database migrated to 0032, seeded, then migrated on.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

const owner = 'owner-1';
const other = 'other-2';
const plot = '11111111-1111-4111-8111-111111111111';
const lead = '33333333-3333-4333-8333-333333333333';
const second = '44444444-4444-4444-8444-444444444444';
const persona = '55555555-5555-4555-8555-555555555555';
const chat = '66666666-6666-4666-8666-666666666666';
const firstRoot = '77777777-7777-4777-8777-777777777771';
const secondRoot = '77777777-7777-4777-8777-777777777772';
const solo = '88888888-8888-4888-8888-888888888888';
const soloMember = '99999999-9999-4999-8999-999999999999';

const card = (name: string): string =>
  JSON.stringify({ spec: 'v3', name, description: '원래 설명', lorebook: [], postHistoryInstructions: '', extensions: { risuai: { utilityBot: false } } });

describe('migration 0033', () => {
  let client: PGlite;
  let folder: string;
  const rows = async (query: string): Promise<any[]> => (await client.query(query)).rows;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'shizue-0033-'));
    const before = join(folder, 'drizzle');
    cpSync(MIGRATIONS, before, { recursive: true });
    const journalPath = join(before, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 32);
    writeFileSync(journalPath, JSON.stringify(journal));

    client = await PGlite.create('memory://', { extensions: { vector } });
    await client.exec(`set time zone 'UTC'`);
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: before });
    await client.exec(`
      insert into "user" (id, name, email, created_at) values
        ('${owner}', 'o', 'o@x.test', now() - interval '1 day'), ('${other}', 'b', 'b@x.test', now());
      insert into plots (id, owner_id, name, intros, custom_ui) values
        ('${plot}', '${owner}', '작품', '["첫 도입부", "둘째 도입부"]', '{"css": "a{}"}'),
        ('${solo}', '${owner}', '혼자', '["하나"]', null);
      insert into characters (id, plot_id, name, card, order_index) values
        ('${lead}', '${plot}', '리안', '${card('리안')}', 0),
        ('${second}', '${plot}', '미오', '${card('미오')}', 1),
        ('${soloMember}', '${solo}', '혼자', '${card('혼자')}', 0);
      insert into personas (id, user_id, name, description) values ('${persona}', '${owner}', '민준', '원래 페르소나');
      insert into chats (id, user_id, plot_id, persona_id, model) values ('${chat}', '${owner}', '${plot}', '${persona}', 'echo/echo');
      insert into messages (id, chat_id, parent_id, role, content, created_at) values
        ('${firstRoot}', '${chat}', null, 'assistant', '첫 도입부', now() - interval '2 minutes'),
        ('${secondRoot}', '${chat}', null, 'assistant', '둘째 도입부', now() - interval '1 minute');
      insert into plot_reader_overlays (user_id, plot_id, overlay) values
        ('${owner}', '${plot}', '{"members": {"${lead}": {"name": "세라", "description": "바뀐 설명", "lorebook": [{"keys": ["탑"], "content": "높은 탑."}], "postHistoryInstructions": "PHI", "firstMessage": "{{char}}가 다시 문을 연다.", "backgroundHtml": "<div>밤</div>"}, "${second}": {"description": "미오의 새 설명"}, "not-a-member": {"description": "x"}}, "persona": "스크립트 페르소나"}'),
        ('${other}', '${plot}', '{"members": {"${lead}": {"name": "남이 바꾼 이름"}}}'),
        ('${owner}', '${solo}', '{"members": {"${soloMember}": {"name": "둘"}}}');
      insert into plot_reader_variables (user_id, plot_id, variables) values
        ('${owner}', '${plot}', '{"a": "1"}'), ('${other}', '${plot}', '{"b": "2"}');
      insert into jobs (kind, payload) values ('notification_fanout', '{}'), ('memory_backfill', '{"chatId": "${chat}"}');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS });
  });

  afterAll(async () => {
    await client.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("writes the owner's rewrites into the cards and the roster, and no one else's", async () => {
    const [first, companion] = await rows(`select name, card from characters where plot_id = '${plot}' order by order_index`);
    expect(first.name).toBe('세라');
    expect(first.card).toMatchObject({
      name: '세라',
      description: '바뀐 설명',
      lorebook: [{ keys: ['탑'], content: '높은 탑.' }],
      postHistoryInstructions: 'PHI',
      extensions: { risuai: { utilityBot: false, backgroundHTML: '<div>밤</div>' } },
    });
    expect(companion.card.description).toBe('미오의 새 설명');
    expect(companion.name).toBe('미오');
  });

  it("gives the work the lead's background and first opening, and every chat's first greeting", async () => {
    const [work] = await rows(`select name, intros, custom_ui from plots where id = '${plot}'`);
    // A work of several keeps its own name.
    expect(work.name).toBe('작품');
    expect(work.intros).toEqual(['{{char}}가 다시 문을 연다.', '둘째 도입부']);
    expect(work.custom_ui).toEqual({ css: 'a{}', backgroundHtml: '<div>밤</div>' });
    const roots = await rows(`select id, content from messages where chat_id = '${chat}' order by created_at`);
    expect(roots).toEqual([
      { id: firstRoot, content: '{{char}}가 다시 문을 연다.' },
      { id: secondRoot, content: '둘째 도입부' },
    ]);
    // A work of one member is that character, and takes its new name.
    const [alone] = await rows(`select p.name as work, c.name as member from plots p join characters c on c.plot_id = p.id where p.id = '${solo}'`);
    expect(alone).toEqual({ work: '둘', member: '둘' });
  });

  it("puts the persona on the work's chats' persona, and keeps the owner's variables for the work", async () => {
    expect(await rows(`select description from personas`)).toEqual([{ description: '스크립트 페르소나' }]);
    expect(await rows(`select plot_id, variables from plot_reader_variables`)).toEqual([{ plot_id: plot, variables: { a: '1' } }]);
    expect(await rows(`select kind from jobs`)).toEqual([{ kind: 'memory_backfill' }]);
  });

  it('drops the community, the overlays, the limits and the claims', async () => {
    const tables = (await rows(`select table_name from information_schema.tables where table_schema = 'public'`)).map((row) => row.table_name);
    for (const gone of ['plot_reader_overlays', 'plot_likes', 'comments', 'follows', 'notifications', 'feed_cursors', 'plot_search_vectors', 'rate_limits', 'leases']) {
      expect(tables).not.toContain(gone);
    }
    const columns = async (table: string): Promise<string[]> =>
      (await rows(`select column_name from information_schema.columns where table_name = '${table}'`)).map((row) => row.column_name);
    for (const gone of ['visibility', 'safety_level', 'published_at', 'like_count', 'chat_count', 'comments_enabled', 'rights_confirmed_at']) {
      expect(await columns('plots')).not.toContain(gone);
    }
    expect(await columns('chats')).not.toContain('generating_at');
    expect(await columns('plot_reader_variables')).not.toContain('user_id');
  });
});
