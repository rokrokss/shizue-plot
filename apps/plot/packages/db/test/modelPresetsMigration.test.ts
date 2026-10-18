/**
 * The model presets migration's data block, on rows in the shape before it: the
 * ChatGPT connection moves from `account` into `credentials` with its sealed
 * tokens as they were, every model the chats ran on becomes a preset, each chat
 * is bound to its own, and the owner's default follows their latest chat.
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/client.js';

const work = mkdtempSync(join(tmpdir(), 'shizue-migration-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Journal { entries: { idx: number; tag: string }[] }

describe('the model presets migration', () => {
  it('moves the ChatGPT connection and the chats’ models into credentials, presets and bindings', async () => {
    cpSync(MIGRATIONS_DIR, join(work, 'drizzle'), { recursive: true });
    const journalPath = join(work, 'drizzle/meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
    const at = journal.entries.findIndex((entry) => entry.tag.endsWith('_model_presets'));
    expect(at).toBeGreaterThan(0);
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }));

    const client = await PGlite.create('memory://', { extensions: { vector } });
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: join(work, 'drizzle') });
    const q = async (text: string, params: unknown[] = []) => (await client.query<Record<string, any>>(text, params)).rows;
    await q(`insert into "user" (id, name, email, created_at) values ('owner', 'Owner', 'me@example.com', now() - interval '1 day'), ('other', 'Other', 'o@example.com', now())`);
    await q(`insert into account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at, scope, client_id)
      values ('a1', 'sub-123', 'chatgpt', 'owner', 'v1.AAA.BBB.CCC', 'v1.DDD.EEE.FFF', null, now() + interval '1 hour', 'openid chatgpt.tokens.use.direct', 'app_owner')`);
    await q(`insert into plots (id, owner_id, name) values ('00000000-0000-4000-8000-000000000001', 'owner', 'P'), ('00000000-0000-4000-8000-000000000002', 'other', 'Q')`);
    const chat = (id: string, owner: string, plot: string, model: string, sub: string | null, effort: string | null, minutesAgo: number) =>
      q(`insert into chats (id, user_id, plot_id, model, sub_model, reasoning_effort, updated_at) values ($1, $2, $3, $4, $5, $6, now() - ($7 || ' minutes')::interval)`,
        [id, owner, plot, model, sub, effort, String(minutesAgo)]);
    const P = '00000000-0000-4000-8000-00000000000';
    await chat('10000000-0000-4000-8000-000000000001', 'owner', `${P}1`, 'gpt-5.4', null, 'high', 30);
    await chat('10000000-0000-4000-8000-000000000002', 'owner', `${P}1`, 'gpt-5.4', 'gpt-5.4-mini', null, 10);
    await chat('10000000-0000-4000-8000-000000000003', 'owner', `${P}1`, 'gpt-5.4-mini', null, null, 20);
    await chat('10000000-0000-4000-8000-000000000004', 'other', `${P}2`, 'gpt-5.2', null, 'low', 5);

    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: join(work, 'drizzle') });

    expect(await q(`select user_id, kind, provider, secrets, meta, expires_at is not null as expires from credentials order by user_id`)).toEqual([
      // No account of its own: a disconnected connection for its presets to wait on.
      { user_id: 'other', kind: 'chatgpt', provider: 'chatgpt', secrets: {}, meta: {}, expires: false },
      {
        user_id: 'owner', kind: 'chatgpt', provider: 'chatgpt',
        secrets: { accessToken: 'v1.AAA.BBB.CCC', refreshToken: 'v1.DDD.EEE.FFF' },
        meta: { subject: 'sub-123', clientId: 'app_owner', scope: 'openid chatgpt.tokens.use.direct' },
        expires: true,
      },
    ]);
    const presets = await q(`select p.id, p.user_id, p.name, p.format, p.model, p.params, c.user_id as credential_owner
      from model_presets p join credentials c on c.id = p.credential_id order by p.user_id, p.name`);
    expect(presets.map(({ id: _id, ...rest }) => rest)).toEqual([
      { user_id: 'other', name: 'gpt-5.2 · low', format: 'openai-responses', model: 'gpt-5.2', params: { reasoningEffort: 'low' }, credential_owner: 'other' },
      { user_id: 'owner', name: 'gpt-5.4', format: 'openai-responses', model: 'gpt-5.4', params: {}, credential_owner: 'owner' },
      { user_id: 'owner', name: 'gpt-5.4 · high', format: 'openai-responses', model: 'gpt-5.4', params: { reasoningEffort: 'high' }, credential_owner: 'owner' },
      { user_id: 'owner', name: 'gpt-5.4-mini', format: 'openai-responses', model: 'gpt-5.4-mini', params: {}, credential_owner: 'owner' },
    ]);
    const named = new Map(presets.map((preset) => [preset.id, preset.name]));
    const bindingOf = (binding: Record<string, string> | null) =>
      binding && Object.fromEntries(Object.entries(binding).map(([slot, id]) => [slot, named.get(id)]));
    expect((await q(`select model_binding from chats order by id`)).map((row) => bindingOf(row.model_binding))).toEqual([
      { main: 'gpt-5.4 · high' },
      { main: 'gpt-5.4', sub: 'gpt-5.4-mini' },
      { main: 'gpt-5.4-mini' },
      { main: 'gpt-5.2 · low' },
    ]);
    // Each owner's default is the main model of the chat they used last.
    expect((await q(`select id, model_binding from "user" order by id`)).map((row) => [row.id, bindingOf(row.model_binding)])).toEqual([
      ['other', { main: 'gpt-5.2 · low' }],
      ['owner', { main: 'gpt-5.4' }],
    ]);
    expect((await q(`select to_regclass('account') as gone`))[0]!.gone).toBeNull();
    expect((await q(`select column_name from information_schema.columns where table_name = 'chats' and column_name in ('model', 'sub_model', 'reasoning_effort')`))).toEqual([]);
    await client.close();
  });

  it('writes nothing on an empty database', async () => {
    const client = await PGlite.create('memory://', { extensions: { vector } });
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    expect((await client.query(`select (select count(*)::int from credentials) as credentials, (select count(*)::int from model_presets) as presets`)).rows)
      .toEqual([{ credentials: 0, presets: 0 }]);
    await client.close();
  });
});
