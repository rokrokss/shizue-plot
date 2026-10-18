/**
 * Migration 0001 on a database made at 0000_init: every preset from before the
 * registry is looked at once at the start — one on an API key whose model a
 * bundled profile names becomes that profile's preset with its values carried
 * over, any other stays custom as it was — and the rows keep their ids, so the
 * chats' and the default's bindings still name them.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDb, MIGRATIONS_DIR, modelPresets, openDb, type OpenedDb } from '../src/index.js';
import journal from '../drizzle/meta/_journal.json' with { type: 'json' };

let opened: OpenedDb;
let folder: string;

/** The migrations up to `0000_init` alone, as an install made before this one had them. */
function initOnly(): string {
  folder = mkdtempSync(join(tmpdir(), 'shizue-0000-'));
  mkdirSync(join(folder, 'meta'));
  copyFileSync(join(MIGRATIONS_DIR, '0000_init.sql'), join(folder, '0000_init.sql'));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.tag === '0000_init') }));
  return folder;
}

const USER = 'owner';
const ids = {
  google: '00000000-0000-4000-8000-000000000001',
  anthropic: '00000000-0000-4000-8000-000000000002',
  openai: '00000000-0000-4000-8000-000000000003',
  openrouter: '00000000-0000-4000-8000-000000000004',
  chatgpt: '00000000-0000-4000-8000-000000000005',
};
const presets = {
  gemini: '10000000-0000-4000-8000-000000000001',
  claude: '10000000-0000-4000-8000-000000000002',
  gpt: '10000000-0000-4000-8000-000000000003',
  routed: '10000000-0000-4000-8000-000000000004',
  plan: '10000000-0000-4000-8000-000000000005',
  local: '10000000-0000-4000-8000-000000000006',
  orphan: '10000000-0000-4000-8000-000000000007',
};
const PLOT = '20000000-0000-4000-8000-000000000001';
const CHAT = '30000000-0000-4000-8000-000000000001';

beforeEach(async () => {
  opened = await openDb();
  await migrate(opened.db, { migrationsFolder: initOnly() });
  const sql = (text: string) => opened.client.exec(text);
  await sql(`insert into "user" (id, name, email, model_binding) values ('${USER}', 'Owner', 'owner@localhost', '{"main":"${presets.gemini}","sub":"${presets.plan}"}')`);
  for (const [provider, id] of Object.entries(ids)) {
    const kind = provider === 'chatgpt' ? 'chatgpt' : 'api_key';
    await sql(`insert into credentials (id, user_id, kind, provider) values ('${id}', '${USER}', '${kind}', '${provider}')`);
  }
  const preset = (id: string, name: string, format: string, model: string, credential: string | null, params: object, capabilities: object = {}, endpoint: string | null = null) =>
    sql(`insert into model_presets (id, user_id, name, format, endpoint, model, credential_id, params, capabilities) values ('${id}', '${USER}', '${name}', '${format}', ${endpoint ? `'${endpoint}'` : 'null'}, '${model}', ${credential ? `'${credential}'` : 'null'}, '${JSON.stringify(params)}', '${JSON.stringify(capabilities)}')`);
  // The owner's AI Studio preset on the model Google stopped serving new users.
  await preset(presets.gemini, 'Flash', 'google', 'gemini-2.5-flash', ids.google, { temperature: 0.9, reasoningEffort: 'none', maxTokens: 2000, stop: ['\nUser:'], extraHeaders: { 'X-Trace': '1' } }, { vision: true });
  await preset(presets.claude, 'Sonnet', 'anthropic', 'claude-sonnet-4-5-20250929', ids.anthropic, { temperature: 1.5, topK: 40, thinkingTokens: 2048 });
  await preset(presets.gpt, 'Sol', 'openai-responses', 'gpt-6.1-sol', ids.openai, { reasoningEffort: 'xhigh', verbosity: 'low', topK: 5 });
  await preset(presets.routed, 'Routed', 'openai-chat', 'some-lab/unlisted-model', ids.openrouter, { temperature: 0.7 });
  await preset(presets.plan, 'ChatGPT', 'openai-responses', 'gpt-6.1-sol', ids.chatgpt, { reasoningEffort: 'high' });
  await preset(presets.local, 'LM Studio', 'openai-chat', 'qwen3', null, { temperature: 0.6 }, {}, 'http://localhost:1234/v1');
  await preset(presets.orphan, 'Keyless Flash', 'google', 'gemini-3.8-flash', null, {});
  await sql(`insert into plots (id, owner_id, name) values ('${PLOT}', '${USER}', 'Plot')`);
  await sql(`insert into chats (id, user_id, plot_id, model_binding) values ('${CHAT}', '${USER}', '${PLOT}', '{"main":"${presets.claude}","sub":"${presets.gpt}"}')`);
});

