/**
 * Integration tests for @shizue/api.
 *
 * Requirements:
 *  - Postgres from `docker compose up -d` (localhost:15433) with `pnpm db:migrate` applied.
 *  - `pnpm -r build` at the workspace root beforehand: @shizue/db, @shizue/core and @shizue/llm
 *    resolve to their dist output.
 *  - Connection string: TEST_DATABASE_URL, a scratch database whose name ends in `_test`
 *    (`resolveTestDatabaseUrl` below refuses everything else — every table is
 *    TRUNCATEd before each test).
 *
 * The suite runs the Hono app in-process through `app.request()` and only ever uses
 * the `echo/echo` model, so no provider key is needed.
 */
import {
  countTokens,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_MAX_RESPONSE_TOKENS,
  IMAGE_ATTACHED_PLACEHOLDER,
  loreEntryKey,
  parseCard,
  placeholderPng,
  PRESET_IDS,
  readPngTextChunks,
  stripPngTextChunks,
} from '@shizue/core';
import { ChatExportSchema } from '@shizue/contracts';
import {
  account,
  characters,
  chatAssetUnlocks,
  chatAttachments,
  chats,
  chatNoteLinks,
  comments,
  createDb,
  feedCursors,
  follows,
  jobs,
  memories,
  messages,
  notifications,
  plots,
  plotAssets,
  user,
  userNotes,
  type ChatMemory,
  type ChatRelationship,
  type Db,
  type JobPayloadMap,
} from '@shizue/db';
import {
  ChatGPTOAuth,
  contentText,
  createEchoAdapter,
  type ChatRequest,
  type StreamDelta,
  type StreamDone,
} from '@shizue/llm';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbedder } from '../../../packages/llm/test/helpers/embed.js';
import { stCard, v3Card } from '../../../packages/core/test/fixtures/cards.js';
import { buildCharx, type CharxAssetSpec } from '../../../packages/core/test/helpers/charx.js';
import { buildPngWithTextChunks } from '../../../packages/core/test/helpers/png.js';
import { createApp } from '../src/app.js';
import { MAX_ASSETS_PER_PLOT } from '../src/assets.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  MAX_UNBOUND_ATTACHMENTS,
  withTurnImages,
} from '../src/attachments.js';
import { createAuth } from '../src/auth.js';
import { createChatGPTAccounts } from '../src/chatgptAccounts.js';
import { createHostedAuth, createSessionStore } from '../src/hostedAuth.js';
import type { AppDeps, AppEnv } from '../src/deps.js';
import { loadRootEnv } from '../src/env.js';
import { ApiError } from '../src/errors.js';
import { acquireChatSlot, releaseChatSlot, renewChatSlot } from '../src/generation.js';
import {
  drainJobs,
  enqueueJob,
  finishJob,
  recordFailure,
  renewLease,
  startJobWorker,
  type JobHandlers,
} from '../src/jobs.js';
import { createJobHandlers, notificationFanout } from '../src/notifications.js';
import {
  MAX_CHARACTERS_PER_PLOT,
  MAX_INTRO_TEXT_LENGTH,
  MAX_INTROS_PER_PLOT,
} from '../src/routes/plots.js';
import { createLocalStorage, type ObjectStorage } from '../src/storage.js';
import { connectS3Server } from './s3Server.js';

loadRootEnv();

/**
 * The connection string for a suite that TRUNCATEs twenty-one tables before every
 * test, so the target has to say out loud that it is disposable. There is no
 * fallback to DATABASE_URL: that is the app's own database, and it is the name a
 * CI secret is most likely to carry.
 *
 * The name check is the one that survives a copied secret — `TEST_DATABASE_URL`
 * set from the same value as the app's would pass an equality check the moment
 * DATABASE_URL is not also exported. A marker table would be stronger still, but
 * the suite builds its own schema from migrations and would have to create the
 * marker itself, which is the same as not having one; the name is the part only
 * a database created for this can satisfy.
 *
 * A `database` query parameter is refused rather than read. postgres.js takes the
 * name from the pathname but forwards unknown parameters into the startup packet,
 * where the server honours `database` and overrides it — so
 * `…/plot_test?database=plot` reads as disposable here and opens `plot`
 * (verified against postgres@3.4.9; `db`/`dbname` are rejected by the server as
 * unrecognized parameters, and are refused here too so no spelling of it works).
 * `assertDisposableTarget` then re-checks the database the driver actually opened,
 * which is the part no URL parsing can get wrong.
 */
function resolveTestDatabaseUrl(): string {
  const remedy =
    'Point TEST_DATABASE_URL at a scratch database whose name ends in `_test`, e.g. postgres://plot:plot@localhost:15433/plot_test — create it once with `docker compose exec -T postgres psql -U plot -d plot -c "CREATE DATABASE plot_test"` and migrate it with `DATABASE_URL=postgres://plot:plot@localhost:15433/plot_test pnpm db:migrate` (README §검증).';
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error(`TEST_DATABASE_URL is not set. ${remedy}`);
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('refusing to run with NODE_ENV=production: this suite truncates every table.');
  }
  if (url === process.env['DATABASE_URL']) {
    throw new Error(
      `TEST_DATABASE_URL is the same as DATABASE_URL, the database the app itself runs on. ${remedy}`,
    );
  }
  const parsed = new URL(url);
  for (const [key] of parsed.searchParams) {
    if (['database', 'db', 'dbname'].includes(key.toLowerCase())) {
      throw new Error(
        `TEST_DATABASE_URL carries a "${key}" parameter, which redirects the connection away from the database its path names. Drop it. ${remedy}`,
      );
    }
  }
  // Only the database name is quoted back: the URL carries credentials.
  const name = parsed.pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL names database "${name}", which is not marked as disposable. ${remedy}`,
    );
  }
  return url;
}

/**
 * Last gate before the first TRUNCATE: ask the open connection what it is on.
 * Runs in `beforeAll`, which vitest completes before any `beforeEach`.
 */
async function assertDisposableTarget(): Promise<void> {
  const [row] = await sql<{ db: string }[]>`select current_database() as db`;
  if (!row?.db.endsWith('_test')) {
    await close();
    throw new Error(
      `connected to database "${row?.db}", which is not marked as disposable — refusing to truncate it. Check TEST_DATABASE_URL.`,
    );
  }
}

const databaseUrl = resolveTestDatabaseUrl();

/**
 * The S3 driver's target: the compose RustFS when it answers, null otherwise. Resolved
 * at module load because vitest decides what to skip while it collects, and the
 * stub driver below covers the same route contract when it is null.
 */
const s3Storage = await connectS3Server();

const v2Card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '리안',
    description: '왕립 도서관의 사서.',
    personality: '조용하고 꼼꼼하다.',
    scenario: '폐관 시간이 지난 도서관.',
    first_mes: '아직 안 가셨군요, {{user}}.',
    mes_example: '',
    alternate_greetings: ['불이 꺼진 열람실에서 마주쳤다.'],
    tags: ['판타지'],
    creator: '리드',
    character_version: '1.0',
    // ccardlib only recognizes a V2 card when these are present.
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    extensions: {},
  },
};

/** The shape `emptyCard` produces, for rows a test inserts straight into the table. */
const emptyCardShape = {
  spec: 'v3' as const,
  name: '',
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
  alternateGreetings: [],
  mesExample: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  creatorNotes: '',
  tags: [],
  creator: '',
  characterVersion: '',
  lorebook: [],
  loreSettings: { scanDepth: 4, tokenBudget: 2048, recursiveScanning: false },
  extensions: {},
  raw: null,
};

let db: Db;
let sql: ReturnType<typeof createDb>['sql'];
let close: () => Promise<void>;
let storageDir: string;
let storage: ObjectStorage;
let auth: ReturnType<typeof createAuth>;
let app: Hono<AppEnv>;

beforeAll(async () => {
  ({ db, sql, close } = createDb(databaseUrl));
  await assertDisposableTarget();
  storageDir = await mkdtemp(join(tmpdir(), 'shizue-api-test-'));
  storage = createLocalStorage(storageDir);
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await sql`TRUNCATE TABLE memories, chat_asset_unlocks, chat_attachments, messages, chat_note_links, user_notes, chats, personas, comments, plot_likes, plot_assets, characters, notifications, follows, plots, feed_cursors, jobs, "session", account, verification, "user" RESTART IDENTITY CASCADE`;
  auth = createAuth(db, {
    secret: 'test-secret-test-secret-test-secret',
    baseUrl: 'http://localhost:13000',
  });
  app = makeApp();
});

/** The plot publication handler registry used by the API. */
const jobHandlers = createJobHandlers();

/**
 * One API instance's dependencies. Two of these are two instances: they share the
 * database and the store, and nothing else — which is what the generation claim
 * has to hold across.
 */
function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    db,
    auth,
    storage,
    env: {},
    createEmbedder: (timeout) => createEmbedder(overrides.env ?? {}, timeout),
    generating: new Set<string>(),
    generationClaims: new Map(),
    refreshingMemory: new Set<string>(),
    extractingRelationship: new Set<string>(),
    suggesting: new Set<string>(),
    drafting: new Set<string>(),
    ...overrides,
  };
}

/** Empty env by default: only the always-on echo model is enabled. */
function makeApp(overrides: Partial<AppDeps> = {}): Hono<AppEnv> {
  return createApp(makeDeps(overrides));
}

/** Adapter that records every chat-model request and replies through echo. */
function capturingApp(overrides: Partial<AppDeps> = {}): {
  app: Hono<AppEnv>;
  prompts: { system: string; messages: ChatRequest['messages']; maxTokens: number }[];
} {
  const prompts: { system: string; messages: ChatRequest['messages']; maxTokens: number }[] = [];
  const echo = createEchoAdapter();
  const app = makeApp({
    getAdapter: () => ({
      providerModel: 'echo',
      adapter: {
        stream: (req) => {
          // The cap goes in too: it is half of the reply-length setting, and the
          // request is the only place it is observable.
          prompts.push({ system: req.system, messages: req.messages, maxTokens: req.maxTokens });
          return echo.stream(req);
        },
      },
    }),
    ...overrides,
  });
  return { app, prompts };
}

/** Generation slot set that records every acquisition. */
class TrackingSet extends Set<string> {
  readonly acquired: string[] = [];

  override add(value: string): this {
    this.acquired.push(value);
    return super.add(value);
  }
}

/** Streams a fixed reply, standing in for a provider that needs a real key. */
const stubGetAdapter: AppDeps['getAdapter'] = () => ({
  providerModel: 'stub',
  adapter: {
    stream: async function* (): AsyncGenerator<StreamDelta, StreamDone> {
      yield { type: 'text', text: '스텁 응답' };
      return { usage: { promptTokens: 1, completionTokens: 1 } };
    },
  },
});

/** Streams one delta and then blows up, standing in for a provider failure. */
const failingGetAdapter: AppDeps['getAdapter'] = () => ({
  providerModel: 'broken',
  adapter: {
    stream: async function* (): AsyncGenerator<StreamDelta, StreamDone> {
      yield { type: 'text', text: '부분 응답' };
      throw new Error('provider exploded');
    },
  },
});

/**
 * Adapter that answers with fixed texts in order, one per call — the side
 * channels (draft, suggestions) take a second attempt when the first is not
 * usable JSON, and the sequence is how that is observed.
 */
function scriptedGetAdapter(...replies: string[]): {
  getAdapter: AppDeps['getAdapter'];
  calls: () => number;
} {
  let call = 0;
  return {
    calls: () => call,
    getAdapter: () => ({
      providerModel: 'scripted',
      adapter: {
        stream: async function* (): AsyncGenerator<StreamDelta, StreamDone> {
          const reply = replies[Math.min(call, replies.length - 1)] ?? '';
          call += 1;
          yield { type: 'text', text: reply };
          return { usage: { promptTokens: 1, completionTokens: 1 } };
        },
      },
    }),
  };
}

/** Adapter that answers only once it is released — for the in-flight guards. */
function gatedGetAdapter(reply: string): {
  getAdapter: AppDeps['getAdapter'];
  started: Promise<void>;
  release: () => void;
} {
  let markStarted!: () => void;
  let open!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const gate = new Promise<void>((resolve) => (open = resolve));
  return {
    started,
    release: () => open(),
    getAdapter: () => ({
      providerModel: 'gated',
      adapter: {
        stream: async function* (): AsyncGenerator<StreamDelta, StreamDone> {
          markStarted();
          await gate;
          yield { type: 'text', text: reply };
          return { usage: { promptTokens: 1, completionTokens: 1 } };
        },
      },
    }),
  };
}

/* ---------------------------------------------------------------- helpers */

type Body = string | FormData | undefined;

function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

async function signUp(email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password1234', name: email.split('@')[0] }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return cookieOf(res);
}

async function request(
  cookie: string | undefined,
  path: string,
  method = 'GET',
  body?: Body,
  target: Hono<AppEnv> = app,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers['cookie'] = cookie;
  if (typeof body === 'string') headers['content-type'] = 'application/json';
  return target.request(path, { method, headers, ...(body === undefined ? {} : { body }) });
}

const json = (
  cookie: string | undefined,
  path: string,
  method = 'GET',
  body?: unknown,
  target: Hono<AppEnv> = app,
): Promise<Response> =>
  request(cookie, path, method, body === undefined ? undefined : JSON.stringify(body), target);

async function readJson(res: Response): Promise<any> {
  return res.json();
}

interface SseEvent {
  event: string;
  data: any;
}

async function readSse(res: Response): Promise<SseEvent[]> {
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const event: SseEvent = { event: 'message', data: undefined };
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event.event = line.slice(6).trim();
        else if (line.startsWith('data:')) event.data = JSON.parse(line.slice(5).trim());
      }
      return event;
    });
}

/** Hand-built pagination cursor — the encoding every opaque cursor shares. */
const encodeCursor = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');

/**
 * Stamps a timestamp column with microsecond precision. Postgres stores it, but
 * a JS Date cannot hold it, so this is the state a cursor round trip has to
 * survive without the driver ever handing the value back intact.
 */
const microsecond = (fraction: string): string => `2027-01-01 00:00:00.${fraction}+00`;

/**
 * Blocks until another backend is waiting on a lock — a barrier for tests that
 * hold a row and need the request racing them to have actually reached it. Polls
 * rather than sleeping, so it does not depend on how fast anything is.
 */
async function waitForLockWaiter(waiters = 1): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await sql`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
    if (Number(row!['waiting']) >= waiters) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('no backend ever blocked on a lock');
}

/** Polls until `check` holds; the fire-and-forget work a request starts has no handle. */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(what);
}

/**
 * The chat's generation claim as the row holds it. This is the guard's authority —
 * the in-process set is only a fast path — so it is what the tests read.
 */
async function claimOf(chatId: string): Promise<Date | null> {
  const [row] = await db.select({ at: chats.generatingAt }).from(chats).where(eq(chats.id, chatId));
  return row?.at ?? null;
}

/** Imports a card file as the plot that wraps it; the owner view comes back. */
async function importCard(cookie: string, file: File): Promise<any> {
  const form = new FormData();
  form.append('file', file);
  const res = await request(cookie, '/api/plots/import', 'POST', form);
  expect(res.status, await res.clone().text()).toBe(201);
  return readJson(res);
}

const cardFile = (): File =>
  new File([JSON.stringify(v2Card)], 'lian.json', { type: 'application/json' });

/** Posts a single `file` part — the shape the avatar and cover routes take. */
function uploadFile(cookie: string, path: string, bytes: Uint8Array, name: string): Promise<Response> {
  const form = new FormData();
  form.append('file', new File([bytes], name));
  return request(cookie, path, 'POST', form);
}

/** Creates a plot; the body is whatever the editor would have written. */
async function createPlot(cookie: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await json(cookie, '/api/plots', 'POST', { name: '새 플롯', ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return readJson(res);
}

/** Partial update of a plot, answered with the owner view. */
async function patchPlot(cookie: string, id: string, body: Record<string, unknown>): Promise<any> {
  const res = await json(cookie, `/api/plots/${id}`, 'PATCH', body);
  expect(res.status, await res.clone().text()).toBe(200);
  return readJson(res);
}

/** Puts one more member on a plot's roster. */
async function addCharacter(
  cookie: string,
  plotId: string,
  body: Record<string, unknown> = {},
): Promise<any> {
  const res = await json(cookie, `/api/plots/${plotId}/characters`, 'POST', {
    name: '리안',
    ...body,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return readJson(res);
}

/** Patches one member of a plot's roster. */
async function patchCharacter(
  cookie: string,
  plotId: string,
  characterId: string,
  body: Record<string, unknown>,
): Promise<any> {
  const res = await json(
    cookie,
    `/api/plots/${plotId}/characters/${characterId}`,
    'PATCH',
    body,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return readJson(res);
}

/** The first member of a plot's roster — the one an imported card became. */
const firstMember = async (cookie: string, plotId: string): Promise<any> =>
  (await readPlot(cookie, plotId)).characters[0];

/** The owner view of a plot as it stands now. */
const readPlot = async (cookie: string, id: string): Promise<any> =>
  readJson(await request(cookie, `/api/plots/${id}`));

/** The public page of a plot, as any reader gets it. */
const readPublicPlot = async (cookie: string | undefined, id: string): Promise<any> =>
  readJson(await request(cookie, `/api/plots/${id}/public`));

/**
 * A plot carrying everything a publish needs, with one member on it. The two
 * defaults are what `requirePublishable` asks for: a setting for the model and
 * at least one opening for the reader.
 */
async function publishablePlot(
  cookie: string,
  plot: Record<string, unknown> = {},
  character: Record<string, unknown> = {},
): Promise<any> {
  const created = await createPlot(cookie, { description: '설명', intros: ['안녕'], ...plot });
  await addCharacter(cookie, created.id, character);
  return readPlot(cookie, created.id);
}

/**
 * Publishes a plot, which is what puts it in front of anyone else — and runs the
 * queue afterwards, since the follower fan-out a publish enqueues is what the
 * notification tests are looking at. A publish with nothing to announce drains
 * nothing.
 */
async function publishPlot(
  cookie: string,
  id: string,
  body: Record<string, unknown> = {},
): Promise<any> {
  const res = await json(cookie, `/api/plots/${id}/publish`, 'POST', { publish: true, ...body });
  expect(res.status, await res.clone().text()).toBe(200);
  await drainJobs(db, jobHandlers);
  return readJson(res);
}

/** Starts a chat on a plot; the initial state comes back. */
async function startChat(
  cookie: string,
  plotId: string,
  body: Record<string, unknown> = {},
): Promise<any> {
  const res = await json(cookie, '/api/chats', 'POST', { plotId, model: 'echo/echo', ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return readJson(res);
}

/** Plot + chat with the opening already stored, ready to generate. */
async function setupChat(cookie: string): Promise<{ plotId: string; chatId: string; state: any }> {
  const plot = await importCard(cookie, cardFile());
  const state = await startChat(cookie, plot.id);
  return { plotId: plot.id, chatId: state.chat.id, state };
}

/* ------------------------------------------------------------------ tests */

describe('auth', () => {
  it('signs up, signs in and returns the session', async () => {
    const cookie = await signUp('alice@example.com');

    const session = await readJson(await request(cookie, '/api/auth/get-session'));
    expect(session.user.email).toBe('alice@example.com');

    const signIn = await json(undefined, '/api/auth/sign-in/email', 'POST', {
      email: 'alice@example.com',
      password: 'password1234',
    });
    expect(signIn.status).toBe(200);
    const reSession = await readJson(await request(cookieOf(signIn), '/api/auth/get-session'));
    expect(reSession.user.id).toBe(session.user.id);
  });

  it('normalizes better-auth failures to the API error shape', async () => {
    await signUp('shape@example.com');
    const res = await json(undefined, '/api/auth/sign-in/email', 'POST', {
      email: 'shape@example.com',
      password: 'wrong-password',
    });

    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(Object.keys(body).sort()).toEqual(['code', 'error']);
    expect(body.error).toEqual(expect.any(String));
    expect(body.code).toBe('invalid_email_or_password');
  });

  it('rejects unauthenticated access', async () => {
    const res = await request(undefined, '/api/plots');
    expect(res.status).toBe(401);
    expect(await readJson(res)).toEqual({ error: expect.any(String), code: 'unauthorized' });
  });
});

/**
 * Stands in for auth.openai.com and the model catalog. Tokens name the account
 * they were issued to, so a test can see whose token reached which call.
 */
function fakeOpenAI() {
  const state = { subject: '', email: '', nonce: '', refreshes: 0, revoked: [] as string[] };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = new URLSearchParams(init?.body as string);
    if (url.endsWith('openid-configuration')) {
      return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke' });
    }
    if (url.endsWith('/revoke')) { state.revoked.push(body.get('token')!); return Response.json({}); }
    if (url.endsWith('/models')) {
      const bearer = String((init?.headers as Record<string, string>)['Authorization']);
      return Response.json({ models: [{ slug: `gpt-for-${bearer.split('-')[1]}`, visibility: 'list' }] });
    }
    if (url.endsWith('/oauth/token')) {
      const refresh = body.get('grant_type') === 'refresh_token';
      if (refresh) state.refreshes++;
      const subject = refresh ? body.get('refresh_token')!.split('-')[1]! : state.subject;
      return Response.json({
        access_token: `ACCESS-${subject}-${state.refreshes}`, refresh_token: `REFRESH-${subject}-${state.refreshes}`,
        id_token: JSON.stringify({ sub: subject, email: state.email, ...(refresh ? {} : { nonce: state.nonce }) }),
        expires_in: 3600, scope: 'openid email offline_access chatgpt.tokens.use.direct',
      });
    }
    throw new Error(`Unexpected OpenAI call: ${url}`);
  };
  // Signature checks are the OAuth module's own tests; here the ID token is plain JSON.
  const verify = (async (token: string) => ({ payload: JSON.parse(token) })) as never;
  return { state, oauth: new ChatGPTOAuth({ fetch: fetcher, verify }) };
}

/** Merges cookie headers the way a browser jar does: a later value replaces, an empty one deletes. */
function jar(...headers: string[]): string {
  const cookies = new Map<string, string>();
  for (const part of headers.join('; ').split('; ').filter(Boolean)) {
    const at = part.indexOf('=');
    if (part.slice(at + 1)) cookies.set(part.slice(0, at), part); else cookies.delete(part.slice(0, at));
  }
  return [...cookies.values()].join('; ');
}

function hostedApp(openai: ReturnType<typeof fakeOpenAI>, env: Record<string, string> = {}) {
  const accounts = createChatGPTAccounts(db, { secret: 'test-secret-test-secret-test-secret', callbackPort: 47801, oauth: openai.oauth });
  const sessions = createSessionStore(db, { secure: false });
  const target = makeApp({ auth: createHostedAuth(sessions, accounts), chatgpt: { accounts, sessions }, env });
  /** The whole round trip as the browser makes it; returns the cookies it ends with. */
  async function signIn(subject: string, cookies = ''): Promise<{ callback: Response; cookie: string; authorization: URL }> {
    const start = await target.request('/api/chatgpt/sign-in', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: JSON.stringify({ next: '/settings', locale: 'ko' }),
    });
    expect(start.status).toBe(200);
    const authorization = new URL((await readJson(start)).authorizationUrl);
    Object.assign(openai.state, { subject, email: `${subject}@chatgpt.test`, nonce: authorization.searchParams.get('nonce') });
    const callback = await target.request(
      `/api/chatgpt/callback?code=c&state=${authorization.searchParams.get('state')}&client_id=app_${subject}`,
      { headers: { cookie: jar(cookies, cookieOf(start)) } },
    );
    return { callback, cookie: jar(cookies, cookieOf(callback)), authorization };
  }
  return { accounts, target, signIn };
}

describe('Sign in with ChatGPT', () => {
  it('signs a reader in at the callback and never hands a token to the browser', async () => {
    const openai = fakeOpenAI();
    const { target, signIn } = hostedApp(openai);
    expect(await readJson(await request(undefined, '/api/auth/get-session', 'GET', undefined, target))).toBeNull();
    expect((await request(undefined, '/api/chats', 'GET', undefined, target)).status).toBe(401);
    for (const path of ['sign-up/email', 'sign-in/email']) {
      expect((await json(undefined, `/api/auth/${path}`, 'POST', { email: 'x@example.test', password: 'password' }, target)).status).toBe(404);
    }

    const { callback, cookie, authorization } = await signIn('alice');
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorization.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:47801/auth/callback');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/ko/settings');
    expect(callback.headers.get('cache-control')).toBe('no-store');
    expect(callback.headers.getSetCookie().find((value) => value.startsWith('shizue_session='))).toMatch(/HttpOnly; SameSite=Lax/);

    const session = await readJson(await request(cookie, '/api/auth/get-session', 'GET', undefined, target));
    expect(session.user.email).toBe('alice@chatgpt.test');
    expect((await request(cookie, '/api/chats', 'GET', undefined, target)).status).toBe(200);
    expect(await readJson(await request(cookie, '/api/chatgpt', 'GET', undefined, target))).toEqual({ connected: true, email: 'alice@chatgpt.test' });
    const [row] = await db.select().from(account).where(eq(account.userId, session.user.id));
    expect(row).toMatchObject({ providerId: 'chatgpt', accountId: 'alice', clientId: 'app_alice' });
    // Sealed at rest.
    expect(`${row!.accessToken}${row!.refreshToken}${row!.idToken}`).not.toMatch(/ACCESS|REFRESH|alice/);
  });

  it('refuses a callback from another browser, a replayed attempt and a declined consent', async () => {
    const openai = fakeOpenAI();
    const { target } = hostedApp(openai);
    const start = await json(undefined, '/api/chatgpt/sign-in', 'POST', { next: '/settings', locale: 'en' }, target);
    const state = new URL((await readJson(start)).authorizationUrl).searchParams.get('state');
    // The attacker's own code and state, opened in someone else's browser.
    const foreign = await request(undefined, `/api/chatgpt/callback?code=c&state=${state}&client_id=app_x`, 'GET', undefined, target);
    expect(foreign.headers.get('location')).toBe('/en/login?error=chatgpt_invalid_state&next=%2Fsettings');
    expect(foreign.headers.getSetCookie().some((value) => value.startsWith('shizue_session='))).toBe(false);
    // Single use, even from the right browser.
    const replay = await request(cookieOf(start), `/api/chatgpt/callback?code=c&state=${state}&client_id=app_x`, 'GET', undefined, target);
    expect(replay.headers.get('location')).toBe('/ko/login?error=chatgpt_invalid_state&next=%2F');

    const again = await json(undefined, '/api/chatgpt/sign-in', 'POST', { next: '//evil.example', locale: 'ja' }, target);
    const retry = new URL((await readJson(again)).authorizationUrl).searchParams.get('state');
    const declined = await request(cookieOf(again), `/api/chatgpt/callback?error=access_denied&state=${retry}`, 'GET', undefined, target);
    expect(declined.headers.get('location')).toBe('/ja/login?error=chatgpt_login_declined&next=%2F');
    expect(await db.select().from(user)).toHaveLength(0);
  });

  it('answers each reader from their own account and signs one out without touching another', async () => {
    const openai = fakeOpenAI();
    const { target, signIn } = hostedApp(openai, { NODE_ENV: 'development' });
    const alice = (await signIn('alice')).cookie;
    const bob = await signIn('bob');
    expect(await readJson(await request(alice, '/api/models', 'GET', undefined, target))).toEqual([{ id: 'gpt-for-alice', label: 'gpt-for-alice' }]);
    expect(await readJson(await request(bob.cookie, '/api/models', 'GET', undefined, target))).toEqual([{ id: 'gpt-for-bob', label: 'gpt-for-bob' }]);
    expect(await readJson(await request(undefined, '/api/models', 'GET', undefined, target))).toEqual([]);

    expect(await readJson(await json(bob.cookie, '/api/chatgpt/sign-out', 'POST', undefined, target))).toEqual({ revocationPending: false });
    expect(openai.state.revoked).toEqual(['REFRESH-bob-0']);
    expect((await request(bob.cookie, '/api/chats', 'GET', undefined, target)).status).toBe(401);
    expect((await request(alice, '/api/chats', 'GET', undefined, target)).status).toBe(200);
    const [bobRow] = await db.select().from(account).where(eq(account.accountId, 'bob'));
    expect(bobRow).toMatchObject({ clientId: 'app_bob', accessToken: null, refreshToken: null });

    // The browser remembers bob's registration, so signing back in does not register again.
    const back = await signIn('bob', bob.cookie);
    expect(back.authorization.searchParams.get('client_id')).toBe('app_bob');
    expect(back.authorization.searchParams.has('agent_name_hint')).toBe(false);
    expect((await request(back.cookie, '/api/chats', 'GET', undefined, target)).status).toBe(200);
    expect(await db.select().from(user)).toHaveLength(2);
  });

  it('rotates an expiring token once however many requests need it', async () => {
    const openai = fakeOpenAI();
    const { accounts, signIn, target } = hostedApp(openai);
    const { cookie } = await signIn('alice');
    const { user: me } = await readJson(await request(cookie, '/api/auth/get-session', 'GET', undefined, target));
    await db.update(account).set({ accessTokenExpiresAt: new Date(0) }).where(eq(account.userId, me.id));
    const tokens = await Promise.all([1, 2, 3].map(() => accounts.forUser(me.id).accessToken()));
    expect(tokens).toEqual(['ACCESS-alice-1', 'ACCESS-alice-1', 'ACCESS-alice-1']);
    expect(openai.state.refreshes).toBe(1);
  });

  it("gives a former local installation's owner, and its plots, to the first account that signs in", async () => {
    const cookie = await signUp('existing-local@example.test');
    const plot = await createPlot(cookie, { name: 'Existing plot' });
    const [owner] = await db.select().from(user);
    await db.insert(account).values({ id: randomUUID(), providerId: 'local-workspace', accountId: 'default', userId: owner!.id });

    const { target, signIn } = hostedApp(fakeOpenAI());
    const first = await signIn('alice');
    const owned = await readJson(await request(first.cookie, '/api/plots', 'GET', undefined, target));
    expect(owned.map((entry: { id: string }) => entry.id)).toContain(plot.id);
    const second = await signIn('bob');
    expect(await readJson(await request(second.cookie, '/api/plots', 'GET', undefined, target))).toEqual([]);
    expect(await db.select().from(account).where(eq(account.providerId, 'local-workspace'))).toHaveLength(0);
  });
});

describe('models', () => {
  it('lists the enabled models', async () => {
    const models = await readJson(await request(undefined, '/api/models'));
    expect(models).toEqual([{ id: 'echo/echo', label: expect.any(String) }]);
  });
});

describe('plots', () => {
  it('supports the CRUD lifecycle', async () => {
    const cookie = await signUp('bob@example.com');

    const created = await createPlot(cookie, {
      name: '아르카디아',
      intro: '  다섯 길드가 나눠 다스리는 도시.  ',
      description: '마법이 흔한 도시국가.',
      language: 'ja',
    });
    expect(created).toMatchObject({
      name: '아르카디아',
      // Trimmed on the way in, and stored beside the setting rather than folded
      // into it: the two have different audiences.
      intro: '다섯 길드가 나눠 다스리는 도시.',
      description: '마법이 흔한 도시국가.',
      language: 'ja',
      visibility: 'private',
      safetyLevel: 'all',
      commentsEnabled: true,
      intros: [],
      tags: [],
      narrator: null,
      customUi: null,
      coverUrl: null,
      likeCount: 0,
      chatCount: 0,
      publishedAt: null,
    });

    expect((await readJson(await request(cookie, '/api/plots'))).map((row: any) => row.id)).toEqual([
      created.id,
    ]);
    expect(await readPlot(cookie, created.id)).toMatchObject({
      id: created.id,
      name: '아르카디아',
      characters: [],
      commentCount: 0,
    });

    const updated = await patchPlot(cookie, created.id, {
      name: '새 이름',
      description: '고친 설명',
      commentsEnabled: false,
    });
    expect(updated).toMatchObject({
      name: '새 이름',
      description: '고친 설명',
      commentsEnabled: false,
      // Untouched fields stay put.
      intro: '다섯 길드가 나눠 다스리는 도시.',
    });

    // The name is required, and never blank.
    expect((await json(cookie, '/api/plots', 'POST', {})).status).toBe(400);
    expect((await json(cookie, '/api/plots', 'POST', { name: '   ' })).status).toBe(400);
    expect((await json(cookie, `/api/plots/${created.id}`, 'PATCH', { name: '' })).status).toBe(400);
    // The reader-facing intro is refused rather than truncated.
    expect((await json(cookie, `/api/plots/${created.id}`, 'PATCH', { intro: '가'.repeat(501) })).status).toBe(400);
    expect((await json(cookie, `/api/plots/${created.id}`, 'PATCH', { intro: '가'.repeat(500) })).status).toBe(200);

    expect((await request(cookie, `/api/plots/${created.id}`, 'DELETE')).status).toBe(204);
    expect((await request(cookie, `/api/plots/${created.id}`)).status).toBe(404);
  });

  it('isolates plots between users', async () => {
    const alice = await signUp('a@example.com');
    const bob = await signUp('b@example.com');
    const plot = await createPlot(alice, { name: '앨리스 작품' });

    expect((await request(bob, `/api/plots/${plot.id}`)).status).toBe(404);
    expect(((await readJson(await request(bob, `/api/plots/${plot.id}`))) as any).code).toBe('not_found');
    expect((await json(bob, `/api/plots/${plot.id}`, 'PATCH', { name: 'x' })).status).toBe(404);
    expect((await request(bob, `/api/plots/${plot.id}`, 'DELETE')).status).toBe(404);
    expect((await json(bob, `/api/plots/${plot.id}/characters`, 'POST', { name: 'x' })).status).toBe(404);
    expect((await request(bob, `/api/plots/${plot.id}/characters`)).status).toBe(404);
    expect(await readJson(await request(bob, '/api/plots'))).toEqual([]);
  });

  it('stores the openings a chat starts from, capped in count and in length', async () => {
    const cookie = await signUp('plot-intros@example.com');
    const plot = await createPlot(cookie, { intros: ['첫 도입부', '두 번째 도입부'] });
    expect(plot.intros).toEqual(['첫 도입부', '두 번째 도입부']);
    // Stored verbatim, macros and all: the chat is what expands them.
    expect((await patchPlot(cookie, plot.id, { intros: ['{{user}}에게'] })).intros).toEqual(['{{user}}에게']);

    const tooMany = await json(cookie, `/api/plots/${plot.id}`, 'PATCH', {
      intros: Array.from({ length: MAX_INTROS_PER_PLOT + 1 }, (_, i) => `도입부 ${i}`),
    });
    expect(tooMany.status).toBe(400);
    expect((await readJson(tooMany)).code).toBe('intro_limit');

    const tooLong = await json(cookie, `/api/plots/${plot.id}`, 'PATCH', {
      intros: ['가'.repeat(MAX_INTRO_TEXT_LENGTH + 1)],
    });
    expect(tooLong.status).toBe(400);
    expect((await readJson(tooLong)).code).toBe('intro_limit');
    expect(
      (await json(cookie, `/api/plots/${plot.id}`, 'PATCH', {
        intros: ['가'.repeat(MAX_INTRO_TEXT_LENGTH)],
      })).status,
    ).toBe(200);

    expect((await json(cookie, `/api/plots/${plot.id}`, 'PATCH', { intros: '도입부' })).status).toBe(400);
    expect((await json(cookie, `/api/plots/${plot.id}`, 'PATCH', { intros: [42] })).status).toBe(400);
    // Nothing of the refusals stuck.
    expect((await readPlot(cookie, plot.id)).intros).toEqual(['가'.repeat(MAX_INTRO_TEXT_LENGTH)]);
  });

  it('keeps the narrator and the custom UI on the work rather than on a member', async () => {
    const cookie = await signUp('plot-settings@example.com');
    const plot = await createPlot(cookie);

    const withNarrator = await patchPlot(cookie, plot.id, {
      narrator: { voice: '건조한 문체.', pov: 'third', unknown: 'dropped' },
    });
    expect(withNarrator.narrator).toEqual({ voice: '건조한 문체.', pov: 'third' });
    // A point of view this build has no label for is dropped, not stored.
    expect((await patchPlot(cookie, plot.id, { narrator: { pov: 'fourth' } })).narrator).toBeNull();
    expect((await patchPlot(cookie, plot.id, { narrator: { voice: '다시.' } })).narrator).toEqual({
      voice: '다시.',
    });
    expect((await patchPlot(cookie, plot.id, { narrator: null })).narrator).toBeNull();
    expect((await json(cookie, `/api/plots/${plot.id}`, 'PATCH', { narrator: '문체' })).status).toBe(400);

    const withUi = await patchPlot(cookie, plot.id, {
      customUi: {
        displayScripts: [{ in: '/\\[hp\\]/g', out: '<b>HP</b>', order: 0, enabled: true }],
        defaultVariables: { hp: '100' },
        componentCode: 'export default () => null;',
        componentCapabilities: ['sendTurn'],
      },
    });
    expect(withUi.customUi).toEqual({
      displayScripts: [{ in: '/\\[hp\\]/g', out: '<b>HP</b>', order: 0, enabled: true }],
      defaultVariables: { hp: '100' },
      componentCode: 'export default () => null;',
      componentCapabilities: ['sendTurn'],
    });
    // An unknown capability is refused rather than silently granting nothing.
    expect(
      (await json(cookie, `/api/plots/${plot.id}`, 'PATCH', {
        customUi: { componentCapabilities: ['impersonate'] },
      })).status,
    ).toBe(400);
    // A config with nothing in it is the same as having none.
    expect((await patchPlot(cookie, plot.id, { customUi: {} })).customUi).toBeNull();
    expect((await json(cookie, `/api/plots/${plot.id}`, 'PATCH', { customUi: [] })).status).toBe(400);
  });

  it('keeps the style on the whitelist the directives can read back', async () => {
    const cookie = await signUp('plot-style@example.com');
    const created = await createPlot(cookie, {
      // A create is a patch onto an empty row: everything the editor may set
      // later it may also set at once.
      style: { tense: 'past', replyLength: 'short', moods: ['romance'] },
    });
    expect(created.style).toEqual({ tense: 'past', replyLength: 'short', moods: ['romance'] });

    const patched = await patchPlot(cookie, created.id, {
      style: {
        // Junk is dropped rather than refused — one unknown option must not cost
        // the creator the ones this build does understand.
        tense: 'future',
        pacing: 'slow',
        difficulty: 'nightmare',
        storytelling: 'sonnet',
        // Deduped, in the creator's order, and clamped to two.
        moods: ['horror', 'horror', 'mystery', 'romance', 'nonsense'],
        statusWindow: true,
        choices: 'keywords',
        nothing: 'at all',
      },
    });
    expect(patched.style).toEqual({
      pacing: 'slow',
      difficulty: 'nightmare',
      moods: ['horror', 'mystery'],
      statusWindow: true,
      choices: 'keywords',
    });
    expect((await readPlot(cookie, created.id)).style).toEqual(patched.style);

    // A style that says nothing is stored as nothing, and so is null.
    expect((await patchPlot(cookie, created.id, { style: { tense: 'sideways' } })).style).toBeNull();
    expect((await patchPlot(cookie, created.id, { style: { pacing: 'fast' } })).style).toEqual({
      pacing: 'fast',
    });
    expect((await patchPlot(cookie, created.id, { style: null })).style).toBeNull();
    expect((await json(cookie, `/api/plots/${created.id}`, 'PATCH', { style: '느리게' })).status).toBe(400);
    expect((await json(cookie, `/api/plots/${created.id}`, 'PATCH', { style: [] })).status).toBe(400);
  });

  it('shows the style on the public page, options and nothing else', async () => {
    const cookie = await signUp('plot-style-public@example.com');
    const plot = await publishablePlot(cookie, {
      style: { difficulty: 'hard', moods: ['horror'], statusWindow: true, choices: 'sentences' },
      narrator: { voice: '건조한 관찰자의 목소리', pov: 'third' },
    });
    await publishPlot(cookie, plot.id);

    // The badge data a reader decides on, plus what the chat page needs to know
    // which of its own toggles are worth offering. Never the compiled directives.
    const view = await readPublicPlot(undefined, plot.id);
    expect(view.style).toEqual({
      difficulty: 'hard',
      moods: ['horror'],
      statusWindow: true,
      choices: 'sentences',
    });
    // The narrator is cut down to its option: `pov` is a badge, `voice` is prompt.
    expect(view.narrator).toEqual({ pov: 'third' });
    expect(JSON.stringify(view)).not.toContain('연출 지시');
    expect(JSON.stringify(view)).not.toContain('건조한 관찰자');
  });

  it('normalizes the tags the catalogue filters on', async () => {
    const cookie = await signUp('plot-tags@example.com');
    const plot = await createPlot(cookie, {
      // Blank, duplicate, over-long and surplus entries are all normalized away.
      tags: [
        '  판타지  ',
        '판타지',
        '',
        'ㄱ'.repeat(30),
        ...Array.from({ length: 12 }, (_, i) => `t${i}`),
      ],
    });
    expect(plot.tags).toEqual([
      '판타지',
      'ㄱ'.repeat(20),
      't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
    ]);
    expect((await patchPlot(cookie, plot.id, { tags: ['로맨스'] })).tags).toEqual(['로맨스']);
    expect((await json(cookie, `/api/plots/${plot.id}`, 'PATCH', { tags: '로맨스' })).status).toBe(400);
    expect((await json(cookie, `/api/plots/${plot.id}`, 'PATCH', { tags: [42] })).status).toBe(400);
  });

  it('imports a V2 JSON card as the plot that wraps it', async () => {
    const cookie = await signUp('json@example.com');
    const plot = await importCard(cookie, cardFile());

    expect(plot.name).toBe('리안');
    // The situation belongs to the work: description and scenario are one field
    // here, and the greetings became the openings a reader picks between.
    expect(plot.description).toBe('왕립 도서관의 사서.\n\n폐관 시간이 지난 도서관.');
    expect(plot.intros).toEqual(['아직 안 가셨군요, {{user}}.', '불이 꺼진 열람실에서 마주쳤다.']);
    expect(plot.tags).toEqual(['판타지']);
    expect(plot.coverUrl).toBeNull();

    // The card itself stays whole on the member it describes.
    expect(plot.characters).toHaveLength(1);
    expect(plot.characters[0]).toMatchObject({ name: '리안', avatarUrl: null, orderIndex: 0 });
    expect(plot.characters[0].card.spec).toBe('v2');
    expect(plot.characters[0].card.description).toBe('왕립 도서관의 사서.');
    expect(plot.characters[0].card.alternateGreetings).toEqual(['불이 꺼진 열람실에서 마주쳤다.']);
  });

  it('imports a PNG card and serves the member avatar', async () => {
    const cookie = await signUp('png@example.com');
    const png = buildPngWithTextChunks({
      chara: Buffer.from(JSON.stringify(v2Card), 'utf-8').toString('base64'),
    });
    const plot = await importCard(cookie, new File([png], 'lian.png', { type: 'image/png' }));
    const member = plot.characters[0];

    expect(plot.name).toBe('리안');
    expect(member.avatarUrl).toBe(`/api/plots/${plot.id}/characters/${member.id}/avatar`);

    const avatar = await request(cookie, member.avatarUrl);
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get('content-type')).toBe('image/png');
    // The stored avatar is the same image minus the card-bearing text chunks.
    expect(new Uint8Array(await avatar.arrayBuffer())).toEqual(stripPngTextChunks(png));
  });

  it('rejects malformed uploads with 400 invalid_card', async () => {
    const cookie = await signUp('bad@example.com');
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2, 3, 4])], 'junk.bin'));
    const res = await request(cookie, '/api/plots/import', 'POST', form);
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('invalid_card');

    // Corrupted zip: fflate throws a raw error, which must not escape as a 500.
    const corruptZip = new Uint8Array(64);
    corruptZip.set([0x50, 0x4b, 0x03, 0x04]);
    const zipForm = new FormData();
    zipForm.append('file', new File([corruptZip], 'broken.charx'));
    const zipRes = await request(cookie, '/api/plots/import', 'POST', zipForm);
    expect(zipRes.status).toBe(400);
    expect((await readJson(zipRes)).code).toBe('invalid_card');

    // And a request with no file at all.
    expect((await request(cookie, '/api/plots/import', 'POST', new FormData())).status).toBe(400);
  });

  it('lifts the narrator and the custom UI off an imported card onto the plot', async () => {
    const cookie = await signUp('import-lift@example.com');
    const card = {
      ...v2Card,
      data: {
        ...v2Card.data,
        extensions: {
          shizue: {
            intro: '독자에게 건네는 한 줄.',
            narrator: { voice: '건조한 문체.', pov: 'omniscient' },
            componentCode: 'export default () => null;',
            componentCapabilities: ['sendTurn'],
          },
          risuai: {
            customScripts: [
              { in: '\\[hp\\]', out: '<b>HP</b>', type: 'editdisplay', ableFlag: true },
            ],
          },
        },
      },
    };
    const plot = await importCard(
      cookie,
      new File([JSON.stringify(card)], 'lian.json', { type: 'application/json' }),
    );

    expect(plot.intro).toBe('독자에게 건네는 한 줄.');
    expect(plot.narrator).toEqual({ voice: '건조한 문체.', pov: 'omniscient' });
    expect(plot.customUi).toMatchObject({
      componentCode: 'export default () => null;',
      componentCapabilities: ['sendTurn'],
    });
    expect(plot.customUi.displayScripts).toHaveLength(1);
    // The card is the import container, so it keeps its own copy for the round trip.
    expect(plot.characters[0].card.narrator).toEqual({ voice: '건조한 문체.', pov: 'omniscient' });
  });

  it('publishes, gates on the basics and unpublishes', async () => {
    const alice = await signUp('publish@example.com');
    const bob = await signUp('publish-reader@example.com');
    const bare = await createPlot(alice, { name: '빈 작품' });

    // Neither a setting nor an opening: nothing to find yet.
    const refused = await json(alice, `/api/plots/${bare.id}/publish`, 'POST', { publish: true });
    expect(refused.status).toBe(400);
    expect((await readJson(refused)).code).toBe('not_publishable');
    expect((await readPlot(alice, bare.id)).visibility).toBe('private');

    // Only the setting: still not publishable — a reader needs a way in.
    await patchPlot(alice, bare.id, { description: '설명만 있음' });
    expect((await json(alice, `/api/plots/${bare.id}/publish`, 'POST', { publish: true })).status).toBe(400);
    // An opening of nothing but whitespace is no opening.
    await patchPlot(alice, bare.id, { intros: ['   '] });
    expect((await json(alice, `/api/plots/${bare.id}/publish`, 'POST', { publish: true })).status).toBe(400);

    await patchPlot(alice, bare.id, { intros: ['안녕'] });
    const published = await publishPlot(alice, bare.id);
    expect(published.visibility).toBe('public');
    expect(published.publishedAt).toEqual(expect.any(String));

    // Unpublishing an unpublishable plot is always allowed, and `publish` is
    // required rather than defaulted.
    expect((await json(alice, `/api/plots/${bare.id}/publish`, 'POST', { publish: false })).status).toBe(200);
    expect((await json(alice, `/api/plots/${bare.id}/publish`, 'POST', {})).status).toBe(400);
    // Publishing stays owner-only.
    expect((await json(bob, `/api/plots/${bare.id}/publish`, 'POST', { publish: true })).status).toBe(404);
  });
});

describe('plot characters', () => {
  it('adds, edits, reorders and removes members under the roster cap', async () => {
    const cookie = await signUp('roster@example.com');
    const plot = await createPlot(cookie);

    const first = await addCharacter(cookie, plot.id, { name: '리안' });
    expect(first).toMatchObject({ name: '리안', orderIndex: 0, avatarUrl: null });
    // A member with no card of its own still gets an empty one to grow into.
    expect(first.card.name).toBe('리안');
    const second = await addCharacter(cookie, plot.id, {
      name: '세라',
      card: { description: '기사단장.', personality: '무뚝뚝하다.' },
    });
    expect(second.orderIndex).toBe(1);
    expect(second.card.description).toBe('기사단장.');

    expect((await readJson(await request(cookie, `/api/plots/${plot.id}/characters`))).map((m: any) => m.name)).toEqual([
      '리안',
      '세라',
    ]);

    const renamed = await readJson(
      await json(cookie, `/api/plots/${plot.id}/characters/${first.id}`, 'PATCH', {
        name: '리안느',
        card: { ...first.card, description: '왕립 도서관의 사서.' },
      }),
    );
    expect(renamed).toMatchObject({ name: '리안느', orderIndex: 0 });
    expect(renamed.card.description).toBe('왕립 도서관의 사서.');
    expect((await json(cookie, `/api/plots/${plot.id}/characters/${first.id}`, 'PATCH', { name: '  ' })).status).toBe(400);

    // The arrangement is rewritten whole, and it has to name the whole roster.
    const reordered = await readJson(
      await json(cookie, `/api/plots/${plot.id}/characters/reorder`, 'POST', {
        ids: [second.id, first.id],
      }),
    );
    expect(reordered.map((member: any) => member.name)).toEqual(['세라', '리안느']);
    expect(reordered.map((member: any) => member.orderIndex)).toEqual([0, 1]);
    for (const ids of [[first.id], [first.id, first.id], [first.id, second.id, randomUUID()], 'x']) {
      expect((await json(cookie, `/api/plots/${plot.id}/characters/reorder`, 'POST', { ids })).status).toBe(400);
    }

    expect((await request(cookie, `/api/plots/${plot.id}/characters/${first.id}`, 'DELETE')).status).toBe(204);
    expect((await readPlot(cookie, plot.id)).characters.map((m: any) => m.name)).toEqual(['세라']);
    expect((await request(cookie, `/api/plots/${plot.id}/characters/${first.id}`, 'DELETE')).status).toBe(404);
  });

  it(`caps a plot at ${MAX_CHARACTERS_PER_PLOT} members`, async () => {
    const cookie = await signUp('roster-cap@example.com');
    const plot = await createPlot(cookie);
    for (let i = 0; i < MAX_CHARACTERS_PER_PLOT; i += 1) {
      await addCharacter(cookie, plot.id, { name: `멤버 ${i}` });
    }

    const over = await json(cookie, `/api/plots/${plot.id}/characters`, 'POST', { name: '한 명 더' });
    expect(over.status).toBe(400);
    expect((await readJson(over)).code).toBe('character_limit');
    expect((await readPlot(cookie, plot.id)).characters).toHaveLength(MAX_CHARACTERS_PER_PLOT);
  });

  it('holds the roster cap against a concurrent create', async () => {
    const cookie = await signUp('roster-race@example.com');
    const plot = await createPlot(cookie);
    // One short of the cap, straight into the table — the route only counts them.
    await db.insert(characters).values(
      Array.from({ length: MAX_CHARACTERS_PER_PLOT - 1 }, (_, i) => ({
        plotId: plot.id,
        name: `seed-${i}`,
        card: { ...emptyCardShape, name: `seed-${i}` },
        orderIndex: i,
      })),
    );

    // A competing transaction takes the plot lock, inserts the last member and
    // holds it. The create has to queue behind it and then see a full roster;
    // without the lock it would count one short and store an eleventh.
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: plots.id }).from(plots).where(eq(plots.id, plot.id)).for('update');
      await tx.insert(characters).values({
        plotId: plot.id,
        name: 'held',
        card: { ...emptyCardShape, name: 'held' },
        orderIndex: 99,
      });
      await held;
    });

    const inFlight = json(cookie, `/api/plots/${plot.id}/characters`, 'POST', { name: '경쟁자' });
    // Long enough that an unlocked create would have finished by now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    open();
    await holder;

    const res = await inFlight;
    expect(res.status, await res.clone().text()).toBe(400);
    expect((await readJson(res)).code).toBe('character_limit');
    expect((await readPlot(cookie, plot.id)).characters).toHaveLength(MAX_CHARACTERS_PER_PLOT);
  });

  it('imports a card as one more member without touching the plot around it', async () => {
    const cookie = await signUp('member-import@example.com');
    const plot = await createPlot(cookie, { description: '원래 설명', intros: ['원래 도입부'] });

    const form = new FormData();
    form.append('file', cardFile());
    const res = await request(cookie, `/api/plots/${plot.id}/characters/import`, 'POST', form);
    expect(res.status, await res.clone().text()).toBe(201);
    const member = await readJson(res);
    expect(member.name).toBe('리안');
    expect(member.card.description).toBe('왕립 도서관의 사서.');

    // Nothing was lifted: the cast joined the work, it did not redecorate it.
    const after = await readPlot(cookie, plot.id);
    expect(after).toMatchObject({ description: '원래 설명', intros: ['원래 도입부'], narrator: null });
    expect(after.characters.map((m: any) => m.name)).toEqual(['리안']);
  });

  it('takes an avatar upload directly and gives it back', async () => {
    const alice = await signUp('avatar-upload@example.com');
    const bob = await signUp('avatar-upload-other@example.com');
    const plot = await createPlot(alice);
    const member = await addCharacter(alice, plot.id, { name: '리안' });
    const url = `/api/plots/${plot.id}/characters/${member.id}/avatar`;
    expect(member.avatarUrl).toBeNull();

    // A PNG carrying a card is stripped here exactly as on the import path.
    const png = buildPngWithTextChunks({
      chara: Buffer.from(JSON.stringify(v2Card), 'utf-8').toString('base64'),
    });
    const uploaded = await readJson(await uploadFile(alice, url, png, 'a.png'));
    expect(uploaded.avatarUrl).toBe(url);
    const served = await request(alice, url);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(stripPngTextChunks(png));

    // Re-uploading in another format leaves no orphan behind under the old key.
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
    await uploadFile(alice, url, gif, 'a.gif');
    expect((await request(alice, url)).headers.get('content-type')).toBe('image/gif');
    await expect(readFile(join(storageDir, 'avatars', `${member.id}.png`))).rejects.toThrow();

    // Bytes that are not an image, and someone else's plot.
    const junk = await uploadFile(alice, url, new Uint8Array([1, 2, 3, 4]), 'x.bin');
    expect(junk.status).toBe(400);
    expect((await readJson(junk)).code).toBe('invalid_asset');
    expect((await uploadFile(bob, url, gif, 'a.gif')).status).toBe(404);
    expect((await request(bob, url, 'DELETE')).status).toBe(404);

    const cleared = await readJson(await request(alice, url, 'DELETE'));
    expect(cleared.avatarUrl).toBeNull();
    expect((await request(alice, url)).status).toBe(404);
    await expect(readFile(join(storageDir, 'avatars', `${member.id}.gif`))).rejects.toThrow();
  });

  it('takes the avatars away with the member and with the plot', async () => {
    const cookie = await signUp('avatar-cleanup@example.com');
    const plot = await createPlot(cookie);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
    const staying = await addCharacter(cookie, plot.id, { name: '남는 멤버' });
    const going = await addCharacter(cookie, plot.id, { name: '나가는 멤버' });
    for (const member of [staying, going]) {
      await uploadFile(cookie, `/api/plots/${plot.id}/characters/${member.id}/avatar`, gif, 'a.gif');
    }

    expect((await request(cookie, `/api/plots/${plot.id}/characters/${going.id}`, 'DELETE')).status).toBe(204);
    await expect(readFile(join(storageDir, 'avatars', `${going.id}.gif`))).rejects.toThrow();
    await readFile(join(storageDir, 'avatars', `${staying.id}.gif`));

    expect((await request(cookie, `/api/plots/${plot.id}`, 'DELETE')).status).toBe(204);
    await expect(readFile(join(storageDir, 'avatars', `${staying.id}.gif`))).rejects.toThrow();
  });
});

describe('card export', () => {
  const stCardFile = (): File =>
    new File([JSON.stringify(stCard())], 'elara.json', { type: 'application/json' });
  const exportPath = (plotId: string, memberId: string, format: string) =>
    `/api/plots/${plotId}/characters/${memberId}/export?format=${format}`;

  it('hands a member back as a V3 card with the plot written over it, to the owner only', async () => {
    const alice = await signUp('card-export@example.com');
    const bob = await signUp('card-export-other@example.com');
    // Imported, so the stored card holds everything the ST card carried —
    // including the lorebook settings the editor's save may not keep.
    const plot = await importCard(alice, stCardFile());
    const member = plot.characters[0];
    const plotEntry = {
      keys: ['왕궁'],
      secondaryKeys: [],
      selective: false,
      content: '왕궁은 북쪽 언덕에 있다.',
      enabled: true,
      constant: false,
      insertionOrder: 0,
      caseSensitive: false,
      useRegex: false,
      position: 'before_char',
    };
    await patchPlot(alice, plot.id, {
      intros: ['첫 인사.', '두 번째.'],
      lorebook: [plotEntry],
      narrator: { pov: 'third' },
    });

    const res = await request(alice, exportPath(plot.id, member.id, 'json'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="___.json"; filename*=UTF-8''${encodeURIComponent('엘라라.json')}`,
    );
    const exported = await readJson(res);
    expect(exported.spec).toBe('chara_card_v3');
    const { card } = parseCard(exported);
    expect(card.name).toBe('엘라라');
    expect(card.firstMes).toBe('첫 인사.');
    expect(card.alternateGreetings).toEqual(['두 번째.']);
    expect(card.narrator).toEqual({ pov: 'third' });
    expect(card.lorebook).toEqual([...member.card.lorebook, plotEntry]);
    // The character note came in as a lorebook entry and goes out as one.
    expect(card.lorebook.filter((entry) => entry.content.includes('숲을 떠나지'))).toHaveLength(1);

    expect((await request(bob, exportPath(plot.id, member.id, 'json'))).status).toBe(404);
    expect((await request(undefined, exportPath(plot.id, member.id, 'json'))).status).toBe(401);
    expect((await request(alice, exportPath(plot.id, randomUUID(), 'json'))).status).toBe(404);
    expect((await request(alice, exportPath(plot.id, member.id, 'xml'))).status).toBe(400);
  });

  it('writes the PNG on the avatar, the cover, or a placeholder', async () => {
    const cookie = await signUp('card-export-png@example.com');
    const plot = await importCard(cookie, stCardFile());
    const member = plot.characters[0];
    const exportPng = async (): Promise<Uint8Array> => {
      const res = await request(cookie, exportPath(plot.id, member.id, 'png'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      return new Uint8Array(await res.arrayBuffer());
    };

    // No avatar and no cover: the placeholder, carrying the card.
    const bare = await exportPng();
    expect(stripPngTextChunks(bare)).toEqual(placeholderPng());
    expect([...readPngTextChunks(bare).keys()]).toEqual(['chara', 'ccv3']);
    const reparsed = parseCard(bare).card;
    expect(reparsed.name).toBe('엘라라');
    expect(reparsed.lorebook).toEqual(member.card.lorebook);

    const cover = buildPngWithTextChunks({ Title: 'cover' });
    await uploadFile(cookie, `/api/plots/${plot.id}/cover`, cover, 'c.png');
    expect(stripPngTextChunks(await exportPng())).toEqual(stripPngTextChunks(cover));

    // The member's own picture wins over the cover (any PNG unlike the cover's will do).
    const avatarPath = `/api/plots/${plot.id}/characters/${member.id}/avatar`;
    const avatar = placeholderPng();
    await uploadFile(cookie, avatarPath, avatar, 'a.png');
    expect(stripPngTextChunks(await exportPng())).toEqual(avatar);

    // An avatar the export cannot write into gives way to the placeholder, not the cover.
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
    await uploadFile(cookie, avatarPath, gif, 'a.gif');
    expect(stripPngTextChunks(await exportPng())).toEqual(placeholderPng());
  });
});

describe('personas', () => {
  it('supports CRUD', async () => {
    const cookie = await signUp('persona@example.com');
    const created = await readJson(
      await json(cookie, '/api/personas', 'POST', { name: '민준', description: '대학생' }),
    );
    expect(created.name).toBe('민준');

    expect(await readJson(await request(cookie, '/api/personas'))).toHaveLength(1);

    const updated = await readJson(
      await json(cookie, `/api/personas/${created.id}`, 'PUT', { description: '대학원생' }),
    );
    expect(updated.description).toBe('대학원생');

    expect((await request(cookie, `/api/personas/${created.id}`, 'DELETE')).status).toBe(204);
    expect(await readJson(await request(cookie, '/api/personas'))).toEqual([]);
  });
});

describe('notes', () => {
  /** Caps from docs/ARCHITECTURE.md Chunk 11 — enforced by the API. */
  const MAX_NOTES = 100;
  const MAX_LENGTH = 2000;
  const MAX_PER_CHAT = 10;

  const createNote = async (cookie: string, body: Record<string, unknown>): Promise<any> => {
    const res = await json(cookie, '/api/notes', 'POST', body);
    expect(res.status, await res.clone().text()).toBe(201);
    return readJson(res);
  };

  it('supports CRUD and filters by group', async () => {
    const cookie = await signUp('note-crud@example.com');
    const created = await createNote(cookie, {
      title: '말투',
      content: '존댓말을 쓴다.',
      groupName: '규칙',
    });
    expect(created).toMatchObject({ title: '말투', content: '존댓말을 쓴다.', groupName: '규칙' });
    await createNote(cookie, { content: '그룹 없는 노트' });

    expect(await readJson(await request(cookie, '/api/notes'))).toHaveLength(2);
    const filtered = await readJson(await request(cookie, '/api/notes?group=규칙'));
    expect(filtered.map((note: any) => note.id)).toEqual([created.id]);
    expect(await readJson(await request(cookie, '/api/notes?group=없는그룹'))).toEqual([]);

    const updated = await readJson(
      await json(cookie, `/api/notes/${created.id}`, 'PUT', { content: '반말을 쓴다.', groupName: '' }),
    );
    expect(updated).toMatchObject({ title: '말투', content: '반말을 쓴다.', groupName: '' });

    expect((await request(cookie, `/api/notes/${created.id}`, 'DELETE')).status).toBe(204);
    expect(await readJson(await request(cookie, '/api/notes'))).toHaveLength(1);
  });

  it('isolates notes between users', async () => {
    const alice = await signUp('note-a@example.com');
    const bob = await signUp('note-b@example.com');
    const note = await createNote(alice, { content: '앨리스의 노트' });

    expect(await readJson(await request(bob, '/api/notes'))).toEqual([]);
    expect((await json(bob, `/api/notes/${note.id}`, 'PUT', { content: '남의 것' })).status).toBe(404);
    expect((await request(bob, `/api/notes/${note.id}`, 'DELETE')).status).toBe(404);
  });

  it('caps the note length and the number of notes per account', async () => {
    const cookie = await signUp('note-cap@example.com');
    const tooLong = await json(cookie, '/api/notes', 'POST', { content: 'ㄱ'.repeat(MAX_LENGTH + 1) });
    expect(tooLong.status).toBe(400);
    expect((await readJson(tooLong)).code).toBe('note_limit');
    // Exactly at the cap is fine.
    await createNote(cookie, { content: 'ㄱ'.repeat(MAX_LENGTH) });

    // Fill the account up directly; the endpoint only has to reject the next one.
    const session = await readJson(await request(cookie, '/api/auth/get-session'));
    await db.insert(userNotes).values(
      Array.from({ length: MAX_NOTES - 1 }, (_, index) => ({
        userId: session.user.id as string,
        content: `채우기 ${index}`,
      })),
    );
    const overflow = await json(cookie, '/api/notes', 'POST', { content: '한 개 더' });
    expect(overflow.status).toBe(400);
    expect((await readJson(overflow)).code).toBe('note_limit');

    // An existing note can still be edited past the cap.
    const [existing] = await db.select().from(userNotes).where(eq(userNotes.userId, session.user.id));
    expect((await json(cookie, `/api/notes/${existing!.id}`, 'PUT', { content: '수정' })).status).toBe(200);
  });

  it('holds the account cap against a concurrent create', async () => {
    const cookie = await signUp('note-race@example.com');
    const session = await readJson(await request(cookie, '/api/auth/get-session'));
    const userId = session.user.id as string;
    // 99 rows straight into the table — the route only counts them.
    await db.insert(userNotes).values(
      Array.from({ length: MAX_NOTES - 1 }, (_, index) => ({ userId, content: `채우기 ${index}` })),
    );

    // A competing transaction takes the account lock, inserts the 100th note and
    // holds it. The create has to queue behind it and then see a full account;
    // without the lock it would count 99 (the row is still uncommitted) and store
    // a 101st note.
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update');
      await tx.insert(userNotes).values({ userId, content: '경쟁 노트' });
      await held;
    });

    const inFlight = json(cookie, '/api/notes', 'POST', { content: '한 개 더' });
    // Long enough that an unlocked create would have finished by now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    open();
    await holder;

    const res = await inFlight;
    expect(res.status, await res.clone().text()).toBe(400);
    expect((await readJson(res)).code).toBe('note_limit');
    expect(await readJson(await request(cookie, '/api/notes'))).toHaveLength(MAX_NOTES);
  });

  it('holds the per-chat cap against a concurrent attach', async () => {
    const cookie = await signUp('note-attach-race@example.com');
    const { chatId } = await setupChat(cookie);
    const ids: string[] = [];
    for (let index = 0; index < MAX_PER_CHAT + 1; index += 1) {
      ids.push((await createNote(cookie, { content: `노트 ${index}` })).id);
    }
    await db
      .insert(chatNoteLinks)
      .values(ids.slice(0, MAX_PER_CHAT - 1).map((noteId) => ({ chatId, noteId })));

    // Same race as the account cap, on the chat row: the tenth link is inserted
    // and held, so the attach must queue and then find the chat full.
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).for('update');
      await tx.insert(chatNoteLinks).values({ chatId, noteId: ids[MAX_PER_CHAT - 1]! });
      await held;
    });

    const inFlight = json(cookie, `/api/chats/${chatId}/notes/${ids.at(-1)}`, 'POST');
    await new Promise((resolve) => setTimeout(resolve, 300));
    open();
    await holder;

    const res = await inFlight;
    expect(res.status, await res.clone().text()).toBe(400);
    expect((await readJson(res)).code).toBe('note_limit');
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).chat.noteIds).toHaveLength(
      MAX_PER_CHAT,
    );
  });

  it('attaches notes to a chat and injects them after the chat note', async () => {
    const cookie = await signUp('note-attach@example.com');
    const { chatId } = await setupChat(cookie);
    const first = await createNote(cookie, { title: '첫 노트', content: '첫 노트 본문입니다.' });
    const second = await createNote(cookie, { title: '둘째 노트', content: '둘째 노트 본문입니다.' });
    await json(cookie, `/api/chats/${chatId}`, 'PATCH', { note: '챗 전용 노트입니다.' });

    const attached = await readJson(await json(cookie, `/api/chats/${chatId}/notes/${second.id}`, 'POST'));
    expect(attached.chat.noteIds).toEqual([second.id]);
    // Re-attaching is a no-op, not a conflict.
    expect((await json(cookie, `/api/chats/${chatId}/notes/${second.id}`, 'POST')).status).toBe(200);
    const both = await readJson(await json(cookie, `/api/chats/${chatId}/notes/${first.id}`, 'POST'));
    // Creation order, not attach order — the link carries no order of its own.
    expect(both.chat.noteIds).toEqual([first.id, second.id]);
    expect((await readJson(await request(cookie, '/api/chats')))[0].noteIds).toEqual([first.id, second.id]);

    const { app: capturing, prompts } = capturingApp();
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '안녕하세요' }, capturing),
    );
    // One author's note slot: the chat's own note first, then the attached bodies.
    expect(prompts.at(-1)!.messages[0]).toEqual({
      role: 'system',
      content: '챗 전용 노트입니다.\n\n첫 노트 본문입니다.\n\n둘째 노트 본문입니다.',
    });

    const detached = await readJson(
      await request(cookie, `/api/chats/${chatId}/notes/${first.id}`, 'DELETE'),
    );
    expect(detached.chat.noteIds).toEqual([second.id]);
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, capturing));
    expect(prompts.at(-1)!.messages[0]!.content).toBe('챗 전용 노트입니다.\n\n둘째 노트 본문입니다.');

    // A deleted note takes its links with it.
    expect((await request(cookie, `/api/notes/${second.id}`, 'DELETE')).status).toBe(204);
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).chat.noteIds).toEqual([]);
  });

  it('caps the notes attached to one chat', async () => {
    const cookie = await signUp('note-chat-cap@example.com');
    const { chatId } = await setupChat(cookie);

    const ids: string[] = [];
    for (let index = 0; index < MAX_PER_CHAT + 1; index += 1) {
      ids.push((await createNote(cookie, { content: `노트 ${index}` })).id);
    }
    for (const id of ids.slice(0, MAX_PER_CHAT)) {
      expect((await json(cookie, `/api/chats/${chatId}/notes/${id}`, 'POST')).status).toBe(200);
    }

    const overflow = await json(cookie, `/api/chats/${chatId}/notes/${ids.at(-1)}`, 'POST');
    expect(overflow.status).toBe(400);
    expect((await readJson(overflow)).code).toBe('note_limit');
    // Detaching one makes room again.
    await request(cookie, `/api/chats/${chatId}/notes/${ids[0]}`, 'DELETE');
    expect((await json(cookie, `/api/chats/${chatId}/notes/${ids.at(-1)}`, 'POST')).status).toBe(200);
  });

  it('refuses to attach a note or a chat that belongs to someone else', async () => {
    const alice = await signUp('note-attach-a@example.com');
    const bob = await signUp('note-attach-b@example.com');
    const { chatId } = await setupChat(alice);
    const bobNote = await createNote(bob, { content: '밥의 노트' });
    const aliceNote = await createNote(alice, { content: '앨리스의 노트' });

    expect((await json(alice, `/api/chats/${chatId}/notes/${bobNote.id}`, 'POST')).status).toBe(404);
    expect((await json(bob, `/api/chats/${chatId}/notes/${aliceNote.id}`, 'POST')).status).toBe(404);
    expect((await json(alice, `/api/chats/${chatId}/notes/${randomUUID()}`, 'POST')).status).toBe(404);
    expect((await readJson(await request(alice, `/api/chats/${chatId}`))).chat.noteIds).toEqual([]);
  });
});

describe('chats', () => {
  it('creates a chat with the plot opening as the root message', async () => {
    const cookie = await signUp('chat@example.com');
    const { chatId, state } = await setupChat(cookie);

    expect(state.path).toHaveLength(1);
    expect(state.path[0].role).toBe('assistant');
    // {{user}} resolves to the default user name when no persona is attached.
    expect(state.path[0].content).toBe('아직 안 가셨군요, 유저.');
    expect(state.chat.headMessageId).toBe(state.path[0].id);
    expect(state.chat.note).toBe('');
    // The plot's second opening is stored as a sibling of the first.
    expect(state.siblings[state.path[0].id].index).toBe(0);
    expect(state.siblings[state.path[0].id].total).toBe(2);

    const list = await readJson(await request(cookie, `/api/chats?plotId=${state.chat.plotId}`));
    expect(list.map((chat: any) => chat.id)).toEqual([chatId]);
    expect((await request(cookie, '/api/chats?plotId=not-a-uuid')).status).toBe(400);
  });

  it('opens on intros[introIndex]', async () => {
    const cookie = await signUp('greeting@example.com');
    const plot = await importCard(cookie, cardFile());
    const state = await startChat(cookie, plot.id, { introIndex: 1 });
    expect(state.path[0].content).toBe('불이 꺼진 열람실에서 마주쳤다.');
    // The index is a position in the plot's own list, not an offset into it.
    expect(state.siblings[state.path[0].id].index).toBe(1);
    expect((await startChat(cookie, plot.id, { introIndex: 0 })).path[0].content).toBe(
      '아직 안 가셨군요, 유저.',
    );
    for (const introIndex of [-1, 1.5, '0']) {
      expect((await json(cookie, '/api/chats', 'POST', { plotId: plot.id, model: 'echo/echo', introIndex })).status).toBe(400);
    }
  });

  it('stores every intro as a root sibling and opens on the chosen one', async () => {
    const cookie = await signUp('greeting-siblings@example.com');
    const plot = await createPlot(cookie, {
      name: '인사 작품',
      intros: ['기본 인사', '두 번째 인사', '세 번째 인사'],
    });
    const state = await startChat(cookie, plot.id);
    const chatId = state.chat.id;

    // Only the chosen opening is on the path; the others wait as siblings.
    expect(state.path).toHaveLength(1);
    expect(state.path[0].content).toBe('기본 인사');
    const info = state.siblings[state.path[0].id];
    expect(info).toEqual({ index: 0, total: 3, ids: [expect.any(String), expect.any(String), expect.any(String)] });

    // Swiping is the ordinary head move, and the order is the creator's.
    for (const [index, content] of [
      [1, '두 번째 인사'],
      [2, '세 번째 인사'],
    ] as const) {
      const swiped = await readJson(
        await json(cookie, `/api/chats/${chatId}/head`, 'POST', { messageId: info.ids[index] }),
      );
      expect(swiped.path).toHaveLength(1);
      expect(swiped.path[0].content).toBe(content);
      expect(swiped.siblings[swiped.path[0].id].index).toBe(index);
    }

    // Regenerating on an intro root adds one more root, not a child.
    const done = (await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST'))).at(-1)!;
    expect(done.event).toBe('done');
    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.path).toHaveLength(1);
    expect(after.path[0].id).toBe(done.data.messageId);
    expect(after.path[0].parentId).toBeNull();
    expect(after.siblings[after.path[0].id]).toEqual({
      index: 3,
      total: 4,
      ids: [...info.ids, done.data.messageId],
    });
  });

  it('caps the intros stored in one chat', async () => {
    const cookie = await signUp('greeting-cap@example.com');
    // The plot cap is the same ten, so the chat's own truncation is exercised by
    // writing the eleventh straight into the column.
    const plot = await createPlot(cookie, {
      name: '인사 많은 작품',
      intros: Array.from({ length: 10 }, (_, i) => `도입부 ${i}`),
    });
    await db
      .update(plots)
      .set({ intros: Array.from({ length: 12 }, (_, i) => `도입부 ${i}`) })
      .where(eq(plots.id, plot.id));

    const state = await startChat(cookie, plot.id);
    const info = state.siblings[state.path[0].id];
    expect(info.total).toBe(10);

    const last = await readJson(
      await json(cookie, `/api/chats/${state.chat.id}/head`, 'POST', { messageId: info.ids[9] }),
    );
    expect(last.path[0].content).toBe('도입부 9');

    // An intro past the cap is not stored, so a chat cannot start on it either.
    const beyond = await json(cookie, '/api/chats', 'POST', {
      plotId: plot.id,
      model: 'echo/echo',
      introIndex: 10,
    });
    expect(beyond.status).toBe(400);
    expect((await readJson(beyond)).code).toBe('invalid_request');
  });

  it('skips the empty intros and starts a chat with none at all', async () => {
    const cookie = await signUp('greeting-empty@example.com');
    const withGaps = await createPlot(cookie, { intros: ['첫 도입부', '   ', '세 번째 도입부'] });
    const state = await startChat(cookie, withGaps.id);
    expect(state.siblings[state.path[0].id].total).toBe(2);

    // A plot that offers nothing simply opens on an empty branch.
    const bare = await createPlot(cookie, { name: '도입부 없는 작품' });
    const empty = await startChat(cookie, bare.id);
    expect(empty.path).toEqual([]);
    expect(empty.chat.headMessageId).toBeNull();
  });

  it('streams a reply over SSE and persists it', async () => {
    const cookie = await signUp('send@example.com');
    const { chatId } = await setupChat(cookie);

    const events = await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '안녕하세요 리안' }),
    );
    const deltas = events.filter((event) => event.event === 'delta');
    const done = events.at(-1)!;
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((event) => event.data.text).join('')).toBe('안녕하세요 리안');
    expect(done.event).toBe('done');
    expect(done.data.messageId).toEqual(expect.any(String));
    expect(done.data.usage.completionTokens).toBeGreaterThan(0);

    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(state.path.map((message: any) => message.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(state.path[1].content).toBe('안녕하세요 리안');
    expect(state.path[2].id).toBe(done.data.messageId);
    expect(state.path[2].content).toBe('안녕하세요 리안');
    expect(state.path[2].model).toBe('echo/echo');
    expect(state.chat.headMessageId).toBe(done.data.messageId);
  });

  it('regenerates a sibling, moves the head, and switches back with POST /head', async () => {
    const cookie = await signUp('regen@example.com');
    const { chatId } = await setupChat(cookie);
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }));

    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const firstReply = before.path[2];

    const events = await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST'));
    const regenerated = events.at(-1)!;
    expect(regenerated.event).toBe('done');

    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.path).toHaveLength(3);
    expect(after.path[2].id).toBe(regenerated.data.messageId);
    expect(after.path[2].id).not.toBe(firstReply.id);
    expect(after.path[2].parentId).toBe(firstReply.parentId);
    expect(after.chat.headMessageId).toBe(regenerated.data.messageId);
    expect(after.siblings[after.path[2].id]).toEqual({
      index: 1,
      total: 2,
      ids: [firstReply.id, regenerated.data.messageId],
    });

    const switched = await readJson(await json(cookie, `/api/chats/${chatId}/head`, 'POST', {
      messageId: firstReply.id,
    }));
    expect(switched.chat.headMessageId).toBe(firstReply.id);
    expect(switched.path[2].id).toBe(firstReply.id);
    expect(switched.siblings[firstReply.id]).toEqual({
      index: 0,
      total: 2,
      ids: [firstReply.id, regenerated.data.messageId],
    });
  });

  it('forks a branch when a user message is edited', async () => {
    const cookie = await signUp('edit@example.com');
    const { chatId } = await setupChat(cookie);
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }));

    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const userMessage = before.path[1];

    const patched = await readJson(
      await json(cookie, `/api/messages/${userMessage.id}`, 'PATCH', { content: '다른 질문' }),
    );
    expect(patched.messageId).not.toBe(userMessage.id);

    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    // The new branch drops the reply that followed the original message.
    expect(after.path.map((message: any) => message.id)).toEqual([before.path[0].id, patched.messageId]);
    expect(after.path[1].content).toBe('다른 질문');
    expect(after.siblings[patched.messageId]).toEqual({
      index: 1,
      total: 2,
      ids: [userMessage.id, patched.messageId],
    });
    expect(after.chat.headMessageId).toBe(patched.messageId);

    // Assistant edits stay in place.
    const assistantId = before.path[2].id;
    const edited = await readJson(
      await json(cookie, `/api/messages/${assistantId}`, 'PATCH', { content: '고친 답변' }),
    );
    expect(edited.messageId).toBe(assistantId);
    const switched = await readJson(await json(cookie, `/api/chats/${chatId}/head`, 'POST', {
      messageId: assistantId,
    }));
    expect(switched.path.at(-1).content).toBe('고친 답변');
  });

  it('exposes sibling ids that drive swiping in both directions', async () => {
    const cookie = await signUp('swipe@example.com');
    const { chatId } = await setupChat(cookie);
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }));

    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const firstReply = before.path[2];
    const regenerated = (await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST'))).at(-1)!;

    // Fresh read, as after a page reload: ids alone must be enough to swipe.
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const info = state.siblings[state.path[2].id];
    expect(info).toEqual({
      index: 1,
      total: 2,
      ids: [firstReply.id, regenerated.data.messageId],
    });
    expect(info.ids).toHaveLength(info.total);
    expect(info.ids[info.index]).toBe(state.path[2].id);

    const back = await readJson(await json(cookie, `/api/chats/${chatId}/head`, 'POST', {
      messageId: info.ids[info.index - 1],
    }));
    expect(back.chat.headMessageId).toBe(firstReply.id);
    const backInfo = back.siblings[firstReply.id];
    expect(backInfo.index).toBe(0);
    expect(backInfo.ids).toEqual(info.ids);

    const forward = await readJson(await json(cookie, `/api/chats/${chatId}/head`, 'POST', {
      messageId: backInfo.ids[backInfo.index + 1],
    }));
    expect(forward.chat.headMessageId).toBe(regenerated.data.messageId);
  });

  it('deletes a message with everything grown from it and ends the branch at its parent', async () => {
    const cookie = await signUp('delete-message@example.com');
    const { chatId } = await setupChat(cookie);
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }));
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '둘째 질문' }));

    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(before.path).toHaveLength(5);
    const kept = before.path.slice(0, 3).map((message: any) => message.id);

    // Mid-branch: the second question takes the reply under it with it, and the
    // head — which was that reply — comes back up to the question's parent.
    const after = await readJson(
      await request(cookie, `/api/chats/${chatId}/messages/${before.path[3].id}`, 'DELETE'),
    );
    expect(after.path.map((message: any) => message.id)).toEqual(kept);
    expect(after.chat.headMessageId).toBe(kept[2]);

    // Gone from the tree, not merely off the path: the branch reads the same on a
    // fresh load, and the deleted turn is no longer anyone's sibling.
    const reread = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(reread.path.map((message: any) => message.id)).toEqual(kept);
    expect(reread.siblings[kept[2]]).toEqual({ index: 0, total: 1, ids: [kept[2]] });
  });

  it('leaves the siblings of a deleted branch where they were', async () => {
    const cookie = await signUp('delete-sibling@example.com');
    const { chatId } = await setupChat(cookie);
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }));

    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const firstReply = before.path[2];
    const regenerated = (await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST'))).at(-1)!;
    const secondReply = regenerated.data.messageId;

    // The head is on the regenerated version; deleting the other one leaves it.
    const after = await readJson(
      await request(cookie, `/api/chats/${chatId}/messages/${firstReply.id}`, 'DELETE'),
    );
    expect(after.chat.headMessageId).toBe(secondReply);
    expect(after.path.map((message: any) => message.id)).toEqual([
      before.path[0].id,
      before.path[1].id,
      secondReply,
    ]);
    expect(after.siblings[secondReply]).toEqual({ index: 0, total: 1, ids: [secondReply] });

    // The intro roots are untouched by a delete further down, and still swipeable.
    const roots = after.siblings[before.path[0].id];
    expect(roots.total).toBe(2);
    const swiped = await readJson(
      await json(cookie, `/api/chats/${chatId}/head`, 'POST', { messageId: roots.ids[1] }),
    );
    expect(swiped.path).toHaveLength(1);
    expect(swiped.path[0].content).toBe('불이 꺼진 열람실에서 마주쳤다.');
  });

  it('opens on another intro when the deleted message is the branch root', async () => {
    const cookie = await signUp('delete-root@example.com');
    const { chatId } = await setupChat(cookie);
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }));

    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const alternate = before.siblings[before.path[0].id].ids[1];

    // A root has no parent to fall back to, so the chat opens on what is left.
    const after = await readJson(
      await request(cookie, `/api/chats/${chatId}/messages/${before.path[0].id}`, 'DELETE'),
    );
    expect(after.chat.headMessageId).toBe(alternate);
    expect(after.path.map((message: any) => message.id)).toEqual([alternate]);
    expect(after.siblings[alternate]).toEqual({ index: 0, total: 1, ids: [alternate] });
  });

  it('refuses a delete that would leave the chat without a message', async () => {
    const cookie = await signUp('delete-last@example.com');
    const plot = await createPlot(cookie, { name: '도입부 하나 작품', intros: ['유일한 도입부'] });
    const state = await startChat(cookie, plot.id);

    const res = await request(
      cookie,
      `/api/chats/${state.chat.id}/messages/${state.path[0].id}`,
      'DELETE',
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('invalid_state');

    const reread = await readJson(await request(cookie, `/api/chats/${state.chat.id}`));
    expect(reread.path.map((message: any) => message.id)).toEqual([state.path[0].id]);
  });

  it('deletes a message only for the owner of the chat it is in', async () => {
    const cookie = await signUp('delete-owner@example.com');
    const other = await signUp('delete-intruder@example.com');
    const { chatId } = await setupChat(cookie);
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const messageId = state.path[0].id;

    expect((await request(undefined, `/api/chats/${chatId}/messages/${messageId}`, 'DELETE')).status).toBe(401);
    expect((await request(other, `/api/chats/${chatId}/messages/${messageId}`, 'DELETE')).status).toBe(404);

    // One's own message, but not in this chat: the chat is the boundary.
    const second = await setupChat(cookie);
    const elsewhere = await readJson(await request(cookie, `/api/chats/${second.chatId}`));
    const res = await request(
      cookie,
      `/api/chats/${chatId}/messages/${elsewhere.path[0].id}`,
      'DELETE',
    );
    expect(res.status).toBe(404);

    // Nothing moved in either chat.
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).path).toHaveLength(1);
    expect((await readJson(await request(cookie, `/api/chats/${second.chatId}`))).path).toHaveLength(1);
  });

  it('refuses to prune while the chat is generating, and prunes once the claim is gone', async () => {
    const cookie = await signUp('delete-vs-generation@example.com');
    const { chatId } = await setupChat(cookie);
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const messageId = state.path[0].id;

    // A live claim: the delete would race the rows the stream is adding.
    await db.update(chats).set({ generatingAt: new Date() }).where(eq(chats.id, chatId));
    const busy = await request(cookie, `/api/chats/${chatId}/messages/${messageId}`, 'DELETE');
    expect(busy.status).toBe(429);
    expect((await readJson(busy)).code).toBe('generation_in_progress');
    // …and the refusal did not eat the claim it bounced off.
    expect(await claimOf(chatId)).not.toBeNull();

    // A stale claim is a crashed instance's, not a stream's: reclaimed and pruned.
    await db
      .update(chats)
      .set({ generatingAt: new Date(Date.now() - 3 * 60 * 1000) })
      .where(eq(chats.id, chatId));
    const gone = await request(cookie, `/api/chats/${chatId}/messages/${messageId}`, 'DELETE');
    expect(gone.status).toBe(200);
    // The chat opens on another intro, and the slot the delete took on its
    // way through is released again.
    const after = await readJson(gone);
    expect(after.path.some((message: any) => message.id === messageId)).toBe(false);
    expect(await claimOf(chatId)).toBeNull();
  });

  it('lists the chats newest first, with the plot cover and how each one reads', async () => {
    const cookie = await signUp('chat-list@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
    await uploadFile(cookie, `/api/plots/${plotId}/cover`, gif, 'c.gif');
    const second = await setupChat(cookie);

    const list = await readJson(await request(cookie, '/api/chats'));
    expect(list.map((chat: any) => chat.id)).toEqual([second.chatId, chatId]);
    const entry = list.find((chat: any) => chat.id === chatId);
    expect(entry.title).toBe('리안');
    expect(entry.coverUrl).toBe(`/api/plots/${plotId}/cover`);
    expect(entry.lastMessage).toBe('아직 안 가셨군요, 유저.');
    // A plot with no cover of its own contributes none.
    expect(list.find((chat: any) => chat.id === second.chatId).coverUrl).toBeNull();

    // The preview follows the head, and the markup the reader never sees goes.
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '{{img::wall}}벽에 걸린 그림' }),
    );
    const after = await readJson(await request(cookie, '/api/chats'));
    expect(after.map((chat: any) => chat.id)).toEqual([chatId, second.chatId]);
    expect(after[0].lastMessage).toBe('벽에 걸린 그림');
  });

  it('patches chat settings', async () => {
    const cookie = await signUp('settings@example.com');
    const { chatId } = await setupChat(cookie);
    const persona = await readJson(await json(cookie, '/api/personas', 'POST', { name: '민준' }));
    // A second enabled model needs its provider key present in the app env.
    const withKey = makeApp({ env: { SHIZUE_TEST_MODELS: '1' } });

    const patched = await readJson(
      await json(
        cookie,
        `/api/chats/${chatId}`,
        'PATCH',
        { model: 'test/text', personaId: persona.id },
        withKey,
      ),
    );
    expect(patched.chat.model).toBe('test/text');
    expect(patched.chat.personaId).toBe(persona.id);
    // Same shape as GET.
    expect(patched.path).toHaveLength(1);
    expect(patched.siblings[patched.path[0].id]).toMatchObject({ index: 0, total: 2 });

    const reread = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(reread.chat.model).toBe('test/text');
    expect(reread.chat.personaId).toBe(persona.id);

    const cleared = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { personaId: null }, withKey),
    );
    expect(cleared.chat.personaId).toBeNull();
    expect(cleared.chat.model).toBe('test/text');
  });

  it('takes a reasoning effort only from the list the chat model advertises', async () => {
    const cookie = await signUp('effort@example.com');
    const { chatId } = await setupChat(cookie);
    const withKey = makeApp({ env: { SHIZUE_TEST_MODELS: '1' } });

    const models = await readJson(await request(cookie, '/api/models', 'GET', undefined, withKey));
    expect(models.find((entry: any) => entry.id === 'test/reasoning')).toEqual({
      id: 'test/reasoning',
      label: expect.any(String),
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    });
    expect(models.find((entry: any) => entry.id === 'echo/echo')).toEqual({ id: 'echo/echo', label: expect.any(String) });

    const patch = (body: unknown) => json(cookie, `/api/chats/${chatId}`, 'PATCH', body, withKey);
    // Echo advertises none, so there is nothing to pick from.
    const refused = await patch({ reasoningEffort: 'high' });
    expect(refused.status).toBe(400);
    expect((await readJson(refused)).code).toBe('invalid_request');

    // Checked against the model the same body switches to.
    const chosen = await readJson(await patch({ model: 'test/reasoning', reasoningEffort: 'high' }));
    expect(chosen.chat).toMatchObject({ model: 'test/reasoning', reasoningEffort: 'high' });
    for (const bad of ['turbo', 7, '']) {
      const res = await patch({ reasoningEffort: bad });
      expect(res.status).toBe(400);
      expect((await readJson(res)).code).toBe('invalid_request');
    }
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).chat.reasoningEffort).toBe('high');

    expect((await readJson(await patch({ reasoningEffort: null }))).chat.reasoningEffort).toBeNull();
    expect((await readJson(await patch({ reasoningEffort: 'low' }))).chat.reasoningEffort).toBe('low');
    // A model that still offers it keeps it; one that does not clears it.
    expect((await readJson(await patch({ model: 'test/reasoning' }))).chat.reasoningEffort).toBe('low');
    expect((await readJson(await patch({ model: 'test/text' }))).chat).toMatchObject({
      model: 'test/text',
      reasoningEffort: null,
    });
  });

  it('sends the reasoning effort only while the model still advertises it', async () => {
    const cookie = await signUp('effort-send@example.com');
    const { chatId } = await setupChat(cookie);
    const sent: (string | undefined)[] = [];
    const echo = createEchoAdapter();
    const effortApp = makeApp({
      env: { SHIZUE_TEST_MODELS: '1' },
      getAdapter: () => ({
        providerModel: 'echo',
        adapter: {
          stream: (req) => {
            sent.push(req.reasoningEffort);
            return echo.stream(req);
          },
        },
      }),
    });
    const send = async (): Promise<void> => {
      const events = await readSse(
        await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '안녕' }, effortApp),
      );
      expect(events.at(-1)?.event).toBe('done');
    };

    await send();
    await json(cookie, `/api/chats/${chatId}`, 'PATCH', { model: 'test/reasoning', reasoningEffort: 'high' }, effortApp);
    await send();
    // An effort the catalog stopped advertising stays stored but is not sent.
    await db.update(chats).set({ reasoningEffort: 'turbo' }).where(eq(chats.id, chatId));
    await send();
    expect(sent).toEqual([undefined, 'high', undefined]);
  });

  it('stores the author note and injects it right before the history', async () => {
    const cookie = await signUp('note@example.com');
    const other = await signUp('note-other@example.com');
    const { chatId } = await setupChat(cookie);
    const note = '지금은 비 오는 밤이다. 리안은 말수를 줄인다.';

    const patched = await readJson(await json(cookie, `/api/chats/${chatId}`, 'PATCH', { note }));
    expect(patched.chat.note).toBe(note);
    // Same shape as GET, and the note survives a re-read.
    expect(patched.path).toHaveLength(1);
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).chat.note).toBe(note);

    const prompts: ChatRequest['messages'][] = [];
    const echo = createEchoAdapter();
    const capturing = makeApp({
      getAdapter: () => ({
        providerModel: 'echo',
        adapter: {
          stream: (req) => {
            prompts.push(req.messages);
            return echo.stream(req);
          },
        },
      }),
    });

    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '안녕하세요' }, capturing),
    );
    expect(prompts.at(-1)!.map((m) => m.content)).toEqual([
      note,
      '아직 안 가셨군요, 유저.',
      '안녕하세요',
      expect.any(String), // post-history
    ]);
    expect(prompts.at(-1)![0]!.role).toBe('system');

    // Clearing it takes it back out of the prompt.
    const cleared = await readJson(await json(cookie, `/api/chats/${chatId}`, 'PATCH', { note: '' }));
    expect(cleared.chat.note).toBe('');
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, capturing));
    expect(prompts.at(-1)!.some((m) => m.content === note)).toBe(false);

    // A non-string note is a 400 that changes nothing.
    const bad = await json(cookie, `/api/chats/${chatId}`, 'PATCH', { note: 42 });
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).code).toBe('invalid_request');
    expect((await json(other, `/api/chats/${chatId}`, 'PATCH', { note: '남의 것' })).status).toBe(404);
  });

  it('rejects invalid chat settings', async () => {
    const cookie = await signUp('settings-bad@example.com');
    const other = await signUp('settings-other@example.com');
    const { chatId } = await setupChat(cookie);

    const unknown = await json(cookie, `/api/chats/${chatId}`, 'PATCH', { model: 'nope/nope' });
    expect(unknown.status).toBe(400);
    expect((await readJson(unknown)).code).toBe('model_unavailable');

    // Known model, but no provider key in this app's env.
    const gated = await json(cookie, `/api/chats/${chatId}`, 'PATCH', {
      model: 'test/text',
    });
    expect(gated.status).toBe(400);
    expect((await readJson(gated)).code).toBe('model_unavailable');

    const otherPersona = await readJson(await json(other, '/api/personas', 'POST', { name: '남의 것' }));
    const stolen = await json(cookie, `/api/chats/${chatId}`, 'PATCH', { personaId: otherPersona.id });
    expect(stolen.status).toBe(404);
    expect((await readJson(stolen)).code).toBe('not_found');

    expect((await json(other, `/api/chats/${chatId}`, 'PATCH', { model: 'echo/echo' })).status).toBe(404);

    // The chat is untouched by all of the above.
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(state.chat.model).toBe('echo/echo');
    expect(state.chat.personaId).toBeNull();
  });

  it('regenerates under a user head after an edit fork', async () => {
    const cookie = await signUp('fork-regen@example.com');
    const { chatId } = await setupChat(cookie);
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }));

    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const patched = await readJson(
      await json(cookie, `/api/messages/${before.path[1].id}`, 'PATCH', { content: '다른 질문' }),
    );

    const events = await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST'));
    const done = events.at(-1)!;
    expect(done.event).toBe('done');

    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.path.map((message: any) => message.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(after.path[1].id).toBe(patched.messageId);
    // A user head gets a child, not a sibling.
    expect(after.path[2].id).toBe(done.data.messageId);
    expect(after.path[2].parentId).toBe(patched.messageId);
    expect(after.path[2].content).toBe('다른 질문');
    expect(after.chat.headMessageId).toBe(done.data.messageId);
    expect(after.siblings[after.path[2].id]).toEqual({
      index: 0,
      total: 1,
      ids: [after.path[2].id],
    });
  });

  it('keeps the user message when the adapter fails mid-stream and retries via regenerate', async () => {
    const cookie = await signUp('fail@example.com');
    const { chatId } = await setupChat(cookie);
    const broken = makeApp({ getAdapter: failingGetAdapter });

    const events = await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '실패할 요청' }, broken),
    );
    expect(events.filter((event) => event.event === 'delta').length).toBeGreaterThan(0);
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect(events.at(-1)!.event).toBe('error');
    expect(events.at(-1)!.data.message).toContain('provider exploded');

    // The user message survives; nothing of the failed reply is stored.
    const failed = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(failed.path.map((message: any) => message.role)).toEqual(['assistant', 'user']);
    expect(failed.path[1].content).toBe('실패할 요청');
    expect(failed.chat.headMessageId).toBe(failed.path[1].id);

    // regenerate is the retry path.
    const retry = await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST'));
    const done = retry.at(-1)!;
    expect(done.event).toBe('done');

    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.path.map((message: any) => message.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(after.path[2].parentId).toBe(failed.path[1].id);
    expect(after.path[2].content).toBe('실패할 요청');
    expect(after.chat.headMessageId).toBe(done.data.messageId);
  });

  it('continues the last assistant message in place', async () => {
    const cookie = await signUp('continue@example.com');
    const { chatId } = await setupChat(cookie);
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '이어서' }));

    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const reply = before.path[2];

    const events = await readSse(await json(cookie, `/api/chats/${chatId}/continue`, 'POST'));
    const done = events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.messageId).toBe(reply.id);

    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.path).toHaveLength(3);
    expect(after.path[2].id).toBe(reply.id);
    expect(after.path[2].content).toBe(`${reply.content}이어서`);
    expect(after.chat.headMessageId).toBe(reply.id);
  });

  it('keeps depth lore in its slot when continue re-attaches the partial reply', async () => {
    const cookie = await signUp('depthlore@example.com');
    const { plotId, chatId } = await setupChat(cookie);

    const member = await firstMember(cookie, plotId);
    await patchCharacter(cookie, plotId, member.id, {
      card: { ...member.card, lorebook: [{ content: 'DEPTH LORE', constant: true, depth: 1 }] },
    });

    const prompts: ChatRequest['messages'][] = [];
    const echo = createEchoAdapter();
    const capturing = makeApp({
      getAdapter: () => ({
        providerModel: 'echo',
        adapter: {
          stream: (req) => {
            prompts.push(req.messages);
            return echo.stream(req);
          },
        },
      }),
    });

    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '이어서' }, capturing),
    );
    // A depth-1 entry sits one message from the end: before the user turn here.
    expect(prompts.at(-1)!.map((m) => m.content)).toEqual([
      '아직 안 가셨군요, 유저.',
      'DEPTH LORE',
      '이어서',
      expect.any(String), // post-history
    ]);

    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    await readSse(await json(cookie, `/api/chats/${chatId}/continue`, 'POST', undefined, capturing));

    // Continue re-attaches the partial assistant message after post-history, so
    // the entry has to stay one message from *that* end, not from the truncated
    // history's end.
    const continued = prompts.at(-1)!;
    expect(continued.at(-1)).toEqual({ role: 'assistant', content: before.path[2].content });
    expect(continued.at(-3)).toEqual({ role: 'system', content: 'DEPTH LORE' });
    expect(continued.at(-4)).toEqual({ role: 'user', content: '이어서' });
  });

  /** A generation POST carrying the reader's time zone, the way the web client sends it. */
  const postInZone = (target: Hono<AppEnv>, cookie: string, path: string, zone: string, body?: unknown) =>
    target.request(path, {
      method: 'POST',
      headers: { cookie, 'x-shizue-tz': zone, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('expands the clock macros in the zone the reader sent, and picks the same way on a regenerate', async () => {
    const cookie = await signUp('clock@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    await patchPlot(cookie, plotId, { description: 'TIME[{{time}}] PICK[{{pick::가,나,다,라,마,바,사}}]' });
    const { app: capturing, prompts } = capturingApp();
    const timeIn = (zone: string): string =>
      new Intl.DateTimeFormat('ko', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date());
    const sent = (index: number, label: string): string =>
      new RegExp(`${label}\\[(.*?)\\]`).exec(prompts[index]!.system)![1]!;

    // Read on both sides of the request, so a minute ticking over in between
    // cannot fail the comparison.
    const zone = 'Pacific/Kiritimati';
    const before = timeIn(zone);
    await readSse(await postInZone(capturing, cookie, `/api/chats/${chatId}/messages`, zone, { content: '안녕' }));
    expect([before, timeIn(zone)]).toContain(sent(0, 'TIME'));

    // A zone Intl refuses is UTC, never a failed turn.
    const utc = timeIn('UTC');
    await readSse(await postInZone(capturing, cookie, `/api/chats/${chatId}/regenerate`, 'Not/AZone'));
    expect([utc, timeIn('UTC')]).toContain(sent(1, 'TIME'));
    expect(sent(1, 'PICK')).toBe(sent(0, 'PICK'));
  });

  it('expands the clock into the intros at chat creation', async () => {
    const cookie = await signUp('clock-intro@example.com');
    const plot = await createPlot(cookie, { intros: ['{{weekday}}의 문 앞'] });
    const weekday = (): string =>
      new Intl.DateTimeFormat('ko', { weekday: 'long', timeZone: 'Asia/Seoul' }).format(new Date());
    const before = weekday();
    const res = await postInZone(app, cookie, '/api/chats', 'Asia/Seoul', { plotId: plot.id, model: 'echo/echo' });
    expect(res.status).toBe(201);
    const state = await readJson(res);
    expect([`${before}의 문 앞`, `${weekday()}의 문 앞`]).toContain(state.path[0].content);
  });

  it('records fresh lore triggers on new turns and keeps a sticky entry for its window', async () => {
    const cookie = await signUp('sticky-lore@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    const member = await firstMember(cookie, plotId);
    const dragon = { keys: ['용'], content: 'DRAGON LORE', sticky: 2, scanDepth: 1 };
    await patchCharacter(cookie, plotId, member.id, { card: { ...member.card, lorebook: [dragon] } });
    const key = loreEntryKey((await firstMember(cookie, plotId)).card.lorebook[0]);
    const { app: capturing, prompts } = capturingApp();
    const triggersOf = async (id: string) =>
      (await db.select().from(messages).where(eq(messages.id, id)))[0]!.loreTriggers;
    const turn = async (path: string, body?: unknown) => {
      const events = await readSse(await json(cookie, `/api/chats/${chatId}/${path}`, 'POST', body, capturing));
      return { id: events.at(-1)!.data.messageId as string, system: prompts.at(-1)!.system };
    };

    // Index 2: the keyword is in the scanned message, so the entry triggers fresh.
    const first = await turn('messages', { content: '용이 나타났다' });
    expect(first.system).toContain('DRAGON LORE');
    expect(await triggersOf(first.id)).toEqual([key]);
    // A continue is the same turn: it writes no record of its own.
    await turn('continue');
    expect(await triggersOf(first.id)).toEqual([key]);

    // Index 4 is within two messages of the trigger: active without the keyword,
    // and not recorded again — for the turn and for its regenerate alike.
    const second = await turn('messages', { content: '고요히 걷는다' });
    expect(second.system).toContain('DRAGON LORE');
    expect(await triggersOf(second.id)).toBeNull();
    const swiped = await turn('regenerate');
    expect(swiped.id).not.toBe(second.id);
    expect(swiped.system).toContain('DRAGON LORE');

    // Index 6 is past the window.
    const third = await turn('messages', { content: '고요히 앉는다' });
    expect(third.system).not.toContain('DRAGON LORE');
  });

  it('sends old status windows stripped while their keys still trigger lore', async () => {
    const cookie = await signUp('status-strip@example.com');
    const intro = '문 앞.\n\n```status\n위치: 왕궁\n```';
    const { plotId, chatId } = await setupChat(cookie);
    await patchPlot(cookie, plotId, {
      intros: [intro],
      lorebook: [{ keys: ['왕궁'], content: 'PALACE LORE' }],
    });
    // A new chat, so the opening is the intro just written.
    const fresh = (await startChat(cookie, plotId)).chat.id;
    expect(chatId).not.toBe(fresh);
    const { app: capturing, prompts } = capturingApp();

    await readSse(await json(cookie, `/api/chats/${fresh}/messages`, 'POST', { content: '들어간다' }, capturing));
    // The intro is still the newest assistant turn: it goes as it is.
    expect(prompts[0]!.messages[0]).toEqual({ role: 'assistant', content: intro });

    await readSse(await json(cookie, `/api/chats/${fresh}/messages`, 'POST', { content: '둘러본다' }, capturing));
    expect(prompts[1]!.messages[0]).toEqual({ role: 'assistant', content: '문 앞.' });
    expect(prompts[1]!.system).toContain('PALACE LORE');
  });

  it('keeps the advanced lore fields a client sends, clamped, and invents none', async () => {
    const cookie = await signUp('lore-coerce@example.com');
    const { plotId } = await setupChat(cookie);
    const plot = await patchPlot(cookie, plotId, {
      lorebook: [
        { content: 'plain' },
        {
          content: 'advanced',
          selectiveLogic: 'not_all',
          probability: 150,
          group: ' 날씨, 시간 ',
          groupWeight: 0,
          scanDepth: -3,
          sticky: 2.6,
          cooldown: 99_999,
          delay: 7,
        },
        { content: 'junk', selectiveLogic: 'or', group: '  ', probability: '50', delay: Number.NaN },
      ],
    });
    const advancedKeys = ['selectiveLogic', 'probability', 'group', 'groupWeight', 'scanDepth', 'sticky', 'cooldown', 'delay'];
    const advanced = (entry: Record<string, unknown>) =>
      Object.fromEntries(advancedKeys.filter((key) => key in entry).map((key) => [key, entry[key]]));
    expect(plot.lorebook.map(advanced)).toEqual([
      {},
      {
        selectiveLogic: 'not_all',
        probability: 100,
        group: '날씨, 시간',
        groupWeight: 1,
        scanDepth: 0,
        sticky: 3,
        cooldown: 10_000,
        delay: 7,
      },
      {},
    ]);
  });

  it('sends a member off the stage until the reader brings them back', async () => {
    const cookie = await signUp('scene-cast@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    const minsu = await addCharacter(cookie, plotId, {
      name: '민수',
      card: {
        description: '여관 주인.',
        mesExample: '<START>\n{{char}}: MINSU EXAMPLE',
        lorebook: [{ content: 'MINSU LORE', constant: true }],
      },
    });
    const { app: capturing, prompts } = capturingApp();
    const patch = (body: unknown) => json(cookie, `/api/chats/${chatId}`, 'PATCH', body);
    const sent = (index: number): string =>
      [prompts[index]!.system, ...prompts[index]!.messages.map((m) => contentText(m.content))].join('\n');

    const away = await patch({ absentCharacterIds: [minsu.id, minsu.id] });
    expect(away.status).toBe(200);
    expect((await readJson(away)).chat.absentCharacterIds).toEqual([minsu.id]);
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '들어간다' }, capturing));
    expect(sent(0)).not.toMatch(/\[등장인물: 민수\]|MINSU EXAMPLE|MINSU LORE/);
    expect(prompts[0]!.system).toContain('[등장인물: 리안]');
    expect(prompts[0]!.system).toContain('현재 장면에 없는 인물: 민수 — ');

    // Only the plot's own members can be sent away.
    const stranger = (await addCharacter(cookie, (await createPlot(cookie)).id)).id;
    for (const body of [{ absentCharacterIds: [stranger] }, { absentCharacterIds: 'x' }, { absentCharacterIds: [1] }]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect((await readJson(res)).code).toBe('invalid_request');
    }

    // An empty list is the whole roster again, stored as nothing at all.
    expect((await readJson(await patch({ absentCharacterIds: [] }))).chat.absentCharacterIds).toEqual([]);
    const [row] = await db.select().from(chats).where(eq(chats.id, chatId));
    expect(row!.absentCharacterIds).toBeNull();
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, capturing));
    expect(sent(1)).toContain('MINSU EXAMPLE');
    expect(prompts[1]!.system).not.toContain('현재 장면에 없는 인물');

    // A member deleted while away leaves an id that matches nobody.
    await patch({ absentCharacterIds: [minsu.id] });
    expect((await request(cookie, `/api/plots/${plotId}/characters/${minsu.id}`, 'DELETE')).status).toBe(204);
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, capturing));
    expect(prompts[2]!.system).not.toContain('현재 장면에 없는 인물');
  });

  it('centers one reply on the members the reader picked, and stores none of it', async () => {
    const cookie = await signUp('scene-focus@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    const lian = await firstMember(cookie, plotId);
    const minsu = await addCharacter(cookie, plotId, { name: '민수' });
    const { app: capturing, prompts } = capturingApp();
    const focus = '이번 응답은 리안, 민수의 대사와 행동을 중심으로 씁니다.';
    const post = (path: string, body?: unknown) =>
      json(cookie, `/api/chats/${chatId}/${path}`, 'POST', body, capturing);
    const lastSent = () => prompts.at(-1)!.messages.at(-1)!;

    // Roster order, whatever order the ids came in.
    await readSse(await post('messages', { content: '안녕', focusCharacterIds: [minsu.id, lian.id] }));
    expect(lastSent()).toEqual({ role: 'system', content: focus });
    const stored = await db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(stored.map((message) => message.content).join('\n')).not.toContain('중심으로');

    // The next turn is back to the scene deciding.
    await readSse(await post('regenerate'));
    expect(contentText(lastSent().content)).not.toContain('중심으로');

    // A continue carries the request just before its partial, which stays the
    // last turn the model resumes; a narration's nudge and the request are one
    // closing instruction.
    await readSse(await post('continue', { focusCharacterIds: [lian.id] }));
    expect(prompts.at(-1)!.messages.at(-2)).toEqual({ role: 'system', content: '이번 응답은 리안의 대사와 행동을 중심으로 씁니다.' });
    expect(lastSent().role).toBe('assistant');
    await readSse(await post('narrate', { focusCharacterIds: [minsu.id] }));
    expect(contentText(lastSent().content)).toMatch(/나레이터의 장면 서술만.*\n이번 응답은 민수의 대사와/s);

    // Only someone on the stage can be asked for, and a refused send writes nothing.
    await json(cookie, `/api/chats/${chatId}`, 'PATCH', { absentCharacterIds: [minsu.id] });
    const before = (await db.select().from(messages).where(eq(messages.chatId, chatId))).length;
    for (const [path, body] of [
      ['messages', { content: '또', focusCharacterIds: [minsu.id] }],
      ['auto', { focusCharacterIds: [randomUUID()] }],
      ['regenerate', { focusCharacterIds: 'x' }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status, path).toBe(400);
      expect((await readJson(res)).code).toBe('invalid_request');
    }
    expect((await db.select().from(messages).where(eq(messages.chatId, chatId))).length).toBe(before);
    expect(await claimOf(chatId)).toBeNull();
  });

  it("shows the plot's creator what a regenerate would send, and nobody else", async () => {
    const owner = await signUp('inspect-owner@example.com');
    const reader = await signUp('inspect-reader@example.com');
    const plot = await publishablePlot(owner, {
      lorebook: [{ content: 'ALWAYS ON', constant: true }],
    });
    await publishPlot(owner, plot.id);
    const own = await startChat(owner, plot.id);
    const theirs = await startChat(reader, plot.id);
    expect(own.isPlotOwner).toBe(true);
    expect(theirs.isPlotOwner).toBe(false);
    await readSse(await json(owner, `/api/chats/${own.chat.id}/messages`, 'POST', { content: '안녕' }));
    const count = async () => (await db.select().from(messages).where(eq(messages.chatId, own.chat.id))).length;
    const before = await count();

    const res = await request(owner, `/api/chats/${own.chat.id}/inspect`);
    expect(res.status).toBe(200);
    const report = await readJson(res);
    expect(report.blocks.map((block: { kind: string }) => block.kind)).toEqual(
      expect.arrayContaining(['main', 'lore_before', 'plot', 'character', 'history', 'post_history']),
    );
    // A regenerate replaces the assistant head: the history ends on the user turn.
    const turns = report.blocks.filter((block: { kind: string }) => block.kind === 'history');
    expect(turns.at(-1)).toMatchObject({ label: 'user', text: '안녕' });
    expect(report.totals).toMatchObject({
      contextBudget: DEFAULT_CONTEXT_BUDGET,
      responseReserve: DEFAULT_MAX_RESPONSE_TOKENS,
    });
    expect(report.totals.used).toBeGreaterThan(0);
    expect(report.lore).toEqual([expect.objectContaining({ source: 'plot', via: 'constant', preview: 'ALWAYS ON' })]);
    expect(await count()).toBe(before);
    expect(await claimOf(own.chat.id)).toBeNull();

    // The reader's own chat on someone else's plot, and the creator on a chat
    // that is not theirs, both read as no such chat.
    expect((await request(reader, `/api/chats/${theirs.chat.id}/inspect`)).status).toBe(404);
    expect((await request(owner, `/api/chats/${theirs.chat.id}/inspect`)).status).toBe(404);
  });

  it('returns 429 while another generation is in flight', async () => {
    const cookie = await signUp('limit@example.com');
    const { chatId } = await setupChat(cookie);

    // Long content: the echo adapter fills the stream buffer and blocks on
    // backpressure until the body is read, keeping the slot held.
    const first = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
      content: Array.from({ length: 2000 }, (_, i) => `단어${i}`).join(' '),
    });
    const second = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '동시 요청' });

    expect(second.status).toBe(429);
    expect((await readJson(second)).code).toBe('generation_in_progress');

    // A second API instance shares nothing but the database, so the claim on the
    // chat row is the only thing that can stop it — and it must, the same way.
    const elsewhere = await json(
      cookie,
      `/api/chats/${chatId}/messages`,
      'POST',
      { content: '다른 인스턴스' },
      makeApp(),
    );
    expect(elsewhere.status).toBe(429);
    expect((await readJson(elsewhere)).code).toBe('generation_in_progress');

    // Settings must not change mid-generation either — the author note included:
    // the endpoint holds the slot whatever the body carries.
    const settings = await json(cookie, `/api/chats/${chatId}`, 'PATCH', { model: 'echo/echo' });
    expect(settings.status).toBe(409);
    expect((await readJson(settings)).code).toBe('generation_in_progress');
    expect((await json(cookie, `/api/chats/${chatId}`, 'PATCH', { note: '메모' })).status).toBe(409);

    // Drain the first stream so the slot is released again.
    await readSse(first);
    expect(await claimOf(chatId)).toBeNull();
    const third = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '이제 가능' });
    expect(third.status).toBe(200);
    await readSse(third);
  });

  it('reclaims a chat whose generation claim went stale', async () => {
    const cookie = await signUp('stale-claim@example.com');
    const { chatId } = await setupChat(cookie);
    const claimedAgo = (ms: number): Promise<unknown> =>
      db
        .update(chats)
        .set({ generatingAt: new Date(Date.now() - ms) })
        .where(eq(chats.id, chatId));

    // Inside the staleness window the claim belongs to a generation that is still
    // running somewhere — no instance may take it, however little it knows.
    await claimedAgo(60_000);
    const blocked = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '점유 중' });
    expect(blocked.status).toBe(429);
    expect((await readJson(blocked)).code).toBe('generation_in_progress');

    // Past two minutes with nobody renewing it, the instance that wrote it is
    // gone: the chat is taken over rather than left wedged forever.
    await claimedAgo(3 * 60_000);
    const reclaimed = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '이제 가능' });
    expect(reclaimed.status).toBe(200);
    expect((await readSse(reclaimed)).at(-1)!.event).toBe('done');
    expect(await claimOf(chatId)).toBeNull();
  });

  /** The account a chat belongs to — what the claim is guarded by. */
  async function ownerOf(chatId: string): Promise<string> {
    const [row] = await db.select({ userId: chats.userId }).from(chats).where(eq(chats.id, chatId));
    return row!.userId;
  }

  // The claim is a lease, and a lease has a holder. Without that identity the
  // instance whose claim went stale would keep writing to a column that is now
  // somebody else's — renewing it back to itself, or clearing it outright and
  // letting a third request in beside a generation that is still running.
  it('keeps a taken-over claim out of the hands of the instance that lost it', async () => {
    const cookie = await signUp('claim-identity@example.com');
    const { chatId } = await setupChat(cookie);
    const userId = await ownerOf(chatId);
    const lost = makeDeps();
    const holder = makeDeps();

    expect(await acquireChatSlot(lost, chatId, userId)).toBe(true);
    // Two minutes on, with nothing renewing it, another instance declares the
    // first one dead and takes the chat over.
    await db
      .update(chats)
      .set({ generatingAt: new Date(Date.now() - 3 * 60_000) })
      .where(eq(chats.id, chatId));
    expect(await acquireChatSlot(holder, chatId, userId)).toBe(true);
    const taken = await claimOf(chatId);

    // The first instance is still alive and still on its heartbeat: it may not
    // pull the claim back, and when its stream finally ends it may not clear one
    // that is no longer its own.
    await renewChatSlot(lost, chatId);
    expect(await claimOf(chatId)).toEqual(taken);
    await releaseChatSlot(lost, chatId);
    expect(await claimOf(chatId)).toEqual(taken);
    expect(lost.generating.has(chatId)).toBe(false);

    // The instance that does hold it renews and releases exactly as before — and
    // the release only works because the renewal wrote the new value back, which
    // is what it compares against.
    await renewChatSlot(holder, chatId);
    const renewed = await claimOf(chatId);
    expect(renewed!.getTime()).toBeGreaterThanOrEqual(taken!.getTime());
    await releaseChatSlot(holder, chatId);
    expect(await claimOf(chatId)).toBeNull();
    expect(holder.generating.has(chatId)).toBe(false);
  });

  it('does not wedge the chat when taking the claim fails', async () => {
    const cookie = await signUp('claim-throws@example.com');
    const { chatId } = await setupChat(cookie);
    const userId = await ownerOf(chatId);

    // A database that drops the very next guarded UPDATE, and is itself again
    // afterwards — the fast-path set is taken before that statement runs.
    let broken = true;
    const flaky = new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'update') return value;
        return (table: unknown) => {
          if (!broken) return (value as typeof db.update).call(target, table as never);
          broken = false;
          return {
            set: () => ({ where: () => ({ returning: () => Promise.reject(new Error('db down')) }) }),
          };
        };
      },
    }) as Db;

    const deps = makeDeps({ db: flaky });
    await expect(acquireChatSlot(deps, chatId, userId)).rejects.toThrow('db down');
    // The chat is not this instance's for the rest of its life.
    expect(deps.generating.has(chatId)).toBe(false);
    expect(await acquireChatSlot(deps, chatId, userId)).toBe(true);
    await releaseChatSlot(deps, chatId);
    expect(await claimOf(chatId)).toBeNull();
  });

  it('joins overlapping renewals instead of reading its own race as a takeover', async () => {
    const cookie = await signUp('claim-overlap@example.com');
    const { chatId } = await setupChat(cookie);
    const userId = await ownerOf(chatId);
    const deps = makeDeps();
    expect(await acquireChatSlot(deps, chatId, userId)).toBe(true);

    // Two heartbeats landing together: without the guard, one CAS advances the
    // row and the other reads its own miss as a takeover and kills the renewal.
    const first = renewChatSlot(deps, chatId);
    const second = renewChatSlot(deps, chatId);
    expect(second).toBe(first);
    await first;

    // The claim survived its own heartbeat, and later renewals still carry it.
    expect(deps.generationClaims.has(chatId)).toBe(true);
    await renewChatSlot(deps, chatId);
    expect(await claimOf(chatId)).not.toBeNull();
    await releaseChatSlot(deps, chatId);
    expect(await claimOf(chatId)).toBeNull();
  });

  it('waits out a renewal in flight before it releases the claim', async () => {
    const cookie = await signUp('claim-release-race@example.com');
    const { chatId } = await setupChat(cookie);
    const userId = await ownerOf(chatId);

    // A database whose next UPDATE is slow but real: the renewal it carries is
    // advancing the row's timestamp while the release comes through.
    let slow = false;
    const delayed = new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'update') return value;
        return (table: unknown) => {
          const real = (value as typeof db.update).call(target, table as never);
          if (!slow) return real;
          slow = false;
          return {
            set: (values: never) => ({
              where: (where: never) => ({
                returning: (shape: never) =>
                  new Promise((resolve) => setTimeout(resolve, 150)).then(() =>
                    real.set(values).where(where).returning(shape),
                  ),
              }),
            }),
          };
        };
      },
    }) as Db;

    const deps = makeDeps({ db: delayed });
    expect(await acquireChatSlot(deps, chatId, userId)).toBe(true);
    slow = true;
    const renewal = renewChatSlot(deps, chatId);
    // Release lands while the renewal is mid-flight. It has to wait it out and
    // clear with the identity the row holds *afterwards* — clearing with the one
    // it replaced would miss, and the finished chat would stay claimed until the
    // staleness window let it go.
    await releaseChatSlot(deps, chatId);
    await renewal;
    expect(await claimOf(chatId)).toBeNull();
    expect(deps.generationClaims.has(chatId)).toBe(false);
  });

  it('releases the generation claim when the client walks away mid-stream', async () => {
    const cookie = await signUp('abort-claim@example.com');
    const target = makeApp({
      getAdapter: () => ({
        providerModel: 'slow',
        adapter: {
          stream: async function* (req): AsyncGenerator<StreamDelta, StreamDone> {
            yield { type: 'text', text: '부분 응답' };
            // Hangs until the client disconnects, like a provider mid-answer.
            await new Promise<void>((_resolve, reject) => {
              const fail = (): void => reject(new Error('aborted'));
              if (req.abortSignal?.aborted) fail();
              else req.abortSignal?.addEventListener('abort', fail);
            });
            return { usage: { promptTokens: 0, completionTokens: 0 } };
          },
        },
      }),
    });
    const { chatId } = await setupChat(cookie);

    const client = new AbortController();
    const res = await target.request(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '안녕' }),
      signal: client.signal,
    });
    expect(await claimOf(chatId)).not.toBeNull();
    // Wait for the first delta, then walk away.
    await res.body!.getReader().read();
    client.abort();

    await until(async () => (await claimOf(chatId)) === null, 'the claim was never released');
    // The partial text was kept: the claim is only released once it is stored.
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(state.path.at(-1).content).toBe('부분 응답');
    // And the chat generates again straight away, on an instance that never saw
    // the abandoned request.
    const next = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '다시' }, makeApp());
    expect(next.status).toBe(200);
    expect((await readSse(next)).at(-1)!.event).toBe('done');
  });

  it('rejects an unavailable model before persisting the user turn', async () => {
    const cookie = await signUp('key-gone@example.com');
    // Chat created while the provider key is configured...
    const keyed = makeApp({ env: { SHIZUE_TEST_MODELS: '1' }, getAdapter: stubGetAdapter });
    const plot = await importCard(cookie, cardFile());
    const created = await readJson(
      await json(
        cookie,
        '/api/chats',
        'POST',
        { plotId: plot.id, model: 'test/text' },
        keyed,
      ),
    );
    const chatId = created.chat.id;
    const headBefore = created.chat.headMessageId;

    // ...and used after the key is gone (the default app runs with an empty env).
    const res = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '키 없음' });
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('model_unavailable');
    // The response is a plain 400, so the client assumes nothing was stored: the
    // chat must be exactly as it was.
    const untouched = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(untouched.chat.headMessageId).toBe(headBefore);
    expect(untouched.path).toHaveLength(1);
    expect(untouched.path.every((message: any) => message.role === 'assistant')).toBe(true);

    // regenerate/continue fail fast the same way.
    expect((await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST')).status).toBe(400);
    expect((await json(cookie, `/api/chats/${chatId}/continue`, 'POST')).status).toBe(400);
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).path).toHaveLength(1);

    // With the key present the very same request goes through.
    const ok = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '키 없음' }, keyed);
    expect(ok.status).toBe(200);
    expect((await readSse(ok)).at(-1)!.event).toBe('done');
    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.path.map((message: any) => message.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(after.path[1].content).toBe('키 없음');
    expect(after.path[2].content).toBe('스텁 응답');
  });

  it('takes the generation slot for the whole settings patch', async () => {
    const cookie = await signUp('slot@example.com');
    const { chatId } = await setupChat(cookie);
    // Slot set owned by the test: it can be held like a generation would, and it
    // records acquisitions so the patch's own hold is observable.
    const generating = new TrackingSet();
    const shared = makeApp({ generating });

    generating.add(chatId);
    generating.acquired.length = 0;
    const blockedPatch = await json(cookie, `/api/chats/${chatId}`, 'PATCH', { model: 'echo/echo' }, shared);
    expect(blockedPatch.status).toBe(409);
    expect((await readJson(blockedPatch)).code).toBe('generation_in_progress');
    // The exclusion runs both ways: a held slot also blocks sends.
    const blockedSend = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: 'x' }, shared);
    expect(blockedSend.status).toBe(429);
    generating.delete(chatId);

    // A rejected patch takes the slot too, and must not leak it — neither the fast
    // path nor the claim the row carries.
    generating.acquired.length = 0;
    expect((await json(cookie, `/api/chats/${chatId}`, 'PATCH', { model: 'nope/nope' }, shared)).status).toBe(400);
    expect(generating.acquired).toEqual([chatId]);
    expect(generating.size).toBe(0);
    expect(await claimOf(chatId)).toBeNull();

    // A successful patch holds the slot for its whole duration, then releases it.
    generating.acquired.length = 0;
    const patched = await json(cookie, `/api/chats/${chatId}`, 'PATCH', { model: 'echo/echo' }, shared);
    expect(patched.status).toBe(200);
    expect(generating.acquired).toEqual([chatId]);
    expect(generating.size).toBe(0);
    expect(await claimOf(chatId)).toBeNull();

    // Slot released: generation works right after.
    const send = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '패치 후' }, shared);
    expect(send.status).toBe(200);
    expect((await readSse(send)).at(-1)!.event).toBe('done');
    expect(generating.size).toBe(0);
  });

  // A chat another user owns must not be told apart from one that does not exist,
  // and taking the slot is the first thing a generation does — so the claim is
  // guarded by owner, and a miss is re-checked before it is reported as busy.
  it('keeps another user out of the slot on a chat that is not theirs', async () => {
    const cookie = await signUp('slot-owner@example.com');
    const intruder = await signUp('slot-intruder@example.com');
    const { chatId } = await setupChat(cookie);

    expect((await json(intruder, `/api/chats/${chatId}/messages`, 'POST', { content: '남의 채팅' })).status).toBe(404);
    expect((await json(intruder, `/api/chats/${chatId}`, 'PATCH', { note: '메모' })).status).toBe(404);
    // The failed attempts left no claim behind for the owner to trip over.
    expect(await claimOf(chatId)).toBeNull();
    const send = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '내 채팅' });
    expect(send.status).toBe(200);
    await readSse(send);
  });

  /** A chain of `count` turns under `parentId`, alternating roles, and the new head. */
  async function seedBranch(chatId: string, parentId: string, count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    // All the stamps before now and one apart, like the greeting roots: a branch
    // is ordered by creation, and a sibling forked later has to be the newer one.
    const stamp = Date.now() - count;
    await db.insert(messages).values(
      ids.map((id, index) => ({
        id,
        chatId,
        parentId: index === 0 ? parentId : ids[index - 1]!,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `턴 ${index}`,
        createdAt: new Date(stamp + index),
      })),
    );
    await db.update(chats).set({ headMessageId: ids.at(-1)! }).where(eq(chats.id, chatId));
    return ids;
  }

  it('reads a short branch whole, and says nothing older is left', async () => {
    const cookie = await signUp('window-short@example.com');
    const { chatId, state } = await setupChat(cookie);

    // The unwindowed answer every other route gives, plus the one new field.
    const read = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(read.path).toEqual(state.path);
    expect(read.siblings).toEqual(state.siblings);
    expect(read.hasMore).toBe(false);
  });

  it('windows a long branch and walks it back with the before cursor', async () => {
    const cookie = await signUp('window-walk@example.com');
    const { chatId, state } = await setupChat(cookie);
    const root = state.path[0].id;
    const branch = [root, ...(await seedBranch(chatId, root, 260))];

    // No parameters: the newest DEFAULT_PATH_LIMIT of the branch, ending at the head.
    const head = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(head.path).toHaveLength(200);
    expect(head.hasMore).toBe(true);
    expect(head.path.at(-1).id).toBe(branch.at(-1));
    expect(head.chat.headMessageId).toBe(branch.at(-1));

    // The cursor is the first id of the window already held.
    const older = await readJson(
      await request(cookie, `/api/chats/${chatId}?before=${head.path[0].id}&limit=50`),
    );
    expect(older.path).toHaveLength(50);
    expect(older.hasMore).toBe(true);

    // The last page stops at the root and says the walk is over.
    const oldest = await readJson(
      await request(cookie, `/api/chats/${chatId}?before=${older.path[0].id}&limit=50`),
    );
    expect(oldest.path).toHaveLength(branch.length - 250);
    expect(oldest.hasMore).toBe(false);
    expect(oldest.path[0].id).toBe(root);

    // Walked end to end, the windows are the branch: no gap, no repeat, in order.
    expect([...oldest.path, ...older.path, ...head.path].map((m: any) => m.id)).toEqual(branch);
  });

  it('caps a window however much is asked for', async () => {
    const cookie = await signUp('window-cap@example.com');
    const { chatId, state } = await setupChat(cookie);
    await seedBranch(chatId, state.path[0].id, 600);

    const read = await readJson(await request(cookie, `/api/chats/${chatId}?limit=100000`));
    expect(read.path).toHaveLength(500);
    expect(read.hasMore).toBe(true);
  });

  it('keeps swipe info whole on a windowed read', async () => {
    const cookie = await signUp('window-siblings@example.com');
    const { chatId, state } = await setupChat(cookie);
    const ids = await seedBranch(chatId, state.path[0].id, 10);

    // A sibling of the window's oldest message, forked from a parent the window
    // does not carry. The swipe UI still has to see both sides of it.
    const [sibling] = await db
      .insert(messages)
      .values({
        chatId,
        parentId: ids[6]!,
        role: 'assistant',
        content: '다른 갈래',
        createdAt: new Date(),
      })
      .returning();

    const read = await readJson(await request(cookie, `/api/chats/${chatId}?limit=3`));
    expect(read.path.map((m: any) => m.id)).toEqual(ids.slice(7));
    expect(read.hasMore).toBe(true);
    expect(read.siblings[ids[7]!]).toEqual({ index: 0, total: 2, ids: [ids[7], sibling!.id] });
    // And nothing outside the window carries info the client cannot place.
    expect(Object.keys(read.siblings)).toEqual(ids.slice(7));
  });

  it('rejects a window it cannot answer', async () => {
    const cookie = await signUp('window-bad@example.com');
    const { chatId, state } = await setupChat(cookie);
    const other = await setupChat(cookie);

    for (const query of ['limit=0', 'limit=-5', 'limit=1.5', 'limit=abc', 'before=nope']) {
      const res = await request(cookie, `/api/chats/${chatId}?${query}`);
      expect(res.status, query).toBe(400);
      expect((await readJson(res)).code).toBe('invalid_request');
    }

    // A cursor from somewhere other than this branch: answering with the newest
    // window instead would hand the client a gap it would read as history.
    const stray = await request(cookie, `/api/chats/${chatId}?before=${other.state.path[0].id}`);
    expect(stray.status).toBe(400);
    // The head is on the branch but has nothing after it: an empty page, not an error.
    const atHead = await readJson(await request(cookie, `/api/chats/${chatId}?before=${state.path[0].id}`));
    expect(atHead.path).toEqual([]);
    expect(atHead.hasMore).toBe(false);
  });

  // The prompt folds the whole branch server-side, but the client only holds a
  // window of it — so a window that cut something has to carry the fold of what
  // it cut, or a variable set before it silently reads as unset on screen.
  it('carries the fold of what a window cut, and nothing on an unwindowed read', async () => {
    const cookie = await signUp('window-variables@example.com');
    const { chatId, state } = await setupChat(cookie);
    const root = state.path[0].id;
    const ids = await seedBranch(chatId, root, 6);
    // Set on the oldest turn of the branch, three windows back.
    await db
      .update(messages)
      .set({ content: '턴 0 {{setvar::호감도::7}}' })
      .where(eq(messages.id, ids[0]!));

    const windowed = await readJson(await request(cookie, `/api/chats/${chatId}?limit=3`));
    expect(windowed.path.map((m: any) => m.id)).toEqual(ids.slice(3));
    expect(windowed.variableDefaults).toEqual({ 호감도: '7' });

    // A window that stopped exactly at the start of the branch cut nothing.
    const whole = await readJson(await request(cookie, `/api/chats/${chatId}?limit=50`));
    expect(whole.hasMore).toBe(false);
    expect('variableDefaults' in whole).toBe(false);
    // And neither does any of the reads that answer with the whole branch.
    const patched = await readJson(await json(cookie, `/api/chats/${chatId}`, 'PATCH', { note: '메모' }));
    expect('variableDefaults' in patched).toBe(false);
  });

  it('exposes memory on GET, null until the first summary', async () => {
    const cookie = await signUp('memory-shape@example.com');
    const { state } = await setupChat(cookie);
    expect(state.chat.memory).toBeNull();
    expect(state.chat.memorySettings).toBeNull();
    expect(state.chat.noteIds).toEqual([]);
  });

  it('stores whitelisted memory settings and rejects everything else', async () => {
    const cookie = await signUp('memory-settings@example.com');
    const other = await signUp('memory-settings-other@example.com');
    const { chatId } = await setupChat(cookie);

    const patched = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', {
        // The unknown key is dropped rather than stored: nothing reads it.
        memorySettings: { contextBudget: 32000, summaryThreshold: 0.4, retrievalCount: 0, nope: 1 },
      }),
    );
    expect(patched.chat.memorySettings).toEqual({
      contextBudget: 32000,
      summaryThreshold: 0.4,
      retrievalCount: 0,
    });
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).chat.memorySettings).toEqual(
      patched.chat.memorySettings,
    );

    for (const settings of [
      { contextBudget: 12000 },
      { summaryThreshold: 0.5 },
      { retrievalCount: 11 },
      { retrievalCount: -1 },
      { retrievalCount: 2.5 },
      { contextBudget: '32000' },
    ]) {
      const bad = await json(cookie, `/api/chats/${chatId}`, 'PATCH', { memorySettings: settings });
      expect(bad.status, JSON.stringify(settings)).toBe(400);
      expect((await readJson(bad)).code).toBe('invalid_request');
    }
    const notAnObject = await json(cookie, `/api/chats/${chatId}`, 'PATCH', { memorySettings: [16000] });
    expect(notAnObject.status).toBe(400);

    // Nothing above touched the chat, and null resets it to the defaults.
    const kept = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(kept.chat.memorySettings).toEqual(patched.chat.memorySettings);
    const reset = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { memorySettings: null }),
    );
    expect(reset.chat.memorySettings).toBeNull();

    expect(
      (await json(other, `/api/chats/${chatId}`, 'PATCH', { memorySettings: { retrievalCount: 1 } }))
        .status,
    ).toBe(404);
  });

  it('caps the prompt history at the chat context budget', async () => {
    const cookie = await signUp('budget@example.com');
    const { chatId } = await setupChat(cookie);
    const prompts: ChatRequest['messages'][] = [];
    const echo = createEchoAdapter();
    // The memory channel answers with nothing, so no summary is ever written and
    // the branch the two budgets are measured against stays identical.
    const capturing = makeApp({
      getAdapter: (modelId) =>
        modelId === 'echo/echo'
          ? {
              providerModel: 'echo',
              adapter: {
                stream: (req) => {
                  prompts.push(req.messages);
                  return echo.stream(req);
                },
              },
            }
          : {
              providerModel: 'silent',
              adapter: {
                stream: async function* (): AsyncGenerator<StreamDelta, StreamDone> {
                  return { usage: { promptTokens: 0, completionTokens: 0 } };
                },
              },
            },
    });
    // The echo model replies with the user's own text, so each turn costs its
    // ~900 tokens twice: six turns overflow 8,000 but fit in 32,000.
    const turn = (index: number): string => `${index}번째. ${'긴 대화가 이어집니다. '.repeat(120)}`;

    for (let index = 0; index < 6; index += 1) {
      const res = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: turn(index) }, capturing);
      expect((await readSse(res)).at(-1)!.event).toBe('done');
    }

    await json(cookie, `/api/chats/${chatId}`, 'PATCH', { memorySettings: { contextBudget: 8000 } });
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, capturing));
    const tight = prompts.at(-1)!.length;

    await json(cookie, `/api/chats/${chatId}`, 'PATCH', { memorySettings: { contextBudget: 32000 } });
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, capturing));
    const roomy = prompts.at(-1)!.length;

    // Same branch, same prompt — only the budget decides how much of it fits.
    expect(tight).toBeLessThan(roomy);
  });

  it('auto-continues from an assistant head without storing the nudge', async () => {
    const cookie = await signUp('auto@example.com');
    const { chatId } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();

    // The greeting is an assistant head, so auto works before any user turn.
    const first = await readSse(await json(cookie, `/api/chats/${chatId}/auto`, 'POST', undefined, capturing));
    expect(first.at(-1)!.event).toBe('done');

    const nudge = prompts.at(-1)!.messages.at(-1)!;
    expect(nudge.role).toBe('system');
    expect(nudge.content).toContain('유저 개입 없이');
    // {{user}} is expanded like anywhere else, and the instruction is the last thing
    // the model reads.
    expect(nudge.content).toContain('유저의 반응이');

    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(state.path).toHaveLength(2);
    expect(state.path.map((message: any) => message.role)).toEqual(['assistant', 'assistant']);
    expect(state.path[1].parentId).toBe(state.path[0].id);
    // The nudge lives in the prompt only.
    expect(state.path.some((message: any) => message.content.includes('유저 개입 없이'))).toBe(false);

    // And it still works right after a normal turn.
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '무슨 일이야?' }, capturing));
    const after = await readSse(await json(cookie, `/api/chats/${chatId}/auto`, 'POST', undefined, capturing));
    expect(after.at(-1)!.event).toBe('done');
    const grown = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(grown.path).toHaveLength(5);
    expect(grown.path.at(-1).role).toBe('assistant');
    expect(grown.path.at(-1).parentId).toBe(grown.path.at(-2).id);
  });

  it('refuses to auto-continue from a user head', async () => {
    const cookie = await signUp('auto-state@example.com');
    const other = await signUp('auto-other@example.com');
    const { chatId } = await setupChat(cookie);

    // Editing a user message leaves the head on that message.
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }));
    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    await json(cookie, `/api/messages/${before.path[1].id}`, 'PATCH', { content: '다른 질문' });

    const res = await json(cookie, `/api/chats/${chatId}/auto`, 'POST');
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('invalid_state');

    expect((await json(other, `/api/chats/${chatId}/auto`, 'POST')).status).toBe(404);
  });

  it('isolates chats between users', async () => {
    const alice = await signUp('chat-a@example.com');
    const bob = await signUp('chat-b@example.com');
    const { chatId } = await setupChat(alice);

    expect((await request(bob, `/api/chats/${chatId}`)).status).toBe(404);
    expect((await json(bob, `/api/chats/${chatId}/messages`, 'POST', { content: 'x' })).status).toBe(404);
    expect(await readJson(await request(bob, '/api/chats'))).toEqual([]);
  });
});

describe('narration turns', () => {
  /** Leaves the head on a user message, which is where auto-continue refuses to go. */
  async function userHead(cookie: string, chatId: string, target: Hono<AppEnv>): Promise<void> {
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '문을 열었다' }, target),
    );
    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    // An edit forks a user sibling and moves the head onto it.
    await json(cookie, `/api/messages/${before.path[1].id}`, 'PATCH', { content: '문을 열었다' });
  }

  it('narrates from a user head and stores the scene under the prefix', async () => {
    const cookie = await signUp('narrate@example.com');
    const other = await signUp('narrate-other@example.com');
    const { chatId } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();
    await userHead(cookie, chatId, capturing);

    const events = await readSse(
      await json(cookie, `/api/chats/${chatId}/narrate`, 'POST', undefined, capturing),
    );
    expect(events.at(-1)!.event).toBe('done');

    // The nudge is the last thing the model reads, with {{char}} expanded.
    const nudge = prompts.at(-1)!.messages.at(-1)!;
    expect(nudge.role).toBe('system');
    expect(nudge.content).toContain('나레이터의 장면 서술만');
    // `{{char}}` is the work now, so the nudge names the plot and asks for the
    // scene rather than any one member's lines.
    expect(nudge.content).toContain('리안의 등장인물');

    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const head = state.path.at(-1);
    expect(head.role).toBe('assistant');
    // The model was asked for the scene alone; the prefix is the server's.
    expect(head.content).toBe('@: 문을 열었다');
    expect(state.chat.headMessageId).toBe(head.id);
    expect(head.parentId).toBe(state.path.at(-2).id);
    // The nudge lives in the prompt only.
    expect(state.path.some((message: any) => message.content.includes('나레이터의 장면'))).toBe(false);

    expect((await json(other, `/api/chats/${chatId}/narrate`, 'POST')).status).toBe(404);
  });

  it('regenerates a narration as a narration, and leaves an ordinary reply alone', async () => {
    const cookie = await signUp('narrate-regen@example.com');
    const { chatId } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();
    await userHead(cookie, chatId, capturing);

    await readSse(await json(cookie, `/api/chats/${chatId}/narrate`, 'POST', undefined, capturing));
    const narrated = await readJson(await request(cookie, `/api/chats/${chatId}`));

    // Swiping a narration must not land on a line of dialogue: the head says what
    // kind of turn it is, and the regenerate re-applies it.
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, capturing));
    expect(prompts.at(-1)!.messages.at(-1)!.content).toContain('나레이터의 장면 서술만');

    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.path.at(-1).content).toBe('@: 문을 열었다');
    expect(after.path.at(-1).id).not.toBe(narrated.path.at(-1).id);
    expect(after.path.at(-1).parentId).toBe(narrated.path.at(-1).parentId);

    // …and an ordinary reply regenerates without ever seeing the nudge.
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '누구세요?' }, capturing),
    );
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, capturing));
    expect(prompts.at(-1)!.messages.at(-1)!.content).not.toContain('나레이터의 장면 서술만');
    const ordinary = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(ordinary.path.at(-1).content).toBe('누구세요?');
  });

  it('reads a generated narration back as narration everywhere it is read', async () => {
    const cookie = await signUp('narrate-history@example.com');
    const { chatId } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();
    await userHead(cookie, chatId, capturing);
    await readSse(await json(cookie, `/api/chats/${chatId}/narrate`, 'POST', undefined, capturing));

    // The next turn carries it labelled rather than as the character speaking, and
    // the prefix itself never reaches the model.
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '누구세요?' }, capturing),
    );
    const contents = prompts.at(-1)!.messages.map((message) => contentText(message.content));
    expect(contents).toContain('[나레이션] 문을 열었다');
    expect(contents.some((content) => content.includes('@:'))).toBe(false);

    // And the export carries it verbatim: the convention is the consumer's to read.
    const exported = await readJson(await request(cookie, `/api/chats/${chatId}/export`));
    expect(ChatExportSchema.safeParse(exported).success).toBe(true);
    expect(
      exported.messages.some(
        (message: any) => message.role === 'assistant' && message.text === '@: 문을 열었다',
      ),
    ).toBe(true);
  });

  it('takes a narrator on the plot and puts it in the cached prefix', async () => {
    const cookie = await signUp('narrator-card@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();

    const saved = await patchPlot(cookie, plotId, {
      // An unknown point of view is dropped rather than stored.
      narrator: { voice: '건조하고 짧게 끊어 쓴다.', pov: 'sideways', extra: 'x' },
    });
    expect(saved.narrator).toEqual({ voice: '건조하고 짧게 끊어 쓴다.' });

    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '안녕' }, capturing),
    );
    expect(prompts.at(-1)!.system).toContain('나레이터 문체: 건조하고 짧게 끊어 쓴다.');
    expect(prompts.at(-1)!.system).not.toContain('나레이션 시점');
  });

  it('lets a chat override the plot narrator, and clears it with null', async () => {
    const cookie = await signUp('narrator-chat@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();

    await patchPlot(cookie, plotId, { narrator: { voice: '작품의 문체.', pov: 'third' } });

    const patched = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', {
        narrator: { voice: '대화의 문체.', pov: 'omniscient' },
      }),
    );
    expect(patched.chat.narrator).toEqual({ voice: '대화의 문체.', pov: 'omniscient' });

    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '안녕' }, capturing),
    );
    // The override stands in for the plot's whole narrator, not field by field.
    expect(prompts.at(-1)!.system).toContain('나레이터 문체: 대화의 문체.');
    expect(prompts.at(-1)!.system).toContain('나레이션 시점: 3인칭 전지적');
    expect(prompts.at(-1)!.system).not.toContain('작품의 문체.');

    // An object that says nothing clears the column, and so does null.
    const emptied = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { narrator: { voice: '   ', pov: 'nope' } }),
    );
    expect(emptied.chat.narrator).toBeNull();
    await json(cookie, `/api/chats/${chatId}`, 'PATCH', { narrator: { pov: 'first' } });
    const cleared = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { narrator: null }),
    );
    expect(cleared.chat.narrator).toBeNull();

    // …and the plot's own is back in force.
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '또 안녕' }, capturing),
    );
    expect(prompts.at(-1)!.system).toContain('나레이터 문체: 작품의 문체.');
    expect(prompts.at(-1)!.system).toContain('나레이션 시점: 3인칭 관찰자');

    expect((await json(cookie, `/api/chats/${chatId}`, 'PATCH', { narrator: 'nope' })).status).toBe(400);
  });
});

describe('plot style', () => {
  /** What the two derived features look like in the compiled block. */
  const STATUS_DIRECTIVE = '```status';
  const CHOICES_DIRECTIVE = '`>> `로 시작하는';

  /** One turn on the capturing app, so the request it produced can be read. */
  const sendTurn = (cookie: string, chatId: string, target: Hono<AppEnv>, content: string): Promise<SseEvent[]> =>
    json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content }, target).then(readSse);

  it('compiles the creator style into the cached prefix, cap and all', async () => {
    const cookie = await signUp('style-prompt@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();

    // A plot that set no style says nothing about one, and generates under the
    // cap every plot has always generated under.
    await sendTurn(cookie, chatId, capturing, '안녕');
    expect(prompts.at(-1)!.system).not.toContain('연출 지시:');
    expect(prompts.at(-1)!.maxTokens).toBe(DEFAULT_MAX_RESPONSE_TOKENS);

    await patchPlot(cookie, plotId, {
      style: {
        replyLength: 'short',
        difficulty: 'nightmare',
        moods: ['horror'],
        // Defaults compile to nothing: the prompt says nothing about what the
        // creator left alone.
        pacing: 'natural',
        delivery: 'balanced',
      },
    });
    await sendTurn(cookie, chatId, capturing, '짧게');
    const styled = prompts.at(-1)!;
    expect(styled.system).toContain('연출 지시:');
    expect(styled.system).toContain('군더더기 없이 짧게');
    expect(styled.system).toContain('적대적으로 굽니다');
    expect(styled.system).toContain('장면의 분위기는 호러');
    expect(styled.system).not.toContain('전개를');
    expect(styled.system).not.toContain('비중을');
    // The directive is only half of the length setting; this is the half that holds.
    expect(styled.maxTokens).toBe(600);

    await patchPlot(cookie, plotId, { style: { replyLength: 'long' } });
    await sendTurn(cookie, chatId, capturing, '길게');
    expect(prompts.at(-1)!.maxTokens).toBe(2400);

    // `auto` asks for nothing and caps at the default, exactly as no style does.
    await patchPlot(cookie, plotId, { style: { replyLength: 'auto' } });
    await sendTurn(cookie, chatId, capturing, '알아서');
    expect(prompts.at(-1)!.system).not.toContain('연출 지시:');
    expect(prompts.at(-1)!.maxTokens).toBe(DEFAULT_MAX_RESPONSE_TOKENS);
  });

  it('crosses the two derived features with the reader own toggles', async () => {
    const cookie = await signUp('style-toggles@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();
    await patchPlot(cookie, plotId, { style: { statusWindow: true, choices: 'keywords' } });

    // On by default: a reader who never touched them gets what the plot asks for.
    const initial = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(initial.chat).toMatchObject({ statusWindowEnabled: true, choicesEnabled: true });
    await sendTurn(cookie, chatId, capturing, '안녕');
    expect(prompts.at(-1)!.system).toContain(STATUS_DIRECTIVE);
    expect(prompts.at(-1)!.system).toContain(CHOICES_DIRECTIVE);
    expect(prompts.at(-1)!.system).toContain('키워드형');

    const patched = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', {
        statusWindowEnabled: false,
        choicesEnabled: false,
      }),
    );
    expect(patched.chat).toMatchObject({ statusWindowEnabled: false, choicesEnabled: false });
    await sendTurn(cookie, chatId, capturing, '조용히');
    expect(prompts.at(-1)!.system).not.toContain(STATUS_DIRECTIVE);
    expect(prompts.at(-1)!.system).not.toContain(CHOICES_DIRECTIVE);

    // And the other way round: a chat's true is nothing on its own — the feature
    // is the creator's to ask for.
    await patchPlot(cookie, plotId, { style: { pacing: 'fast' } });
    await json(cookie, `/api/chats/${chatId}`, 'PATCH', {
      statusWindowEnabled: true,
      choicesEnabled: true,
    });
    await sendTurn(cookie, chatId, capturing, '다시');
    expect(prompts.at(-1)!.system).toContain('전개를 빠르게');
    expect(prompts.at(-1)!.system).not.toContain(STATUS_DIRECTIVE);
    expect(prompts.at(-1)!.system).not.toContain(CHOICES_DIRECTIVE);
  });

  it('refuses a toggle while a generation is running', async () => {
    const cookie = await signUp('style-toggle-busy@example.com');
    const { chatId } = await setupChat(cookie);

    // Long content: the echo adapter fills the stream buffer and blocks on
    // backpressure until the body is read, keeping the slot held.
    const first = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
      content: Array.from({ length: 2000 }, (_, i) => `단어${i}`).join(' '),
    });
    const blocked = await json(cookie, `/api/chats/${chatId}`, 'PATCH', { statusWindowEnabled: false });
    expect(blocked.status).toBe(409);
    expect((await readJson(blocked)).code).toBe('generation_in_progress');

    await readSse(first);
    const after = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { statusWindowEnabled: false }),
    );
    expect(after.chat.statusWindowEnabled).toBe(false);
  });
});

describe('recommended profiles', () => {
  const KNIGHT = { name: '기사', description: '왕국을 지키는 기사.' };
  const THIEF = { name: '도적', description: '뒷골목의 도적.' };

  it('stores what the coercion keeps and shows it to readers', async () => {
    const cookie = await signUp('profiles-owner@example.com');
    const plot = await publishablePlot(cookie, {
      profiles: [
        KNIGHT,
        // Junk rows are dropped rather than refused, the way an unknown style
        // option is: the two the creator really wrote still land.
        { description: '이름이 없다' },
        { name: '   ' },
        'not a profile',
        { name: `${'가'.repeat(40)}`, description: '나'.repeat(1200) },
      ],
    });

    expect(plot.profiles).toEqual([
      { id: expect.any(String), ...KNIGHT },
      { id: expect.any(String), name: '가'.repeat(30), description: '나'.repeat(1000) },
    ]);
    // The ids are the handles a chat start points at, so they survive a re-read.
    expect((await readPlot(cookie, plot.id)).profiles).toEqual(plot.profiles);

    // Editing sends them back whole, ids included.
    const edited = await patchPlot(cookie, plot.id, {
      profiles: [{ ...plot.profiles[0], description: '왕국을 떠난 기사.' }, THIEF],
    });
    expect(edited.profiles[0]).toEqual({ ...plot.profiles[0], description: '왕국을 떠난 기사.' });
    expect(edited.profiles[1]).toEqual({ id: expect.any(String), ...THIEF });

    // Reader-facing by design: the start panel is where one is picked.
    await publishPlot(cookie, plot.id);
    const reader = await signUp('profiles-reader@example.com');
    expect((await readPublicPlot(reader, plot.id)).profiles).toEqual(edited.profiles);

    // Nothing left to recommend empties the column, and a list is required to be one.
    expect((await patchPlot(cookie, plot.id, { profiles: [] })).profiles).toEqual([]);
    expect((await readPublicPlot(reader, plot.id)).profiles).toEqual([]);
    const refused = await json(cookie, `/api/plots/${plot.id}`, 'PATCH', { profiles: '기사' });
    expect(refused.status).toBe(400);
    expect((await readJson(refused)).code).toBe('invalid_request');
  });

  it('starts a chat on a copy of the profile the reader picked', async () => {
    const alice = await signUp('profiles-creator@example.com');
    const plot = await publishablePlot(alice, { profiles: [KNIGHT] });
    await publishPlot(alice, plot.id);
    const [profile] = (await readPlot(alice, plot.id)).profiles;

    const bob = await signUp('profiles-picker@example.com');
    const state = await startChat(bob, plot.id, { profileId: profile.id });

    // The chat points at a persona of the reader's own, not at the plot's row.
    const personas = await readJson(await request(bob, '/api/personas'));
    expect(personas).toEqual([{ id: expect.any(String), ...KNIGHT, createdAt: expect.any(String) }]);
    expect(state.chat.personaId).toBe(personas[0].id);
    expect(state.chat.personaId).not.toBe(profile.id);
    // And it is theirs to edit afterwards, like any other persona.
    const renamed = await json(bob, `/api/personas/${personas[0].id}`, 'PUT', { name: '떠도는 기사' });
    expect(renamed.status).toBe(200);

    // A second start copies again: a copy is cheap and the reader owns it.
    await startChat(bob, plot.id, { profileId: profile.id });
    expect((await readJson(await request(bob, '/api/personas'))).length).toBe(2);

    // The two ways of naming a persona are mutually exclusive.
    const both = await json(bob, '/api/chats', 'POST', {
      plotId: plot.id,
      model: 'echo/echo',
      personaId: personas[0].id,
      profileId: profile.id,
    });
    expect(both.status).toBe(400);
    expect((await readJson(both)).code).toBe('invalid_request');

    // A profile of some other plot is not this plot's to start on.
    const other = await publishablePlot(alice, { profiles: [THIEF] });
    const foreign = (await readPlot(alice, other.id)).profiles[0].id;
    const missing = await json(bob, '/api/chats', 'POST', {
      plotId: plot.id,
      model: 'echo/echo',
      profileId: foreign,
    });
    expect(missing.status).toBe(404);
    // Nothing was copied for a start that did not happen.
    expect((await readJson(await request(bob, '/api/personas'))).length).toBe(2);
  });
});

describe('unlockable assets', () => {
  const KEYWORD = { kind: 'keyword', keywords: ['고백'] };

  /** An asset row without the bytes: what is under test is the reveal, not the image. */
  async function seedAsset(plotId: string, slug: string, unlock: unknown = null): Promise<string> {
    const [row] = await db
      .insert(plotAssets)
      .values({ plotId, slug, path: `assets/${slug}.gif`, mime: 'image/gif', unlock: unlock as never })
      .returning({ id: plotAssets.id });
    return row!.id;
  }

  /** The chat's locks, in slug order — the rows are written in one breath. */
  const locksOf = async (cookie: string, chatId: string): Promise<any[]> => {
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    return [...state.assetLocks].sort((a, b) => a.slug.localeCompare(b.slug));
  };

  /** One turn, answered with the `done` payload the client celebrates on. */
  async function sendTurn(cookie: string, chatId: string, content: string): Promise<any> {
    const events = await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content }));
    const done = events.at(-1)!;
    expect(done.event).toBe('done');
    return done.data;
  }

  /** A published plot with one locked asset and one that was never locked. */
  async function lockedPlot(cookie: string, unlock: unknown): Promise<any> {
    const plot = await publishablePlot(cookie, { name: '해금 작품' });
    const plain = await seedAsset(plot.id, 'plain');
    const secret = await seedAsset(plot.id, 'secret', unlock);
    await publishPlot(cookie, plot.id);
    return { id: plot.id, plain, secret };
  }

  it('stores an unlock through the coercion and keeps its condition from readers', async () => {
    const cookie = await signUp('unlock-owner@example.com');
    const plot = await publishablePlot(cookie, { name: '조건 작품' });
    await seedAsset(plot.id, 'secret');
    const patch = (unlock: unknown): Promise<Response> =>
      json(cookie, `/api/plots/${plot.id}/assets/secret`, 'PATCH', { unlock });

    const set = await patch({ kind: 'keyword', keywords: [' 고백 ', '고백', ''] });
    expect(set.status).toBe(200);
    expect((await readJson(set)).unlock).toEqual(KEYWORD);

    // A condition this build could not evaluate would leave the image shut
    // forever, so it is cleared rather than stored.
    expect((await readJson(await patch({ kind: 'mood', mood: 'romance' }))).unlock).toBeNull();
    expect((await readJson(await patch(KEYWORD))).unlock).toEqual(KEYWORD);
    expect((await readJson(await patch(null))).unlock).toBeNull();
    await patch(KEYWORD);

    // Re-uploading the bytes does not restate the condition.
    const form = new FormData();
    form.append('file', new File([Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01])], 'x.gif'));
    form.append('slug', 'secret');
    const reuploaded = await request(cookie, `/api/plots/${plot.id}/assets`, 'POST', form);
    expect(reuploaded.status).toBe(201);
    expect((await readJson(reuploaded)).unlock).toEqual(KEYWORD);

    const missing = await json(cookie, `/api/plots/${plot.id}/assets/secret`, 'PATCH', {});
    expect(missing.status).toBe(400);
    expect((await patch({ kind: 'turns', count: 1 })).status).toBe(200);
    expect((await json(cookie, `/api/plots/${plot.id}/assets/gone`, 'PATCH', { unlock: null })).status).toBe(404);

    // The keywords are the spoiler the reveal is worth having: only the owner's
    // reads carry the condition.
    await publishPlot(cookie, plot.id);
    const reader = await signUp('unlock-reader@example.com');
    const [asOwner] = await readJson(await request(cookie, `/api/plots/${plot.id}/assets`));
    const [asReader] = await readJson(await request(reader, `/api/plots/${plot.id}/assets`));
    expect(asOwner.unlock).toEqual({ kind: 'turns', count: 1 });
    expect(asReader).not.toHaveProperty('unlock');
    expect((await json(reader, `/api/plots/${plot.id}/assets/secret`, 'PATCH', { unlock: null })).status).toBe(404);
  });

  it('opens a keyword unlock on the turn that says it', async () => {
    const alice = await signUp('unlock-keyword-creator@example.com');
    const plot = await lockedPlot(alice, KEYWORD);
    const bob = await signUp('unlock-keyword-reader@example.com');
    const chatId = (await startChat(bob, plot.id)).chat.id;

    expect(await locksOf(bob, chatId)).toEqual([
      { assetId: plot.plain, slug: 'plain', locked: false, kind: null },
      { assetId: plot.secret, slug: 'secret', locked: true, kind: 'keyword' },
    ]);

    // The echo model mirrors the turn, so the assistant text is what was sent.
    const quiet = await sendTurn(bob, chatId, '안녕');
    expect(quiet).not.toHaveProperty('unlockedAssetIds');
    expect((await locksOf(bob, chatId))[1].locked).toBe(true);

    const opened = await sendTurn(bob, chatId, '이제 고백할게');
    expect(opened.unlockedAssetIds).toEqual([plot.secret]);
    expect(await locksOf(bob, chatId)).toEqual([
      { assetId: plot.plain, slug: 'plain', locked: false, kind: null },
      { assetId: plot.secret, slug: 'secret', locked: false, kind: 'keyword' },
    ]);

    // Already open: the row is written once and only the turn that opened it says so.
    const again = await sendTurn(bob, chatId, '다시 고백할게');
    expect(again).not.toHaveProperty('unlockedAssetIds');
    expect(await db.select().from(chatAssetUnlocks).where(eq(chatAssetUnlocks.chatId, chatId))).toHaveLength(1);

    // Another reader's chat starts locked: an unlock belongs to one conversation.
    const carol = await signUp('unlock-keyword-other@example.com');
    const fresh = (await startChat(carol, plot.id)).chat.id;
    expect((await locksOf(carol, fresh))[1].locked).toBe(true);
  });

  it('opens a turn unlock at depth and a relationship unlock when the axis reaches it', async () => {
    const alice = await signUp('unlock-depth-creator@example.com');
    const plot = await publishablePlot(alice, { name: '깊이 작품' });
    const deep = await seedAsset(plot.id, 'deep', { kind: 'turns', count: 3 });
    const close = await seedAsset(plot.id, 'close', { kind: 'relationship', axis: 'trust', min: 60 });
    await publishPlot(alice, plot.id);

    const bob = await signUp('unlock-depth-reader@example.com');
    // The opening is already an assistant turn, so the branch starts at depth 1.
    const chatId = (await startChat(bob, plot.id)).chat.id;

    // Depth 2: neither condition is met, and axes that were never extracted
    // simply never satisfy a relationship unlock.
    expect(await sendTurn(bob, chatId, '한 번')).not.toHaveProperty('unlockedAssetIds');

    // Depth 3.
    expect((await sendTurn(bob, chatId, '두 번')).unlockedAssetIds).toEqual([deep]);

    const relationship: ChatRelationship = {
      axes: { affection: 50, obsession: 0, trust: 61, liking: 50, disgust: 0, fear: 0 },
      note: '조금씩 믿기 시작했다.',
      updatedAt: new Date().toISOString(),
      lastExtractedAssistantDepth: 3,
    };
    await db.update(chats).set({ relationship }).where(eq(chats.id, chatId));
    expect((await sendTurn(bob, chatId, '세 번')).unlockedAssetIds).toEqual([close]);
    expect(await locksOf(bob, chatId)).toEqual([
      { assetId: close, slug: 'close', locked: false, kind: 'relationship' },
      { assetId: deep, slug: 'deep', locked: false, kind: 'turns' },
    ]);
  });

  it('shows the creator their own work whole', async () => {
    const alice = await signUp('unlock-creator-view@example.com');
    const plot = await lockedPlot(alice, KEYWORD);
    const chatId = (await startChat(alice, plot.id)).chat.id;

    // Locked for nobody in the creator's own chat — the hint still says what the
    // condition is, because that is the editor's own answer.
    expect(await locksOf(alice, chatId)).toEqual([
      { assetId: plot.plain, slug: 'plain', locked: false, kind: null },
      { assetId: plot.secret, slug: 'secret', locked: false, kind: 'keyword' },
    ]);
    // And nothing to open: there is no reveal to celebrate for the author.
    expect(await sendTurn(alice, chatId, '고백할게')).not.toHaveProperty('unlockedAssetIds');
    expect(await db.select().from(chatAssetUnlocks).where(eq(chatAssetUnlocks.chatId, chatId))).toHaveLength(0);
  });

  it('says nothing about a plot with no assets', async () => {
    const cookie = await signUp('unlock-none@example.com');
    const { chatId } = await setupChat(cookie);
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).assetLocks).toEqual([]);
  });
});

describe('scene editing', () => {
  /** Writes a branch straight into the table, so the scene under test is exact. */
  async function seedScene(
    chatId: string,
    rows: {
      role: 'user' | 'assistant';
      content: string;
      source?: 'user' | 'component';
      directions?: string;
      loreTriggers?: string[];
    }[],
    parentId: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    let parent = parentId;
    // Distinct stamps, like the greeting roots — and all of them before now, so a
    // sibling this scene is forked into is always the newer of the two.
    const stamp = Date.now() - rows.length;
    for (const [index, row] of rows.entries()) {
      const [written] = await db
        .insert(messages)
        .values({
          chatId,
          parentId: parent,
          role: row.role,
          content: row.content,
          ...(row.source ? { source: row.source } : {}),
          ...(row.directions ? { directions: row.directions } : {}),
          ...(row.loreTriggers ? { loreTriggers: row.loreTriggers } : {}),
          createdAt: new Date(stamp + index),
        })
        .returning();
      parent = written!.id;
      ids.push(written!.id);
    }
    await db.update(chats).set({ headMessageId: parent }).where(eq(chats.id, chatId));
    return ids;
  }

  /** Greeting, a line of the reader's own, then a scene of three turns. */
  async function sceneChat(
    cookie: string,
  ): Promise<{ chatId: string; dialogue: string; scene: string[] }> {
    const { chatId, state } = await setupChat(cookie);
    const [dialogue, ...scene] = await seedScene(
      chatId,
      [
        { role: 'user', content: '안녕' },
        { role: 'user', content: '@: 문이 열린다' },
        { role: 'assistant', content: '누구세요?' },
        { role: 'assistant', content: '@: 바람이 분다' },
      ],
      state.path[0].id,
    );
    return { chatId, dialogue: dialogue!, scene };
  }

  const messageCount = async (chatId: string): Promise<number> =>
    (await db.select().from(messages).where(eq(messages.chatId, chatId))).length;

  const editScene = (cookie: string, chatId: string, body: unknown): Promise<Response> =>
    json(cookie, `/api/chats/${chatId}/edit-scene`, 'POST', body);

  it('forks at the first changed block and leaves the old run in the tree', async () => {
    const cookie = await signUp('scene-edit@example.com');
    const { chatId, scene } = await sceneChat(cookie);

    const res = await editScene(cookie, chatId, {
      messageIds: scene,
      blocks: [
        { originId: scene[0], kind: 'narration', content: '문이 열린다' },
        { originId: scene[1], kind: 'dialogue', content: '거기 누구야?' },
        { originId: scene[2], kind: 'narration', content: '바람이 분다' },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const after = await readJson(res);

    // The unchanged first block is the fork point: it stays, and everything from
    // the changed one on is a new run under it.
    expect(after.path).toHaveLength(5);
    expect(after.path[2].id).toBe(scene[0]);
    expect(after.path[3].id).not.toBe(scene[1]);
    expect(after.path[3].content).toBe('거기 누구야?');
    expect(after.path[4].content).toBe('@: 바람이 분다');
    expect(after.path[4].id).not.toBe(scene[2]);
    expect(after.chat.headMessageId).toBe(after.path[4].id);
    // The rewrite is the reader's words, not a model's.
    expect(after.path[3].model).toBeNull();

    // The old run is still there as a sibling, and a swipe goes back to it whole.
    expect(after.siblings[after.path[3].id]).toEqual({
      index: 1,
      total: 2,
      ids: [scene[1], after.path[3].id],
    });
    const back = await readJson(
      await json(cookie, `/api/chats/${chatId}/head`, 'POST', { messageId: scene[1] }),
    );
    expect(back.path.map((message: any) => message.id)).toEqual([
      back.path[0].id,
      back.path[1].id,
      scene[0],
      scene[1],
      scene[2],
    ]);
  });

  it('keeps the turn each rebuilt block came from', async () => {
    const cookie = await signUp('scene-role@example.com');
    const { chatId, state } = await setupChat(cookie);
    const [narration, reply] = await seedScene(
      chatId,
      [
        // A narration the reader wrote, through a component, under a ruling.
        { role: 'user', content: '@: 문이 열린다', source: 'component', directions: '판정: 성공' },
        { role: 'assistant', content: '누구세요?', loreTriggers: ['0badc0de'] },
      ],
      state.path[0].id,
    );

    const after = await readJson(
      await editScene(cookie, chatId, {
        messageIds: [narration, reply],
        blocks: [
          { originId: narration, kind: 'narration', content: '문이 조용히 열린다' },
          { originId: reply, kind: 'dialogue', content: '누구세요?' },
        ],
      }),
    );

    // Rebuilt from the first block, so both rows are new — and both are still the
    // turn they were.
    const [rewritten, rebuiltReply] = after.path.slice(1);
    expect(rewritten.id).not.toBe(narration);
    expect(rewritten.role).toBe('user');
    expect(rewritten.source).toBe('component');
    expect(rewritten.directions).toBe('판정: 성공');
    expect(rewritten.content).toBe('@: 문이 조용히 열린다');
    expect(rebuiltReply.id).not.toBe(reply);
    expect(rebuiltReply.role).toBe('assistant');
    // The lore it triggered stays on the turn, or a typo fix would end a sticky
    // entry's window.
    const [stored] = await db.select().from(messages).where(eq(messages.id, rebuiltReply.id));
    expect(stored!.loreTriggers).toEqual(['0badc0de']);
  });

  it('gives a new narration block to the reader and a new dialogue block to the character', async () => {
    const cookie = await signUp('scene-new@example.com');
    const { chatId, scene } = await sceneChat(cookie);

    const after = await readJson(
      await editScene(cookie, chatId, {
        messageIds: [scene[0]],
        blocks: [
          { originId: scene[0], kind: 'narration', content: '문이 열린다' },
          { kind: 'narration', content: '복도에 불이 들어온다' },
          { kind: 'dialogue', content: '누구세요?' },
        ],
      }),
    );

    // Adding to the end still forks, so the block that matched comes back as a copy
    // of itself and the new turns hang off that.
    const [copy, addedNarration, addedDialogue] = after.path.slice(-3);
    expect(copy.id).not.toBe(scene[0]);
    expect(after.siblings[copy.id].ids).toEqual([scene[0], copy.id]);
    expect(addedNarration.role).toBe('user');
    // The prefix is the server's to write, here as much as on a generated turn.
    expect(addedNarration.content).toBe('@: 복도에 불이 들어온다');
    expect(addedNarration.parentId).toBe(copy.id);
    expect(addedDialogue.role).toBe('assistant');
    expect(addedDialogue.content).toBe('누구세요?');
    expect(addedDialogue.parentId).toBe(addedNarration.id);
    expect(after.chat.headMessageId).toBe(addedDialogue.id);
  });

  it('forks at the tail when the rewrite only adds to the end of the scene', async () => {
    const cookie = await signUp('scene-append@example.com');
    const { chatId, scene } = await sceneChat(cookie);

    const after = await readJson(
      await editScene(cookie, chatId, {
        messageIds: scene,
        blocks: [
          { originId: scene[0], kind: 'narration', content: '문이 열린다' },
          { originId: scene[1], kind: 'dialogue', content: '누구세요?' },
          { originId: scene[2], kind: 'narration', content: '바람이 분다' },
          { kind: 'dialogue', content: '아무도 없나요?' },
        ],
      }),
    );

    // The scene's last turn is re-inserted beside itself, so the addition hangs off
    // a sibling rather than off the branch the reader was on.
    const [copy, added] = after.path.slice(-2);
    expect(copy.id).not.toBe(scene[2]);
    expect(copy.content).toBe('@: 바람이 분다');
    expect(copy.parentId).toBe(scene[1]);
    expect(added.content).toBe('아무도 없나요?');
    expect(after.chat.headMessageId).toBe(added.id);
    expect(after.siblings[copy.id]).toEqual({ index: 1, total: 2, ids: [scene[2], copy.id] });

    // …so a swipe back is the scene exactly as it read before the addition.
    const back = await readJson(
      await json(cookie, `/api/chats/${chatId}/head`, 'POST', { messageId: scene[2] }),
    );
    expect(back.chat.headMessageId).toBe(scene[2]);
    expect(back.path.map((message: any) => message.id).slice(-3)).toEqual(scene);
  });

  it('forks at the tail when the rewrite drops the end of the scene', async () => {
    const cookie = await signUp('scene-drop@example.com');
    const { chatId, scene } = await sceneChat(cookie);

    const after = await readJson(
      await editScene(cookie, chatId, {
        messageIds: scene,
        blocks: [{ originId: scene[0], kind: 'narration', content: '문이 열린다' }],
      }),
    );

    // The one block that stayed comes back as a copy of itself: the scene now ends
    // where the reader ended it, and nothing was written over to do it.
    const head = after.path[after.path.length - 1];
    expect(after.path).toHaveLength(3);
    expect(head.id).not.toBe(scene[0]);
    expect(head.content).toBe('@: 문이 열린다');
    expect(after.chat.headMessageId).toBe(head.id);
    expect(after.siblings[head.id]).toEqual({ index: 1, total: 2, ids: [scene[0], head.id] });

    // The dropped turns are one swipe away — the head lands on the deepest leaf
    // under the original, which is the tail, whole.
    const back = await readJson(
      await json(cookie, `/api/chats/${chatId}/head`, 'POST', { messageId: scene[0] }),
    );
    expect(back.chat.headMessageId).toBe(scene[2]);
    expect(back.path.map((message: any) => message.id).slice(-3)).toEqual(scene);
  });

  it('does nothing at all when the scene comes back unchanged', async () => {
    const cookie = await signUp('scene-noop@example.com');
    const { chatId, scene } = await sceneChat(cookie);
    const before = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const rows = await messageCount(chatId);

    const after = await readJson(
      await editScene(cookie, chatId, {
        messageIds: scene,
        blocks: [
          { originId: scene[0], kind: 'narration', content: '문이 열린다' },
          { originId: scene[1], kind: 'dialogue', content: '누구세요?' },
          { originId: scene[2], kind: 'narration', content: '바람이 분다' },
        ],
      }),
    );

    expect(await messageCount(chatId)).toBe(rows);
    expect(after.chat.headMessageId).toBe(before.chat.headMessageId);
    expect(after.path.map((message: any) => message.id)).toEqual(
      before.path.map((message: any) => message.id),
    );
  });

  it('refuses a scene that is not a run of the branch, and an edit of someone else\'s chat', async () => {
    const cookie = await signUp('scene-bad@example.com');
    const other = await signUp('scene-bad-other@example.com');
    const { chatId, dialogue, scene } = await sceneChat(cookie);
    const block = (originId: string, kind: string, content: string) => ({ originId, kind, content });

    const refused = async (body: unknown): Promise<void> => {
      const res = await editScene(cookie, chatId, body);
      expect(res.status, await res.clone().text()).toBe(400);
      expect((await readJson(res)).code).toBe('invalid_request');
    };

    // A gap in the middle: the ids have to name a contiguous run.
    await refused({
      messageIds: [scene[0], scene[2]],
      blocks: [block(scene[0]!, 'narration', '문이 열린다'), block(scene[2]!, 'narration', '바람이 분다')],
    });
    // The reader's own dialogue is what breaks a scene, so it is never part of one.
    await refused({
      messageIds: [dialogue],
      blocks: [block(dialogue, 'dialogue', '안녕')],
    });
    await refused({
      messageIds: [scene[0]],
      blocks: [block(scene[0]!, 'narration', '   ')],
    });
    // No kind toggle on a block that came from a message.
    await refused({
      messageIds: [scene[0]],
      blocks: [block(scene[0]!, 'dialogue', '문이 열린다')],
    });
    // …nor an original used twice, or out of the order it stands in.
    await refused({
      messageIds: scene,
      blocks: [block(scene[1]!, 'dialogue', '누구세요?'), block(scene[0]!, 'narration', '문이 열린다')],
    });

    // Nothing was written by any of that.
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(state.path.map((message: any) => message.id).slice(-3)).toEqual(scene);

    expect(
      (
        await editScene(other, chatId, {
          messageIds: [scene[0]],
          blocks: [block(scene[0]!, 'narration', '다른 사람의 장면')],
        })
      ).status,
    ).toBe(404);
  });
});

describe('custom UI', () => {
  /** A RisuAI-exported card carrying a status-window display script. */
  const risuCard = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '루미',
      description: '상태창을 쓰는 캐릭터.',
      personality: '',
      scenario: '',
      first_mes: '[status] hp=100',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1.0',
      extensions: {
        risuai: {
          defaultVariables: 'hp=100',
          customScripts: [
            { comment: '', in: 'a', out: 'b', type: 'editinput' },
            {
              comment: '상태창',
              in: '\\[status\\] hp=(\\d+)',
              out: '<div class="hp">HP $1</div>',
              type: 'editdisplay',
              ableFlag: true,
              flag: 'g<move_top><order 2>',
            },
          ],
        },
      },
    },
  };

  it('imports RisuAI editdisplay scripts and default variables, and round-trips them', async () => {
    const cookie = await signUp('risu-import@example.com');
    const plot = await importCard(
      cookie,
      new File([JSON.stringify(risuCard)], 'lumi.json', { type: 'application/json' }),
    );

    // The import lifts them onto the work: a chat is the plot's, so what a chat
    // renders with cannot belong to one of its members.
    expect(plot.customUi.displayScripts).toEqual([
      {
        in: '\\[status\\] hp=(\\d+)',
        out: '<div class="hp">HP $1</div>',
        flags: 'g',
        order: 2,
        action: 'move_top',
        enabled: true,
      },
    ]);
    expect(plot.customUi.defaultVariables).toEqual({ hp: '100' });
    // The script type we do not map is untouched in the member's extensions, so
    // an export can hand it back exactly as it arrived.
    expect(plot.characters[0].card.extensions.risuai.customScripts[0].type).toBe('editinput');

    // A save from the editor keeps both fields, and edits reach the stored plot.
    const saved = await patchPlot(cookie, plot.id, {
      customUi: {
        displayScripts: [
          { ...plot.customUi.displayScripts[0], order: 5, action: 'repeat_back' },
          { in: '', out: '<b>x</b>', order: 6, enabled: true },
        ],
        defaultVariables: { hp: '80', mood: '평온', bad: 3 },
      },
    });
    // A script with no pattern matches nothing, so it is not stored; a non-string
    // variable is not a variable.
    expect(saved.customUi.displayScripts).toEqual([
      {
        in: '\\[status\\] hp=(\\d+)',
        out: '<div class="hp">HP $1</div>',
        flags: 'g',
        order: 5,
        action: 'repeat_back',
        enabled: true,
      },
    ]);
    expect(saved.customUi.defaultVariables).toEqual({ hp: '80', mood: '평온' });
  });

  it('refuses a display script pattern that could hang a reader', async () => {
    const cookie = await signUp('redos@example.com');
    const plot = await createPlot(cookie, { name: '패턴' });

    const save = (pattern: string) =>
      json(cookie, `/api/plots/${plot.id}`, 'PATCH', {
        customUi: { displayScripts: [{ in: pattern, out: '<b>$1</b>', order: 0, enabled: true }] },
      });

    // `^(a+)+$` is the standard catastrophic-backtracking demonstration: it runs
    // in the reader's tab, synchronously, on every render.
    const rejected = await save('^(a+)+$');
    expect(rejected.status).toBe(400);
    expect((await readJson(rejected)).code).toBe('invalid_request');
    expect((await save('([')).status).toBe(400);
    expect((await save(`a{${'0'.repeat(600)}}`)).status).toBe(400);

    // The stored plot never took the bad one…
    expect((await readPlot(cookie, plot.id)).customUi).toBeNull();
    // …and an ordinary status-window pattern still saves.
    expect((await save('\\[status\\] hp=(\\d+)')).status).toBe(200);
  });

  it('imports a hazardous pattern switched off instead of refusing the whole card', async () => {
    const cookie = await signUp('redos-import@example.com');
    const hazardous = {
      ...risuCard,
      data: {
        ...risuCard.data,
        extensions: {
          risuai: {
            customScripts: [{ comment: '', in: '^(a+)+$', out: '<b>$1</b>', type: 'editdisplay' }],
          },
        },
      },
    };
    const plot = await importCard(
      cookie,
      new File([JSON.stringify(hazardous)], 'redos.json', { type: 'application/json' }),
    );
    // A whole card is not worth refusing over one script, and a script the creator
    // can see and rewrite is better than one silently dropped.
    expect(plot.customUi.displayScripts).toEqual([
      { in: '^(a+)+$', out: '<b>$1</b>', order: 0, enabled: false },
    ]);
  });

  it('leaves a plot that never used the feature without the column', async () => {
    const cookie = await signUp('no-custom-ui@example.com');
    const plot = await createPlot(cookie, { name: '평범' });
    expect(plot.customUi).toBeNull();
    expect(plot.characters).toBeUndefined();
  });

  it('keeps component code through create, update, import and the public view', async () => {
    const owner = await signUp('component-owner@example.com');
    const reader = await signUp('component-reader@example.com');
    const code = 'function StatusWindow({ hp = 0 }) {\n  return <div>HP {hp}</div>;\n}';

    const plot = await publishablePlot(owner, {
      name: '컴포넌트 작품',
      intros: ['<StatusWindow hp={100} />'],
      customUi: { componentCode: code },
    });
    expect(plot.customUi.componentCode).toBe(code);

    // The code is stored exactly as written — it runs in a sandboxed frame on an
    // opaque origin, so the server has no reason to rewrite or screen it.
    const edited = `${code}\nfunction Gauge() { return <b>x</b>; }`;
    expect((await patchPlot(owner, plot.id, { customUi: { componentCode: edited } })).customUi.componentCode).toBe(
      edited,
    );

    // Only the size is refused: every reader downloads it.
    const tooLong = await json(owner, `/api/plots/${plot.id}`, 'PATCH', {
      customUi: { componentCode: 'a'.repeat(40_001) },
    });
    expect(tooLong.status).toBe(400);
    expect((await readJson(tooLong)).code).toBe('invalid_request');

    // Presentation travels with the public view, like the display scripts.
    await publishPlot(owner, plot.id);
    const view = await readPublicPlot(reader, plot.id);
    expect(view.public).toBe(true);
    expect(view.customUi).toBeUndefined();
    expect(view.componentCode).toBe(edited);

    // …and an imported card brings it along under our own extension namespace.
    const imported = await importCard(
      owner,
      new File(
        [
          JSON.stringify({
            ...risuCard,
            data: { ...risuCard.data, extensions: { shizue: { componentCode: code } } },
          }),
        ],
        'component.json',
        { type: 'application/json' },
      ),
    );
    expect(imported.customUi.componentCode).toBe(code);
    expect(imported.characters[0].card.extensions.shizue.componentCode).toBe(code);
  });

  it('drops oversized component code on import rather than storing it', async () => {
    const cookie = await signUp('component-import-cap@example.com');
    // Import does not go through the editor, so the cap has to hold here too:
    // the card is jsonb every reader of a published character downloads.
    const oversized = {
      ...risuCard,
      data: {
        ...risuCard.data,
        extensions: { shizue: { componentCode: 'a'.repeat(40_001) } },
      },
    };
    const plot = await importCard(
      cookie,
      new File([JSON.stringify(oversized)], 'huge.json', { type: 'application/json' }),
    );
    expect(plot.customUi).toBeNull();
    // The card itself still arrived.
    expect(plot.characters[0].card.name).toBe('루미');
  });

  it('ships display scripts with the public view, which has no card', async () => {
    const owner = await signUp('risu-owner@example.com');
    const reader = await signUp('risu-reader@example.com');
    const plot = await importCard(
      owner,
      new File([JSON.stringify(risuCard)], 'lumi.json', { type: 'application/json' }),
    );
    await publishPlot(owner, plot.id);

    const view = await readPublicPlot(reader, plot.id);
    expect(view.public).toBe(true);
    expect(view.characters[0].card).toBeUndefined();
    expect(view.displayScripts).toHaveLength(1);
    expect(view.defaultVariables).toEqual({ hp: '100' });
  });

  it('resolves getvar from the branch while the setvar macros stay in the history', async () => {
    const cookie = await signUp('getvar@example.com');
    const plot = await createPlot(cookie, {
      name: '변수 작품',
      description: '설명',
      intros: ['HP는 {{getvar::hp}}'],
      customUi: { defaultVariables: { hp: '100' } },
    });
    await addCharacter(cookie, plot.id, {
      name: '변수 캐릭터',
      card: { description: '설명', systemPrompt: '[현재 HP {{getvar::hp}}]' },
    });
    const created = await startChat(cookie, plot.id);
    const chatId = created.chat.id;
    // The opening is stored raw: there is no branch to derive variables from yet.
    expect(created.path[0].content).toBe('HP는 {{getvar::hp}}');

    const { app: capturing, prompts } = capturingApp();
    await readSse(
      await json(
        cookie,
        `/api/chats/${chatId}/messages`,
        'POST',
        { content: '{{setvar::hp::40}} 다쳤다' },
        capturing,
      ),
    );

    const first = prompts.at(-1)!;
    // The plot's text sees the folded value, defaults included.
    expect(first.system).toContain('[현재 HP 40]');
    // The macro itself reaches the model untouched: it is the protocol the model
    // has to keep emitting.
    expect(first.messages.at(-2)!.content).toBe('{{setvar::hp::40}} 다쳤다');
    // getvar is a macro like any other, so it is expanded in the history too.
    expect(first.messages.some((message) => message.content === 'HP는 40')).toBe(true);

    // A second turn folds addvar on top of what the branch already holds. The
    // echo reply repeats the user text, so only the new macro moves the value.
    await readSse(
      await json(
        cookie,
        `/api/chats/${chatId}/messages`,
        'POST',
        { content: '{{addvar::hp::-15}} 더 다쳤다' },
        capturing,
      ),
    );
    expect(prompts.at(-1)!.system).toContain('[현재 HP 25]');
  });

  it('survives a variable named after an Object.prototype member', async () => {
    const cookie = await signUp('proto-var@example.com');
    const plot = await createPlot(cookie, {
      name: '프로토 작품',
      description: '설명',
      // A card written by a stranger seeds one, and the opening reaches every
      // reader of a published plot.
      intros: ['{{setvar::toString::시작}}안녕'],
      customUi: { defaultVariables: { valueOf: '1', __proto__: '2' } },
    });
    await addCharacter(cookie, plot.id, {
      name: '프로토 캐릭터',
      card: { description: '설명', systemPrompt: '[상태 {{getvar::toString}}/{{getvar::constructor}}]' },
    });
    const created = await startChat(cookie, plot.id);

    const { app: capturing, prompts } = capturingApp();
    // Every one of these folds through `addvar`, where a value that is not a
    // string must never reach `.trim()`: the fold reruns on every later
    // generation of the branch, so a throw there takes the chat down for good.
    const res = await json(
      cookie,
      `/api/chats/${created.chat.id}/messages`,
      'POST',
      {
        content:
          '{{addvar::valueOf::1}}{{addvar::hasOwnProperty::3}}' +
          '{{addvar::__proto__::5}}{{setvar::constructor::끝}}',
      },
      capturing,
    );
    expect(res.status).toBe(200);
    const events = await readSse(res);
    expect(events.at(-1)!.event).toBe('done');
    expect(prompts.at(-1)!.system).toContain('[상태 시작/끝]');

    // …and the chat still reads and still generates afterwards.
    expect((await request(cookie, `/api/chats/${created.chat.id}`)).status).toBe(200);
    const again = await readSse(
      await json(cookie, `/api/chats/${created.chat.id}/regenerate`, 'POST', undefined, capturing),
    );
    expect(again.at(-1)!.event).toBe('done');
  });

  it('keeps the variable macros out of an intro preview', async () => {
    const owner = await signUp('preview-owner@example.com');
    const reader = await signUp('preview-reader@example.com');
    const plot = await publishablePlot(owner, {
      name: '미리보기',
      intros: ['{{setvar::hp::100}}안녕하세요', '{{img::door}}문 앞이다'],
    });
    await publishPlot(owner, plot.id);

    const view = await readPublicPlot(reader, plot.id);
    // The listings' cut, and the whole text beside it — both stripped of the
    // markup a reader has no way to resolve.
    expect(view.introPreview).toBe('안녕하세요');
    expect(view.intros).toEqual(['안녕하세요', '문 앞이다']);
    expect(view.introPreviews).toEqual(['안녕하세요', '문 앞이다']);
  });
});

describe('the game layer', () => {
  it('keeps the declared capabilities through save and the public view, and refuses an unknown one', async () => {
    const owner = await signUp('capability-owner@example.com');
    const reader = await signUp('capability-reader@example.com');

    const plot = await publishablePlot(owner, {
      name: '게임 작품',
      intros: ['문 앞이다'],
      customUi: { componentCapabilities: ['sendTurn'] },
    });
    expect(plot.customUi.componentCapabilities).toEqual(['sendTurn']);

    // A capability nothing grants is a creator's misspelling, and a plot that
    // silently declares nothing is worse than a rejected save.
    const unknown = await json(owner, `/api/plots/${plot.id}`, 'PATCH', {
      customUi: { componentCapabilities: ['impersonate'] },
    });
    expect(unknown.status).toBe(400);
    expect((await readJson(unknown)).code).toBe('invalid_request');

    await publishPlot(owner, plot.id);
    expect((await readPublicPlot(reader, plot.id)).componentCapabilities).toEqual(['sendTurn']);

    // A plot that never asked carries no column, and its public view grants nothing.
    const plain = await publishablePlot(owner, { name: '평범', intros: ['문 앞이다'] });
    expect(plain.customUi).toBeNull();
    await publishPlot(owner, plain.id);
    expect((await readPublicPlot(reader, plain.id)).componentCapabilities).toEqual([]);
  });

  it('grants component turns per chat through PATCH', async () => {
    const cookie = await signUp('allow-turns@example.com');
    const { chatId, state } = await setupChat(cookie);
    // Nothing is granted by opening a chat.
    expect(state.chat.allowComponentTurns).toBe(false);

    const granted = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { allowComponentTurns: true }),
    );
    expect(granted.chat.allowComponentTurns).toBe(true);
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).chat.allowComponentTurns).toBe(
      true,
    );

    const revoked = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { allowComponentTurns: false }),
    );
    expect(revoked.chat.allowComponentTurns).toBe(false);
    expect((await json(cookie, `/api/chats/${chatId}`, 'PATCH', { allowComponentTurns: 'yes' })).status).toBe(
      400,
    );
  });

  /**
   * A character that declares the capability, a chat on it, and — unless
   * `consent` says otherwise — the reader's consent already given.
   */
  async function setupGameChat(
    email: string,
    options: { capability?: boolean; consent?: boolean } = {},
  ): Promise<{ cookie: string; plotId: string; chatId: string }> {
    const cookie = await signUp(email);
    const plot = await publishablePlot(
      cookie,
      {
        name: '게임 작품',
        intros: ['문 앞이다'],
        customUi: {
          componentCode: 'function Panel() { return <div>x</div>; }',
          ...(options.capability === false ? {} : { componentCapabilities: ['sendTurn'] }),
        },
      },
      { name: '게임 캐릭터', card: { description: '설명' } },
    );
    const created = await startChat(cookie, plot.id);
    if (options.consent !== false) {
      await json(cookie, `/api/chats/${created.chat.id}`, 'PATCH', { allowComponentTurns: true });
    }
    return { cookie, plotId: plot.id, chatId: created.chat.id };
  }

  it('takes a component turn once both gates are satisfied', async () => {
    const { cookie, chatId } = await setupGameChat('component-granted@example.com');

    const events = await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '문을 연다',
        source: 'component',
      }),
    );
    expect(events.at(-1)!.event).toBe('done');
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).path[1].source).toBe(
      'component',
    );

    // Consent revoked in one tab stops the next send from another: both halves of
    // the grant are re-read per request rather than trusted from a page load.
    await json(cookie, `/api/chats/${chatId}`, 'PATCH', { allowComponentTurns: false });
    const after = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
      content: '한 번 더',
      source: 'component',
    });
    expect(after.status).toBe(403);
  });

  it('refuses a component turn the chat never consented to', async () => {
    const { cookie, chatId } = await setupGameChat('component-no-consent@example.com', {
      consent: false,
    });

    // The browser gates this three ways, but the browser is the half a component
    // has influence over: a plain POST wearing the label must not get through.
    const res = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
      content: '문을 연다',
      source: 'component',
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).code).toBe('component_turns_not_allowed');
    // Nothing was written: the chat still holds nothing but its opening.
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).path).toHaveLength(1);

    // The same text as the reader's own turn is not gated at all.
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '문을 연다' }));
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).path).toHaveLength(3);
  });

  it('refuses a component turn on a plot that does not declare the capability', async () => {
    const { cookie, plotId, chatId } = await setupGameChat('component-no-capability@example.com', {
      capability: false,
    });

    const res = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
      content: '문을 연다',
      source: 'component',
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).code).toBe('component_turns_not_allowed');
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).path).toHaveLength(1);

    // Declaring it now is enough — the plot is read per request, so the reverse
    // (a creator taking it back) stops the very next send as well.
    const plot = await readPlot(cookie, plotId);
    await patchPlot(cookie, plotId, {
      customUi: { ...plot.customUi, componentCapabilities: ['sendTurn'] },
    });
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '문을 연다',
        source: 'component',
      }),
    );
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).path[1].source).toBe(
      'component',
    );
  });

  it('stores the source and the directions of a turn and reads them back', async () => {
    const { cookie, chatId } = await setupGameChat('component-turn@example.com');

    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '문을 연다',
        source: 'component',
        directions: '주사위 3. 자물쇠 따기는 실패한다.',
      }),
    );
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(state.path[1].source).toBe('component');
    expect(state.path[1].directions).toBe('주사위 3. 자물쇠 따기는 실패한다.');
    // Neither the opening nor the model's reply came from a component: both plain.
    expect(state.path[0].source).toBe('user');
    expect(state.path[0].directions).toBeNull();
    expect(state.path[2].source).toBe('user');

    // An ordinary send is labelled as one without asking.
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '뒤로 물러난다' }));
    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.path[3].source).toBe('user');
    expect(after.path[3].directions).toBeNull();
  });

  it('refuses a source it does not know and directions past the cap', async () => {
    const cookie = await signUp('turn-validation@example.com');
    const { chatId } = await setupChat(cookie);

    const source = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
      content: '문을 연다',
      source: 'system',
    });
    expect(source.status).toBe(400);
    expect((await readJson(source)).code).toBe('invalid_request');

    const directions = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
      content: '문을 연다',
      directions: 'a'.repeat(801),
    });
    expect(directions.status).toBe(400);

    // Neither attempt stored a turn: a 400 leaves the chat where it was.
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(state.path).toHaveLength(1);

    // One character under the cap goes through.
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '문을 연다',
        directions: 'a'.repeat(800),
      }),
    );
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).path[1].directions).toHaveLength(
      800,
    );
  });

  it('holds a component turn to the length it declares, and only a component turn', async () => {
    const { cookie, chatId } = await setupGameChat('component-turn-cap@example.com');

    // Exactly the cap the three client layers truncate to: an honest turn.
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: 'a'.repeat(2000),
        source: 'component',
      }),
    );
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).path[1].content).toHaveLength(
      2000,
    );

    // One character over never came through the runtime, so it is refused before
    // anything is written.
    const over = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
      content: 'a'.repeat(2001),
      source: 'component',
    });
    expect(over.status).toBe(400);
    expect((await readJson(over)).code).toBe('invalid_request');
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).path).toHaveLength(3);

    // The same text the reader typed themselves is not capped at all: the contract
    // belongs to the program, not to the person.
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: 'a'.repeat(2001) }),
    );
    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.path).toHaveLength(5);
    expect(after.path[3].content).toHaveLength(2001);
    expect(after.path[3].source).toBe('user');
  });

  it('injects the last turn\'s ruling outside the cached prefix, and re-applies it on regenerate', async () => {
    const cookie = await signUp('directions-prompt@example.com');
    const { chatId } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();

    await readSse(
      await json(
        cookie,
        `/api/chats/${chatId}/messages`,
        'POST',
        // Directions ride on any user turn; the source label is a separate grant.
        { content: '자물쇠를 딴다', directions: '주사위 3. 실패한다.' },
        capturing,
      ),
    );
    const first = prompts.at(-1)!;
    // Ahead of everything the assembler puts in `messages`, and nowhere near the
    // system string — that is the Anthropic cache prefix.
    expect(first.messages[0]).toEqual({ role: 'system', content: '[게임 판정]\n주사위 3. 실패한다.' });
    expect(first.system).not.toContain('게임 판정');
    // The ruling is not message text: the history carries the turn, not the ruling.
    expect(
      first.messages.filter((message) => contentText(message.content).includes('주사위 3')),
    ).toHaveLength(1);

    // Regenerate answers the same user turn, so it is judged the same way.
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, capturing));
    expect(prompts.at(-1)!.messages[0]).toEqual(first.messages[0]);

    // The next turn has no ruling of its own, and the previous one does not
    // come back with it.
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '문을 연다' }, capturing),
    );
    const second = prompts.at(-1)!;
    expect(second.messages.some((message) => contentText(message.content).includes('게임 판정'))).toBe(
      false,
    );
    expect(second.system).toBe(first.system);
  });
});

describe('chat attachments', () => {
  /** Minimal bytes that sniff as a GIF; an attachment is never looked at. */
  const gif = (marker: number): Uint8Array =>
    Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, marker]);

  /** What the composer measures off the image before it sends the bytes. */
  const measured = { width: '800', height: '600', thumbhash: 'HBkSHYSIeHiPiHh8eJd4h4eAeIhw==' };

  function upload(
    cookie: string | undefined,
    chatId: string,
    bytes: Uint8Array,
    fields: Record<string, string> = measured,
    target: Hono<AppEnv> = app,
  ): Promise<Response> {
    const form = new FormData();
    form.append('file', new File([bytes], 'shot.gif'));
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return request(cookie, `/api/chats/${chatId}/attachments`, 'POST', form, target);
  }

  const attach = async (cookie: string, chatId: string, marker = 1): Promise<any> => {
    const res = await upload(cookie, chatId, gif(marker));
    expect(res.status, await res.clone().text()).toBe(201);
    return readJson(res);
  };

  const storedPath = async (id: string): Promise<string> => {
    const [row] = await db.select().from(chatAttachments).where(eq(chatAttachments.id, id));
    return row!.path;
  };

  it('uploads an image for a turn that has not been sent yet, and serves it back', async () => {
    const cookie = await signUp('attach-upload@example.com');
    const { chatId } = await setupChat(cookie);

    const created = await attach(cookie, chatId);
    expect(created).toEqual({
      id: expect.any(String),
      url: `/api/chats/${chatId}/attachments/${created.id}`,
      mime: 'image/gif',
      width: 800,
      height: 600,
      thumbhash: measured.thumbhash,
    });
    // Its own namespace in the store, and a key nothing user-supplied reaches.
    expect(await storedPath(created.id)).toBe(`attachments/${created.id}.gif`);

    const served = await request(cookie, created.url);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/gif');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(gif(1));

    // Nothing has claimed it, so the composer may take it back out again.
    expect((await request(cookie, created.url, 'DELETE')).status).toBe(204);
    expect((await request(cookie, created.url)).status).toBe(404);
    expect(await storage.get(`attachments/${created.id}.gif`)).toBeNull();
  });

  it('refuses a file that is not an image, an oversized one, and half a measurement', async () => {
    const cookie = await signUp('attach-refuse@example.com');
    const { chatId } = await setupChat(cookie);

    const notAnImage = await upload(cookie, chatId, Uint8Array.from([1, 2, 3, 4]));
    expect(notAnImage.status).toBe(400);
    expect((await readJson(notAnImage)).code).toBe('invalid_attachment');

    const oversized = await upload(cookie, chatId, new Uint8Array(MAX_ATTACHMENT_BYTES + 1).fill(0x47));
    expect(oversized.status).toBe(400);
    expect((await readJson(oversized)).code).toBe('attachment_too_large');

    const halfMeasured = await upload(cookie, chatId, gif(1), { width: '800' });
    expect(halfMeasured.status).toBe(400);
    expect((await readJson(halfMeasured)).code).toBe('invalid_asset');

    const fileless = await request(cookie, `/api/chats/${chatId}/attachments`, 'POST', new FormData());
    expect(fileless.status).toBe(400);
    expect((await readJson(fileless)).code).toBe('invalid_request');

    // An image the browser could not decode still uploads, just without a box.
    const unmeasured = await readJson(await upload(cookie, chatId, gif(2), {}));
    expect(unmeasured).toMatchObject({ width: null, height: null, thumbhash: null });

    expect(await db.select().from(chatAttachments)).toHaveLength(1);
  });

  it('is the chat owner’s alone, to upload and to read', async () => {
    const cookie = await signUp('attach-owner@example.com');
    const other = await signUp('attach-intruder@example.com');
    const { chatId } = await setupChat(cookie);
    const created = await attach(cookie, chatId);

    expect((await upload(other, chatId, gif(2))).status).toBe(404);
    expect((await upload(undefined, chatId, gif(2))).status).toBe(401);
    expect((await request(other, created.url)).status).toBe(404);
    expect((await request(undefined, created.url)).status).toBe(401);
    expect((await request(other, created.url, 'DELETE')).status).toBe(404);

    // The chat is the boundary: the same id under another of one's own chats is
    // not found either.
    const second = await setupChat(cookie);
    expect(
      (await request(cookie, `/api/chats/${second.chatId}/attachments/${created.id}`)).status,
    ).toBe(404);
  });

  it('binds the uploads a send names to the turn, and carries them on the branch', async () => {
    const cookie = await signUp('attach-send@example.com');
    const { chatId } = await setupChat(cookie);
    const first = await attach(cookie, chatId, 1);
    const second = await attach(cookie, chatId, 2);

    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '이 사진 봐',
        attachmentIds: [first.id, second.id],
      }),
    );

    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const userTurn = state.path.at(-2);
    expect(userTurn.content).toBe('이 사진 봐');
    expect(userTurn.attachments).toEqual([first, second]);
    // Every other turn carries the field, empty.
    expect(state.path.at(-1).attachments).toEqual([]);

    // Claimed: the same upload cannot be hung on a second turn.
    const again = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
      content: '다시',
      attachmentIds: [first.id],
    });
    expect(again.status).toBe(400);
    expect((await readJson(again)).code).toBe('invalid_attachment');
    // And the refused send left no message behind.
    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.path.map((message: any) => message.id)).toEqual(
      state.path.map((message: any) => message.id),
    );
  });

  it('refuses more than four, and ids that are not this chat’s own', async () => {
    const cookie = await signUp('attach-cap@example.com');
    const { chatId } = await setupChat(cookie);
    const mine = await attach(cookie, chatId);
    const elsewhere = await setupChat(cookie);
    const theirs = await attach(cookie, elsewhere.chatId);

    const tooMany = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
      content: '다섯 장',
      attachmentIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    });
    expect(tooMany.status).toBe(400);
    expect((await readJson(tooMany)).code).toBe('attachment_limit');

    const foreign = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
      content: '남의 것',
      attachmentIds: [mine.id, theirs.id],
    });
    expect(foreign.status).toBe(400);
    expect((await readJson(foreign)).code).toBe('invalid_attachment');

    // Neither the message nor the binding survived the refusal.
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).path).toHaveLength(1);
    const [row] = await db.select().from(chatAttachments).where(eq(chatAttachments.id, mine.id));
    expect(row!.messageId).toBeNull();
  });

  it('puts the turn’s images to a model with eyes, and the note to one without', async () => {
    const cookie = await signUp('attach-prompt@example.com');
    const { app: seeing, prompts } = capturingApp({ env: { SHIZUE_TEST_MODELS: '1' } });
    const plot = await importCard(cookie, cardFile());
    const created = await readJson(
      await json(cookie, '/api/chats', 'POST', {
        plotId: plot.id,
        model: 'test/vision',
      }, seeing),
    );
    const chatId = created.chat.id;
    const image = await attach(cookie, chatId);

    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '이건 뭐야?',
        attachmentIds: [image.id],
      }, seeing),
    );

    // The turn is split into parts, and the bytes travel inline: the serving
    // route is behind this reader's session, so a URL would be no use upstream.
    const sent = prompts.at(-1)!.messages.at(-2)!;
    expect(sent.content).toEqual([
      { type: 'text', text: '이건 뭐야?' },
      { type: 'image', url: `data:image/gif;base64,${Buffer.from(gif(1)).toString('base64')}` },
    ]);

    // Regenerating the same turn shows the model the same thing.
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, seeing));
    expect(prompts.at(-1)!.messages.at(-2)).toEqual(sent);

    // The next turn carries no image, and the previous turn's does not come
    // back with it — one turn's images are answered once.
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '그렇구나' }, seeing),
    );
    expect(
      prompts.at(-1)!.messages.every((message) => typeof message.content === 'string'),
    ).toBe(true);
  });

  it('replaces the image with a note for a model that cannot see it', async () => {
    const cookie = await signUp('attach-blind@example.com');
    // The bytes must not even be read: a model without vision would have them
    // dropped again by the assembler, and base64 is paid for on the way there.
    let reads = 0;
    const counted: ObjectStorage = {
      ...storage,
      get: (key) => {
        reads += 1;
        return storage.get(key);
      },
    };
    const { app: blind, prompts } = capturingApp({ storage: counted });
    const plot = await importCard(cookie, cardFile());
    const created = await readJson(
      await json(cookie, '/api/chats', 'POST', { plotId: plot.id, model: 'echo/echo' }, blind),
    );
    const chatId = created.chat.id;
    const image = await attach(cookie, chatId);

    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '이건 뭐야?',
        attachmentIds: [image.id],
      }, blind),
    );

    const sent = prompts.at(-1)!.messages.at(-2)!;
    expect(sent.content).toBe(`이건 뭐야?\n${IMAGE_ATTACHED_PLACEHOLDER}`);
    expect(reads).toBe(0);

    // And the same for a turn already on the branch, which regenerate reads back.
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, blind));
    expect(prompts.at(-1)!.messages.at(-2)!.content).toBe(
      `이건 뭐야?\n${IMAGE_ATTACHED_PLACEHOLDER}`,
    );
    expect(reads).toBe(0);
  });

  it('exports the images the branch carries, alongside the character’s own', async () => {
    const cookie = await signUp('attach-export@example.com');
    const { chatId } = await setupChat(cookie);
    const image = await attach(cookie, chatId);
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '이 사진 봐',
        attachmentIds: [image.id],
      }),
    );

    const payload = await readJson(await request(cookie, `/api/chats/${chatId}/export`));
    expect(ChatExportSchema.safeParse(payload).success).toBe(true);
    const exported = payload.messages.find((message: any) => message.text === '이 사진 봐');
    expect(exported.attachments).toEqual([
      { id: image.id, url: `/api/chats/${chatId}/attachments/${image.id}`, mime: 'image/gif' },
    ]);
    // Only where there is one: the field is absent on every other turn.
    expect(payload.messages.filter((message: any) => 'attachments' in message)).toHaveLength(1);
  });

  /**
   * Every object under the attachments namespace — the store has no listing. The
   * directory outlives each test, unlike the tables, so what is asserted on is
   * always the difference a test made.
   */
  const attachmentObjects = async (): Promise<string[]> => {
    try {
      return (await readdir(join(storageDir, 'attachments'))).sort();
    } catch {
      return [];
    }
  };

  // Uploading is the one way to put bytes in a chat's store without ever writing
  // a message, so it is the one place a cap and a sweep can live.
  it('caps the uploads a chat holds for turns that were never sent', async () => {
    const cookie = await signUp('attach-unbound-cap@example.com');
    const { chatId } = await setupChat(cookie);
    const before = await attachmentObjects();
    for (let marker = 0; marker < MAX_UNBOUND_ATTACHMENTS; marker += 1) {
      await attach(cookie, chatId, marker);
    }

    const refused = await upload(cookie, chatId, gif(99));
    expect(refused.status).toBe(400);
    expect((await readJson(refused)).code).toBe('attachment_limit');
    // Nothing of the refused upload landed — neither a row nor its bytes.
    expect(await db.select().from(chatAttachments)).toHaveLength(MAX_UNBOUND_ATTACHMENTS);
    expect((await attachmentObjects()).length - before.length).toBe(MAX_UNBOUND_ATTACHMENTS);

    // Only the outstanding ones count: a send hands its uploads to a turn, and
    // the composer has room again.
    const claimed = (await db.select().from(chatAttachments)).slice(0, 4).map((row) => row.id);
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '네 장',
        attachmentIds: claimed,
      }),
    );
    expect((await upload(cookie, chatId, gif(98))).status).toBe(201);
  });

  it('holds the unsent-upload cap against a burst of parallel uploads', async () => {
    const cookie = await signUp('attach-burst@example.com');
    const { chatId } = await setupChat(cookie);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);

    // Twenty at once. The sweep, the count and the insert hold the chat's row
    // lock as one decision, so exactly sixteen can land no matter the schedule.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        uploadFile(cookie, `/api/chats/${chatId}/attachments`, gif, `burst-${i}.gif`),
      ),
    );
    expect(results.filter((res) => res.status === 201)).toHaveLength(16);
    expect(results.filter((res) => res.status === 400)).toHaveLength(4);

    const rows = await db
      .select({ id: chatAttachments.id })
      .from(chatAttachments)
      .where(eq(chatAttachments.chatId, chatId));
    expect(rows).toHaveLength(16);
  });

  it('sweeps an upload no turn ever claimed once it is a day old', async () => {
    const cookie = await signUp('attach-sweep@example.com');
    const { chatId } = await setupChat(cookie);
    const stale = await attach(cookie, chatId, 1);
    const recent = await attach(cookie, chatId, 2);
    const sent = await attach(cookie, chatId, 3);
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '보낸 사진',
        attachmentIds: [sent.id],
      }),
    );
    const stalePath = await storedPath(stale.id);
    // A day and an hour back: whatever composer made it is long gone. The turn's
    // own image is aged with it, and must survive — it belongs to a message now.
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db
      .update(chatAttachments)
      .set({ createdAt: longAgo })
      .where(inArray(chatAttachments.id, [stale.id, sent.id]));

    const next = await attach(cookie, chatId, 4);
    const rows = await db.select().from(chatAttachments).where(eq(chatAttachments.chatId, chatId));
    expect(rows.map((row) => row.id).sort()).toEqual([recent.id, sent.id, next.id].sort());
    expect(await storage.get(stalePath)).toBeNull();
  });

  it('takes the stored bytes back when the row cannot be written', async () => {
    const cookie = await signUp('attach-insert-fails@example.com');
    const { chatId } = await setupChat(cookie);
    // The upload's row now lands inside its cap transaction, so the failure has
    // to be injected on the tx the transaction callback is handed, not on `db`.
    const broken = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (run: (tx: unknown) => Promise<unknown>) =>
            target.transaction((tx) =>
              run(
                new Proxy(tx, {
                  get(txTarget, txProperty, txReceiver) {
                    if (txProperty === 'insert') {
                      return (table: unknown) => {
                        if (table !== chatAttachments) return txTarget.insert(table as never);
                        return {
                          values: () => ({
                            returning: () => Promise.reject(new Error('insert failed')),
                          }),
                        };
                      };
                    }
                    const value = Reflect.get(txTarget, txProperty, txReceiver);
                    return typeof value === 'function' ? value.bind(txTarget) : value;
                  },
                }) as never,
              ),
            );
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Db;

    const before = await attachmentObjects();
    const res = await upload(cookie, chatId, gif(5), measured, makeApp({ db: broken }));
    expect(res.status).toBe(500);
    // No row points at them, and nothing would ever come back for them.
    expect(await db.select().from(chatAttachments)).toHaveLength(0);
    expect(await attachmentObjects()).toEqual(before);
  });

  it('stops inlining a turn’s images at the byte cap, and says the rest were there', async () => {
    const cookie = await signUp('attach-inline-cap@example.com');
    const { chatId } = await setupChat(cookie);
    const first = await attach(cookie, chatId, 1);
    const second = await attach(cookie, chatId, 2);
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '두 장',
        attachmentIds: [first.id, second.id],
      }),
    );
    const [turn] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.content, '두 장')));

    // A store whose objects each take half the inline budget: the first image
    // fits beside nothing else, so the second cannot travel with it.
    const half = Buffer.alloc(Math.floor(MAX_INLINE_IMAGE_BYTES / 2), 0x47);
    const oversized: ObjectStorage = {
      ...storage,
      get: async () => ({
        size: half.length,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(half);
            controller.close();
          },
        }),
      }),
    };

    const history = await withTurnImages(
      makeDeps({ storage: oversized, env: { SHIZUE_TEST_MODELS: '1' } }),
      'reader',
      'test/vision',
      [turn!],
      [{ role: 'user', content: '두 장' }],
    );
    expect(history[0]!.images).toHaveLength(1);
    expect(history[0]!.images![0]!.startsWith('data:image/gif;base64,')).toBe(true);
    // The one that was left out is still accounted for, in words.
    expect(history[0]!.content).toBe(`두 장\n${IMAGE_ATTACHED_PLACEHOLDER}`);
  });

  it('sweeps up the images of a deleted turn, and of a deleted chat', async () => {
    const cookie = await signUp('attach-prune@example.com');
    const { chatId } = await setupChat(cookie);
    const image = await attach(cookie, chatId, 3);
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '이 사진 봐',
        attachmentIds: [image.id],
      }),
    );
    const path = await storedPath(image.id);

    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    const userTurn = state.path.at(-2);
    // The subtree goes, and the images hanging off it go with it — rows first,
    // then the objects they pointed at.
    await request(cookie, `/api/chats/${chatId}/messages/${userTurn.id}`, 'DELETE');
    expect(await db.select().from(chatAttachments)).toHaveLength(0);
    expect(await storage.get(path)).toBeNull();

    // And an unclaimed upload is cleaned up with the chat it was made in.
    const orphan = await attach(cookie, chatId, 4);
    const orphanPath = await storedPath(orphan.id);
    expect((await request(cookie, `/api/chats/${chatId}`, 'DELETE')).status).toBe(204);
    expect(await db.select().from(chatAttachments)).toHaveLength(0);
    expect(await storage.get(orphanPath)).toBeNull();
  });
});

describe('drawing a scene', () => {
  /** Minimal bytes that sniff as a GIF; nothing here looks at a pixel. */
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x07]);

  /**
   * The provider seam, stubbed. A live fal call spends real money, so the suite
   * never has one — what is under test is the route around it.
   */
  const drawnBy = (
    generateSceneImage: AppDeps['generateSceneImage'],
    overrides: Partial<AppDeps> = {},
  ): Hono<AppEnv> =>
    makeApp({ env: { FAL_KEY: 'test-key' }, ...overrides, generateSceneImage });

  const drawingApp = (overrides: Partial<AppDeps> = {}): Hono<AppEnv> =>
    drawnBy(async () => ({ bytes: gif, width: 1024, height: 768 }), overrides);

  const draw = (cookie: string | undefined, chatId: string, target: Hono<AppEnv>): Promise<Response> =>
    json(cookie, `/api/chats/${chatId}/draw-scene`, 'POST', undefined, target);

  it('is neither routed nor advertised without an image provider', async () => {
    const cookie = await signUp('draw-off@example.com');
    const { chatId, state } = await setupChat(cookie);

    // The chat read is where the client learns the action exists at all.
    expect(state.capabilities).toEqual({ drawScene: false });
    expect((await draw(cookie, chatId, app)).status).toBe(404);

    const configured = drawingApp();
    const seen = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, configured));
    expect(seen.capabilities).toEqual({ drawScene: true });
  });

  it('hangs the drawn scene on the branch as a narration turn', async () => {
    const cookie = await signUp('draw-turn@example.com');
    const prompts: string[] = [];
    const target = drawnBy(async (_deps, prompt) => {
      prompts.push(prompt);
      return { bytes: gif, width: 1024, height: 768 };
    });
    const { chatId, state: before } = await setupChat(cookie);

    const res = await draw(cookie, chatId, target);
    expect(res.status, await res.clone().text()).toBe(200);
    const state = await readJson(res);

    // A narration with no words: the picture is the whole of what the turn says.
    const drawn = state.path.at(-1);
    expect(drawn.role).toBe('assistant');
    expect(drawn.content).toBe('@:');
    expect(drawn.parentId).toBe(before.path.at(-1).id);
    // …and the head moved onto it, so the next turn answers the scene.
    expect(state.chat.headMessageId).toBe(drawn.id);

    expect(drawn.attachments).toEqual([
      {
        id: expect.any(String),
        url: `/api/chats/${chatId}/attachments/${drawn.attachments[0].id}`,
        mime: 'image/gif',
        // What the provider reported. The thumbhash is a browser's to measure.
        width: 1024,
        height: 768,
        thumbhash: null,
      },
    ]);
    const served = await request(cookie, drawn.attachments[0].url, 'GET', undefined, target);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(gif);

    // The prompt is the card plus the scene so far, and nothing else.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('리안');
    expect(prompts[0]).toContain('왕립 도서관의 사서.');
    expect(prompts[0]).toContain('아직 안 가셨군요');
  });

  it('is the chat owner’s alone to ask for', async () => {
    const cookie = await signUp('draw-owner@example.com');
    const other = await signUp('draw-intruder@example.com');
    const target = drawingApp();
    const { chatId } = await setupChat(cookie);

    expect((await draw(other, chatId, target)).status).toBe(404);
    expect((await draw(undefined, chatId, target)).status).toBe(401);
    expect(await db.select().from(chatAttachments)).toHaveLength(0);
    // A refused request never took the slot it would have had to release.
    expect(await claimOf(chatId)).toBeNull();
  });

  it('refuses to draw on a chat that is already generating', async () => {
    const cookie = await signUp('draw-busy@example.com');
    const target = drawingApp();
    const { chatId } = await setupChat(cookie);

    // The claim as a running generation leaves it, inside the staleness window.
    await db.update(chats).set({ generatingAt: new Date() }).where(eq(chats.id, chatId));
    const busy = await draw(cookie, chatId, target);
    expect(busy.status).toBe(429);
    expect((await readJson(busy)).code).toBe('generation_in_progress');
    expect(await db.select().from(chatAttachments)).toHaveLength(0);
  });

  it('writes nothing when the provider fails', async () => {
    const cookie = await signUp('draw-failure@example.com');
    const { chatId } = await setupChat(cookie);

    const broken = drawnBy(async () => {
      throw new ApiError(502, 'image_failed', 'The image provider did not answer');
    });
    const failed = await draw(cookie, chatId, broken);
    expect(failed.status).toBe(502);
    expect((await readJson(failed)).code).toBe('image_failed');
    // Nothing written, and the slot handed straight back.
    expect(await db.select().from(chatAttachments)).toHaveLength(0);
    expect(await claimOf(chatId)).toBeNull();
  });
});

describe('chat export', () => {
  /** Writes a branch straight into the table, so the tree under test is exact. */
  async function seedPath(
    chatId: string,
    rows: { role: 'user' | 'assistant'; content: string }[],
    parentId: string | null = null,
  ): Promise<string[]> {
    const ids: string[] = [];
    let parent = parentId;
    for (const [index, row] of rows.entries()) {
      const [written] = await db
        .insert(messages)
        .values({
          chatId,
          parentId: parent,
          role: row.role,
          content: row.content,
          // Distinct stamps, like the greeting roots: siblings order by creation.
          createdAt: new Date(Date.now() + index),
        })
        .returning();
      parent = written!.id;
      ids.push(written!.id);
    }
    await db.update(chats).set({ headMessageId: parent }).where(eq(chats.id, chatId));
    return ids;
  }

  const exportOf = async (cookie: string, chatId: string): Promise<any> => {
    const res = await request(cookie, `/api/chats/${chatId}/export`);
    expect(res.status, await res.clone().text()).toBe(200);
    return readJson(res);
  };

  it('exports the current branch in the shape the contract fixes', async () => {
    const cookie = await signUp('export-owner@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '안녕' }));

    const payload = await exportOf(cookie, chatId);
    // The contract is the boundary: what an export consumer parses is what we send.
    expect(() => ChatExportSchema.parse(payload)).not.toThrow();

    expect(payload.version).toBe(1);
    expect(payload.chat).toEqual({
      id: chatId,
      plotId,
      plotName: '리안',
      exportedAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payload.chat.exportedAt))).toBe(false);

    // The path the chat is on, oldest first, and nothing that is not on it.
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(state.path).toHaveLength(3);
    expect(payload.messages).toEqual(
      state.path.map((message: any) => ({
        id: message.id,
        role: message.role,
        text: message.content,
        createdAt: message.createdAt,
      })),
    );

    expect(payload.assets).toEqual([]);
    expect(payload.coverUrl).toBeNull();
    // The roster travels by name and face, in the creator's order.
    const member = (await readPlot(cookie, plotId)).characters[0];
    expect(payload.characters).toEqual([{ id: member.id, name: '리안', avatarUrl: null }]);
    // A plot with no variables in play has no timeline to speak of.
    expect(payload.variableTimeline).toEqual([]);
  });

  it('is not readable through anyone else, or through an id that is not a chat', async () => {
    const alice = await signUp('export-mine@example.com');
    const bob = await signUp('export-theirs@example.com');
    const { chatId } = await setupChat(alice);

    expect((await request(bob, `/api/chats/${chatId}/export`)).status).toBe(404);
    expect((await request(alice, `/api/chats/${randomUUID()}/export`)).status).toBe(404);
    expect((await request(alice, '/api/chats/not-a-uuid/export')).status).toBe(404);
    expect((await request(undefined, `/api/chats/${chatId}/export`)).status).toBe(401);
  });

  it("keeps exporting the reader's own conversation after the creator withdraws the plot", async () => {
    const alice = await signUp('export-creator@example.com');
    const bob = await signUp('export-reader@example.com');
    const plot = await publishablePlot(
      alice,
      {
        name: '사라진 작품',
        description: 'SECRET-DESCRIPTION',
        intros: ['문 앞이다'],
        customUi: { defaultVariables: { hp: '100' } },
      },
      {
        name: '사라진 캐릭터',
        card: {
          description: 'SECRET-DESCRIPTION',
          systemPrompt: 'SECRET-SYSTEM-PROMPT',
          lorebook: [{ keys: ['문'], content: 'SECRET-LORE' }],
        },
      },
    );
    const member = plot.characters[0];
    await publishPlot(alice, plot.id);
    // A cover, an avatar and an asset, so their going away is observable.
    await db.update(plots).set({ coverPath: 'covers/gone.png' }).where(eq(plots.id, plot.id));
    await db.update(characters).set({ avatarPath: 'avatars/gone.png' }).where(eq(characters.id, member.id));
    await db.insert(plotAssets).values({
      plotId: plot.id,
      slug: 'smile',
      path: 'assets/smile.gif',
      mime: 'image/gif',
    });

    const created = await startChat(bob, plot.id);
    const chatId = created.chat.id;
    const ids = await seedPath(chatId, [
      { role: 'assistant', content: '문 앞이다 {{img::smile}}' },
      { role: 'user', content: '{{addvar::hp::-30}} 들어간다' },
      { role: 'assistant', content: '문이 닫힌다' },
    ]);

    // While the plot is public it contributes everything it has.
    const before = await exportOf(bob, chatId);
    expect(before.chat.plotName).toBe('사라진 작품');
    expect(before.coverUrl).toBe(`/api/plots/${plot.id}/cover`);
    expect(before.characters).toEqual([
      {
        id: member.id,
        name: '사라진 캐릭터',
        avatarUrl: `/api/plots/${plot.id}/characters/${member.id}/avatar`,
      },
    ]);
    expect(before.assets).toEqual([
      { slug: 'smile', url: `/api/plots/${plot.id}/assets/smile`, mime: 'image/gif' },
    ]);
    expect(before.variableTimeline).toEqual([{ messageId: ids[2], variables: { hp: '70' } }]);

    // The creator takes the plot back. The conversation is bob's own record — the
    // chat itself stays readable, so the export of it does too.
    await json(alice, `/api/plots/${plot.id}/publish`, 'POST', { publish: false });
    expect((await request(bob, `/api/chats/${chatId}`)).status).toBe(200);

    const after = await exportOf(bob, chatId);
    expect(() => ChatExportSchema.parse(after)).not.toThrow();
    expect(after.messages).toEqual(before.messages);
    expect(after.chat.plotId).toBe(plot.id);
    // The chat's own title stands in, so the withdrawn plot is never read for it.
    expect(after.chat.plotName).toBe('사라진 작품');
    // What the creator withdrew is what leaves: the roster, the images, the cover.
    expect(after.characters).toEqual([]);
    expect(after.assets).toEqual([]);
    expect(after.coverUrl).toBeNull();
    // Folded from an empty base rather than the plot's defaults, so the timeline
    // holds only what the conversation itself set.
    expect(after.variableTimeline).toEqual([{ messageId: ids[2], variables: { hp: '-30' } }]);

    const serialized = JSON.stringify(after);
    for (const secret of ['SECRET-DESCRIPTION', 'SECRET-SYSTEM-PROMPT', 'SECRET-LORE']) {
      expect(serialized, secret).not.toContain(secret);
    }
    // And it is still only bob's to export.
    expect((await request(alice, `/api/chats/${chatId}/export`)).status).toBe(404);
  });

  it('exports the plot assets the branch references, and only those', async () => {
    const cookie = await signUp('export-assets@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    // The bytes never matter here: the export hands out the url, not the file.
    await db.insert(plotAssets).values([
      { plotId, slug: 'smile', path: 'assets/smile.gif', mime: 'image/gif' },
      // Held by the plot but never shown on this branch.
      { plotId, slug: 'cry', path: 'assets/cry.png', mime: 'image/png' },
      { plotId, slug: 'wink', path: 'assets/wink.png', mime: 'image/png' },
    ]);
    await seedPath(chatId, [
      { role: 'assistant', content: '문 앞이다' },
      { role: 'user', content: '{{img::smile}} 웃는다' },
      // A slug with no asset behind it exports nothing, a second reference to one
      // that has does not export it twice, and the loose spelling counts too.
      { role: 'assistant', content: '{{img::smile}}{{img::gone}}{{ img :: wink }}' },
    ]);

    const payload = await exportOf(cookie, chatId);
    expect(payload.assets).toEqual([
      { slug: 'smile', url: `/api/plots/${plotId}/assets/smile`, mime: 'image/gif' },
      { slug: 'wink', url: `/api/plots/${plotId}/assets/wink`, mime: 'image/png' },
    ]);
    // The reference itself stays in the text: it is what the message says.
    expect(payload.messages[1].text).toBe('{{img::smile}} 웃는다');
  });

  it('lists the variable fold only where it moved, on the branch that is current', async () => {
    const cookie = await signUp('export-variables@example.com');
    const plot = await createPlot(cookie, {
      name: '변수 작품',
      description: '설명',
      intros: ['문 앞이다'],
      customUi: { defaultVariables: { hp: '100' } },
    });
    const created = await startChat(cookie, plot.id);
    const chatId = created.chat.id;
    const ids = await seedPath(chatId, [
      // The defaults alone are not a change, so the opening carries no snapshot.
      { role: 'assistant', content: '문 앞이다' },
      { role: 'user', content: '{{setvar::hp::80}} 부딪힌다' },
      { role: 'assistant', content: '피가 난다' },
      { role: 'user', content: '숨을 고른다' },
      // Nothing moved across this turn either, so it is not a change point.
      { role: 'assistant', content: '조용하다' },
      { role: 'user', content: '{{addvar::hp::-30}} 또 맞는다' },
      { role: 'assistant', content: '휘청인다' },
    ]);

    const payload = await exportOf(cookie, chatId);
    expect(payload.variableTimeline).toEqual([
      { messageId: ids[2], variables: { hp: '80' } },
      { messageId: ids[6], variables: { hp: '50' } },
    ]);

    // A fork off the opening: the export follows the head, so the fold of the
    // branch that was left behind is not in it at all.
    const [, forked] = await seedPath(
      chatId,
      [
        { role: 'user', content: '{{setvar::hp::5}} 넘어진다' },
        { role: 'assistant', content: '겨우 버틴다' },
      ],
      ids[0]!,
    );
    expect((await exportOf(cookie, chatId)).variableTimeline).toEqual([
      { messageId: forked, variables: { hp: '5' } },
    ]);
  });

  it('carries a component turn as one, and nothing the plot holds', async () => {
    const cookie = await signUp('export-card@example.com');
    const plot = await publishablePlot(
      cookie,
      {
        name: '게임 작품',
        description: 'SECRET-PLOT-DESCRIPTION',
        intros: ['문 앞이다'],
        lorebook: [{ keys: ['문'], content: 'SECRET-PLOT-LORE' }],
        customUi: {
          componentCode: 'function SecretPanel() { return <div>x</div>; }',
          componentCapabilities: ['sendTurn'],
        },
      },
      {
        name: '게임 캐릭터',
        card: {
          description: 'SECRET-DESCRIPTION',
          personality: 'SECRET-PERSONALITY',
          scenario: 'SECRET-SCENARIO',
          mesExample: 'SECRET-EXAMPLE',
          systemPrompt: 'SECRET-SYSTEM-PROMPT',
          postHistoryInstructions: 'SECRET-JAILBREAK',
          creatorNotes: 'SECRET-NOTES',
          lorebook: [{ keys: ['문'], content: 'SECRET-LORE' }],
        },
      },
    );
    const created = await startChat(cookie, plot.id);
    const chatId = created.chat.id;
    await json(cookie, `/api/chats/${chatId}`, 'PATCH', { allowComponentTurns: true });
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', {
        content: '문을 연다',
        source: 'component',
        directions: 'SECRET-DIRECTIONS',
      }),
    );

    const payload = await exportOf(cookie, chatId);
    expect(payload.messages[1]).toEqual({
      id: expect.any(String),
      role: 'user',
      text: '문을 연다',
      createdAt: expect.any(String),
      source: 'component',
    });
    // Every other turn is the reader's own or the model's, so it says nothing.
    expect(payload.messages[0].source).toBeUndefined();
    expect(payload.messages[2].source).toBeUndefined();
    expect(payload.chat.plotName).toBe('게임 작품');
    // The roster is a name and a face; the card behind it never travels.
    expect(payload.characters).toEqual([
      { id: plot.characters[0].id, name: '게임 캐릭터', avatarUrl: null },
    ]);

    // The rights boundary, asserted on the bytes that leave: the conversation and
    // the work's public face travel, the definition never does — and neither does
    // anything else the message row happens to carry.
    const serialized = JSON.stringify(payload);
    for (const secret of [
      'SECRET-DESCRIPTION',
      'SECRET-PLOT-DESCRIPTION',
      'SECRET-PERSONALITY',
      'SECRET-SCENARIO',
      'SECRET-EXAMPLE',
      'SECRET-SYSTEM-PROMPT',
      'SECRET-JAILBREAK',
      'SECRET-NOTES',
      'SECRET-LORE',
      'SECRET-PLOT-LORE',
      'SECRET-DIRECTIONS',
      'SecretPanel',
    ]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });
});

describe('presets', () => {
  it('lists the catalogue without a session', async () => {
    const res = await request(undefined, '/api/presets');
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(PRESET_IDS.map((id) => ({ id })));
  });

  it('stores the chat preset and assembles the prompt with it', async () => {
    const cookie = await signUp('preset@example.com');
    const { chatId } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();

    // Default: the standard preset, in both the system prefix and the reminder.
    const { state } = await setupChat(cookie);
    expect(state.chat.preset).toBe('standard');
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '안녕' }, capturing));
    expect(prompts.at(-1)!.system).toContain('등장인물 전원과 내레이터를 연기하는 작가');
    expect(prompts.at(-1)!.messages.at(-1)!.content).toContain('등장인물과 내레이터만 연기합니다');

    const patched = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { preset: 'screenplay' }),
    );
    expect(patched.chat.preset).toBe('screenplay');
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).chat.preset).toBe('screenplay');

    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, capturing));
    const screenplay = prompts.at(-1)!;
    expect(screenplay.system).toContain('각본가');
    expect(screenplay.system).not.toContain('등장인물 전원과 내레이터를 연기하는 작가');
    // The post-history reminder switches with it.
    expect(screenplay.messages.at(-1)!.content).toContain('대사 2~5줄');
  });

  it('rejects an unknown preset without touching the chat', async () => {
    const cookie = await signUp('preset-bad@example.com');
    const other = await signUp('preset-other@example.com');
    const { chatId } = await setupChat(cookie);
    await json(cookie, `/api/chats/${chatId}`, 'PATCH', { preset: 'novel' });

    // 'toString' and friends are on the catalogue's prototype, not in it: a lookup
    // that accepted them would store an id no generation can resolve.
    for (const preset of ['nope', '', 42, null, 'toString', 'constructor', '__proto__']) {
      const res = await json(cookie, `/api/chats/${chatId}`, 'PATCH', { preset });
      expect(res.status, JSON.stringify(preset)).toBe(400);
      expect((await readJson(res)).code).toBe('invalid_request');
    }
    expect((await json(other, `/api/chats/${chatId}`, 'PATCH', { preset: 'novel' })).status).toBe(404);

    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).chat.preset).toBe('novel');
  });
});

describe('memory', () => {
  const SUMMARY = '리안과 유저는 폐관 후 도서관에서 여러 번 마주쳤다. 리안은 열람실 열쇠를 맡기로 했다.';
  /** Where the rolling summary kicks in — see docs/ARCHITECTURE.md Chunk 4. */
  const TRIGGER_TOKENS = DEFAULT_CONTEXT_BUDGET * 0.6;

  interface Captured {
    system: string;
    messages: ChatRequest['messages'];
  }

  interface Harness {
    app: Hono<AppEnv>;
    /** Chat-model requests, in order. */
    prompts: Captured[];
    /** Memory-channel requests, in order. */
    summaries: Captured[];
    /** Every background refresh actually scheduled — one entry per refresh. */
    tasks: Promise<void>[];
    /** Awaits the fire-and-forget work started so far, of either kind. */
    settle: () => Promise<void>;
  }

  /** A promise plus the handle that resolves it, for ordering a hung call. */
  function gate(): { wait: Promise<void>; open: () => void } {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait, open };
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * App whose chat model is the real echo adapter (captured on the way in) and whose
   * memory channel is a stub returning a fixed summary.
   */
  function memoryApp(
    options: Partial<AppDeps> & { summaryText?: string; summaryGate?: Promise<void> } = {},
  ): Harness {
    const { summaryText = SUMMARY, summaryGate, ...overrides } = options;
    const prompts: Captured[] = [];
    const summaries: Captured[] = [];
    const tasks: Promise<void>[] = [];
    const pending: Promise<void>[] = [];
    const echo = createEchoAdapter();

    const getAdapter: AppDeps['getAdapter'] = (modelId) => {
      if (modelId === 'echo/echo') {
        return {
          providerModel: 'echo',
          adapter: {
            stream: (req) => {
              prompts.push({ system: req.system, messages: req.messages });
              return echo.stream(req);
            },
          },
        };
      }
      return {
        providerModel: 'memory-stub',
        adapter: {
          stream: async function* (req): AsyncGenerator<StreamDelta, StreamDone> {
            // The relationship job shares the memory channel; these tests run long
            // enough to trigger it, and its calls are not summaries. An empty answer
            // is dropped silently, which is what this harness wants.
            if (req.system.includes('관계 분석가')) {
              return { usage: { promptTokens: 0, completionTokens: 0 } };
            }
            // Recorded before the gate, so a blocked refresh is still observable.
            summaries.push({ system: req.system, messages: req.messages });
            if (summaryGate) await summaryGate;
            yield { type: 'text', text: summaryText };
            return { usage: { promptTokens: 0, completionTokens: 0 } };
          },
        },
      };
    };

    return {
      app: makeApp({
        getAdapter,
        onBackgroundTask: (task, kind) => {
          pending.push(task);
          // `tasks` counts refreshes only, so the relationship job running alongside
          // does not look like a duplicate refresh.
          if (kind === 'memory') tasks.push(task);
        },
        ...overrides,
      }),
      prompts,
      summaries,
      tasks,
      settle: async () => {
        await Promise.all(pending);
      },
    };
  }

  /**
   * Sends turns until a refresh actually starts. Roughly TRIGGER_TOKENS worth of
   * turns are needed — the echo model replies with the user's own text, so a turn
   * costs twice its content — and the cap only bounds a runaway.
   */
  async function fillPastThreshold(
    cookie: string,
    chatId: string,
    harness: Harness,
    target = 1,
  ): Promise<string[]> {
    const maxTurns = Math.ceil(TRIGGER_TOKENS / countTokens(longTurn(1))) + 4;
    const sent: string[] = [];
    for (let turn = 1; turn <= maxTurns && harness.summaries.length < target; turn += 1) {
      const content = longTurn(turn);
      const res = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content }, harness.app);
      expect((await readSse(res)).at(-1)!.event).toBe('done');
      sent.push(content);
    }
    // The last turn's refresh is fire-and-forget: give it a moment to reach the model.
    for (let i = 0; i < 50 && harness.summaries.length < target; i += 1) await delay(10);
    expect(harness.summaries.length).toBeGreaterThanOrEqual(target);
    return sent;
  }

  const longTurn = (turn: number): string =>
    `${turn}번째 이야기. ${'서가 사이에서 나눈 긴 대화입니다. '.repeat(50)}`;

  /** Polls until a refresh has written its summary. */
  async function waitForMemory(cookie: string, chatId: string, harness: Harness): Promise<any> {
    for (let i = 0; i < 100; i += 1) {
      const state = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
      if (state.chat.memory) return state;
      await delay(10);
    }
    throw new Error('the refresh never wrote a summary');
  }

  /** Stores one long-term fact directly, standing in for a completed extraction. */
  async function insertFact(
    cookie: string,
    chatId: string,
    fact: { content: string; sourceMessageId: string | null; embedding?: number[] },
  ): Promise<void> {
    const session = await readJson(await request(cookie, '/api/auth/get-session'));
    const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
    await db.insert(memories).values({
      userId: session.user.id,
      plotId: chat!.plotId,
      chatId,
      content: fact.content,
      embedding: fact.embedding ?? null,
      sourceMessageId: fact.sourceMessageId,
    });
  }

  /** Pins a summary onto an existing chat, as a completed update would. */
  async function seedMemory(chatId: string, anchorMessageId: string): Promise<ChatMemory> {
    const memory: ChatMemory = {
      summary: SUMMARY,
      anchorMessageId,
      updatedAt: new Date().toISOString(),
    };
    await db.update(chats).set({ memory }).where(eq(chats.id, chatId));
    return memory;
  }

  it('strips image references from the summarization transcript', async () => {
    const cookie = await signUp('memory-image@example.com');
    const { chatId } = await setupChat(cookie);
    const harness = memoryApp();

    // The oldest turn is the first the summary swallows.
    const first = `첫 장면입니다 {{img::smile}} ${'서가 사이에서 나눈 긴 대화입니다. '.repeat(50)}`;
    const opening = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: first }, harness.app);
    expect((await readSse(opening)).at(-1)!.event).toBe('done');
    await fillPastThreshold(cookie, chatId, harness);

    const transcript = harness.summaries.at(-1)!.messages[0]!.content;
    expect(transcript).toContain('첫 장면입니다');
    expect(transcript).not.toContain('{{img');
  });

  it('summarizes earlier when the chat lowers its threshold', async () => {
    const cookie = await signUp('memory-threshold@example.com');
    const harness = memoryApp();
    const tuned = await setupChat(cookie);
    const plain = await setupChat(cookie);
    // A smaller budget and an earlier trigger: 8000 * 0.4 against 16000 * 0.6.
    await json(cookie, `/api/chats/${tuned.chatId}`, 'PATCH', {
      memorySettings: { contextBudget: 8000, summaryThreshold: 0.4 },
    });

    /** Turns this chat needed before a refresh actually called the memory model. */
    async function turnsUntilSummary(chatId: string): Promise<number> {
      const maxTurns = Math.ceil(TRIGGER_TOKENS / countTokens(longTurn(1))) + 4;
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        const before = harness.summaries.length;
        const res = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: longTurn(turn) }, harness.app);
        expect((await readSse(res)).at(-1)!.event).toBe('done');
        // The refresh is scheduled during `done`, so awaiting the background work
        // settles it before the next turn.
        await harness.settle();
        if (harness.summaries.length > before) return turn;
      }
      throw new Error('no refresh was ever triggered');
    }

    expect(await turnsUntilSummary(tuned.chatId)).toBeLessThan(await turnsUntilSummary(plain.chatId));
  });

  it('folds the evicted turns into chats.memory once the branch crosses the threshold', async () => {
    const cookie = await signUp('memory-roll@example.com');
    const { chatId } = await setupChat(cookie);
    const harness = memoryApp();

    const sent = await fillPastThreshold(cookie, chatId, harness);
    await harness.settle();

    // The memory channel saw the running summary slot and the oldest turn.
    expect(harness.summaries.length).toBeGreaterThan(0);
    const ask = harness.summaries.at(-1)!.messages[0]!.content;
    expect(ask).toContain('[기존 요약]');
    expect(ask).toContain(sent[0]!);

    const state = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
    expect(state.chat.memory.summary).toBe(SUMMARY);
    expect(state.chat.memory.updatedAt).toEqual(expect.any(String));
    // The anchor is a real message on the current branch.
    const anchorIndex = state.path.findIndex((m: any) => m.id === state.chat.memory.anchorMessageId);
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    expect(anchorIndex).toBeLessThan(state.path.length - 1);

    // The next turn carries the summary instead of the messages it stands for.
    const next = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '그 다음은?' }, harness.app);
    expect((await readSse(next)).at(-1)!.event).toBe('done');
    const prompt = harness.prompts.at(-1)!;
    expect(prompt.system).toContain('[지난 이야기 요약]');
    expect(prompt.system).toContain(SUMMARY);
    expect(prompt.messages.some((message) => contentText(message.content).includes(sent[0]!))).toBe(
      false,
    );
    expect(prompt.messages.at(-2)!.content).toBe('그 다음은?');

    // Embeddings are not configured, so nothing is extracted or stored.
    const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM memories`;
    expect(count).toBe(0);
    expect(harness.summaries.at(-1)!.system).not.toContain('"facts"');
  });

  it('drops the summary when the branch no longer contains the anchor', async () => {
    const cookie = await signUp('memory-branch@example.com');
    const { chatId } = await setupChat(cookie);
    const harness = memoryApp();

    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }, harness.app));
    const before = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
    await seedMemory(chatId, before.path[1].id);

    // On the anchored branch the summary is injected and history starts after it.
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, harness.app));
    expect(harness.prompts.at(-1)!.system).toContain(SUMMARY);
    expect(harness.prompts.at(-1)!.messages.some((m) => m.content === '첫 질문')).toBe(false);

    // Editing the user turn forks a branch that does not contain the anchor.
    const patched = await readJson(
      await json(cookie, `/api/messages/${before.path[1].id}`, 'PATCH', { content: '다른 질문' }, harness.app),
    );
    expect(patched.messageId).not.toBe(before.path[1].id);

    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, harness.app));
    const forked = harness.prompts.at(-1)!;
    expect(forked.system).not.toContain(SUMMARY);
    expect(forked.system).not.toContain('[지난 이야기 요약]');
    expect(forked.messages.some((m) => m.content === '다른 질문')).toBe(true);
    // The stored memory is untouched: switching back to the anchored branch restores it.
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
    expect(state.chat.memory.summary).toBe(SUMMARY);
  });

  it('runs one refresh per chat at a time and reschedules once it finishes', async () => {
    const cookie = await signUp('memory-inflight@example.com');
    const { chatId } = await setupChat(cookie);
    const blocked = gate();
    const harness = memoryApp({ summaryGate: blocked.wait });

    await fillPastThreshold(cookie, chatId, harness);
    // Turns below the threshold schedule a refresh that returns immediately; the
    // one that crossed it is now stuck in the model call.
    const scheduled = harness.tasks.length;

    // The branch stays over the threshold, so every further turn would schedule a
    // duplicate refresh if the in-flight one were not guarding the chat.
    for (const content of ['그 다음은?', '또 그 다음은?']) {
      await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content }, harness.app));
    }
    expect(harness.tasks).toHaveLength(scheduled);
    expect(harness.summaries).toHaveLength(1);

    blocked.open();
    await harness.settle();
    expect(harness.tasks).toHaveLength(scheduled);

    // Guard cleared: the chat refreshes again once it is back over the threshold.
    await fillPastThreshold(cookie, chatId, harness, 2);
    await harness.settle();
    expect(harness.tasks.length).toBeGreaterThan(scheduled);
    expect(harness.summaries).toHaveLength(2);
  });

  it('drops a refresh whose result lost a race with the user', async () => {
    const cookie = await signUp('memory-cas@example.com');
    const { chatId } = await setupChat(cookie);
    const blocked = gate();
    const harness = memoryApp({ summaryGate: blocked.wait });

    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }, harness.app));
    const before = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
    const seeded = await seedMemory(chatId, before.path[1].id);

    // A refresh reads the seeded memory and then stalls in the model call.
    await fillPastThreshold(cookie, chatId, harness);

    // Meanwhile the user rewrites the summary the refresh started from.
    const edited = await readJson(
      await json(cookie, `/api/chats/${chatId}/memory`, 'PUT', { summary: '유저가 직접 쓴 요약.' }),
    );
    expect(edited.chat.memory.updatedAt).not.toBe(seeded.updatedAt);

    blocked.open();
    await harness.settle();

    const after = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
    expect(after.chat.memory.summary).toBe('유저가 직접 쓴 요약.');
    expect(after.chat.memory.anchorMessageId).toBe(seeded.anchorMessageId);
  });

  it('keeps a summary a later edit does not invalidate, but still drops the refresh', async () => {
    const cookie = await signUp('memory-noncovered@example.com');
    const { chatId } = await setupChat(cookie);
    const blocked = gate();
    const harness = memoryApp({ summaryGate: blocked.wait, summaryText: '리프레시가 쓴 요약.' });

    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }, harness.app));
    const before = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
    const seeded = await seedMemory(chatId, before.path[1].id);
    await fillPastThreshold(cookie, chatId, harness);

    // Editing a reply that sits after the anchor leaves the summary describing it
    // correctly, so the summary stays...
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
    await json(cookie, `/api/messages/${state.path.at(-1).id}`, 'PATCH', { content: '고친 답변' });
    const kept = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(kept.chat.memory.summary).toBe(SUMMARY);

    // ...but the refresh that read the pre-edit text still loses.
    blocked.open();
    await harness.settle();

    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.chat.memory.summary).toBe(SUMMARY);
    expect(after.chat.memory.anchorMessageId).toBe(seeded.anchorMessageId);
  });

  it('clears a summary that already covers an edited assistant message', async () => {
    const cookie = await signUp('memory-edit-covered@example.com');
    const { chatId } = await setupChat(cookie);
    const harness = memoryApp();

    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }, harness.app));
    const path = (await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app))).path;
    const [greeting, , reply] = path;

    // Anchored at the greeting: the later reply is not covered by the summary.
    await seedMemory(chatId, greeting.id);
    await json(cookie, `/api/messages/${reply.id}`, 'PATCH', { content: '고친 답변' });
    const kept = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(kept.chat.memory.summary).toBe(SUMMARY);

    // Anchored at the reply: editing it now rewrites text the summary stands for.
    await seedMemory(chatId, reply.id);
    await insertFact(cookie, chatId, { content: '리안은 고양이를 무서워한다.', sourceMessageId: reply.id });
    await insertFact(cookie, chatId, { content: '도서관은 자정에 닫는다.', sourceMessageId: null });

    await json(cookie, `/api/messages/${reply.id}`, 'PATCH', { content: '다시 고친 답변' });
    const cleared = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(cleared.chat.memory).toBeNull();
    expect(cleared.path.at(-1).content).toBe('다시 고친 답변');

    // Facts are a derived cache of a summary that no longer holds, so they all go.
    const rows = await db.select().from(memories).where(eq(memories.chatId, chatId));
    expect(rows).toEqual([]);
  });

  describe('with embeddings configured', () => {
    const EMBEDDING_ENV = {
      EMBEDDING_BASE_URL: 'https://embed.test/v1',
      EMBEDDING_API_KEY: 'embed-key',
      EMBEDDING_MODEL: 'text-embedding-test',
    };
    const FACTS = ['리안은 고양이를 무서워한다.', '유저는 목요일마다 도서관에 온다.'];
    /** One-hot slot per keyword: cosine similarity is 1 for a match and 0 otherwise. */
    const SLOTS: Record<string, number> = { 고양이: 11, 목요일: 7 };

    function vectorFor(text: string): number[] {
      const vector = new Array<number>(1536).fill(0);
      const keyword = Object.keys(SLOTS).find((key) => text.includes(key));
      vector[keyword === undefined ? 0 : SLOTS[keyword]!] = 1;
      return vector;
    }

    /** Every text the embedding provider was asked to embed, in order. */
    const embedded: string[] = [];

    /** Routes /embeddings to the one-hot stub and everything else to the real fetch. */
    function stubEmbeddings(embedGate?: Promise<void>): void {
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (typeof url !== 'string' || !url.startsWith(EMBEDDING_ENV.EMBEDDING_BASE_URL)) {
          return realFetch(url, init);
        }
        // A held call still honours its deadline, like a real slow provider would:
        // the caller that gives up (retrieval) must not be stuck behind the caller
        // the test is holding (fact extraction, which runs on a 60s budget).
        if (embedGate) {
          await Promise.race([
            embedGate,
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
          ]);
        }
        const { input } = JSON.parse(init.body as string) as { input: string[] };
        embedded.push(...input);
        return Response.json({
          data: input.map((text, index) => ({ index, embedding: vectorFor(text) })),
        });
      });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      embedded.length = 0;
    });

    it('embeds the retrieval query without its image references', async () => {
      const cookie = await signUp('memory-embed-image@example.com');
      const { chatId, state } = await setupChat(cookie);
      stubEmbeddings();
      const harness = memoryApp({ env: EMBEDDING_ENV });
      // Retrieval only runs for a chat that already has a summary.
      await seedMemory(chatId, state.path.at(-1).id);
      embedded.length = 0;

      const res = await json(
        cookie,
        `/api/chats/${chatId}/messages`,
        'POST',
        { content: '목요일 {{img::smile}} 에도 오시나요?' },
        harness.app,
      );
      expect((await readSse(res)).at(-1)!.event).toBe('done');

      // The query leaves this service for a provider, so it is stripped like any
      // other model-bound text.
      expect(embedded.some((text) => text.includes('목요일'))).toBe(true);
      expect(embedded.some((text) => text.includes('{{img'))).toBe(false);
    });

    it('extracts and stores no facts at all when the chat turns retrieval off', async () => {
      const cookie = await signUp('memory-facts-off@example.com');
      const { chatId } = await setupChat(cookie);
      stubEmbeddings();
      const harness = memoryApp({ env: EMBEDDING_ENV });
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { memorySettings: { retrievalCount: 0 } });
      embedded.length = 0;

      await fillPastThreshold(cookie, chatId, harness);
      await harness.settle();

      // The rolling summary still runs...
      const state = await waitForMemory(cookie, chatId, harness);
      expect(state.chat.memory.summary).toBe(SUMMARY);
      // ...but the fact layer is off end to end: not asked for, not embedded, not
      // stored. Nothing derived from the chat reaches the embedding provider.
      expect(harness.summaries.at(-1)!.system).not.toContain('"facts"');
      expect(embedded).toEqual([]);
      const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM memories`;
      expect(count).toBe(0);
    });

    it('stops retrieving facts when the chat asks for none', async () => {
      const cookie = await signUp('memory-retrieval-count@example.com');
      const { chatId, state } = await setupChat(cookie);
      stubEmbeddings();
      const harness = memoryApp({ env: EMBEDDING_ENV });
      await seedMemory(chatId, state.path.at(-1).id);
      await insertFact(cookie, chatId, {
        content: FACTS[1]!,
        sourceMessageId: null,
        embedding: vectorFor(FACTS[1]!),
      });

      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { memorySettings: { retrievalCount: 0 } });
      embedded.length = 0;
      const off = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '목요일에도 오시나요?' }, harness.app);
      expect((await readSse(off)).at(-1)!.event).toBe('done');
      expect(harness.prompts.at(-1)!.system).not.toContain('[기억]');
      // Retrieval is off, not filtered: the query never reaches the embedder.
      expect(embedded).toEqual([]);

      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { memorySettings: { retrievalCount: 5 } });
      const on = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '목요일에도 오시나요?' }, harness.app);
      expect((await readSse(on)).at(-1)!.event).toBe('done');
      expect(harness.prompts.at(-1)!.system).toContain('[기억]');
      expect(harness.prompts.at(-1)!.system).toContain(FACTS[1]!);
    });

    it('extracts, embeds and retrieves long-term facts', async () => {
      const cookie = await signUp('memory-embed@example.com');
      const { chatId } = await setupChat(cookie);
      stubEmbeddings();
      const harness = memoryApp({
        env: EMBEDDING_ENV,
        // The extraction prompt asks for JSON; answer in the requested shape.
        summaryText: JSON.stringify({ summary: SUMMARY, facts: FACTS }),
      });

      await fillPastThreshold(cookie, chatId, harness);
      await harness.settle();

      expect(harness.summaries.at(-1)!.system).toContain('"facts"');
      const session = await readJson(await request(cookie, '/api/auth/get-session'));
      const stored = await db.select().from(memories).where(eq(memories.chatId, chatId));
      expect(stored.map((row) => row.content).sort()).toEqual([...FACTS].sort());
      expect(stored.every((row) => row.embedding?.length === 1536)).toBe(true);
      expect(stored.every((row) => row.userId === session.user.id)).toBe(true);

      const state = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
      expect(stored.every((row) => row.sourceMessageId === state.chat.memory.anchorMessageId)).toBe(true);

      // The next user message retrieves the closest fact first.
      const res = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '목요일에도 오시나요?' }, harness.app);
      expect((await readSse(res)).at(-1)!.event).toBe('done');
      const { system } = harness.prompts.at(-1)!;
      expect(system).toContain('[기억]');
      expect(system.indexOf('[기억]')).toBeGreaterThan(system.indexOf('[지난 이야기 요약]'));
      expect(system.indexOf(FACTS[1]!)).toBeLessThan(system.indexOf(FACTS[0]!));
    });

    it('discards a first refresh when a message is edited while it runs', async () => {
      const cookie = await signUp('memory-first-race@example.com');
      const { chatId } = await setupChat(cookie);
      stubEmbeddings();
      const blocked = gate();
      const harness = memoryApp({
        env: EMBEDDING_ENV,
        summaryGate: blocked.wait,
        summaryText: JSON.stringify({ summary: SUMMARY, facts: FACTS }),
      });

      // Nothing to compare against yet — the chat has no memory at all.
      await fillPastThreshold(cookie, chatId, harness);
      const state = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
      expect(state.chat.memory).toBeNull();

      // The edit changes text the in-flight refresh already read.
      await json(cookie, `/api/messages/${state.path[0].id}`, 'PATCH', { content: '고친 인사' });

      blocked.open();
      await harness.settle();

      const after = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
      expect(after.chat.memory).toBeNull();
      expect(await db.select().from(memories).where(eq(memories.chatId, chatId))).toEqual([]);
    });

    it('does not store facts when an edit lands between the summary write and the insert', async () => {
      const cookie = await signUp('memory-fact-race@example.com');
      const { chatId } = await setupChat(cookie);
      const embedding = gate();
      stubEmbeddings(embedding.wait);
      const harness = memoryApp({
        // Filling past the threshold may send one more turn than it takes, and
        // that turn retrieves. Retrieval is best-effort, so a short deadline lets
        // it give up on the held provider instead of waiting for the gate.
        env: { ...EMBEDDING_ENV, EMBEDDING_TIMEOUT_MS: '30' },
        summaryText: JSON.stringify({ summary: SUMMARY, facts: FACTS }),
      });

      // The summary is committed; the refresh is now stuck embedding its facts.
      await fillPastThreshold(cookie, chatId, harness);
      const state = await waitForMemory(cookie, chatId, harness);
      expect(state.chat.memory.summary).toBe(SUMMARY);

      // The newest reply sits after the anchor, so the summary itself stays valid.
      const tail = state.path.at(-1);
      expect(tail.role).toBe('assistant');
      await json(cookie, `/api/messages/${tail.id}`, 'PATCH', { content: '고친 답변' });

      embedding.open();
      await harness.settle();

      expect(await db.select().from(memories).where(eq(memories.chatId, chatId))).toEqual([]);
      const after = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
      expect(after.chat.memory.summary).toBe(SUMMARY);
    });

    it('ignores facts that belong to a branch this path left behind', async () => {
      const cookie = await signUp('memory-offbranch@example.com');
      const { chatId } = await setupChat(cookie);
      stubEmbeddings();
      const harness = memoryApp({ env: EMBEDDING_ENV });

      await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }, harness.app));
      const before = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
      await seedMemory(chatId, before.path[1].id);
      await insertFact(cookie, chatId, {
        content: FACTS[1]!,
        sourceMessageId: before.path[1].id,
        embedding: vectorFor(FACTS[1]!),
      });
      // Same chat, but extracted from a message that is not on this path.
      await insertFact(cookie, chatId, {
        content: FACTS[0]!,
        sourceMessageId: randomUUID(),
        embedding: vectorFor(FACTS[0]!),
      });

      await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, harness.app));
      const onBranch = harness.prompts.at(-1)!.system;
      expect(onBranch).toContain('[기억]');
      expect(onBranch).toContain(FACTS[1]!);
      expect(onBranch).not.toContain(FACTS[0]!);

      // Forking away from the anchor drops the whole memory layer, facts included.
      await json(cookie, `/api/messages/${before.path[1].id}`, 'PATCH', { content: '다른 질문' }, harness.app);
      await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, harness.app));
      const forked = harness.prompts.at(-1)!.system;
      expect(forked).not.toContain('[기억]');
      expect(forked).not.toContain(FACTS[1]!);
    });

    it('gives up on retrieval that misses its deadline and streams anyway', async () => {
      const cookie = await signUp('memory-embed-slow@example.com');
      const { chatId } = await setupChat(cookie);
      const harness = memoryApp({ env: { ...EMBEDDING_ENV, EMBEDDING_TIMEOUT_MS: '30' } });

      await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }, harness.app));
      const before = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
      await seedMemory(chatId, before.path[1].id);
      await insertFact(cookie, chatId, {
        content: FACTS[1]!,
        sourceMessageId: before.path[1].id,
        embedding: vectorFor(FACTS[1]!),
      });

      // An embedding provider that accepts the request and never answers.
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
        if (typeof url !== 'string' || !url.startsWith(EMBEDDING_ENV.EMBEDDING_BASE_URL)) {
          return realFetch(url, init);
        }
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });

      const res = await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, harness.app);
      expect((await readSse(res)).at(-1)!.event).toBe('done');
      // The summary still goes in; only the facts are missing.
      expect(harness.prompts.at(-1)!.system).toContain(SUMMARY);
      expect(harness.prompts.at(-1)!.system).not.toContain('[기억]');
    });

    it('keeps working when the embedding provider fails', async () => {
      const cookie = await signUp('memory-embed-down@example.com');
      const { chatId } = await setupChat(cookie);
      vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
      const harness = memoryApp({ env: EMBEDDING_ENV });

      await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }, harness.app));
      const before = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));
      await seedMemory(chatId, before.path[1].id);

      // Retrieval fails, but the turn still runs and the summary is still injected.
      await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, harness.app));
      expect(harness.prompts.at(-1)!.system).toContain(SUMMARY);
      expect(harness.prompts.at(-1)!.system).not.toContain('[기억]');
    });
  });

  it('lets the user rewrite the summary, keeping the anchor', async () => {
    const cookie = await signUp('memory-edit@example.com');
    const other = await signUp('memory-other@example.com');
    const { chatId } = await setupChat(cookie);
    const harness = memoryApp();

    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '첫 질문' }, harness.app));
    const before = await readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));

    // Nothing to edit yet.
    const early = await json(cookie, `/api/chats/${chatId}/memory`, 'PUT', { summary: '아무거나' });
    expect(early.status).toBe(400);
    expect((await readJson(early)).code).toBe('invalid_state');

    const seeded = await seedMemory(chatId, before.path[1].id);
    const edited = await readJson(
      await json(cookie, `/api/chats/${chatId}/memory`, 'PUT', { summary: '유저가 고쳐 쓴 요약.' }),
    );
    expect(edited.chat.memory.summary).toBe('유저가 고쳐 쓴 요약.');
    expect(edited.chat.memory.anchorMessageId).toBe(seeded.anchorMessageId);
    expect(edited.path).toHaveLength(3);

    const reread = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(reread.chat.memory.summary).toBe('유저가 고쳐 쓴 요약.');

    // The edit is what the next generation sees.
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, harness.app));
    expect(harness.prompts.at(-1)!.system).toContain('유저가 고쳐 쓴 요약.');
    expect(harness.prompts.at(-1)!.system).not.toContain(SUMMARY);

    expect((await json(cookie, `/api/chats/${chatId}/memory`, 'PUT', {})).status).toBe(400);
    expect((await json(other, `/api/chats/${chatId}/memory`, 'PUT', { summary: 'x' })).status).toBe(404);
  });
});

describe('relationship', () => {
  /** Assistant turns between two extraction attempts — docs/ARCHITECTURE.md Chunk 9. */
  const TURNS_PER_UPDATE = 5;
  const NOTE = '조심스럽게 서로를 믿기 시작한 사이.';
  /** Out-of-range and fractional on purpose: the server clamps and rounds. */
  const RAW_AXES = { affection: 140, obsession: -20, trust: 61.6, liking: 70, disgust: 0, fear: 3 };
  const CLAMPED = { affection: 100, obsession: 0, trust: 62, liking: 70, disgust: 0, fear: 3 };

  interface Captured {
    system: string;
    messages: ChatRequest['messages'];
  }

  interface Harness {
    app: Hono<AppEnv>;
    /** Chat-model requests, in order. */
    prompts: Captured[];
    /** Memory-channel requests the relationship job made, in order. */
    extractions: Captured[];
    /** Turns sent so far, so every turn carries a distinct text. */
    sent: number;
    settle: () => Promise<void>;
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function gate(): { wait: Promise<void>; open: () => void } {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait, open };
  }

  /**
   * Chat model = echo (captured on the way in); memory channel = a stub answering
   * with `answer`. The turns stay short, so the rolling summary never triggers and
   * every memory-channel call belongs to the relationship job.
   */
  function relationshipApp(
    options: { answer?: string; extractionGate?: Promise<void> } & Partial<AppDeps> = {},
  ): Harness {
    const { answer = JSON.stringify({ axes: RAW_AXES, note: NOTE }), extractionGate, ...overrides } = options;
    const prompts: Captured[] = [];
    const extractions: Captured[] = [];
    const tasks: Promise<void>[] = [];
    const echo = createEchoAdapter();

    const getAdapter: AppDeps['getAdapter'] = (modelId) => {
      if (modelId === 'echo/echo') {
        return {
          providerModel: 'echo',
          adapter: {
            stream: (req) => {
              prompts.push({ system: req.system, messages: req.messages });
              return echo.stream(req);
            },
          },
        };
      }
      return {
        providerModel: 'relationship-stub',
        adapter: {
          stream: async function* (req): AsyncGenerator<StreamDelta, StreamDone> {
            // Recorded before the gate, so a blocked extraction is still observable.
            extractions.push({ system: req.system, messages: req.messages });
            if (extractionGate) await extractionGate;
            yield { type: 'text', text: answer };
            return { usage: { promptTokens: 0, completionTokens: 0 } };
          },
        },
      };
    };

    return {
      app: makeApp({ getAdapter, onBackgroundTask: (task) => void tasks.push(task), ...overrides }),
      prompts,
      extractions,
      sent: 0,
      settle: async () => {
        await Promise.all(tasks);
      },
    };
  }

  const turnText = (harness: Harness): string => `${(harness.sent += 1)}번째 턴`;

  /** Sends `count` turns, letting the background work of each one finish. */
  async function turns(cookie: string, chatId: string, harness: Harness, count: number): Promise<void> {
    for (let turn = 0; turn < count; turn += 1) {
      const content = turnText(harness);
      const res = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content }, harness.app);
      expect((await readSse(res)).at(-1)!.event).toBe('done');
      await harness.settle();
    }
  }

  const chatOf = async (cookie: string, chatId: string, harness: Harness): Promise<any> =>
    readJson(await request(cookie, `/api/chats/${chatId}`, 'GET', undefined, harness.app));

  /**
   * The greeting is already an assistant message on the path, so a fresh chat sits
   * at depth 1 and the first extraction lands one send earlier than the cycle.
   */
  const SENDS_TO_FIRST = TURNS_PER_UPDATE - 1;

  it('strips image references from the extraction transcript', async () => {
    const cookie = await signUp('relationship-image@example.com');
    const { chatId } = await setupChat(cookie);
    const harness = relationshipApp();

    // The greeting is the first assistant turn, so four more reach the trigger.
    await turns(cookie, chatId, harness, 1);
    const res = await json(
      cookie,
      `/api/chats/${chatId}/messages`,
      'POST',
      { content: '웃어줘 {{img::smile}}' },
      harness.app,
    );
    expect((await readSse(res)).at(-1)!.event).toBe('done');
    await harness.settle();
    await turns(cookie, chatId, harness, 2);

    const transcript = harness.extractions.at(-1)!.messages[0]!.content;
    expect(transcript).toContain('웃어줘');
    expect(transcript).not.toContain('{{img');
  });

  it('extracts once the branch holds five assistant turns, clamps the axes and injects the block', async () => {
    const cookie = await signUp('relationship-cycle@example.com');
    const { chatId, state } = await setupChat(cookie);
    expect(state.chat.relationship).toBeNull();
    expect(state.chat.relationshipEnabled).toBe(true);
    const harness = relationshipApp();

    // Below the threshold nothing is written at all — the count lives on the branch.
    await turns(cookie, chatId, harness, SENDS_TO_FIRST - 1);
    expect(harness.extractions).toHaveLength(0);
    expect((await chatOf(cookie, chatId, harness)).chat.relationship).toBeNull();
    expect(harness.prompts.at(-1)!.system).not.toContain('[현재 관계 상태]');

    await turns(cookie, chatId, harness, 1);
    expect(harness.extractions).toHaveLength(1);
    // The model sees the defaults it starts from and the recent turns.
    const ask = harness.extractions[0]!.messages[0]!.content;
    expect(ask).toContain('[현재 수치]');
    expect(ask).toContain('affection: 50');
    expect(ask).toContain('obsession: 0');
    expect(ask).toContain(`${SENDS_TO_FIRST}번째 턴`);
    expect(harness.extractions[0]!.system).toContain('"axes"');

    const updated = await chatOf(cookie, chatId, harness);
    expect(updated.chat.relationship.axes).toEqual(CLAMPED);
    expect(updated.chat.relationship.note).toBe(NOTE);
    // Recorded at the depth the extraction read, not back at zero.
    expect(updated.chat.relationship.lastExtractedAssistantDepth).toBe(TURNS_PER_UPDATE);
    expect(updated.chat.relationship.updatedAt).toEqual(expect.any(String));

    // The next generation carries the block, after the persona and the memory.
    await turns(cookie, chatId, harness, 1);
    const system = harness.prompts.at(-1)!.system;
    expect(system).toContain('[현재 관계 상태]');
    expect(system).toContain('애정 100 / 집착 0 / 신뢰 62 / 호감 70 / 혐오 0 / 두려움 3');
    expect(system).toContain(NOTE);
    // Macros in the block are expanded like the rest of the system prefix.
    expect(system).toContain('리안의 등장인물들이 유저에게 느끼는 마음의 온도');

    // The next cycle is another five assistant turns past that depth.
    await turns(cookie, chatId, harness, TURNS_PER_UPDATE - 2);
    expect(harness.extractions).toHaveLength(1);
    await turns(cookie, chatId, harness, 1);
    expect(harness.extractions).toHaveLength(2);
    // The second call starts from the stored numbers, not the defaults.
    expect(harness.extractions[1]!.messages[0]!.content).toContain('affection: 100');
    expect((await chatOf(cookie, chatId, harness)).chat.relationship.lastExtractedAssistantDepth).toBe(
      TURNS_PER_UPDATE * 2,
    );
  });

  it('opens a relationship-gated asset with the axes it just wrote', async () => {
    const alice = await signUp('relationship-unlock-creator@example.com');
    const plot = await publishablePlot(alice, { name: '관계 해금 작품' });
    // `trust` lands on 62 (CLAMPED), so this extraction is what crosses it.
    const [asset] = await db
      .insert(plotAssets)
      .values({
        plotId: plot.id,
        slug: 'close',
        path: 'assets/close.gif',
        mime: 'image/gif',
        unlock: { kind: 'relationship', axis: 'trust', min: 60 },
      })
      .returning({ id: plotAssets.id });
    await publishPlot(alice, plot.id);

    const bob = await signUp('relationship-unlock-reader@example.com');
    const harness = relationshipApp();
    const chatId = (await startChat(bob, plot.id)).chat.id;
    const unlocks = (): Promise<unknown[]> =>
      db.select().from(chatAssetUnlocks).where(eq(chatAssetUnlocks.chatId, chatId));

    // Nothing has been extracted yet, so nothing satisfies the condition.
    await turns(bob, chatId, harness, SENDS_TO_FIRST - 1);
    expect(harness.extractions).toHaveLength(0);
    expect(await unlocks()).toHaveLength(0);

    // The turn's own evaluation ran before the extraction did, with the axes as
    // they stood: null. The extraction's second pass is what opens the asset —
    // without it the reader would have to send one more turn to see it, and would
    // never see it at all if they stopped here.
    await turns(bob, chatId, harness, 1);
    expect(harness.extractions).toHaveLength(1);
    expect((await chatOf(bob, chatId, harness)).chat.relationship.axes.trust).toBe(CLAMPED.trust);
    expect(await unlocks()).toEqual([
      { chatId, assetId: asset!.id, unlockedAt: expect.any(Date) },
    ]);

    // No further generation: the reveal is simply there on the next state read.
    expect((await chatOf(bob, chatId, harness)).assetLocks).toEqual([
      { assetId: asset!.id, slug: 'close', locked: false, kind: 'relationship' },
    ]);
  });

  it('counts branch depth, so regenerate and continue are not new turns', async () => {
    const cookie = await signUp('relationship-depth@example.com');
    const { chatId } = await setupChat(cookie);
    const harness = relationshipApp();

    // One send short of the threshold.
    await turns(cookie, chatId, harness, SENDS_TO_FIRST - 1);
    expect(harness.extractions).toHaveLength(0);

    // A regenerate swaps the last reply for a sibling: same branch length.
    for (let i = 0; i < 5; i += 1) {
      await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, harness.app));
      await harness.settle();
    }
    // A continue extends the last reply in place: same branch length again.
    for (let i = 0; i < 2; i += 1) {
      await readSse(await json(cookie, `/api/chats/${chatId}/continue`, 'POST', undefined, harness.app));
      await harness.settle();
    }
    expect(harness.extractions).toHaveLength(0);
    expect((await chatOf(cookie, chatId, harness)).chat.relationship).toBeNull();

    // Only a real turn moves the count.
    await turns(cookie, chatId, harness, 1);
    expect(harness.extractions).toHaveLength(1);
  });

  it('stops extracting and injecting once the chat turns it off', async () => {
    const cookie = await signUp('relationship-toggle@example.com');
    const { chatId } = await setupChat(cookie);
    const harness = relationshipApp();
    const relationship: ChatRelationship = {
      axes: CLAMPED,
      note: NOTE,
      updatedAt: new Date().toISOString(),
      lastExtractedAssistantDepth: 0,
    };
    await db.update(chats).set({ relationship }).where(eq(chats.id, chatId));

    const off = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { relationshipEnabled: false }, harness.app),
    );
    expect(off.chat.relationshipEnabled).toBe(false);
    // The numbers are kept, so turning it back on restores them.
    expect(off.chat.relationship.axes).toEqual(CLAMPED);

    await turns(cookie, chatId, harness, TURNS_PER_UPDATE);
    expect(harness.prompts.at(-1)!.system).not.toContain('[현재 관계 상태]');
    // Disabled means no model call and no bookkeeping either.
    expect(harness.extractions).toHaveLength(0);
    expect(
      (await chatOf(cookie, chatId, harness)).chat.relationship.lastExtractedAssistantDepth,
    ).toBe(0);

    const on = await readJson(
      await json(cookie, `/api/chats/${chatId}`, 'PATCH', { relationshipEnabled: true }, harness.app),
    );
    expect(on.chat.relationshipEnabled).toBe(true);
    await turns(cookie, chatId, harness, 1);
    expect(harness.prompts.at(-1)!.system).toContain('[현재 관계 상태]');

    const bad = await json(cookie, `/api/chats/${chatId}`, 'PATCH', { relationshipEnabled: 'yes' });
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).code).toBe('invalid_request');
    expect((await readJson(await request(cookie, `/api/chats/${chatId}`))).chat.relationshipEnabled).toBe(true);
  });

  it('ignores an answer it cannot use and retries on the next cycle', async () => {
    const cookie = await signUp('relationship-parse@example.com');
    const { chatId } = await setupChat(cookie);
    // Valid JSON, but one axis short: a partial answer would silently keep numbers
    // the model never looked at.
    const harness = relationshipApp({ answer: '```json\n{"axes": {"affection": 60}, "note": "반쪽"}\n```' });

    await turns(cookie, chatId, harness, SENDS_TO_FIRST);
    expect(harness.extractions).toHaveLength(1);
    const after = await chatOf(cookie, chatId, harness);
    // Silently dropped, but the attempt is recorded so the retry waits a cycle.
    expect(after.chat.relationship).toMatchObject({
      axes: null,
      note: '',
      lastExtractedAssistantDepth: TURNS_PER_UPDATE,
    });
    expect(harness.prompts.at(-1)!.system).not.toContain('[현재 관계 상태]');

    await turns(cookie, chatId, harness, TURNS_PER_UPDATE - 1);
    expect(harness.extractions).toHaveLength(1);
    await turns(cookie, chatId, harness, 1);
    expect(harness.extractions).toHaveLength(2);
  });

  it('runs one extraction per chat at a time and loses no turn to the in-flight window', async () => {
    const cookie = await signUp('relationship-inflight@example.com');
    const { chatId } = await setupChat(cookie);
    const blocked = gate();
    const harness = relationshipApp({ extractionGate: blocked.wait });

    // Cannot settle() here: the extraction this crosses into is stuck in the call.
    for (let turn = 0; turn < SENDS_TO_FIRST; turn += 1) {
      const content = turnText(harness);
      const res = await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content }, harness.app);
      expect((await readSse(res)).at(-1)!.event).toBe('done');
    }
    for (let i = 0; i < 50 && harness.extractions.length === 0; i += 1) await delay(10);
    expect(harness.extractions).toHaveLength(1);

    // Further turns must not start a second extraction while that one is in flight.
    for (const content of ['그 다음은?', '또 그 다음은?']) {
      await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content }, harness.app));
    }
    await delay(50);
    expect(harness.extractions).toHaveLength(1);

    blocked.open();
    await harness.settle();
    const stored = await chatOf(cookie, chatId, harness);
    expect(stored.chat.relationship.axes).toEqual(CLAMPED);
    // The depth the extraction read, so the two turns it ran through still count.
    expect(stored.chat.relationship.lastExtractedAssistantDepth).toBe(TURNS_PER_UPDATE);

    // Branch is at depth 7: three more turns reach the next threshold, not five.
    await turns(cookie, chatId, harness, 2);
    expect(harness.extractions).toHaveLength(1);
    await turns(cookie, chatId, harness, 1);
    expect(harness.extractions).toHaveLength(2);
  });

  it('rebases onto a shorter branch instead of blocking every later update', async () => {
    const cookie = await signUp('relationship-branch@example.com');
    const { chatId } = await setupChat(cookie);
    const harness = relationshipApp();

    await turns(cookie, chatId, harness, SENDS_TO_FIRST);
    expect(harness.extractions).toHaveLength(1);
    const path = (await chatOf(cookie, chatId, harness)).path;

    // Editing the first user message forks a branch that starts over at the greeting.
    await json(cookie, `/api/messages/${path[1].id}`, 'PATCH', { content: '다른 첫 질문' }, harness.app);
    await readSse(await json(cookie, `/api/chats/${chatId}/regenerate`, 'POST', undefined, harness.app));
    await harness.settle();

    const rebased = await chatOf(cookie, chatId, harness);
    expect(rebased.path.filter((m: any) => m.role === 'assistant')).toHaveLength(2);
    // No extraction on a branch that is shorter than the last one read...
    expect(harness.extractions).toHaveLength(1);
    // ...and the depth follows this branch, keeping the numbers it already has.
    expect(rebased.chat.relationship.lastExtractedAssistantDepth).toBe(2);
    expect(rebased.chat.relationship.axes).toEqual(CLAMPED);

    // From the rebased depth the cycle works again.
    await turns(cookie, chatId, harness, TURNS_PER_UPDATE - 1);
    expect(harness.extractions).toHaveLength(1);
    await turns(cookie, chatId, harness, 1);
    expect(harness.extractions).toHaveLength(2);
  });
});

describe('plot hub', () => {
  /** Session user id — the creator page is keyed on it. */
  async function userIdOf(cookie: string): Promise<string> {
    return (await readJson(await request(cookie, '/api/auth/get-session'))).user.id;
  }

  interface Spec {
    name: string;
    language?: string;
    tags?: string[];
    intro?: string;
    intros?: string[];
    likeCount?: number;
    chatCount?: number;
    publishedAt?: Date;
  }

  /** A plot with enough substance to publish, and one member on its roster. */
  async function seedPlot(cookie: string, spec: Spec): Promise<any> {
    const plot = await createPlot(cookie, {
      name: spec.name,
      description: `${spec.name} 설명`,
      intros: spec.intros ?? [`${spec.name}의 도입부`],
      ...(spec.intro !== undefined ? { intro: spec.intro } : {}),
      ...(spec.tags ? { tags: spec.tags } : {}),
      ...(spec.language ? { language: spec.language } : {}),
    });
    await addCharacter(cookie, plot.id, { name: `${spec.name} 멤버` });
    return plot;
  }

  async function publish(cookie: string, id: string, value = true): Promise<any> {
    const res = await json(cookie, `/api/plots/${id}/publish`, 'POST', { publish: value });
    expect(res.status, await res.clone().text()).toBe(200);
    return readJson(res);
  }

  /** Publishes a plot and stamps the counters the sort tests need. */
  async function seedPublic(cookie: string, spec: Spec): Promise<string> {
    const created = await seedPlot(cookie, spec);
    await publish(cookie, created.id);
    if (spec.likeCount !== undefined || spec.chatCount !== undefined || spec.publishedAt !== undefined) {
      await db
        .update(plots)
        .set({
          ...(spec.likeCount !== undefined ? { likeCount: spec.likeCount } : {}),
          ...(spec.chatCount !== undefined ? { chatCount: spec.chatCount } : {}),
          ...(spec.publishedAt !== undefined ? { publishedAt: spec.publishedAt } : {}),
        })
        .where(eq(plots.id, created.id));
    }
    return created.id;
  }

  const exploreNames = async (cookie: string | undefined, query: string): Promise<string[]> => {
    const res = await request(cookie, `/api/explore?${query}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await readJson(res)).items.map((item: any) => item.name);
  };

  /** Pages the catalogue two at a time, running `mutate` once the first page is out. */
  async function walkExplore(
    cookie: string,
    query: string,
    mutate: () => Promise<void>,
  ): Promise<string[]> {
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const res: Response = await request(
        cookie,
        `/api/explore?${query}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(res.status, await res.clone().text()).toBe(200);
      const body: any = await readJson(res);
      walked.push(...body.items.map((item: any) => item.name));
      cursor = body.nextCursor;
      if (page === 0) await mutate();
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    return walked;
  }

  /** Counters the moving-boundary walks start from; the names are their order. */
  const RANKED = [
    ['A', 60],
    ['B', 50],
    ['C', 40],
    ['D', 30],
    ['E', 20],
    ['F', 10],
  ] as const;

  it('publishes, filters on its tags and unpublishes', async () => {
    const alice = await signUp('publish@example.com');
    const bob = await signUp('publish-reader@example.com');
    const created = await seedPlot(alice, { name: '발행 작품', tags: ['판타지'] });
    expect(created.visibility).toBe('private');

    const published = await publish(alice, created.id);
    expect(published.visibility).toBe('public');

    const view = await readPublicPlot(bob, created.id);
    expect(view.tags).toEqual(['판타지']);
    expect(await exploreNames(bob, 'language=ko')).toEqual(['발행 작품']);

    // The filter column is the plot's own now, so an edit moves the catalogue.
    await patchPlot(alice, created.id, { tags: ['로맨스'] });
    expect(await exploreNames(bob, 'language=ko&tag=로맨스')).toEqual(['발행 작품']);
    expect(await exploreNames(bob, 'language=ko&tag=판타지')).toEqual([]);

    const unpublished = await publish(alice, created.id, false);
    expect(unpublished.visibility).toBe('private');
    expect(await exploreNames(bob, 'language=ko')).toEqual([]);
    expect((await request(bob, `/api/plots/${created.id}/public`)).status).toBe(404);
  });

  it('explores only public plots of the requested language', async () => {
    const alice = await signUp('explore-owner@example.com');
    const bob = await signUp('explore-reader@example.com');
    await seedPublic(alice, { name: '한국어 공개' });
    await seedPublic(alice, { name: '영어 공개', language: 'en' });
    await seedPlot(alice, { name: '비공개' });

    expect(await exploreNames(bob, 'language=ko')).toEqual(['한국어 공개']);
    expect(await exploreNames(bob, 'language=en')).toEqual(['영어 공개']);
    // The owner sees the same partition — no private rows leak into explore.
    expect(await exploreNames(alice, 'language=ko')).toEqual(['한국어 공개']);
    expect(await exploreNames(bob, 'language=ja')).toEqual([]);

    expect((await request(bob, '/api/explore')).status).toBe(400);
    expect((await request(bob, '/api/explore?language=de')).status).toBe(400);
    expect((await request(bob, '/api/explore?language=ko&sort=oldest')).status).toBe(400);
    expect((await request(bob, '/api/explore?language=ko&limit=49')).status).toBe(400);
    expect((await request(bob, '/api/explore?language=ko&cursor=not-a-cursor')).status).toBe(400);
    // Explore *is* plots now: the separate rail above it is gone.
    expect((await request(bob, '/api/explore/plots?language=ko')).status).toBe(404);
    // A cursor id is compared against a uuid column: a malformed one is refused
    // here rather than blowing up in Postgres.
    const malformed = encodeCursor({ value: new Date().toISOString(), id: 'not-a-uuid' });
    const res = await request(bob, `/api/explore?language=ko&cursor=${encodeURIComponent(malformed)}`);
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('invalid_request');
  });

  it('does not skip plots that share a publish millisecond across a page boundary', async () => {
    const alice = await signUp('explore-microsecond@example.com');
    const bob = await signUp('explore-microsecond-reader@example.com');
    const older = await seedPublic(alice, { name: '같은 밀리초 A' });
    const newer = await seedPublic(alice, { name: '같은 밀리초 B' });
    // The same millisecond, microseconds apart: the serialized cursor cannot tell
    // them apart, so the boundary has to be read back from the row itself.
    await sql`update plots set published_at = ${microsecond('000200')}::timestamptz where id = ${older}::uuid`;
    await sql`update plots set published_at = ${microsecond('000700')}::timestamptz where id = ${newer}::uuid`;

    const first = await readJson(await request(bob, '/api/explore?language=ko&sort=recent&limit=1'));
    expect(first.items.map((item: any) => item.name)).toEqual(['같은 밀리초 B']);

    const second = await readJson(
      await request(
        bob,
        `/api/explore?language=ko&sort=recent&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
      ),
    );
    expect(second.items.map((item: any) => item.name)).toEqual(['같은 밀리초 A']);
    expect(second.nextCursor).toBeNull();
  });

  it('sorts by recency, chats and likes', async () => {
    const alice = await signUp('sort-owner@example.com');
    const bob = await signUp('sort-reader@example.com');
    const at = (day: number): Date => new Date(Date.UTC(2026, 0, day));
    await seedPublic(alice, { name: 'A', publishedAt: at(1), likeCount: 5, chatCount: 1 });
    await seedPublic(alice, { name: 'B', publishedAt: at(3), likeCount: 1, chatCount: 9 });
    await seedPublic(alice, { name: 'C', publishedAt: at(2), likeCount: 9, chatCount: 5 });

    expect(await exploreNames(bob, 'language=ko&sort=recent')).toEqual(['B', 'C', 'A']);
    expect(await exploreNames(bob, 'language=ko')).toEqual(['B', 'C', 'A']);
    expect(await exploreNames(bob, 'language=ko&sort=likes')).toEqual(['C', 'A', 'B']);
    expect(await exploreNames(bob, 'language=ko&sort=chats')).toEqual(['B', 'C', 'A']);
  });

  it('filters by name and tag', async () => {
    const alice = await signUp('filter-owner@example.com');
    const bob = await signUp('filter-reader@example.com');
    await seedPublic(alice, { name: '도서관 사서', tags: ['판타지', '차분'] });
    await seedPublic(alice, { name: '도서관 손님', tags: ['일상'] });
    await seedPublic(alice, { name: '기사단장', tags: ['판타지'] });
    await seedPublic(alice, { name: '100% 순도', tags: [] });

    expect((await exploreNames(bob, 'language=ko&q=도서관')).sort()).toEqual(['도서관 사서', '도서관 손님']);
    expect(await exploreNames(bob, 'language=ko&q=단장')).toEqual(['기사단장']);
    expect((await exploreNames(bob, 'language=ko&tag=판타지')).sort()).toEqual(['기사단장', '도서관 사서']);
    expect(await exploreNames(bob, 'language=ko&q=도서관&tag=판타지')).toEqual(['도서관 사서']);
    expect(await exploreNames(bob, 'language=ko&tag=없는태그')).toEqual([]);
    // LIKE wildcards from the user are literal text.
    expect(await exploreNames(bob, `language=ko&q=${encodeURIComponent('100%')}`)).toEqual(['100% 순도']);
    expect(await exploreNames(bob, `language=ko&q=${encodeURIComponent('%')}`)).toEqual(['100% 순도']);
  });

  it('walks the whole catalogue through the cursor', async () => {
    const alice = await signUp('cursor-owner@example.com');
    const bob = await signUp('cursor-reader@example.com');
    // Identical like counts: the id tiebreak is the only thing keeping the order total.
    for (let i = 0; i < 7; i += 1) {
      await seedPublic(alice, { name: `작품 ${i}`, likeCount: i < 4 ? 2 : 0, publishedAt: new Date(2026, 0, 1 + i) });
    }

    for (const sort of ['recent', 'likes', 'chats']) {
      const expected = await exploreNames(bob, `language=ko&sort=${sort}&limit=48`);
      expect(expected).toHaveLength(7);

      const walked: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const res: Response = await request(
          bob,
          `/api/explore?language=ko&sort=${sort}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        expect(res.status, await res.clone().text()).toBe(200);
        const body: any = await readJson(res);
        walked.push(...body.items.map((item: any) => item.name));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(walked).toEqual(expected);
      expect(new Set(walked).size).toBe(7);
    }
  });

  it('walks the likes sort exactly once per plot while the counts move', async () => {
    const alice = await signUp('explore-moving-likes@example.com');
    const bob = await signUp('explore-moving-likes-reader@example.com');
    const ids = new Map<string, string>();
    for (const [name, likeCount] of RANKED) {
      ids.set(name, await seedPublic(alice, { name, likeCount }));
    }

    const walked = await walkExplore(bob, 'language=ko&sort=likes', async () => {
      // B was on page 1 and drops to the bottom; E was still unseen and jumps to
      // the top. A cursor keyed on B's old count would hand B back a second time
      // and never reach E at all.
      await db.update(plots).set({ likeCount: 5 }).where(eq(plots.id, ids.get('B')!));
      await db.update(plots).set({ likeCount: 100 }).where(eq(plots.id, ids.get('E')!));
    });

    expect(walked.slice(0, 2)).toEqual(['A', 'B']);
    expect([...walked].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('walks the chats sort exactly once per plot while the counts move', async () => {
    const alice = await signUp('explore-moving-chats@example.com');
    const bob = await signUp('explore-moving-chats-reader@example.com');
    const ids = new Map<string, string>();
    for (const [name, chatCount] of RANKED) {
      ids.set(name, await seedPublic(alice, { name, chatCount }));
    }

    const walked = await walkExplore(bob, 'language=ko&sort=chats', async () => {
      await db.update(plots).set({ chatCount: 5 }).where(eq(plots.id, ids.get('B')!));
      await db.update(plots).set({ chatCount: 100 }).where(eq(plots.id, ids.get('E')!));
    });

    expect(walked.slice(0, 2)).toEqual(['A', 'B']);
    expect([...walked].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  const walkRows = async (): Promise<number> =>
    Number((await sql`select count(*)::int as n from feed_cursors`)[0]!['n']);

  it('serves the first counter-sorted page without opening a walk', async () => {
    const alice = await signUp('explore-page-one@example.com');
    const bob = await signUp('explore-page-one-reader@example.com');
    for (const [name, likeCount] of RANKED) await seedPublic(alice, { name, likeCount });

    // The common case by far: a reader looks at the feed and never pages. That
    // must cost no write at all, even though a next page exists.
    const first = await readJson(await request(bob, '/api/explore?language=ko&sort=likes&limit=2'));
    expect(first.items.map((item: any) => item.name)).toEqual(['A', 'B']);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(await walkRows()).toBe(0);

    // The snapshot appears only when that cursor is actually consumed.
    const second = await readJson(
      await request(
        bob,
        `/api/explore?language=ko&sort=likes&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      ),
    );
    expect(second.items.map((item: any) => item.name)).toEqual(['C', 'D']);
    expect(await walkRows()).toBe(1);

    // A feed that ends on its first page has no cursor and still writes nothing.
    const whole = await request(bob, '/api/explore?language=ko&sort=likes&limit=48');
    expect((await readJson(whole)).nextCursor).toBeNull();
    expect(await walkRows()).toBe(1);
  });

  it('collects abandoned walks a capped batch at a time', async () => {
    const alice = await signUp('explore-sweep@example.com');
    const bob = await signUp('explore-sweep-reader@example.com');
    for (const [name, likeCount] of RANKED) await seedPublic(alice, { name, likeCount });

    // A quiet hour's worth of abandoned walks. The request that comes next must
    // not pay for the whole backlog — arrays and all — before it can answer.
    await sql`
      insert into feed_cursors (seen, updated_at)
      select '{}'::uuid[], now() - interval '2 hours' from generate_series(1, 60)`;
    expect(await walkRows()).toBe(60);

    const first = await readJson(await request(bob, '/api/explore?language=ko&sort=likes&limit=2'));
    await request(
      bob,
      `/api/explore?language=ko&sort=likes&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    // 50 swept, 10 stale left for the next opener, plus the walk just opened.
    expect(await walkRows()).toBe(11);
  });

  it('answers a retried counter-sort page with the same plots', async () => {
    const alice = await signUp('explore-retry@example.com');
    const bob = await signUp('explore-retry-reader@example.com');
    for (const [name, likeCount] of RANKED) await seedPublic(alice, { name, likeCount });

    const page = async (cursor: string): Promise<any> =>
      readJson(
        await request(bob, `/api/explore?language=ko&sort=likes&limit=2&cursor=${encodeURIComponent(cursor)}`),
      );
    const names = (body: any): string[] => body.items.map((item: any) => item.name);

    const first = await readJson(await request(bob, '/api/explore?language=ko&sort=likes&limit=2'));
    // The first cursor carries page one rather than naming a walk, so consuming it
    // twice opens two walks. Each is a consistent walk of its own; what matters is
    // that both readers are handed the same page.
    const second = await page(first.nextCursor);
    const secondAgain = await page(first.nextCursor);
    expect(names(second)).toEqual(['C', 'D']);
    expect(names(secondAgain)).toEqual(['C', 'D']);
    expect(secondAgain.nextCursor).not.toEqual(second.nextCursor);
    expect(await walkRows()).toBe(2);

    // Once a walk is open its cursor is a position in it, so a retry replays it
    // byte for byte instead of selecting again.
    const third = await page(second.nextCursor);
    expect(names(third)).toEqual(['E', 'F']);
    expect(await page(second.nextCursor)).toEqual(third);

    // Still true once the counters have moved enough to change what a fresh
    // selection would pick: the snapshot pins which rows the page holds and where
    // the walk resumes. Their contents are read live, so a replay shows the
    // current like count rather than a stale one.
    await db.update(plots).set({ likeCount: 500 }).where(eq(plots.name, 'F'));
    const replayed = await page(second.nextCursor);
    expect(names(replayed)).toEqual(['E', 'F']);
    expect(replayed.nextCursor).toEqual(third.nextCursor);
    expect(replayed.items[1].likeCount).toBe(500);

    // A cursor pointing at a walk that no longer exists is refused, not silently
    // restarted at the top of the feed.
    await sql`truncate table feed_cursors`;
    const stale = await request(
      bob,
      `/api/explore?language=ko&sort=likes&limit=2&cursor=${encodeURIComponent(second.nextCursor)}`,
    );
    expect(stale.status).toBe(400);
    expect((await readJson(stale)).code).toBe('invalid_request');
  });

  it('hands two requests racing on one cursor the same page, not two halves of it', async () => {
    const alice = await signUp('explore-race@example.com');
    const bob = await signUp('explore-race-reader@example.com');
    const ids = new Map<string, string>();
    for (const [name, likeCount] of RANKED) {
      ids.set(name, await seedPublic(alice, { name, likeCount }));
    }

    const first = await readJson(await request(bob, '/api/explore?language=ko&sort=likes&limit=2'));
    const open = await readJson(
      await request(
        bob,
        `/api/explore?language=ko&sort=likes&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      ),
    );

    const url = `/api/explore?language=ko&sort=likes&limit=2&cursor=${encodeURIComponent(open.nextCursor)}`;

    // Hold the walk's row the way a competing request would, and let a paging
    // request pile up behind it. Then move the counters *while it waits* and
    // release. Selection happens under the lock, so the page it comes back with
    // has to be the one the new counts imply — a request that selected before
    // taking the lock would answer with the old ordering (E before F).
    let pending: Promise<any> | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`select id from feed_cursors for update`;
        pending = request(bob, url).then(readJson);
        await waitForLockWaiter();
        await tx`update plots set like_count = 99 where id = ${ids.get('F')!}::uuid`;
      });
    } catch (error) {
      // The next test truncates every table, so a request left in flight here
      // would fail that one instead of this one. Never leave one behind.
      await pending?.catch(() => undefined);
      throw error;
    }
    const answered = await pending!;
    expect(answered.items.map((item: any) => item.name)).toEqual(['F', 'E']);

    // A retry now replays that page rather than selecting again, and the snapshot
    // carries no id twice — the evidence any unserialized append would leave.
    expect(await readJson(await request(bob, url))).toEqual(answered);
    const [walk] = await db.select({ seen: feedCursors.seen }).from(feedCursors);
    expect(new Set(walk!.seen).size).toBe(walk!.seen.length);

    // And the walk as a whole still yields every plot exactly once.
    const walked = [...first.items, ...open.items, ...answered.items].map((item: any) => item.name);
    let cursor: string | null = answered.nextCursor;
    for (let hop = 0; hop < 10 && cursor; hop += 1) {
      const body: any = await readJson(
        await request(bob, `/api/explore?language=ko&sort=likes&limit=2&cursor=${encodeURIComponent(cursor)}`),
      );
      walked.push(...body.items.map((item: any) => item.name));
      cursor = body.nextCursor;
    }
    expect(cursor).toBeNull();
    expect([...walked].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  /**
   * A like row of a chosen age. The weekly sort ranks on these rather than on
   * `like_count`, so the tests write them directly — the API only ever likes now.
   */
  async function likeAt(plotId: string, userId: string, daysAgo: number): Promise<void> {
    await sql`
      insert into plot_likes (user_id, plot_id, created_at)
      values (${userId}, ${plotId}::uuid, now() - (${daysAgo}::int * interval '1 day'))`;
  }

  it('ranks the weekly sort on the trailing week and breaks ties on the total', async () => {
    const alice = await signUp('weekly-owner@example.com');
    const bob = await signUp('weekly-reader@example.com');
    const one = await userIdOf(await signUp('weekly-liker-1@example.com'));
    const two = await userIdOf(await signUp('weekly-liker-2@example.com'));

    // A is the most liked work there is, and none of it happened this week.
    const a = await seedPublic(alice, { name: 'A', likeCount: 50 });
    const b = await seedPublic(alice, { name: 'B', likeCount: 5 });
    const c = await seedPublic(alice, { name: 'C', likeCount: 30 });
    const d = await seedPublic(alice, { name: 'D', likeCount: 40 });
    await likeAt(a, one, 30);
    await likeAt(a, two, 20);
    await likeAt(b, one, 0);
    await likeAt(b, two, 1);
    await likeAt(c, one, 2);
    await likeAt(d, one, 6);
    // Just outside the window: it counts for the total and not for the week.
    await likeAt(d, two, 8);

    // B(2) first, then the two plots tied at one like this week — the total
    // decides between them — and A last, whichever way its counter reads.
    expect(await exploreNames(bob, 'language=ko&sort=weekly')).toEqual(['B', 'D', 'C', 'A']);
    // The all-time sort is untouched and reads the other way round.
    expect(await exploreNames(bob, 'language=ko&sort=likes')).toEqual(['A', 'D', 'C', 'B']);

    // The partition holds for this sort like any other: another language's rows
    // are not in it, and neither are private ones.
    const other = await seedPublic(alice, { name: '영어', language: 'en' });
    const secret = await seedPlot(alice, { name: '비공개' });
    await likeAt(other, one, 0);
    await likeAt(secret.id, one, 0);
    expect(await exploreNames(bob, 'language=ko&sort=weekly')).toEqual(['B', 'D', 'C', 'A']);
    expect(await exploreNames(bob, 'language=en&sort=weekly')).toEqual(['영어']);
  });

  it('walks the weekly sort exactly once per plot while the week moves', async () => {
    const alice = await signUp('weekly-walk@example.com');
    const bob = await signUp('weekly-walk-reader@example.com');
    const one = await userIdOf(await signUp('weekly-walk-1@example.com'));
    const two = await userIdOf(await signUp('weekly-walk-2@example.com'));
    const three = await userIdOf(await signUp('weekly-walk-3@example.com'));

    const ids = new Map<string, string>();
    for (const [name, likeCount] of RANKED) {
      const id = await seedPublic(alice, { name, likeCount });
      ids.set(name, id);
      // One like each this week, so the week ties everywhere and the totals
      // decide — a starting order the counters can then be moved out of.
      await likeAt(id, one, 1);
    }

    const walked = await walkExplore(bob, 'language=ko&sort=weekly', async () => {
      // B was on page 1 and falls out of the week entirely; E was still unseen
      // and takes the top of it. A cursor keyed on either would hand B back and
      // never reach E.
      await sql`delete from plot_likes where plot_id = ${ids.get('B')!}::uuid`;
      await likeAt(ids.get('E')!, two, 0);
      await likeAt(ids.get('E')!, three, 0);
    });

    expect(walked.slice(0, 2)).toEqual(['A', 'B']);
    expect([...walked].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('gives everyone the public page and the owner the whole plot', async () => {
    const alice = await signUp('view-owner@example.com');
    const bob = await signUp('view-reader@example.com');
    const longIntro = '가'.repeat(250);
    const created = await createPlot(alice, {
      name: '공개 작품',
      intro: '독자에게 건네는 한 줄.',
      description: 'SECRET-SETTING',
      intros: [longIntro],
      tags: ['판타지'],
      lorebook: [{ keys: ['문'], content: 'SECRET-LORE' }],
    });
    const member = await addCharacter(alice, created.id, {
      name: '공개 멤버',
      card: { intro: '멤버를 소개하는 한 줄.', description: 'SECRET-MEMBER' },
    });
    await publish(alice, created.id);
    const secret = await seedPlot(alice, { name: '비공개 작품' });

    const view = await readPublicPlot(bob, created.id);
    expect(view).toEqual({
      public: true,
      id: created.id,
      name: '공개 작품',
      coverUrl: null,
      creatorId: await userIdOf(alice),
      creatorName: 'view-owner',
      language: 'ko',
      tags: ['판타지'],
      likeCount: 0,
      chatCount: 0,
      // Written for readers rather than for the model, so it may leave.
      intro: '독자에게 건네는 한 줄.',
      introPreview: '가'.repeat(200),
      // The detail read carries the prologue whole; only the listings cut it.
      intros: [longIntro],
      introPreviews: ['가'.repeat(200)],
      // Options rather than prompt text, so the badge row travels; null until the
      // creator sets one. The narrator is cut down to its option — `voice` is
      // prompt text and must not appear here.
      style: null,
      narrator: null,
      // The follow edge to the creator — nobody follows anyone in this fixture.
      creatorFollow: { followerCount: 0, followedByMe: false },
      // Written for readers too, and empty until the creator recommends one.
      profiles: [],
      publishedAt: expect.any(String),
      likedByMe: false,
      // The roster is public by name, face and reader-facing line, and by nothing
      // else — the card behind each member stays with the owner.
      characters: [
        {
          id: member.id,
          name: '공개 멤버',
          avatarUrl: null,
          intro: '멤버를 소개하는 한 줄.',
        },
      ],
      // Presentation, so it travels even though the definition does not.
      displayScripts: [],
      defaultVariables: {},
      componentCode: '',
      componentCapabilities: [],
      // Only this read carries them; the card grids do not count comments.
      commentsEnabled: true,
      commentCount: 0,
    });
    // Nothing the model is told ever leaves.
    expect(JSON.stringify(view)).not.toContain('SECRET-');

    const owned = await readPlot(alice, created.id);
    expect(owned.public).toBeUndefined();
    expect(owned.description).toBe('SECRET-SETTING');
    expect(owned.visibility).toBe('public');
    expect(owned.characters[0].card.description).toBe('SECRET-MEMBER');
    // The counters the owner's own public page renders.
    expect(owned).toMatchObject({ likeCount: 0, chatCount: 0, publishedAt: expect.any(String) });
    expect((await readPlot(alice, secret.id)).publishedAt).toBeNull();

    expect((await request(bob, `/api/plots/${secret.id}/public`)).status).toBe(404);
    // Editing stays owner-only even for a public plot.
    expect((await json(bob, `/api/plots/${created.id}`, 'PATCH', { name: 'x' })).status).toBe(404);
    expect((await json(bob, `/api/plots/${created.id}/publish`, 'POST', { publish: false })).status).toBe(404);
    expect((await request(bob, `/api/plots/${created.id}`, 'DELETE')).status).toBe(404);
    // The owner's own list is unaffected by anyone else's public plots.
    expect(await readJson(await request(bob, '/api/plots'))).toEqual([]);
  });

  it('carries the member faces on every listing card', async () => {
    const alice = await signUp('stack-owner@example.com');
    const bob = await signUp('stack-reader@example.com');
    const plot = await createPlot(alice, {
      name: '얼굴 있는 작품',
      description: '설명',
      intros: ['도입부'],
    });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
    const first = await addCharacter(alice, plot.id, { name: '첫 멤버' });
    const second = await addCharacter(alice, plot.id, { name: '둘째 멤버' });
    await uploadFile(alice, `/api/plots/${plot.id}/characters/${first.id}/avatar`, gif, 'a.gif');
    await publish(alice, plot.id);

    const [card] = (await readJson(await request(bob, '/api/explore?language=ko'))).items;
    // In the creator's order, and a member with no picture leaves a null behind
    // rather than dropping out of the stack.
    expect(card.characters).toEqual([
      {
        id: first.id,
        name: '첫 멤버',
        avatarUrl: `/api/plots/${plot.id}/characters/${first.id}/avatar`,
      },
      { id: second.id, name: '둘째 멤버', avatarUrl: null },
    ]);
    // The card grid never counts comments, and never carries a definition.
    expect(card.commentCount).toBeUndefined();
    expect(card.description).toBeUndefined();
    expect(card.lorebook).toBeUndefined();
  });

  it('opens the catalogue and a public page to a reader without an account', async () => {
    const alice = await signUp('anon-owner@example.com');
    const longIntro = '가'.repeat(250);
    const created = await seedPlot(alice, { name: '익명 열람 작품', intros: [longIntro] });
    await publish(alice, created.id);
    const secret = await seedPlot(alice, { name: '비공개 작품' });

    // The catalogue and the creator page both read without a cookie.
    expect(await exploreNames(undefined, 'language=ko')).toEqual(['익명 열람 작품']);
    const creator = await request(undefined, `/api/creators/${await userIdOf(alice)}`);
    expect(creator.status).toBe(200);
    expect((await readJson(creator)).publicPlots).toHaveLength(1);

    const seen = await readPublicPlot(undefined, created.id);
    expect(seen).toMatchObject({ public: true, name: '익명 열람 작품' });
    // The prologue whole on the detail read; the listing keeps its cut.
    expect(seen.intros).toEqual([longIntro]);
    expect(seen.introPreview).toBe('가'.repeat(200));
    // Nobody is signed in, so nothing is liked by them.
    expect(seen.likedByMe).toBe(false);
    expect((await readJson(await request(undefined, '/api/explore?language=ko'))).items[0].likedByMe).toBe(
      false,
    );

    // What is not published is not there at all.
    expect((await request(undefined, `/api/plots/${secret.id}/public`)).status).toBe(404);

    // Reading is where it stops: everything owned, and every write, still needs a session.
    for (const [path, method] of [
      ['/api/plots', 'GET'],
      [`/api/plots/${created.id}`, 'GET'],
      [`/api/plots/${created.id}/characters`, 'GET'],
      ['/api/personas', 'GET'],
      ['/api/notes', 'GET'],
      ['/api/chats', 'GET'],
      [`/api/plots/${created.id}/like`, 'POST'],
    ] as const) {
      const res = await request(undefined, path, method);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect((await readJson(res)).code).toBe('unauthorized');
    }
    const startingChat = await json(undefined, '/api/chats', 'POST', {
      plotId: created.id,
      model: 'echo/echo',
    });
    expect(startingChat.status).toBe(401);
  });

  it('likes and unlikes idempotently', async () => {
    const alice = await signUp('like-owner@example.com');
    const bob = await signUp('like-reader@example.com');
    const id = await seedPublic(alice, { name: '좋아요 작품' });
    const secret = await seedPlot(alice, { name: '비공개' });

    expect(await readJson(await json(bob, `/api/plots/${id}/like`, 'POST'))).toEqual({
      liked: true,
      likeCount: 1,
    });
    // Repeating the like is a no-op, counter included.
    expect(await readJson(await json(bob, `/api/plots/${id}/like`, 'POST'))).toEqual({
      liked: true,
      likeCount: 1,
    });
    const seen = await readPublicPlot(bob, id);
    expect(seen.likedByMe).toBe(true);
    expect(seen.likeCount).toBe(1);
    // Likes are per user: alice has not liked her own plot.
    expect((await readJson(await request(alice, `/api/explore?language=ko`))).items[0]).toMatchObject({
      likeCount: 1,
      likedByMe: false,
    });

    expect(await readJson(await request(bob, `/api/plots/${id}/like`, 'DELETE'))).toEqual({
      liked: false,
      likeCount: 0,
    });
    expect(await readJson(await request(bob, `/api/plots/${id}/like`, 'DELETE'))).toEqual({
      liked: false,
      likeCount: 0,
    });
    expect((await readPublicPlot(bob, id)).likedByMe).toBe(false);

    // A plot bob cannot see cannot be liked either.
    expect((await json(bob, `/api/plots/${secret.id}/like`, 'POST')).status).toBe(404);
    expect((await request(bob, `/api/plots/${secret.id}/like`, 'DELETE')).status).toBe(404);
  });

  it('lets other users chat with a public plot and counts those chats', async () => {
    const alice = await signUp('chat-owner@example.com');
    const bob = await signUp('chat-reader@example.com');
    const id = await seedPublic(alice, { name: '대화 작품' });
    const secret = await seedPlot(alice, { name: '비공개' });

    const state = await startChat(bob, id);
    expect(state.path[0].content).toBe('대화 작품의 도입부');
    expect((await readPublicPlot(bob, id)).chatCount).toBe(1);

    // The owner's own chats do not inflate the counter.
    await startChat(alice, id);
    expect((await readPublicPlot(bob, id)).chatCount).toBe(1);

    // Bob's chat runs against the creator's row, so an edit reaches it.
    expect((await json(bob, '/api/chats', 'POST', { plotId: secret.id, model: 'echo/echo' })).status).toBe(404);
    const events = await readSse(
      await json(bob, `/api/chats/${state.chat.id}/messages`, 'POST', { content: '안녕' }),
    );
    expect(events.at(-1)!.event).toBe('done');
  });

  it('serves the covers and member avatars of public plots to non-owners', async () => {
    const alice = await signUp('avatar-owner@example.com');
    const bob = await signUp('avatar-reader@example.com');
    const png = buildPngWithTextChunks({
      chara: Buffer.from(JSON.stringify(v2Card), 'utf-8').toString('base64'),
    });
    const plot = await importCard(alice, new File([png], 'lian.png', { type: 'image/png' }));
    await patchPlot(alice, plot.id, { description: '설명' });
    await uploadFile(alice, `/api/plots/${plot.id}/cover`, png, 'c.png');
    const member = plot.characters[0];
    const avatarUrl = `/api/plots/${plot.id}/characters/${member.id}/avatar`;

    expect((await request(bob, avatarUrl)).status).toBe(404);
    expect((await request(bob, `/api/plots/${plot.id}/cover`)).status).toBe(404);

    await publish(alice, plot.id);
    const avatar = await request(bob, avatarUrl);
    expect(avatar.status).toBe(200);
    expect(new Uint8Array(await avatar.arrayBuffer())).toEqual(stripPngTextChunks(png));
    // A cover is a card PNG's text chunks away from being the definition itself.
    const cover = await request(bob, `/api/plots/${plot.id}/cover`);
    expect(cover.status).toBe(200);
    expect(readPngTextChunks(new Uint8Array(await cover.arrayBuffer())).size).toBe(0);
    // The public view carries the same urls.
    const view = await readPublicPlot(bob, plot.id);
    expect(view.coverUrl).toBe(`/api/plots/${plot.id}/cover`);
    expect(view.characters[0].avatarUrl).toBe(avatarUrl);
  });

  it('never serves an embedded card with a public avatar', async () => {
    const alice = await signUp('avatar-card@example.com');
    const bob = await signUp('avatar-card-reader@example.com');
    const png = buildPngWithTextChunks({
      chara: Buffer.from(JSON.stringify(v2Card), 'utf-8').toString('base64'),
    });
    const plot = await importCard(alice, new File([png], 'lian.png', { type: 'image/png' }));
    const member = plot.characters[0];
    const url = `/api/plots/${plot.id}/characters/${member.id}/avatar`;
    // The import itself still reads the card out of the same bytes.
    expect(member.card.description).toBe('왕립 도서관의 사서.');
    await publish(alice, plot.id);

    const served = new Uint8Array(await (await request(bob, url)).arrayBuffer());
    expect(readPngTextChunks(served).size).toBe(0);
    // Image data survives: what is left is byte-identical to the same PNG built
    // without any text chunk.
    expect(served).toEqual(buildPngWithTextChunks({}));

    // An avatar that reached the store without passing the stripping is cleaned
    // up by publishing.
    await writeFile(join(storageDir, 'avatars', `${member.id}.png`), png);
    expect(readPngTextChunks(new Uint8Array(await (await request(bob, url)).arrayBuffer())).size).toBe(1);
    await publish(alice, plot.id);
    const resanitized = new Uint8Array(await (await request(bob, url)).arrayBuffer());
    expect(readPngTextChunks(resanitized).size).toBe(0);
    expect(resanitized).toEqual(buildPngWithTextChunks({}));
  });

  it('stops other users generations once the plot is unpublished', async () => {
    const alice = await signUp('revoke-owner@example.com');
    const bob = await signUp('revoke-reader@example.com');
    const id = await seedPublic(alice, { name: '회수 작품' });
    const state = await startChat(bob, id);
    const chatId = state.chat.id;
    const first = await readSse(
      await json(bob, `/api/chats/${chatId}/messages`, 'POST', { content: '안녕' }),
    );
    expect(first.at(-1)!.event).toBe('done');
    const before = await readJson(await request(bob, `/api/chats/${chatId}`));

    await publish(alice, id, false);

    const blocked = await json(bob, `/api/chats/${chatId}/messages`, 'POST', { content: '계속 대화' });
    expect(blocked.status).toBe(404);
    expect((await readJson(blocked)).code).toBe('not_found');
    expect((await json(bob, `/api/chats/${chatId}/regenerate`, 'POST')).status).toBe(404);
    expect((await json(bob, `/api/chats/${chatId}/continue`, 'POST')).status).toBe(404);
    // The refused turn left no trace.
    expect(await readJson(await request(bob, `/api/chats/${chatId}`))).toEqual(before);

    // The creator's own chats are unaffected by the plot being private.
    const own = await startChat(alice, id);
    const ownReply = await readSse(
      await json(alice, `/api/chats/${own.chat.id}/messages`, 'POST', { content: '주인장' }),
    );
    expect(ownReply.at(-1)!.event).toBe('done');

    // Publishing again restores the other user's chat.
    await publish(alice, id);
    const resumed = await readSse(
      await json(bob, `/api/chats/${chatId}/messages`, 'POST', { content: '다시 안녕' }),
    );
    expect(resumed.at(-1)!.event).toBe('done');
  });

  it('lists a creator public plots', async () => {
    const alice = await signUp('creator@example.com');
    const bob = await signUp('creator-reader@example.com');
    const aliceId = await userIdOf(alice);
    await seedPublic(alice, { name: '공개 1', publishedAt: new Date(Date.UTC(2026, 0, 1)) });
    await seedPublic(alice, { name: '공개 2', language: 'en', publishedAt: new Date(Date.UTC(2026, 0, 2)) });
    await seedPlot(alice, { name: '비공개' });

    const page = await readJson(await request(bob, `/api/creators/${aliceId}`));
    expect(page.id).toBe(aliceId);
    expect(page.name).toBe('creator');
    // Newest first, across languages; private plots never appear.
    expect(page.publicPlots.map((item: any) => item.name)).toEqual(['공개 2', '공개 1']);
    expect(page.publicPlots[0].description).toBeUndefined();
    expect(page.publicPlots[0].creatorName).toBe('creator');

    expect((await request(bob, `/api/creators/${await userIdOf(bob)}`)).status).toBe(200);
    expect((await request(bob, '/api/creators/nobody')).status).toBe(404);
  });

  it('puts the plot block ahead of its members and merges the lorebooks', async () => {
    const cookie = await signUp('plot-prompt@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    const member = await firstMember(cookie, plotId);

    await patchPlot(cookie, plotId, {
      name: '아르카디아',
      description: '마법이 흔한 도시국가다.',
      lorebook: [{ keys: ['길드'], content: '길드는 다섯 개다.', insertionOrder: 10 }],
    });
    await patchCharacter(cookie, plotId, member.id, {
      card: { ...member.card, lorebook: [{ keys: ['길드'], content: '사서는 야근을 한다.', insertionOrder: 5 }] },
    });

    const { app: capturing, prompts } = capturingApp();
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '길드 이야기를 해줘' }, capturing),
    );

    const system = prompts.at(-1)!.system;
    expect(system).toContain('[작품: 아르카디아]\n마법이 흔한 도시국가다.');
    expect(system).toContain('[등장인물: 리안]');
    // The work frames the people in it, so it comes first.
    expect(system.indexOf('[작품: 아르카디아]')).toBeLessThan(system.indexOf('[등장인물: 리안]'));
    // Both lorebooks activate, ordered by insertionOrder across the merge.
    expect(system).toContain('길드는 다섯 개다.');
    expect(system.indexOf('사서는 야근을 한다.')).toBeLessThan(system.indexOf('길드는 다섯 개다.'));
  });

  it('shares one lore budget between the plot and its members', async () => {
    const cookie = await signUp('plot-budget@example.com');
    const { plotId, chatId } = await setupChat(cookie);
    const member = await firstMember(cookie, plotId);
    const plotEntry = '작품 로어: 길드는 다섯 개다.';
    const memberEntry = '등장인물 로어: 사서는 야근을 한다.';

    await patchPlot(cookie, plotId, {
      lorebook: [{ keys: ['길드'], content: plotEntry, insertionOrder: 0 }],
    });
    await patchCharacter(cookie, plotId, member.id, {
      card: {
        ...member.card,
        lorebook: [{ keys: ['길드'], content: memberEntry, insertionOrder: 1 }],
        // Room for exactly one of the two: the budget is one budget.
        loreSettings: { ...member.card.loreSettings, tokenBudget: countTokens(plotEntry) },
      },
    });

    const { app: capturing, prompts } = capturingApp();
    await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '길드 이야기' }, capturing),
    );

    const system = prompts.at(-1)!.system;
    expect(system).toContain(plotEntry);
    expect(system).not.toContain(memberEntry);
  });

  it('writes every member into the prompt, in the creator’s order', async () => {
    const cookie = await signUp('plot-roster-prompt@example.com');
    const plot = await createPlot(cookie, {
      name: '아르카디아',
      description: '마법이 흔한 도시국가다.',
      intros: ['문 앞이다'],
    });
    const first = await addCharacter(cookie, plot.id, {
      name: '리안',
      card: { description: '왕립 도서관의 사서.', personality: '조용하다.' },
    });
    const second = await addCharacter(cookie, plot.id, {
      name: '세라',
      card: { description: '기사단장.' },
    });
    const { chat } = await startChat(cookie, plot.id);

    const { app: capturing, prompts } = capturingApp();
    await readSse(await json(cookie, `/api/chats/${chat.id}/messages`, 'POST', { content: '안녕' }, capturing));

    const system = prompts.at(-1)!.system;
    expect(system).toContain('[등장인물: 리안]\n왕립 도서관의 사서.');
    expect(system).toContain('리안의 성격: 조용하다.');
    expect(system).toContain('[등장인물: 세라]\n기사단장.');
    expect(system.indexOf('[등장인물: 리안]')).toBeLessThan(system.indexOf('[등장인물: 세라]'));

    // Reordering the roster reorders the blocks.
    await json(cookie, `/api/plots/${plot.id}/characters/reorder`, 'POST', {
      ids: [second.id, first.id],
    });
    await readSse(await json(cookie, `/api/chats/${chat.id}/messages`, 'POST', { content: '또' }, capturing));
    const after = prompts.at(-1)!.system;
    expect(after.indexOf('[등장인물: 세라]')).toBeLessThan(after.indexOf('[등장인물: 리안]'));
  });

  it('carries a reader-facing intro and a cover beside the setting', async () => {
    const alice = await signUp('plot-intro@example.com');
    const bob = await signUp('plot-intro-reader@example.com');
    const plot = await seedPlot(alice, {
      name: '아르카디아',
      intro: '  다섯 길드가 나눠 다스리는 도시.  ',
    });
    expect(plot).toMatchObject({ intro: '다섯 길드가 나눠 다스리는 도시.', coverUrl: null });

    // A card PNG uploaded as a cover: the definition lives in its text chunks, and
    // a cover is served to every reader, so the chunks go — exactly as on an avatar.
    const png = buildPngWithTextChunks({
      chara: Buffer.from(JSON.stringify(v2Card), 'utf-8').toString('base64'),
    });
    const covered = await readJson(await uploadFile(alice, `/api/plots/${plot.id}/cover`, png, 'c.png'));
    expect(covered.coverUrl).toBe(`/api/plots/${plot.id}/cover`);
    await publish(alice, plot.id);

    const served = await request(bob, covered.coverUrl);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(readPngTextChunks(bytes).size).toBe(0);
    expect(bytes).toEqual(stripPngTextChunks(png));

    expect(await readPublicPlot(bob, plot.id)).toMatchObject({
      intro: '다섯 길드가 나눠 다스리는 도시.',
      coverUrl: `/api/plots/${plot.id}/cover`,
    });
    expect((await readJson(await request(bob, '/api/explore?language=ko'))).items[0]).toMatchObject({
      intro: '다섯 길드가 나눠 다스리는 도시.',
      coverUrl: `/api/plots/${plot.id}/cover`,
    });

    // Re-uploading in another format leaves no orphan behind under the old key.
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
    await uploadFile(alice, `/api/plots/${plot.id}/cover`, gif, 'c.gif');
    await expect(readFile(join(storageDir, 'covers', `${plot.id}.png`))).rejects.toThrow();

    // Bytes that are not an image, and someone else's plot.
    const junk = await uploadFile(alice, `/api/plots/${plot.id}/cover`, new Uint8Array([1, 2, 3, 4]), 'x.bin');
    expect(junk.status).toBe(400);
    expect((await readJson(junk)).code).toBe('invalid_asset');
    expect((await uploadFile(bob, `/api/plots/${plot.id}/cover`, gif, 'c.gif')).status).toBe(404);
    expect((await request(bob, `/api/plots/${plot.id}/cover`, 'DELETE')).status).toBe(404);

    const cleared = await readJson(await request(alice, `/api/plots/${plot.id}/cover`, 'DELETE'));
    expect(cleared.coverUrl).toBeNull();
    expect((await request(bob, `/api/plots/${plot.id}/cover`)).status).toBe(404);
    await expect(readFile(join(storageDir, 'covers', `${plot.id}.gif`))).rejects.toThrow();
  });

  it('takes the cover away with the plot it belonged to', async () => {
    const alice = await signUp('plot-cover-delete@example.com');
    const plot = await createPlot(alice, { name: '아르카디아' });
    await uploadFile(alice, `/api/plots/${plot.id}/cover`, buildPngWithTextChunks({}), 'c.png');
    await readFile(join(storageDir, 'covers', `${plot.id}.png`));

    expect((await request(alice, `/api/plots/${plot.id}`, 'DELETE')).status).toBe(204);
    await expect(readFile(join(storageDir, 'covers', `${plot.id}.png`))).rejects.toThrow();
  });
});

describe('follows', () => {
  /** Session user id — the creator page and its follow edge are keyed on it. */
  async function userIdOf(cookie: string): Promise<string> {
    return (await readJson(await request(cookie, '/api/auth/get-session'))).user.id;
  }

  const follow = (cookie: string | undefined, creatorId: string, method = 'POST'): Promise<Response> =>
    request(cookie, `/api/creators/${creatorId}/follow`, method);

  it('follows and unfollows idempotently and counts the followers', async () => {
    const alice = await signUp('follow-creator@example.com');
    const bob = await signUp('follow-reader@example.com');
    const carol = await signUp('follow-reader-2@example.com');
    const aliceId = await userIdOf(alice);

    const page = async (cookie: string | undefined): Promise<any> =>
      readJson(await request(cookie, `/api/creators/${aliceId}`));
    expect(await page(bob)).toMatchObject({ followerCount: 0, followedByMe: false });

    expect(await readJson(await follow(bob, aliceId))).toEqual({ followerCount: 1, followedByMe: true });
    // Following twice is the same row, so the second call answers the same thing.
    expect(await readJson(await follow(bob, aliceId))).toEqual({ followerCount: 1, followedByMe: true });
    await follow(carol, aliceId);

    // The count is everyone's; the edge is the reader's own.
    expect(await page(bob)).toMatchObject({ followerCount: 2, followedByMe: true });
    expect(await page(alice)).toMatchObject({ followerCount: 2, followedByMe: false });
    // Nobody signed in follows nobody, and still sees the count.
    expect(await page(undefined)).toMatchObject({ followerCount: 2, followedByMe: false });

    expect(await readJson(await follow(bob, aliceId, 'DELETE'))).toEqual({
      followerCount: 1,
      followedByMe: false,
    });
    expect(await readJson(await follow(bob, aliceId, 'DELETE'))).toEqual({
      followerCount: 1,
      followedByMe: false,
    });
    expect(await page(bob)).toMatchObject({ followerCount: 1, followedByMe: false });
  });

  it('refuses a self-follow, an unknown creator and a reader without an account', async () => {
    const alice = await signUp('self-follow@example.com');
    const aliceId = await userIdOf(alice);

    const self = await follow(alice, aliceId);
    expect(self.status).toBe(400);
    expect((await readJson(self)).code).toBe('invalid_request');
    // And nothing was written by the refusal.
    expect((await readJson(await request(alice, `/api/creators/${aliceId}`))).followerCount).toBe(0);

    expect((await follow(alice, 'nobody')).status).toBe(404);
    expect((await follow(undefined, aliceId)).status).toBe(401);
    expect((await follow(undefined, aliceId, 'DELETE')).status).toBe(401);
  });
});

describe('notifications', () => {
  async function userIdOf(cookie: string): Promise<string> {
    return (await readJson(await request(cookie, '/api/auth/get-session'))).user.id;
  }

  const follow = (cookie: string, creatorId: string): Promise<Response> =>
    request(cookie, `/api/creators/${creatorId}/follow`, 'POST');

  const listNotifications = async (cookie: string, query = ''): Promise<any> =>
    readJson(await request(cookie, `/api/notifications${query}`));

  it('notifies every follower the first time a plot goes public', async () => {
    const alice = await signUp('notify-creator@example.com');
    const bob = await signUp('notify-follower@example.com');
    const carol = await signUp('notify-stranger@example.com');
    const aliceId = await userIdOf(alice);
    await follow(bob, aliceId);

    const plot = await publishablePlot(alice, { name: '알림 작품' });
    // A plot sitting private announces nothing.
    expect(await listNotifications(bob)).toEqual({ items: [], nextCursor: null, unreadCount: 0 });

    await publishPlot(alice, plot.id);
    const list = await listNotifications(bob);
    expect(list.unreadCount).toBe(1);
    expect(list.items).toEqual([
      {
        id: expect.any(String),
        kind: 'plot_published',
        actorId: aliceId,
        actorName: 'notify-creator',
        plotId: plot.id,
        plotName: '알림 작품',
        read: false,
        createdAt: expect.any(String),
      },
    ]);
    // Only followers hear about it, and nobody hears about their own publish.
    expect((await listNotifications(carol)).items).toEqual([]);
    expect((await listNotifications(alice)).items).toEqual([]);

    // Republishing announces nothing: the row is minted when a work first goes
    // public, and an unpublish does not take that back.
    await publishPlot(alice, plot.id);
    await json(alice, `/api/plots/${plot.id}/publish`, 'POST', { publish: false });
    await publishPlot(alice, plot.id);
    expect((await listNotifications(bob)).items).toHaveLength(1);

    // Following afterwards is not a subscription to the past.
    await follow(carol, aliceId);
    expect((await listNotifications(carol)).items).toEqual([]);

    // A second work does announce itself, to both of them now.
    const second = await publishablePlot(alice, { name: '두 번째 작품' });
    await publishPlot(alice, second.id);
    expect((await listNotifications(bob)).items.map((item: any) => item.plotName)).toEqual([
      '두 번째 작품',
      '알림 작품',
    ]);
    expect((await listNotifications(carol)).items).toHaveLength(1);
  });

  it('mints one notification when two publishes race on the same plot', async () => {
    const alice = await signUp('notify-race-creator@example.com');
    const bob = await signUp('notify-race-follower@example.com');
    await follow(bob, await userIdOf(alice));
    const plot = await publishablePlot(alice, { name: '경쟁 발행' });

    // Whether this is the first publish is a check-then-write, so both requests
    // are made to read the unstamped row before either of them may write it:
    // hold the plot, let both pile up on it, and only then release. Deciding on
    // a row read before the lock would announce the same plot twice.
    const publish = (): Promise<Response> =>
      json(alice, `/api/plots/${plot.id}/publish`, 'POST', { publish: true });
    let raced: Promise<Response[]> | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`select id from plots where id = ${plot.id}::uuid for update`;
        const first = publish();
        await waitForLockWaiter();
        const second = publish();
        await waitForLockWaiter(2);
        raced = Promise.all([first, second]);
      });
    } catch (error) {
      // The next test truncates every table, so a request left in flight here
      // would fail that one instead of this one.
      await raced?.catch(() => undefined);
      throw error;
    }
    expect((await raced!).map((res) => res.status)).toEqual([200, 200]);
    // The race is decided at the enqueue: one fan-out was queued, so one round of
    // it is all there is to run.
    expect(await db.select().from(jobs)).toHaveLength(1);
    await drainJobs(db, jobHandlers);
    expect((await listNotifications(bob)).items).toHaveLength(1);
  });

  it('walks the list through the cursor and marks everything read at once', async () => {
    const alice = await signUp('notify-walk-creator@example.com');
    const bob = await signUp('notify-walk-follower@example.com');
    await follow(bob, await userIdOf(alice));

    const names: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const plot = await publishablePlot(alice, { name: `작품 ${i}` });
      await publishPlot(alice, plot.id);
      names.push(`작품 ${i}`);
    }

    const first = await listNotifications(bob, '?limit=2');
    expect(first.unreadCount).toBe(5);
    const walked: string[] = first.items.map((item: any) => item.plotName);
    let cursor: string | null = first.nextCursor;
    for (let page = 0; page < 5 && cursor; page += 1) {
      const body: any = await listNotifications(bob, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
      // The badge is answered when the list is opened, not on every page of it.
      expect(body.unreadCount).toBeUndefined();
      walked.push(...body.items.map((item: any) => item.plotName));
      cursor = body.nextCursor;
    }
    expect(cursor).toBeNull();
    // Newest first, every notification exactly once.
    expect(walked).toEqual([...names].reverse());

    const malformed = encodeCursor({ createdAt: new Date().toISOString(), id: 'not-a-uuid' });
    const bad = await request(bob, `/api/notifications?cursor=${encodeURIComponent(malformed)}`);
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).code).toBe('invalid_request');
    expect((await request(bob, '/api/notifications?limit=51')).status).toBe(400);
    expect((await request(undefined, '/api/notifications')).status).toBe(401);

    expect(await readJson(await json(bob, '/api/notifications/read', 'POST'))).toEqual({ unreadCount: 0 });
    const read = await listNotifications(bob);
    expect(read.unreadCount).toBe(0);
    expect(read.items.every((item: any) => item.read)).toBe(true);
    // Reading is a no-op the second time, and it is the reader's own list only.
    expect(await readJson(await json(bob, '/api/notifications/read', 'POST'))).toEqual({ unreadCount: 0 });
    expect((await json(undefined, '/api/notifications/read', 'POST')).status).toBe(401);
  });
});

describe('job queue', () => {
  /** A payload of the one kind there is; the queue does not read into it. */
  const payload = (plotId = randomUUID(), actorId = 'author') => ({
    kind: 'plot_published' as const,
    plotId,
    actorId,
    publishedAt: new Date().toISOString(),
  });

  /** Enqueues the way a route does: inside a transaction of its own. */
  const enqueue = (body = payload(), opts?: { runAt?: Date }): Promise<void> =>
    db.transaction((tx) => enqueueJob(tx, 'notification_fanout', body, opts));

  const readJob = async (): Promise<any> => (await db.select().from(jobs))[0];

  /** The real registry with the fan-out lane replaced; this suite is about the queue, not the handlers. */
  const handlersOf = (handler: JobHandlers['notification_fanout']): JobHandlers => ({
    ...jobHandlers,
    notification_fanout: handler,
  });

  /** What a fan-out payload is about. These tests only ever enqueue the plot kind. */
  const subjectOf = (body: JobPayloadMap['notification_fanout']): string =>
    body.plotId;

  it('runs a queued job once, with the payload it was given', async () => {
    const seen: unknown[] = [];
    const handlers = handlersOf(async (_db, body) => {
      seen.push(body);
    });
    const body = payload();
    await enqueue(body);
    // A job that is not due yet is nobody's to claim.
    await enqueue(payload(), { runAt: new Date(Date.now() + 60 * 60_000) });

    expect(await drainJobs(db, handlers)).toBe(1);
    expect(seen).toEqual([body]);
    const [done, later] = await db.select().from(jobs).orderBy(asc(jobs.runAt));
    expect(done).toMatchObject({ status: 'done', attempts: 1, lockedAt: null, lockedBy: null });
    expect(later).toMatchObject({ status: 'pending', attempts: 0 });
    // Draining again finds nothing: a finished job is not claimable, and the other
    // one is an hour out.
    expect(await drainJobs(db, handlers)).toBe(0);
  });

  it('retries a failing job with a growing backoff and gives up after maxAttempts', async () => {
    let calls = 0;
    const handlers = handlersOf(async () => {
      calls += 1;
      throw new Error('handler exploded');
    });
    await enqueue();

    expect(await drainJobs(db, handlers)).toBe(1);
    const first = await readJob();
    expect(first).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'handler exploded',
      lockedAt: null,
      lockedBy: null,
    });
    // Pushed out by 2^1 minutes, so the retry is not due and the drain is empty.
    expect(first.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(await drainJobs(db, handlers)).toBe(0);

    // Each retry is pulled into the past rather than waited for — a minute back, so
    // that "due" does not rest on this process's clock and Postgres's agreeing to
    // the millisecond.
    const due = (): Date => new Date(Date.now() - 60_000);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await db.update(jobs).set({ runAt: due() });
      expect(await drainJobs(db, handlers)).toBe(1);
      expect((await readJob()).attempts).toBe(attempt);
    }
    expect(calls).toBe(5);
    expect(await readJob()).toMatchObject({ status: 'failed', lastError: 'handler exploded' });
    // A job that gave up stays given up, however due the row looks.
    await db.update(jobs).set({ runAt: due() });
    expect(await drainJobs(db, handlers)).toBe(0);
    expect(calls).toBe(5);
  });

  it('never hands the same job to two claimers at once', async () => {
    const bodies = [payload(), payload(), payload(), payload()];
    for (const body of bodies) await enqueue(body);

    const seen: string[] = [];
    const handlers = handlersOf(async (_db, body) => {
      seen.push(subjectOf(body));
      // Held long enough that the other loop is certainly asking for work while
      // this one has the row.
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    const [first, second] = await Promise.all([drainJobs(db, handlers), drainJobs(db, handlers)]);
    expect(first + second).toBe(4);
    // Every job ran, and none of them ran twice.
    expect([...seen].sort()).toEqual(bodies.map((body) => body.plotId).sort());
    const rows = await db.select().from(jobs);
    expect(rows.map((row) => [row.status, row.attempts])).toEqual([
      ['done', 1],
      ['done', 1],
      ['done', 1],
      ['done', 1],
    ]);
  });

  it('takes over a lease whose holder stopped, and leaves a live one alone', async () => {
    let calls = 0;
    const handlers = handlersOf(async () => {
      calls += 1;
    });
    await enqueue();
    // A worker that is still on it, one attempt in.
    await db.update(jobs).set({ lockedAt: new Date(), lockedBy: 'other:1', attempts: 1 });
    expect(await drainJobs(db, handlers)).toBe(0);
    expect(calls).toBe(0);

    // The same row after that worker stopped saying anything for three minutes.
    await db.update(jobs).set({ lockedAt: new Date(Date.now() - 3 * 60_000) });
    expect(await drainJobs(db, handlers)).toBe(1);
    expect(calls).toBe(1);
    // The takeover counts as an attempt of its own: the lease that expired had one.
    expect(await readJob()).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('fails a job whose worker died on its final attempt instead of reclaiming it forever', async () => {
    let calls = 0;
    const handlers = handlersOf(async () => {
      calls += 1;
    });
    await enqueue();
    // What a worker that died on the last attempt it had leaves behind: every attempt
    // spent, a lease nobody is renewing, and a row that still says `pending`.
    await db
      .update(jobs)
      .set({ attempts: 5, lockedAt: new Date(Date.now() - 3 * 60_000), lockedBy: 'dead:1' });

    expect(await drainJobs(db, handlers)).toBe(0);
    // Nothing ran it a sixth time — and nothing left it claimable either.
    expect(calls).toBe(0);
    expect(await readJob()).toMatchObject({
      status: 'failed',
      attempts: 5,
      lockedAt: null,
      lockedBy: null,
      lastError: 'lease expired after the final attempt',
    });
  });

  it('lets a worker whose lease was taken over write nothing about the job', async () => {
    await enqueue();
    // The claim the first worker holds, as it saw it.
    await db.update(jobs).set({ attempts: 1, lockedAt: new Date(), lockedBy: 'first:1' });
    const held = await readJob();
    // Its lease runs out and the job is taken over. The claim increments `attempts`,
    // which is what the first worker's writes are fenced on.
    await db.update(jobs).set({ attempts: 2, lockedAt: new Date(), lockedBy: 'second:2' });

    expect(await finishJob(db, held, 'first:1')).toBe(0);
    expect(await recordFailure(db, held, 'first:1', new Error('too late'))).toBe(0);
    // Neither of them touched the row: the job is still the second worker's, still
    // pending, and still carrying no failure of the first worker's making.
    expect(await readJob()).toMatchObject({
      status: 'pending',
      attempts: 2,
      lockedBy: 'second:2',
      lastError: null,
    });

    // The worker that does hold it is still able to finish it.
    expect(await finishJob(db, await readJob(), 'second:2')).toBe(1);
    expect(await readJob()).toMatchObject({ status: 'done', lockedBy: null, lockedAt: null });
  });

  it('renews the lease under a running handler, and not under a stale one', async () => {
    await enqueue();
    // A claim that has been running longer than the lease stands on its own.
    await db
      .update(jobs)
      .set({ attempts: 1, lockedAt: new Date(Date.now() - 3 * 60_000), lockedBy: 'slow:1' });
    const held = await readJob();

    // Tighter than the minute the worker renews on: the point is that it lands, not
    // how long it waits.
    const stopRenewing = renewLease(db, held, 'slow:1', 20);
    try {
      await vi.waitFor(
        async () => expect((await readJob()).lockedAt.getTime()).toBeGreaterThan(Date.now() - 60_000),
        { timeout: 2_000, interval: 10 },
      );
    } finally {
      stopRenewing();
    }

    // Once the job has been taken over, the old holder's renewal must not pull it
    // back: same fence as every other write it makes.
    await db
      .update(jobs)
      .set({ attempts: 2, lockedAt: new Date(Date.now() - 3 * 60_000), lockedBy: 'other:2' });
    const takenOver = await readJob();
    const stopStale = renewLease(db, held, 'slow:1', 20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    stopStale();
    expect((await readJob()).lockedAt.getTime()).toBe(takenOver.lockedAt.getTime());
  });

  it('picks work up on its own while the worker runs, and not after it stops', async () => {
    const seen: string[] = [];
    const handlers = handlersOf(async (_db, body) => {
      seen.push(subjectOf(body));
    });
    // A tighter poll than the instance runs: this test is about the loop coming
    // back, not about how long it waits.
    const stopWorker = startJobWorker({ db, handlers }, { idleMs: 5 });
    const body = payload();
    try {
      await enqueue(body);
      await vi.waitFor(async () => expect((await readJob()).status).toBe('done'), {
        timeout: 2_000,
        interval: 10,
      });
      expect(seen).toEqual([body.plotId]);
    } finally {
      stopWorker();
    }

    // Stopped means stopped: what is queued afterwards is left for somebody else.
    await enqueue();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await db.select().from(jobs).where(eq(jobs.status, 'pending'))).toHaveLength(1);
    expect(seen).toEqual([body.plotId]);
  });
});

describe('publish fan-out', () => {
  async function userIdOf(cookie: string): Promise<string> {
    return (await readJson(await request(cookie, '/api/auth/get-session'))).user.id;
  }

  /**
   * Followers straight into the tables. The fan-out reads rows and not sessions,
   * and a few thousand sign-ups would be a password hash each.
   */
  async function seedFollowers(
    creatorId: string,
    count: number,
    prefix: string,
    createdAt?: Date,
  ): Promise<string[]> {
    const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
    await db.insert(user).values(ids.map((id) => ({ id, name: id, email: `${id}@example.com` })));
    // One statement, so every row carries the same `created_at` — which is the tie
    // the keyset walk has to break on the follower id. `createdAt` states it outright
    // where a test has to be sure which side of the publish a follow fell on.
    await db
      .insert(follows)
      .values(ids.map((id) => ({ followerId: id, creatorId, ...(createdAt ? { createdAt } : {}) })));
    return ids;
  }

  /** The publish stamp the enqueue sends along as the fan-out's cutoff. */
  const publishedAtOf = async (plotId: string): Promise<Date> =>
    (await db.select({ at: plots.publishedAt }).from(plots).where(eq(plots.id, plotId)))[0]!.at!;

  /** The payload the queue would have carried, for a handler a test runs by hand. */
  const fanoutPayload = async (plotId: string, actorId: string) => ({
    kind: 'plot_published' as const,
    plotId,
    actorId,
    publishedAt: (await publishedAtOf(plotId)).toISOString(),
  });

  const notifiedBy = async (plotId: string): Promise<string[]> =>
    (await db.select({ userId: notifications.userId }).from(notifications).where(eq(notifications.plotId, plotId)))
      .map((row) => row.userId)
      .sort();

  /**
   * The db a handler sees, with a seam right after its first insert lands: the walk
   * has read one batch and taken its boundary from it, and this is where something
   * happens to the world before the next batch is read. It stands in for exactly the
   * two calls the fan-out makes of its handle, so a fan-out that starts using a
   * third breaks here rather than quietly skipping the seam.
   */
  function dbWithSeamAfterFirstInsert(between: () => Promise<void>): Db {
    let fired = false;
    return {
      select: db.select.bind(db),
      insert: (table: any) => ({
        values: (rows: any) => ({
          onConflictDoNothing: async () => {
            await db.insert(table).values(rows).onConflictDoNothing();
            if (fired) return;
            fired = true;
            await between();
          },
        }),
      }),
    } as unknown as Db;
  }

  /** Publishes without draining: these tests run the fan-out themselves. */
  const publishOnly = async (cookie: string, id: string): Promise<any> => {
    const res = await json(cookie, `/api/plots/${id}/publish`, 'POST', { publish: true });
    expect(res.status, await res.clone().text()).toBe(200);
    return readJson(res);
  };

  it('notifies every follower across batches, and announces nothing twice', async () => {
    const alice = await signUp('fanout-creator@example.com');
    const aliceId = await userIdOf(alice);
    const followers = await seedFollowers(aliceId, 25, 'fanout-follower');
    const plot = await publishablePlot(alice, { name: '팬아웃 작품' });

    await publishOnly(alice, plot.id);
    // One job, and no rows until it runs: the publish hands the work over rather
    // than doing it.
    expect(await db.select().from(jobs)).toHaveLength(1);
    expect(await notifiedBy(plot.id)).toEqual([]);

    // Five to a batch, so the walk has to come back six times for twenty-five
    // followers — including the last, empty read.
    const batched: JobHandlers = {
      ...jobHandlers,
      notification_fanout: (handlerDb, body) => notificationFanout(handlerDb, body, 5),
    };
    expect(await drainJobs(db, batched)).toBe(1);
    expect(await notifiedBy(plot.id)).toEqual([...followers].sort());
    // The creator follows nobody, least of all themselves.
    expect((await notifiedBy(plot.id)).includes(aliceId)).toBe(false);

    // Running the fan-out again is a re-delivery of nothing: the rows an earlier
    // attempt wrote conflict instead of arriving a second time.
    await notificationFanout(db, await fanoutPayload(plot.id, aliceId), 5);
    expect(await notifiedBy(plot.id)).toEqual([...followers].sort());
  });

  it('does not notify a reader who followed after the publish', async () => {
    const alice = await signUp('fanout-late-creator@example.com');
    const aliceId = await userIdOf(alice);
    const [early] = await seedFollowers(aliceId, 1, 'fanout-early-follower');
    const plot = await publishablePlot(alice, { name: '늦은 팔로우' });
    await publishOnly(alice, plot.id);

    // The job sits in the queue while somebody new follows. What the fan-out is
    // about is the moment of the publish, not the moment a worker got to it —
    // following is not a subscription to the past, however late the work is done.
    const publishedAt = await publishedAtOf(plot.id);
    await seedFollowers(aliceId, 1, 'fanout-late-follower', new Date(publishedAt.getTime() + 1_000));

    expect(await drainJobs(db, jobHandlers)).toBe(1);
    expect(await notifiedBy(plot.id)).toEqual([early]);
  });

  it('finishes the walk when the follow it took its boundary from is gone', async () => {
    const alice = await signUp('fanout-boundary-creator@example.com');
    const aliceId = await userIdOf(alice);
    const followers = await seedFollowers(aliceId, 12, 'fanout-boundary-follower');
    const plot = await publishablePlot(alice, { name: '경계 팔로우' });
    await publishOnly(alice, plot.id);

    // Five to a batch, so the fifth row of the walk is the boundary the second batch
    // starts from.
    const walk = await db
      .select({ id: follows.followerId })
      .from(follows)
      .where(eq(follows.creatorId, aliceId))
      .orderBy(desc(follows.createdAt), desc(follows.followerId));
    const boundary = walk[4]!.id;

    // That reader unfollows between the first batch and the second — which is
    // allowed, and must not end the walk. Everyone after them in the order has not
    // been told yet.
    const unfollowing = dbWithSeamAfterFirstInsert(async () => {
      await db.delete(follows).where(and(eq(follows.creatorId, aliceId), eq(follows.followerId, boundary)));
    });
    await notificationFanout(unfollowing, await fanoutPayload(plot.id, aliceId), 5);

    // All twelve: the one who left was in the batch that had already landed.
    expect(await notifiedBy(plot.id)).toEqual([...followers].sort());
  });

  it('reaches past the follower count the inline fan-out used to give up at', async () => {
    const alice = await signUp('fanout-crowd-creator@example.com');
    const aliceId = await userIdOf(alice);
    // One over the 5,000 the publish transaction used to skip everything past.
    await sql`insert into "user" (id, name, email)
      select 'crowd-' || g, 'crowd', 'crowd-' || g || '@example.com' from generate_series(1, 5001) g`;
    await sql`insert into follows (follower_id, creator_id)
      select 'crowd-' || g, ${aliceId} from generate_series(1, 5001) g`;

    const plot = await publishablePlot(alice, { name: '많은 팔로워' });
    await publishOnly(alice, plot.id);
    expect(await drainJobs(db, jobHandlers)).toBe(1);

    expect(await notifiedBy(plot.id)).toHaveLength(5001);
    expect(await readJson(await request(alice, '/api/notifications'))).toMatchObject({ unreadCount: 0 });
  });

  it('queues nothing for a publish that announces nothing', async () => {
    const alice = await signUp('fanout-quiet-creator@example.com');
    const aliceId = await userIdOf(alice);
    await seedFollowers(aliceId, 3, 'fanout-quiet-follower');

    // Only the first publish announces anything; an unpublish keeps `published_at`,
    // so the second one has nothing to say either.
    const plain = await publishablePlot(alice, { name: '일반 작품' });
    await publishOnly(alice, plain.id);
    expect(await db.select().from(jobs)).toHaveLength(1);
    await json(alice, `/api/plots/${plain.id}/publish`, 'POST', { publish: false });
    await publishOnly(alice, plain.id);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it('leaves nothing to announce when the plot is gone before the job runs', async () => {
    const alice = await signUp('fanout-deleted-creator@example.com');
    const aliceId = await userIdOf(alice);
    await seedFollowers(aliceId, 3, 'fanout-deleted-follower');
    const plot = await publishablePlot(alice, { name: '지워질 작품' });
    await publishOnly(alice, plot.id);
    expect((await request(alice, `/api/plots/${plot.id}`, 'DELETE')).status).toBe(204);

    // The job still runs, finds nothing to announce and finishes — rather than
    // failing its foreign key on every attempt until it gives up.
    expect(await drainJobs(db, jobHandlers)).toBe(1);
    expect(await db.select().from(notifications)).toHaveLength(0);
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: 'done', attempts: 1 });
  });
});

describe('plot draft', () => {
  const DRAFT = JSON.stringify({
    name: '별빛 도서관',
    intro: '밤에만 문을 여는 도서관 이야기.',
    description: '해가 지면 열리는 왕립 도서관.',
    characters: [{ name: '리안', description: '야간 사서.', personality: '조용하고 꼼꼼하다.' }],
    intros: ['리안: 아직 안 가셨군요.'],
    tags: ['판타지', '판타지', '   '],
  });

  it('writes a draft the studio can create a plot from, and stores nothing', async () => {
    const cookie = await signUp('draft@example.com');
    // Fenced, because that is how a model actually answers with JSON.
    const { getAdapter, calls } = scriptedGetAdapter(`\`\`\`json\n${DRAFT}\n\`\`\``);
    const drafting = makeApp({ getAdapter });

    const res = await json(cookie, '/api/plots/draft', 'POST', { premise: '밤의 도서관' }, drafting);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await readJson(res)).toEqual({
      name: '별빛 도서관',
      intro: '밤에만 문을 여는 도서관 이야기.',
      description: '해가 지면 열리는 왕립 도서관.',
      characters: [{ name: '리안', description: '야간 사서.', personality: '조용하고 꼼꼼하다.' }],
      intros: ['리안: 아직 안 가셨군요.'],
      // Through the same normalization a create's tags go through.
      tags: ['판타지'],
    });
    expect(calls()).toBe(1);
    // The draft is an answer, not a row: the creator's shelf is still empty.
    expect(await readJson(await request(cookie, '/api/plots'))).toEqual([]);
  });

  it('retries once, and reports a model that never produced a draft', async () => {
    const cookie = await signUp('draft-retry@example.com');
    const { getAdapter, calls } = scriptedGetAdapter('초안을 준비했습니다!', DRAFT);
    const retrying = makeApp({ getAdapter });

    const ok = await json(cookie, '/api/plots/draft', 'POST', { premise: '밤의 도서관' }, retrying);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(calls()).toBe(2);

    // A keyless deployment serves only the echo model, and it answers with the
    // premise rather than with JSON — so the default app is the failure itself.
    const failed = await json(cookie, '/api/plots/draft', 'POST', { premise: '밤의 도서관' });
    expect(failed.status).toBe(502);
    expect((await readJson(failed)).code).toBe('draft_failed');
    expect(await readJson(await request(cookie, '/api/plots'))).toEqual([]);
  });

  it('checks the premise and the session before it calls anything', async () => {
    const cookie = await signUp('draft-guard@example.com');
    const { getAdapter, calls } = scriptedGetAdapter(DRAFT);
    const drafting = makeApp({ getAdapter });

    for (const premise of ['', '   ', 'x'.repeat(2001)]) {
      const res = await json(cookie, '/api/plots/draft', 'POST', { premise }, drafting);
      expect(res.status).toBe(400);
      expect((await readJson(res)).code).toBe('invalid_request');
    }
    expect((await json(cookie, '/api/plots/draft', 'POST', {}, drafting)).status).toBe(400);
    expect((await json(undefined, '/api/plots/draft', 'POST', { premise: '밤' }, drafting)).status).toBe(401);
    expect(calls()).toBe(0);
  });

  it('writes one draft at a time per creator', async () => {
    const cookie = await signUp('draft-busy@example.com');
    const other = await signUp('draft-busy-2@example.com');
    const { getAdapter, started, release } = gatedGetAdapter(DRAFT);
    const drafting = makeApp({ getAdapter });

    const first = json(cookie, '/api/plots/draft', 'POST', { premise: '밤의 도서관' }, drafting);
    await started;
    const second = await json(cookie, '/api/plots/draft', 'POST', { premise: '또 하나' }, drafting);
    expect(second.status).toBe(429);
    expect((await readJson(second)).code).toBe('draft_in_progress');
    // Per creator, not per instance: someone else's draft is not held up by it.
    const theirs = json(other, '/api/plots/draft', 'POST', { premise: '다른 사람' }, drafting);

    release();
    expect((await first).status).toBe(200);
    expect((await theirs).status).toBe(200);
    // And the slot is given back once the call is over.
    expect((await json(cookie, '/api/plots/draft', 'POST', { premise: '다시' }, drafting)).status).toBe(200);
  });
});

describe('reply suggestions', () => {
  const SUGGESTIONS = JSON.stringify({
    suggestions: ['그럼 같이 가볼까요?', '*조용히 문을 닫는다*', '가'.repeat(300)],
  });

  /** A chat with one exchange on it — something to suggest an answer to. */
  async function chatWithTurn(cookie: string): Promise<string> {
    const { chatId } = await setupChat(cookie);
    const events = await readSse(
      await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content: '안녕' }),
    );
    expect(events.at(-1)!.event).toBe('done');
    return chatId;
  }

  const messageCount = async (chatId: string): Promise<number> =>
    (await db.select().from(messages).where(eq(messages.chatId, chatId))).length;

  it('offers three reader replies and stores none of them', async () => {
    const cookie = await signUp('suggest@example.com');
    const chatId = await chatWithTurn(cookie);
    const before = await messageCount(chatId);

    const { getAdapter, calls } = scriptedGetAdapter(`\`\`\`json\n${SUGGESTIONS}\n\`\`\``);
    const suggesting = makeApp({ getAdapter });
    const res = await json(cookie, `/api/chats/${chatId}/suggest`, 'POST', undefined, suggesting);
    expect(res.status, await res.clone().text()).toBe(200);

    const body = await readJson(res);
    expect(body.suggestions).toHaveLength(3);
    expect(body.suggestions[0]).toBe('그럼 같이 가볼까요?');
    // Cut rather than dropped: three chips beat two whole ones.
    expect(body.suggestions[2]).toBe('가'.repeat(200));
    expect(calls()).toBe(1);
    // Nothing was written: the branch is exactly what it was.
    expect(await messageCount(chatId)).toBe(before);
  });

  it('says so when the deployment has no memory model to ask', async () => {
    const cookie = await signUp('suggest-off@example.com');
    const chatId = await chatWithTurn(cookie);

    // The default app has no provider key, so the memory channel resolves to
    // nothing and the button is simply not offered.
    const res = await json(cookie, `/api/chats/${chatId}/suggest`, 'POST');
    expect(res.status).toBe(503);
    expect((await readJson(res)).code).toBe('suggestions_unavailable');
  });

  it('reports a memory model that never produced suggestions', async () => {
    const cookie = await signUp('suggest-fail@example.com');
    const chatId = await chatWithTurn(cookie);

    // The echo model can be pointed at the memory channel, and it answers with
    // the prompt rather than with JSON — the parse failure exactly as it lands.
    const echoing = makeApp({ env: { MEMORY_MODEL: 'echo/echo' } });
    const res = await json(cookie, `/api/chats/${chatId}/suggest`, 'POST', undefined, echoing);
    expect(res.status).toBe(502);
    expect((await readJson(res)).code).toBe('suggestions_failed');
  });

  it('stands back while the chat generates, and suggests one thing at a time', async () => {
    const cookie = await signUp('suggest-busy@example.com');
    const chatId = await chatWithTurn(cookie);
    const { getAdapter, started, release } = gatedGetAdapter(SUGGESTIONS);
    const suggesting = makeApp({ getAdapter });

    // A claim on the chat row is what a running stream leaves behind.
    await db.update(chats).set({ generatingAt: new Date() }).where(eq(chats.id, chatId));
    const busy = await json(cookie, `/api/chats/${chatId}/suggest`, 'POST', undefined, suggesting);
    expect(busy.status).toBe(429);
    expect((await readJson(busy)).code).toBe('generation_in_progress');

    // A claim nobody renewed belongs to an instance that died, and must not
    // leave the chat without suggestions forever.
    await db
      .update(chats)
      .set({ generatingAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(chats.id, chatId));

    const first = json(cookie, `/api/chats/${chatId}/suggest`, 'POST', undefined, suggesting);
    await started;
    const second = await json(cookie, `/api/chats/${chatId}/suggest`, 'POST', undefined, suggesting);
    expect(second.status).toBe(429);
    expect((await readJson(second)).code).toBe('suggestion_in_progress');

    release();
    expect((await first).status).toBe(200);
    // The guard is given back with the answer.
    expect(
      (await json(cookie, `/api/chats/${chatId}/suggest`, 'POST', undefined, suggesting)).status,
    ).toBe(200);
  });

  it('belongs to the chat owner alone', async () => {
    const cookie = await signUp('suggest-owner@example.com');
    const stranger = await signUp('suggest-stranger@example.com');
    const chatId = await chatWithTurn(cookie);
    const { getAdapter } = scriptedGetAdapter(SUGGESTIONS);
    const suggesting = makeApp({ getAdapter });

    expect(
      (await json(stranger, `/api/chats/${chatId}/suggest`, 'POST', undefined, suggesting)).status,
    ).toBe(404);
    expect(
      (await json(undefined, `/api/chats/${chatId}/suggest`, 'POST', undefined, suggesting)).status,
    ).toBe(401);
  });
});

describe('plot assets', () => {
  /** A card-bearing PNG, so the stripping is observable on what gets served. */
  const cardPng = (): Uint8Array =>
    buildPngWithTextChunks({ chara: Buffer.from(JSON.stringify(v2Card), 'utf-8').toString('base64') });

  /** Minimal bytes that sniff as a GIF; the content never matters. */
  const gif = (marker: number): Uint8Array =>
    Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, marker]);

  /** A plot with enough substance to publish, so the visibility rules bite. */
  async function newPlot(cookie: string, name = '에셋 작품'): Promise<any> {
    return publishablePlot(cookie, { name, description: `${name} 설명`, intros: [`${name}의 도입부`] });
  }

  function upload(
    cookie: string,
    id: string,
    slug: string,
    bytes: Uint8Array,
    fields = true,
    measurement: Record<string, string> = {},
  ): Promise<Response> {
    const form = new FormData();
    form.append('file', new File([bytes], 'upload.bin'));
    if (fields) form.append('slug', slug);
    for (const [key, value] of Object.entries(measurement)) form.append(key, value);
    return request(cookie, `/api/plots/${id}/assets`, 'POST', form);
  }

  /** What the web app measures off an image before it sends the bytes. */
  const measured = { width: '1600', height: '900', thumbhash: 'HBkSHYSIeHiPiHh8eJd4h4eAeIhw==' };

  const listAssets = async (cookie: string | undefined, id: string): Promise<any[]> =>
    readJson(await request(cookie, `/api/plots/${id}/assets`));

  it('uploads, lists, serves and deletes an asset', async () => {
    const cookie = await signUp('asset-owner@example.com');
    const plot = await newPlot(cookie);
    const png = cardPng();

    const created = await readJson(await upload(cookie, plot.id, 'smile', png));
    expect(created).toEqual({
      slug: 'smile',
      url: `/api/plots/${plot.id}/assets/smile`,
      mime: 'image/png',
      // Nothing measured this one, and nothing on the read side needs it to be.
      width: null,
      height: null,
      thumbhash: null,
      // The owner's own read of the reveal condition; nothing is set here.
      unlock: null,
      createdAt: expect.any(String),
    });
    expect(await listAssets(cookie, plot.id)).toEqual([created]);

    const served = await request(cookie, created.url);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    // Stored exactly like an avatar: an asset is public, the card is not.
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(stripPngTextChunks(png));
    expect(readPngTextChunks(new Uint8Array(await (await request(cookie, created.url)).arrayBuffer())).size).toBe(
      0,
    );

    expect((await request(cookie, created.url, 'DELETE')).status).toBe(204);
    expect((await request(cookie, created.url)).status).toBe(404);
    expect(await listAssets(cookie, plot.id)).toEqual([]);
    // Deleting what is no longer there is a plain 404.
    expect((await request(cookie, created.url, 'DELETE')).status).toBe(404);
  });

  it('replaces the image behind a slug instead of adding a second one', async () => {
    const cookie = await signUp('asset-replace@example.com');
    const plot = await newPlot(cookie);
    await upload(cookie, plot.id, 'smile', cardPng());

    const replaced = await readJson(await upload(cookie, plot.id, 'smile', gif(1)));
    expect(replaced.mime).toBe('image/gif');
    expect(await listAssets(cookie, plot.id)).toEqual([replaced]);

    const served = await request(cookie, replaced.url);
    expect(served.headers.get('content-type')).toBe('image/gif');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(gif(1));
  });

  it('keeps the size and placeholder the uploader measured', async () => {
    const cookie = await signUp('asset-measured@example.com');
    const plot = await newPlot(cookie);

    const created = await readJson(await upload(cookie, plot.id, 'smile', gif(1), true, measured));
    expect(created).toMatchObject({ width: 1600, height: 900, thumbhash: measured.thumbhash });
    expect(await listAssets(cookie, plot.id)).toEqual([created]);

    // The measurement belongs to the bytes: a replacement that carries none
    // clears it rather than describing the new image with the old numbers.
    const replaced = await readJson(await upload(cookie, plot.id, 'smile', gif(2)));
    expect(replaced).toMatchObject({ width: null, height: null, thumbhash: null });
  });

  it('refuses a measurement that is half sent or out of bounds', async () => {
    const cookie = await signUp('asset-measure-bad@example.com');
    const plot = await newPlot(cookie);

    const refuse = async (measurement: Record<string, string>): Promise<string> => {
      const response = await upload(cookie, plot.id, 'smile', gif(1), true, measurement);
      expect(response.status).toBe(400);
      return (await readJson(response)).code;
    };

    expect(await refuse({ width: '1600', height: '900' })).toBe('invalid_asset');
    expect(await refuse({ ...measured, height: '0' })).toBe('invalid_asset');
    expect(await refuse({ ...measured, width: '90000' })).toBe('invalid_asset');
    expect(await refuse({ ...measured, width: '16.5' })).toBe('invalid_asset');
    expect(await refuse({ ...measured, thumbhash: 'not base64!' })).toBe('invalid_asset');
    expect(await refuse({ ...measured, thumbhash: 'A'.repeat(65) })).toBe('invalid_asset');
    // Refused before anything was written.
    expect(await listAssets(cookie, plot.id)).toEqual([]);
  });

  it('normalizes the slug and refuses what cannot become one', async () => {
    const cookie = await signUp('asset-slug@example.com');
    const plot = await newPlot(cookie);

    expect((await readJson(await upload(cookie, plot.id, '  Smile Face!! ', gif(1)))).slug).toBe(
      'smile-face',
    );
    expect((await readJson(await upload(cookie, plot.id, 'a'.repeat(60), gif(1)))).slug).toHaveLength(40);

    // Nothing sluggable survives, so there is no handle to store it under.
    const hangul = await upload(cookie, plot.id, '웃음', gif(1));
    expect(hangul.status).toBe(400);
    expect((await readJson(hangul)).code).toBe('invalid_asset');

    const missing = await upload(cookie, plot.id, '', gif(1), false);
    expect(missing.status).toBe(400);
    expect((await readJson(missing)).code).toBe('invalid_asset');

    const notAnImage = await upload(cookie, plot.id, 'junk', Uint8Array.from([1, 2, 3, 4]));
    expect(notAnImage.status).toBe(400);
    expect((await readJson(notAnImage)).code).toBe('invalid_asset');

    const noFile = new FormData();
    noFile.append('slug', 'smile');
    const fileless = await request(cookie, `/api/plots/${plot.id}/assets`, 'POST', noFile);
    expect(fileless.status).toBe(400);
    expect((await readJson(fileless)).code).toBe('invalid_request');
  });

  it(`caps a plot at ${MAX_ASSETS_PER_PLOT} assets while still allowing replacements`, async () => {
    const cookie = await signUp('asset-cap@example.com');
    const plot = await newPlot(cookie);
    // All but one straight into the table — the route only counts them.
    await db.insert(plotAssets).values(
      Array.from({ length: MAX_ASSETS_PER_PLOT - 1 }, (_, i) => ({
        plotId: plot.id,
        slug: `a${i}`,
        path: `assets/a${i}.gif`,
        mime: 'image/gif',
      })),
    );
    expect((await upload(cookie, plot.id, `a${MAX_ASSETS_PER_PLOT - 1}`, gif(1))).status).toBe(201);

    const over = await upload(cookie, plot.id, `a${MAX_ASSETS_PER_PLOT}`, gif(2));
    expect(over.status).toBe(400);
    expect((await readJson(over)).code).toBe('asset_limit');

    // A slug that already exists is not a new asset, so the cap does not block it.
    expect((await upload(cookie, plot.id, 'a0', gif(99))).status).toBe(201);
    expect(await listAssets(cookie, plot.id)).toHaveLength(MAX_ASSETS_PER_PLOT);
  });

  it('serves assets to anyone who may read the plot, but only the owner writes', async () => {
    const alice = await signUp('asset-visible@example.com');
    const bob = await signUp('asset-reader@example.com');
    const plot = await newPlot(alice, '공개 에셋 작품');
    const created = await readJson(await upload(alice, plot.id, 'smile', gif(1)));

    // Private: not even the existence of the plot is visible.
    expect((await request(bob, `/api/plots/${plot.id}/assets`)).status).toBe(404);
    expect((await request(bob, created.url)).status).toBe(404);

    await publishPlot(alice, plot.id);

    // Everything the owner's own listing carries but the reveal condition, which
    // is the creator's alone.
    const { unlock, ...visible } = created;
    expect(unlock).toBeNull();
    expect(await listAssets(bob, plot.id)).toEqual([visible]);
    const served = await request(bob, created.url);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(gif(1));

    // Writing stays with the owner — for everyone else the plot is not theirs.
    expect((await upload(bob, plot.id, 'other', gif(2))).status).toBe(404);
    expect((await request(bob, created.url, 'DELETE')).status).toBe(404);
    // The images of a public plot are as public as the page they are on.
    expect((await request(undefined, created.url)).status).toBe(200);
    expect((await request(undefined, `/api/plots/${plot.id}/assets`)).status).toBe(200);
  });

  it('stores the embedded images of a charx import, deduping the slugs', async () => {
    const cookie = await signUp('asset-charx@example.com');
    const icon = cardPng();
    const charx = buildCharx(v3Card, [
      { type: 'icon', name: 'main', ext: 'png', entry: 'assets/icon/main.png', bytes: icon },
      { type: 'emotion', name: 'Smile', ext: 'png', entry: 'assets/emotion/a.png', bytes: cardPng() },
      { type: 'emotion', name: 'smile', ext: 'gif', entry: 'assets/emotion/b.gif', bytes: gif(2) },
      { type: 'emotion', name: '웃음', ext: 'gif', entry: 'assets/emotion/c.gif', bytes: gif(3) },
      { type: 'other', name: 'notes', ext: 'txt', entry: 'assets/notes.txt', bytes: gif(4) },
    ]);

    const plot = await importCard(cookie, new File([charx], 'sei.charx'));
    const member = plot.characters[0];
    expect(plot.name).toBe('세이');
    // The icon is still the member's avatar, not an asset.
    expect(member.avatarUrl).toBe(`/api/plots/${plot.id}/characters/${member.id}/avatar`);

    // Names are slugged, a collision gets a suffix, and a name with nothing
    // sluggable in it falls back to its position in the card. One insert means
    // one timestamp, so the list comes back in slug order.
    const assets: Record<string, any> = Object.fromEntries(
      (await listAssets(cookie, plot.id)).map((asset: any) => [asset.slug, asset]),
    );
    expect(Object.keys(assets)).toEqual(['asset-3', 'smile', 'smile-2']);
    expect(assets['smile'].mime).toBe('image/png');
    expect(assets['smile-2'].mime).toBe('image/gif');
    expect(assets['asset-3'].mime).toBe('image/gif');

    const first = await request(cookie, assets['smile'].url);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(stripPngTextChunks(cardPng()));
    const second = await request(cookie, assets['smile-2'].url);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(gif(2));
    // The avatar is the icon, untouched by the asset pass.
    const avatar = await request(cookie, member.avatarUrl);
    expect(new Uint8Array(await avatar.arrayBuffer())).toEqual(stripPngTextChunks(icon));
  });

  it('stops a charx import at the archive parser bound, below the plot cap', async () => {
    const cookie = await signUp('asset-charx-cap@example.com');
    /** `MAX_ASSETS` in @shizue/core's charx reader, which runs before this route. */
    const CHARX_ASSET_BOUND = 50;
    const embedded: CharxAssetSpec[] = Array.from({ length: CHARX_ASSET_BOUND + 5 }, (_, i) => ({
      type: 'emotion',
      name: `e${i}`,
      ext: 'gif',
      entry: `assets/emotion/e${i}.gif`,
      bytes: gif(i),
    }));
    const plot = await importCard(cookie, new File([buildCharx(v3Card, embedded)], 'many.charx'));

    // The archive is bounded before its images ever reach the plot's own cap.
    expect(CHARX_ASSET_BOUND).toBeLessThan(MAX_ASSETS_PER_PLOT);
    const slugs = (await listAssets(cookie, plot.id)).map((asset: any) => asset.slug);
    expect(slugs.sort()).toEqual(
      Array.from({ length: CHARX_ASSET_BOUND }, (_, i) => `e${i}`).sort(),
    );
  });

  it('fits a member import into whatever room the plot has left', async () => {
    const cookie = await signUp('asset-member-import-cap@example.com');
    // Its own store, so what is on disk afterwards is this test's and nothing else.
    const dir = await mkdtemp(join(tmpdir(), 'shizue-import-cap-'));
    const target = makeApp({ storage: createLocalStorage(dir) });
    const plot = await newPlot(cookie);

    // Two slots left, one of them already holding the first slug the archive wants.
    await db.insert(plotAssets).values([
      { plotId: plot.id, slug: 'e0', path: 'assets/taken.gif', mime: 'image/gif' },
      ...Array.from({ length: MAX_ASSETS_PER_PLOT - 3 }, (_, i) => ({
        plotId: plot.id,
        slug: `seed-${i}`,
        path: `assets/seed-${i}.gif`,
        mime: 'image/gif',
      })),
    ]);
    expect(await listAssets(cookie, plot.id)).toHaveLength(MAX_ASSETS_PER_PLOT - 2);

    const embedded: CharxAssetSpec[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'emotion',
      name: `e${i}`,
      ext: 'gif',
      entry: `assets/emotion/e${i}.gif`,
      bytes: gif(i),
    }));
    const form = new FormData();
    form.append('file', new File([buildCharx(v3Card, embedded)], 'many.charx'));
    const res = await request(cookie, `/api/plots/${plot.id}/characters/import`, 'POST', form, target);
    expect(res.status, await res.clone().text()).toBe(201);

    // The import fills the room it found and stops there, rather than reading the
    // free space before the write and overshooting it.
    const after = await listAssets(cookie, plot.id);
    expect(after).toHaveLength(MAX_ASSETS_PER_PLOT);
    const slugs = after.map((asset: any) => asset.slug);
    // The collision took a suffix instead of dying on the unique constraint.
    expect(slugs).toContain('e0');
    expect(slugs).toContain('e0-2');
    expect(new Set(slugs).size).toBe(slugs.length);

    // And the images that did not fit left nothing in the store behind them:
    // every object under `assets/` is named by a row.
    const rows = await db
      .select({ path: plotAssets.path })
      .from(plotAssets)
      .where(eq(plotAssets.plotId, plot.id));
    const named = new Set(rows.map((row) => row.path.slice('assets/'.length)));
    const onDisk = await readdir(join(dir, 'assets'));
    expect(onDisk.filter((file) => !named.has(file))).toEqual([]);
    expect(onDisk).toHaveLength(2);
  });

  it('keeps image references in the stored message but never sends them to the model', async () => {
    const cookie = await signUp('asset-prompt@example.com');
    const { chatId } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();

    const content = '반가워 {{img::smile}} 오늘도';
    await readSse(await json(cookie, `/api/chats/${chatId}/messages`, 'POST', { content }, capturing));

    const sent = prompts.at(-1)!;
    expect([sent.system, ...sent.messages.map((message) => message.content)].join('\n')).not.toContain(
      '{{img',
    );
    // The message itself keeps the reference — that is what the chat renders.
    const state = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(state.path.map((message: any) => message.content)).toContain(content);
  });

  it('never sends an image reference to the model on the continue path', async () => {
    const cookie = await signUp('asset-continue@example.com');
    const { chatId, state } = await setupChat(cookie);
    const { app: capturing, prompts } = capturingApp();

    // An assistant message is edited in place, so the reference really is in the
    // stored text the continue path re-attaches after the post-history block.
    const opening = state.path.at(-1);
    expect((await json(cookie, `/api/messages/${opening.id}`, 'PATCH', { content: '문이 열린다 {{img::smile}}' })).status).toBe(200);

    const events = await readSse(await json(cookie, `/api/chats/${chatId}/continue`, 'POST', undefined, capturing));
    expect(events.at(-1)!.event).toBe('done');

    // That partial bypasses the assembler, so it carries its own stripping.
    const sent = prompts.at(-1)!;
    expect(sent.messages.at(-1)!.role).toBe('assistant');
    expect(sent.messages.at(-1)!.content).toBe('문이 열린다');
    expect([sent.system, ...sent.messages.map((message) => message.content)].join('\n')).not.toContain('{{img');

    // The stored message keeps the reference; the continuation appends to it.
    const after = await readJson(await request(cookie, `/api/chats/${chatId}`));
    expect(after.path.at(-1).content).toContain('{{img::smile}}');
  });

  it('holds the cap against a concurrent upload', async () => {
    const cookie = await signUp('asset-race@example.com');
    const plot = await newPlot(cookie);
    // One short of the cap straight into the table — the route only counts them.
    await db.insert(plotAssets).values(
      Array.from({ length: MAX_ASSETS_PER_PLOT - 1 }, (_, i) => ({
        plotId: plot.id,
        slug: `seed-${i}`,
        path: `assets/seed-${i}.gif`,
        mime: 'image/gif',
      })),
    );

    // A competing transaction takes the plot lock, inserts the last asset and
    // holds it. The upload has to queue behind it and then see a full plot;
    // without the lock it would count one short and store one asset too many.
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: plots.id }).from(plots).where(eq(plots.id, plot.id)).for('update');
      await tx
        .insert(plotAssets)
        .values({ plotId: plot.id, slug: 'held', path: 'assets/held.gif', mime: 'image/gif' });
      await held;
    });

    const inFlight = upload(cookie, plot.id, 'racer', gif(1));
    // Long enough that an unlocked upload would have finished by now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    open();
    await holder;

    const res = await inFlight;
    expect(res.status, await res.clone().text()).toBe(400);
    expect((await readJson(res)).code).toBe('asset_limit');
    expect(await listAssets(cookie, plot.id)).toHaveLength(MAX_ASSETS_PER_PLOT);
  });

  it('cleans up the asset files when the plot goes away', async () => {
    const cookie = await signUp('asset-delete@example.com');
    const plot = await newPlot(cookie);
    const created = await readJson(await upload(cookie, plot.id, 'smile', gif(1)));
    const [{ path }] = await db
      .select({ path: plotAssets.path })
      .from(plotAssets)
      .where(eq(plotAssets.plotId, plot.id));

    expect((await request(cookie, `/api/plots/${plot.id}`, 'DELETE')).status).toBe(204);
    expect((await request(cookie, created.url)).status).toBe(404);
    await expect(readFile(join(storageDir, path))).rejects.toThrow();
  });
});

describe('safety level', () => {
  it('refuses the adult level until age verification exists', async () => {
    const cookie = await signUp('safety-adult@example.com');
    const created = await publishablePlot(cookie, { name: '검증' });
    expect(created.safetyLevel).toBe('all');

    // Every write that may declare a level refuses `adult`, as it does a level
    // that never existed.
    for (const safetyLevel of ['adult', 'teen']) {
      const published = await json(cookie, `/api/plots/${created.id}/publish`, 'POST', {
        publish: true,
        safetyLevel,
      });
      expect(published.status, safetyLevel).toBe(400);
      expect((await readJson(published)).code).toBe('invalid_request');
      const patched = await json(cookie, `/api/plots/${created.id}`, 'PATCH', { safetyLevel });
      expect(patched.status, safetyLevel).toBe(400);
      expect((await readJson(patched)).code).toBe('invalid_request');
      const fresh = await json(cookie, '/api/plots', 'POST', { name: '새 작품', safetyLevel });
      expect(fresh.status, safetyLevel).toBe(400);
      expect((await readJson(fresh)).code).toBe('invalid_request');
    }

    // Refused before anything was written.
    expect(await readPlot(cookie, created.id)).toMatchObject({ visibility: 'private', safetyLevel: 'all' });
    expect((await publishPlot(cookie, created.id, { safetyLevel: 'all' })).safetyLevel).toBe('all');
  });

  /** Rows saved as `adult` before the level was refused keep it, and stay unlisted. */
  it('hides a plot stored as adult from every public surface of another user', async () => {
    const alice = await signUp('safety-owner@example.com');
    const bob = await signUp('safety-viewer@example.com');
    const aliceId = (await readJson(await request(alice, '/api/auth/get-session'))).user.id;

    const adult = await publishablePlot(
      alice,
      { name: '성인 작품', description: '성인 작품 설명', intros: ['성인 작품의 도입부'], tags: ['성인태그'] },
      { name: '성인 작품 멤버' },
    );
    await publishPlot(alice, adult.id);
    await db.update(plots).set({ safetyLevel: 'adult' }).where(eq(plots.id, adult.id));
    // A published, all-ages sibling proves the filter is about the level only.
    const safe = await publishablePlot(alice, { name: '전체 작품' });
    await publishPlot(alice, safe.id);

    const names = async (path: string, key = 'items'): Promise<string[]> => {
      const res = await request(bob, path);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await readJson(res))[key].map((item: any) => item.name);
    };

    expect(await names('/api/explore?language=ko')).toEqual(['전체 작품']);
    expect(await names('/api/explore?language=ko&tag=성인태그')).toEqual([]);
    expect(await names(`/api/creators/${aliceId}`, 'publicPlots')).toEqual(['전체 작품']);

    // Direct reads are 404, not a redacted view.
    const member = (await readPlot(alice, adult.id)).characters[0];
    expect((await request(bob, `/api/plots/${adult.id}/public`)).status).toBe(404);
    expect((await request(bob, `/api/plots/${adult.id}/cover`)).status).toBe(404);
    expect((await request(bob, `/api/plots/${adult.id}/characters/${member.id}/avatar`)).status).toBe(404);
    expect((await request(bob, `/api/plots/${adult.id}/assets`)).status).toBe(404);
    expect((await request(bob, `/api/plots/${adult.id}/assets/smile`)).status).toBe(404);
    expect((await request(bob, `/api/plots/${adult.id}/comments`)).status).toBe(404);
    expect((await json(bob, `/api/plots/${adult.id}/like`, 'POST')).status).toBe(404);

    const chat = await json(bob, '/api/chats', 'POST', { plotId: adult.id, model: 'echo/echo' });
    expect(chat.status).toBe(404);
    expect((await readJson(chat)).code).toBe('not_found');
  });
});

describe('plot comments', () => {
  /** A published plot, ready to be commented on. */
  async function publicPlot(cookie: string, name = '댓글 작품'): Promise<string> {
    const created = await publishablePlot(cookie, {
      name,
      description: `${name} 설명`,
      intros: [`${name}의 도입부`],
    });
    await publishPlot(cookie, created.id);
    return created.id;
  }

  async function comment(cookie: string, plotId: string, body: unknown): Promise<any> {
    const res = await json(cookie, `/api/plots/${plotId}/comments`, 'POST', body);
    expect(res.status, await res.clone().text()).toBe(201);
    return readJson(res);
  }

  async function list(cookie: string | undefined, plotId: string, query = ''): Promise<any> {
    const res = await request(cookie, `/api/plots/${plotId}/comments${query}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return readJson(res);
  }

  const contentsOf = (page: any): string[] => page.items.map((item: any) => item.content);

  const countOf = async (cookie: string, plotId: string): Promise<number> =>
    (await readPublicPlot(cookie, plotId)).commentCount;

  it('lets a reader comment on a published plot and the creator reply', async () => {
    const alice = await signUp('comment-owner@example.com');
    const bob = await signUp('comment-reader@example.com');
    const plotId = await publicPlot(alice);

    const first = await comment(bob, plotId, { content: '  재밌어요  ' });
    expect(first.content).toBe('재밌어요');
    expect(first.authorName).toBe('comment-reader');
    expect(first.parentId).toBeNull();
    expect(first.spoiler).toBe(false);
    expect(first.deleted).toBe(false);
    expect(first.canDelete).toBe(true);

    await comment(bob, plotId, { content: '결말이 반전입니다', spoiler: true });
    await comment(alice, plotId, { content: '고마워요', parentId: first.id });
    await comment(bob, plotId, { content: '저도 그렇게 봤어요', parentId: first.id });

    // Top-level newest first; the replies under one, in the order they were written.
    const page = await list(bob, plotId);
    expect(contentsOf(page)).toEqual(['결말이 반전입니다', '재밌어요']);
    expect(page.items[0].spoiler).toBe(true);
    expect(page.items[0].replies).toEqual([]);
    expect(page.items[1].replies.map((reply: any) => reply.content)).toEqual([
      '고마워요',
      '저도 그렇게 봤어요',
    ]);
    expect(page.items[1].replies[0].authorName).toBe('comment-owner');
    expect(page.nextCursor).toBeNull();
    expect(await countOf(bob, plotId)).toBe(4);

    // The creator may moderate every comment on their own page.
    const asOwner = await list(alice, plotId);
    expect(asOwner.items.every((item: any) => item.canDelete)).toBe(true);
  });

  it('shows the section to a reader without an account, and takes nothing from one', async () => {
    const alice = await signUp('comment-anon-owner@example.com');
    const bob = await signUp('comment-anon-reader@example.com');
    const plotId = await publicPlot(alice, '익명 댓글 작품');
    await comment(bob, plotId, { content: '먼저 남긴 댓글' });

    const page = await list(undefined, plotId);
    expect(contentsOf(page)).toEqual(['먼저 남긴 댓글']);
    // Moderation belongs to somebody; a reader without an account is nobody.
    expect(page.items[0].canDelete).toBe(false);
    expect(page.items[0].authorName).toBe('comment-anon-reader');

    const write = await json(undefined, `/api/plots/${plotId}/comments`, 'POST', {
      content: '나도 한마디',
    });
    expect(write.status).toBe(401);
    expect((await readJson(write)).code).toBe('unauthorized');
    expect(contentsOf(await list(alice, plotId))).toEqual(['먼저 남긴 댓글']);
  });

  it('hides the comment section of a plot the reader cannot see', async () => {
    const alice = await signUp('comment-private@example.com');
    const bob = await signUp('comment-outsider@example.com');
    const created = await createPlot(alice, { name: '비공개 작품' });

    expect((await request(bob, `/api/plots/${created.id}/comments`)).status).toBe(404);
    const write = await json(bob, `/api/plots/${created.id}/comments`, 'POST', { content: '안녕' });
    expect(write.status).toBe(404);
    expect((await readJson(write)).code).toBe('not_found');

    // The owner sees their own plot, so they may comment on it.
    await comment(alice, created.id, { content: '혼잣말' });
    expect(contentsOf(await list(alice, created.id))).toEqual(['혼잣말']);
  });

  it('rejects a second reply level and a parent from another plot', async () => {
    const alice = await signUp('comment-parent@example.com');
    const one = await publicPlot(alice, '첫 작품');
    const two = await publicPlot(alice, '둘째 작품');
    const top = await comment(alice, one, { content: '최상위 댓글' });
    const reply = await comment(alice, one, { content: '대댓글', parentId: top.id });

    const nested = await json(alice, `/api/plots/${one}/comments`, 'POST', {
      content: '대대댓글',
      parentId: reply.id,
    });
    expect(nested.status).toBe(400);
    expect((await readJson(nested)).code).toBe('invalid_request');

    // A comment of another plot is no parent, and no comment either.
    const foreign = await json(alice, `/api/plots/${two}/comments`, 'POST', {
      content: '남의 글에 붙이기',
      parentId: top.id,
    });
    expect(foreign.status).toBe(404);

    for (const parentId of [randomUUID(), 'not-a-uuid']) {
      const res = await json(alice, `/api/plots/${one}/comments`, 'POST', {
        content: '없는 부모',
        parentId,
      });
      expect(res.status).toBe(404);
    }
  });

  it('rejects blank and over-long content', async () => {
    const cookie = await signUp('comment-validation@example.com');
    const plotId = await publicPlot(cookie);

    const blank = await json(cookie, `/api/plots/${plotId}/comments`, 'POST', {
      content: '   \n  ',
    });
    expect(blank.status).toBe(400);
    expect((await readJson(blank)).code).toBe('invalid_request');

    const long = await json(cookie, `/api/plots/${plotId}/comments`, 'POST', {
      content: 'ㄱ'.repeat(501),
    });
    expect(long.status).toBe(400);
    expect((await readJson(long)).code).toBe('comment_limit');

    // The cap itself still fits.
    expect((await comment(cookie, plotId, { content: 'ㄱ'.repeat(500) })).content).toHaveLength(500);
  });

  it('lets the author and the plot owner delete, and nobody else', async () => {
    const alice = await signUp('comment-mod-owner@example.com');
    const bob = await signUp('comment-mod-author@example.com');
    const carol = await signUp('comment-mod-stranger@example.com');
    const plotId = await publicPlot(alice);

    const mine = await comment(bob, plotId, { content: '밥의 댓글' });
    // A third party cannot delete it and is not told it is there to delete.
    expect((await request(carol, `/api/comments/${mine.id}`, 'DELETE')).status).toBe(404);
    expect((await list(carol, plotId)).items[0].canDelete).toBe(false);

    expect((await request(bob, `/api/comments/${mine.id}`, 'DELETE')).status).toBe(204);
    // Deleting it twice finds nothing the second time.
    expect((await request(bob, `/api/comments/${mine.id}`, 'DELETE')).status).toBe(404);

    const moderated = await comment(bob, plotId, { content: '또 다른 댓글' });
    expect((await request(alice, `/api/comments/${moderated.id}`, 'DELETE')).status).toBe(204);
    expect((await list(bob, plotId)).items).toEqual([]);
  });

  it('keeps a deleted comment only while it anchors a reply, and keeps nothing of it', async () => {
    const alice = await signUp('comment-delete-owner@example.com');
    const bob = await signUp('comment-delete-reader@example.com');
    const plotId = await publicPlot(alice);

    const anchored = await comment(bob, plotId, { content: '지워질 댓글', spoiler: true });
    const reply = await comment(alice, plotId, { content: '남는 대댓글', parentId: anchored.id });
    const lonely = await comment(bob, plotId, { content: '혼자 지워질 댓글' });

    expect((await request(alice, `/api/comments/${anchored.id}`, 'DELETE')).status).toBe(204);
    expect((await request(bob, `/api/comments/${lonely.id}`, 'DELETE')).status).toBe(204);

    // The one with a reply stays as a placeholder; the one without is simply gone.
    const page = await list(bob, plotId);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe(anchored.id);
    expect(page.items[0].deleted).toBe(true);
    expect(page.items[0].content).toBe('');
    expect(page.items[0].authorName).toBeNull();
    expect(page.items[0].spoiler).toBe(false);
    expect(page.items[0].canDelete).toBe(false);
    expect(page.items[0].replies.map((item: any) => item.content)).toEqual(['남는 대댓글']);
    expect(await countOf(bob, plotId)).toBe(1);

    // The words are gone from the database, not just from the response.
    const stored = await db.select().from(comments).where(eq(comments.id, anchored.id));
    expect(stored[0]!.content).toBe('');
    expect(stored[0]!.spoiler).toBe(false);
    expect(stored[0]!.deletedAt).not.toBeNull();

    // A placeholder is not a comment: nothing new attaches to it.
    const late = await json(bob, `/api/plots/${plotId}/comments`, 'POST', {
      content: '늦은 대댓글',
      parentId: anchored.id,
    });
    expect(late.status).toBe(404);

    // Once the last live reply goes, the placeholder has nothing left to anchor.
    expect((await request(alice, `/api/comments/${reply.id}`, 'DELETE')).status).toBe(204);
    expect((await list(bob, plotId)).items).toEqual([]);
    expect(await countOf(bob, plotId)).toBe(0);
  });

  it('closes the section when the creator turns comments off', async () => {
    const alice = await signUp('comment-switch-owner@example.com');
    const bob = await signUp('comment-switch-reader@example.com');
    const plotId = await publicPlot(alice);
    await comment(bob, plotId, { content: '이미 있는 댓글' });

    const closed = await patchPlot(alice, plotId, { commentsEnabled: false });
    expect(closed.commentsEnabled).toBe(false);

    const write = await json(bob, `/api/plots/${plotId}/comments`, 'POST', { content: '새 댓글' });
    expect(write.status).toBe(403);
    expect((await readJson(write)).code).toBe('comments_disabled');
    // Not even the creator writes past their own switch.
    expect(
      (await json(alice, `/api/plots/${plotId}/comments`, 'POST', { content: '나도' })).status,
    ).toBe(403);

    expect((await list(bob, plotId)).items).toEqual([]);
    const detail = await readPublicPlot(bob, plotId);
    expect(detail.commentsEnabled).toBe(false);
    expect(detail.commentCount).toBe(0);

    // Turning it back on brings the existing comments back untouched.
    await patchPlot(alice, plotId, { commentsEnabled: true });
    expect(contentsOf(await list(bob, plotId))).toEqual(['이미 있는 댓글']);
    expect(await countOf(bob, plotId)).toBe(1);
  });

  it('walks the top-level comments with the cursor', async () => {
    const cookie = await signUp('comment-cursor@example.com');
    const plotId = await publicPlot(cookie);
    const created: any[] = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(await comment(cookie, plotId, { content: `댓글 ${i}` }));
    }
    // Replies ride along with their parent and never take a slot in the page.
    await comment(cookie, plotId, { content: '대댓글', parentId: created[4].id });

    const first = await list(cookie, plotId, '?limit=2');
    expect(contentsOf(first)).toEqual(['댓글 4', '댓글 3']);
    expect(first.items[0].replies).toHaveLength(1);

    const second = await list(cookie, plotId, `?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
    expect(contentsOf(second)).toEqual(['댓글 2', '댓글 1']);

    const third = await list(cookie, plotId, `?limit=2&cursor=${encodeURIComponent(second.nextCursor)}`);
    expect(contentsOf(third)).toEqual(['댓글 0']);
    expect(third.nextCursor).toBeNull();

    // The cursor is opaque, so anything unreadable is a bad request.
    const bad = await request(cookie, `/api/plots/${plotId}/comments?cursor=not-a-cursor`);
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).code).toBe('invalid_request');

    // A cursor id is compared against a uuid column: a malformed one is refused
    // here rather than blowing up in Postgres.
    const malformed = encodeCursor({ createdAt: new Date().toISOString(), id: 'not-a-uuid' });
    const res = await request(
      cookie,
      `/api/plots/${plotId}/comments?cursor=${encodeURIComponent(malformed)}`,
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('invalid_request');
  });

  it('does not skip comments that share a millisecond across a page boundary', async () => {
    const cookie = await signUp('comment-microsecond@example.com');
    const plotId = await publicPlot(cookie);
    const older = await comment(cookie, plotId, { content: '같은 밀리초 1' });
    const newer = await comment(cookie, plotId, { content: '같은 밀리초 2' });
    // The same millisecond, microseconds apart: the serialized cursor cannot tell
    // them apart, so the boundary has to be read back from the row itself.
    await sql`update comments set created_at = ${microsecond('000200')}::timestamptz where id = ${older.id}::uuid`;
    await sql`update comments set created_at = ${microsecond('000700')}::timestamptz where id = ${newer.id}::uuid`;

    const first = await list(cookie, plotId, '?limit=1');
    expect(contentsOf(first)).toEqual(['같은 밀리초 2']);

    const second = await list(
      cookie,
      plotId,
      `?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    expect(contentsOf(second)).toEqual(['같은 밀리초 1']);
    expect(second.nextCursor).toBeNull();
  });

  it('still walks to the end when the row the cursor names is gone', async () => {
    const cookie = await signUp('comment-cursor-gone@example.com');
    const plotId = await publicPlot(cookie);
    const older = await comment(cookie, plotId, { content: '남는 댓글' });
    const newer = await comment(cookie, plotId, { content: '사라질 댓글' });
    // A millisecond apart, which is all the fallback has to work with.
    await sql`update comments set created_at = ${microsecond('001000')}::timestamptz where id = ${older.id}::uuid`;
    await sql`update comments set created_at = ${microsecond('002000')}::timestamptz where id = ${newer.id}::uuid`;

    const first = await list(cookie, plotId, '?limit=1');
    expect(contentsOf(first)).toEqual(['사라질 댓글']);

    // Nothing in the API erases a comment row, but the plot it hangs off can
    // take it with it — the cursor then falls back to the timestamp it carries.
    await sql`delete from comments where id = ${newer.id}::uuid`;
    const second = await list(
      cookie,
      plotId,
      `?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    expect(contentsOf(second)).toEqual(['남는 댓글']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('storage drivers', () => {

  /** In-memory driver that signs URLs, so the redirect branch is exercised anywhere. */
  function stubStorage(): ObjectStorage & { objects: Map<string, Uint8Array> } {
    const objects = new Map<string, Uint8Array>();
    return {
      objects,
      async put(key, bytes) {
        objects.set(key, bytes);
      },
      async get(key) {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return { body: new Blob([bytes]).stream(), size: bytes.length };
      },
      async delete(key) {
        objects.delete(key);
      },
      };
  }

  const gifBytes = (): Uint8Array => Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01]);
  async function newPlotOn(target: Hono<AppEnv>, cookie: string): Promise<any> {
    const res = await json(cookie, '/api/plots', 'POST', { name: '드라이버 작품' }, target);
    expect(res.status, await res.clone().text()).toBe(201);
    return readJson(res);
  }

  /**
   * Gives a member an avatar the only way the API offers: a card import. The card
   * rides in the PNG's text chunks and is stripped on the way into storage, so
   * what comes back out is the same PNG with no chunks at all.
   */
  async function importWithAvatar(target: Hono<AppEnv>, cookie: string): Promise<any> {
    const png = buildPngWithTextChunks({
      chara: Buffer.from(JSON.stringify(v2Card), 'utf-8').toString('base64'),
    });
    const form = new FormData();
    form.append('file', new File([png], 'lian.png', { type: 'image/png' }));
    const res = await request(cookie, '/api/plots/import', 'POST', form, target);
    expect(res.status, await res.clone().text()).toBe(201);
    return readJson(res);
  }

  async function uploadAsset(
    target: Hono<AppEnv>,
    cookie: string,
    id: string,
    bytes: Uint8Array,
  ): Promise<any> {
    const form = new FormData();
    form.append('file', new File([bytes], 'upload.bin'));
    form.append('slug', 'smile');
    const res = await request(cookie, `/api/plots/${id}/assets`, 'POST', form, target);
    expect(res.status, await res.clone().text()).toBe(201);
    return readJson(res);
  }

  /**
   * Every route, end to end, on whatever driver it is handed. `redirects` says
   * whether the driver is available.
   */
  function servesEverything(
    name: string,
    open: () => ObjectStorage,
    enabled = true,
  ): void {
    it.runIf(enabled)(`serves and deletes through the ${name} driver`, async () => {
      const storage = open();
      const target = makeApp({ storage });
      const cookie = await signUp(`driver-${name.replace(/\W+/g, '-').replace(/-+$/, '')}@example.com`);

      // --- asset: bytes, on our origin, whatever the driver can sign.
      const plot = await newPlotOn(target, cookie);
      const asset = await uploadAsset(target, cookie, plot.id, gifBytes());
      const assetRes = await request(cookie, asset.url, 'GET', undefined, target);
      expect(assetRes.status).toBe(200);
      expect(assetRes.headers.get('content-type')).toBe('image/gif');
      expect(assetRes.headers.get('content-length')).toBe(String(gifBytes().length));
      expect(new Uint8Array(await assetRes.arrayBuffer())).toEqual(gifBytes());

      // --- avatar: same rule.
      const withAvatar = await importWithAvatar(target, cookie);
      const member = withAvatar.characters[0];
      const avatarRes = await request(cookie, member.avatarUrl, 'GET', undefined, target);
      expect(avatarRes.status).toBe(200);
      expect(avatarRes.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await avatarRes.arrayBuffer())).toEqual(buildPngWithTextChunks({}));

      // --- deletion reaches the store, not just the rows.
      const [assetRow] = await db
        .select({ path: plotAssets.path })
        .from(plotAssets)
        .where(eq(plotAssets.plotId, plot.id));
      expect(assetRow!.path).toMatch(/^assets\//);
      expect(member.avatarUrl).toBeTruthy();
      const [avatarRow] = await db
        .select({ avatarPath: characters.avatarPath })
        .from(characters)
        .where(eq(characters.id, member.id));
      expect(avatarRow!.avatarPath).toMatch(/^avatars\//);

      expect((await request(cookie, `/api/plots/${plot.id}`, 'DELETE', undefined, target)).status).toBe(204);
      expect((await request(cookie, `/api/plots/${withAvatar.id}`, 'DELETE', undefined, target)).status).toBe(
        204,
      );
      expect(await storage.get(assetRow!.path)).toBeNull();
      expect(await storage.get(avatarRow!.avatarPath!)).toBeNull();


    });
  }

  servesEverything('local', () => storage);
  servesEverything('memory', () => stubStorage());
  servesEverything('s3 (RustFS)', () => s3Storage!, s3Storage !== null);

  it('serves an asset on the authenticated API origin', async () => {
    // Chat images stay on the API origin for authenticated reads.
    const target = makeApp({ storage: stubStorage() });
    const cookie = await signUp('driver-no-asset-redirect@example.com');
    const plot = await newPlotOn(target, cookie);
    const asset = await uploadAsset(target, cookie, plot.id, gifBytes());

    const res = await request(cookie, asset.url, 'GET', undefined, target);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});
