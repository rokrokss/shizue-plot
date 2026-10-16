import { serve } from '@hono/node-server';
import { createDb } from '@shizue/db';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { createChatGPTAccounts } from './chatgptAccounts.js';
import type { AppDeps } from './deps.js';
import { createLocalEmbedder } from './embedder.js';
import { createHostedAuth, createSessionStore } from './hostedAuth.js';
import { loadRootEnv, readConfig } from './env.js';
import { startJobWorker } from './jobs.js';
import { stopGenerations } from './generation.js';
import { createJobHandlers } from './notifications.js';
import { createRemoteFetch } from './localizeAssets.js';
import { probeRequestLua } from './requestLua.js';
import { createScriptFetch } from './scriptFetch.js';
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

// One set for the routes and the job worker: the memory backfill shares the
// per-chat refresh guard with the turns the reader is sending meanwhile.
const deps: AppDeps = {
  db,
  auth: createHostedAuth(sessions, accounts, fixture),
  chatgpt: { accounts, sessions },
  webOrigin: config.authUrl,
  storage: createStorage(config.storage),
  // One for the process: card scripts' requests and the per-reader rate limit they share.
  scriptFetch: createScriptFetch({ ownOrigins: [config.authUrl, ...(config.apiOrigin ? [config.apiOrigin] : [])] }),
  // What an import fetches of a card's pictures and fonts on other hosts, never this app's own.
  remoteFetch: createRemoteFetch({ ownOrigins: [config.authUrl, ...(config.apiOrigin ? [config.apiOrigin] : [])] }),
  env: config.env,
  generating: new Set<string>(),
  generationClaims: new Map(),
  generationStreams: new Set(),
  refreshingMemory: new Set<string>(),
  extractingRelationship: new Set<string>(),
  detectingEmotion: new Set<string>(),
  embeddingVectors: new Map(),
  suggesting: new Set<string>(),
  drafting: new Set<string>(),
};
// Lazy: the model loads on the first search, not here (`embedder.ts`).
const embedder = createLocalEmbedder(config.env);
if (embedder) deps.embedder = embedder;
const app = createApp(deps);
// Whether this Node can sandbox a card's editRequest Lua, asked now so the log says so at startup.
void probeRequestLua();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[api] listening on http://${config.host}:${info.port}`);
});

// Every instance polls the same queue; `for update skip locked` is what keeps them
// off each other's rows.
const stopJobWorker = startJobWorker({ db, handlers: createJobHandlers(deps) });

// A signal listener replaces node's own, which was the thing that ended the
// process — so this has to end it. Only the claiming is stopped first: a job still
// running is left where it is, and its lease expires two minutes later for the next
// instance to take over.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // No new connections; the open streams are stopped below.
    server.close();
    stopJobWorker();
    // A reply mid-stream is stopped as a disconnect stops it — kept, and its chat
    // freed — rather than cut by the exit. Five seconds is for that storing, which
    // takes well under one, never for the replies, and leaves the rest of a host's
    // grace (commonly 10–30s) to the embedder.
    void stopGenerations(deps, 5_000)
      // The embedder's thread is ended next: onnxruntime does not survive an exit around it.
      .then(() => deps.embedder?.close())
      .finally(() => process.exit(0));
  });
}