afterEach(async () => {
  await opened.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('migration 0001: presets onto the registry', () => {
  it('turns key presets a profile names into that profile, leaves the rest custom, and keeps every binding', async () => {
    await migrateDb(opened.db);
    const rows = Object.fromEntries((await opened.db.select().from(modelPresets)).map((row) => [row.id, row]));

    const gemini = rows[presets.gemini]!;
    expect(gemini).toMatchObject({ kind: 'profile', format: 'google', model: 'gemini-2.5-flash', credentialId: ids.google, params: { extraHeaders: { 'X-Trace': '1' } }, capabilities: { vision: true } });
    expect(gemini.sourceProfile).toMatchObject({ registryId: 'bundled', profileId: 'google:gemini-25-flash' });
    expect(gemini.profileSnapshot?.profileId).toBe('google:gemini-25-flash');
    // Its values carried where 2.5 Flash has the field; an effort it has no level for is left out.
    expect(gemini.userValues).toMatchObject({ modelId: 'gemini-2.5-flash', temperature: 0.9, maxOutputTokens: 2000, stopSequences: ['\nUser:'], includeThoughts: true });
    expect(gemini.userValues).not.toHaveProperty('thinkingLevel');

    const claude = rows[presets.claude]!;
    expect(claude).toMatchObject({ kind: 'profile', format: 'anthropic', model: 'claude-sonnet-4-5-20250929', params: {} });
    expect(claude.sourceProfile?.profileId).toBe('anthropic:sonnet-45');
    // 1.5 is past Claude's 0–1, so it goes; the budget turns thinking on.
    expect(claude.userValues).toMatchObject({ top_k: 40, thinking_budget_tokens: 2048, thinking_type: 'enabled', max_tokens: 4096 });
    expect(claude.userValues).not.toHaveProperty('temperature');

    const gpt = rows[presets.gpt]!;
    expect(gpt).toMatchObject({ kind: 'profile', format: 'openai-chat', model: 'gpt-6.1-sol' });
    expect(gpt.sourceProfile?.profileId).toBe('openai:gpt-61-sol');
    expect(gpt.userValues).toMatchObject({ reasoning_effort: 'xhigh', verbosity: 'low', max_completion_tokens: 8192 });

    // A model no profile names, the ChatGPT plan, a keyless server and a preset with no key stay as they were.
    for (const id of [presets.routed, presets.plan, presets.local, presets.orphan]) {
      expect(rows[id], id).toMatchObject({ kind: 'custom', sourceProfile: null, profileSnapshot: null, userValues: {} });
    }
    expect(rows[presets.plan]).toMatchObject({ format: 'openai-responses', model: 'gpt-6.1-sol', params: { reasoningEffort: 'high' } });
    expect(rows[presets.local]).toMatchObject({ endpoint: 'http://localhost:1234/v1', params: { temperature: 0.6 } });

    const bindings = await opened.client.query<{ owner: unknown; chat: unknown }>(`select (select model_binding from "user") as owner, (select model_binding from chats) as chat`);
    expect(bindings.rows[0]).toEqual({ owner: { main: presets.gemini, sub: presets.plan }, chat: { main: presets.claude, sub: presets.gpt } });
  });

  it('looks at a preset once: the next start changes nothing, and a custom preset made later stays custom', async () => {
    await migrateDb(opened.db);
    const before = await opened.db.select().from(modelPresets);
    await opened.client.exec(`insert into model_presets (user_id, name, format, model, credential_id) values ('${USER}', 'Typed', 'google', 'gemini-3.8-flash', '${ids.google}')`);
    await migrateDb(opened.db);
    const after = await opened.db.select().from(modelPresets);
    for (const row of before) expect(after.find((entry) => entry.id === row.id)).toEqual(row);
    expect(after.find((row) => row.name === 'Typed')).toMatchObject({ kind: 'custom', profileSnapshot: null });
  });
});
