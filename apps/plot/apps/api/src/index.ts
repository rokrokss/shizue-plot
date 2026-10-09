import { serve } from '@hono/node-server';
import { createDb } from '@shizue/db';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { createChatGPTAccounts } from './chatgptAccounts.js';
import { createHostedAuth, createSessionStore } from './hostedAuth.js';
import { loadRootEnv, readConfig } from './env.js';
import { startJobWorker } from './jobs.js';
import { createJobHandlers } from './notifications.js';
import { createStorage } from './storage.js';
import { fakeChatGPTOAuth } from './testOpenAI.js';

loadRootEnv();
const config = readConfig();

const { db } = createDb(config.databaseUrl);
const testing = config.env['NODE_ENV'] === 'test';
const accounts = createChatGPTAccounts(db, {
  secret: config.authSecret,
  callbackPort: config.chatgptCallbackPort,
  ...(testing && config.env['CHATGPT_FAKE_OPENAI'] === '1' ? { oauth: fakeChatGPTOAuth() } : {}),
});
const sessions = createSessionStore(db, { secure: new URL(config.authUrl).protocol === 'https:' });
// The email/password fixture makes many test users; it never exists outside NODE_ENV=test.
const fixture = testing ? createAuth(db, {
  secret: config.authSecret,
  baseUrl: config.authUrl,
  extraTrustedOrigins: config.authExtraTrustedOrigins,
}) : undefined;

const app = createApp({
  db,
  auth: createHostedAuth(sessions, accounts, fixture),
  chatgpt: { accounts, sessions },
  webOrigin: config.authUrl,
  storage: createStorage(config.storage),
  env: config.env,
  generating: new Set<string>(),
  generationClaims: new Map(),
  refreshingMemory: new Set<string>(),
  extractingRelationship: new Set<string>(),
  suggesting: new Set<string>(),
  drafting: new Set<string>(),
});

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[api] listening on http://${config.host}:${info.port}`);
});

// Every instance polls the same queue; `for update skip locked` is what keeps them
// off each other's rows.
const stopJobWorker = startJobWorker({ db, handlers: createJobHandlers() });

// A signal listener replaces node's own, which was the thing that ended the
// process — so this has to end it. Only the claiming is stopped first: a job still
// running is left where it is, and its lease expires two minutes later for the next
// instance to take over.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopJobWorker();
    process.exit(0);
  });
}
