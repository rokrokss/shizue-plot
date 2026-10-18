/**
 * What the model layer's suites share (`models.test.ts`, `credentials.test.ts`):
 * the app on an in-memory PGlite, migrated once and emptied before each test,
 * its requests made as this computer's browser or as a paired phone's, and
 * provider calls answered by a stand-in for `fetch`.
 */
import { migrateDb, openDb, session, type Db, type OpenedDb } from '@shizue/db';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { tokenCipher } from '../src/chatgptAccounts.js';
import type { AppDeps, AppEnv } from '../src/deps.js';
import { ensureOwner } from '../src/session.js';
import { createLocalStorage, type ObjectStorage } from '../src/storage.js';

export const SECRET = 'models-test-secret-models-test-secret';

/** What Tailscale Serve and then the Next rewrite send on for a phone on the tailnet. */
const FROM_TUNNEL = {
  host: 'localhost:8787',
  'x-forwarded-host': 'mac.example.ts.net:8444',
  'x-forwarded-proto': 'https',
  'x-forwarded-for': '100.101.102.103',
  'tailscale-user-login': 'owner@example.com',
};

export interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export function modelsHarness() {
  let opened: OpenedDb;
  let storage: ObjectStorage;
  /** What a test's provider stand-in answers; every call it takes is in `sent`. */
  let respond: (request: SentRequest) => Response | Promise<Response> = () => {
    throw new Error('no provider call expected');
  };
  const sent: SentRequest[] = [];

  beforeAll(async () => {
    opened = await openDb();
    await migrateDb(opened.db);
    storage = createLocalStorage(await mkdtemp(join(tmpdir(), 'shizue-models-test-')));
  });
  afterAll(async () => {
    await opened.close();
  });
  beforeEach(async () => {
    await opened.client.exec('TRUNCATE TABLE "user", verification, jobs RESTART IDENTITY CASCADE');
    sent.length = 0;
    respond = () => {
      throw new Error('no provider call expected');
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request: SentRequest = {
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      };
      sent.push(request);
      return respond(request);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const harness = {
    get db(): Db {
      return opened.db;
    },
    sent,
    /** Answers the provider calls from here on. */
    provider(handler: (request: SentRequest) => Response | Promise<Response>): void {
      respond = handler;
    },
    makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
      return {
        db: opened.db,
        storage,
        env: {},
        vault: tokenCipher(SECRET),
        generating: new Set(),
        generationStreams: new Set(),
        refreshingMemory: new Set(),
        detectingEmotion: new Set(),
        embeddingVectors: new Map(),
        suggesting: new Set(),
        remoteFetch: async () => {
          throw new Error('no network in the API tests');
        },
        // Background work a turn starts is awaited, so a test ends with nothing in flight.
        onBackgroundTask: () => {},
        ...overrides,
      };
    },
    app(overrides: Partial<AppDeps> = {}): Hono<AppEnv> {
      return createApp(harness.makeDeps(overrides));
    },
    owner: (): Promise<string> => ensureOwner(opened.db),
    /** A request from this computer's browser, `body` sent as JSON. */
    async call(target: Hono<AppEnv>, method: string, path: string, body?: unknown): Promise<Response> {
      return target.request(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    /** A paired phone's session cookie, as a claimed pairing code leaves it. */
    async phone(): Promise<string> {
      const token = randomBytes(32).toString('base64url');
      await opened.db.insert(session).values({
        id: `paired:${randomUUID()}`,
        token: createHash('sha256').update(token).digest('hex'),
        userId: await ensureOwner(opened.db),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
      return `shizue_session=${token}`;
    },
    /** A request from a paired phone, through the tunnel. */
    async fromPhone(target: Hono<AppEnv>, cookie: string, method: string, path: string, body?: unknown): Promise<Response> {
      return target.request(
        path,
        {
          method,
          headers: { ...FROM_TUNNEL, cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      );
    },
  };
  return harness;
}

export async function readJson(res: Response): Promise<any> {
  return res.json();
}

export interface SseEvent {
  event: string;
  data: any;
}

export async function readSse(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event: SseEvent = { event: 'message', data: undefined };
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event.event = line.slice(6).trim();
        else if (line.startsWith('data:')) event.data = JSON.parse(line.slice(5).trim());
      }
      return event;
    });
}

/** An SSE body as a provider streams it. */
export const sseBody = (events: unknown[]): Response =>
  new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

/** A Chat Completions stream that answers `text`, with `reasoning` before it. */
export const chatCompletion = (text: string, reasoning?: string): Response =>
  sseBody([
    ...(reasoning ? [{ choices: [{ delta: { reasoning_content: reasoning } }] }] : []),
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    '[DONE]',
  ]);
