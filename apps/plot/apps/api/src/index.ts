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
import { STOP_CHANNEL, stopGenerations, stopLocalGeneration } from './generation.js';
import { createBackgroundTasks, onUnhandledRejection } from './lifecycle.js';
import { installJsonConsole } from './log.js';
import { luaSandboxEnabled, startMetricsServer } from './metrics.js';
import { createJobHandlers } from './notifications.js';
import { createRemoteFetch } from './localizeAssets.js';
import { probeRequestLua } from './requestLua.js';
import { createScriptFetch } from './scriptFetch.js';
import { createStorage } from './storage.js';
import { fakeChatGPTOAuth } from './testOpenAI.js';

loadRootEnv();
const config = readConfig();
// Before anything else is said: the embedder and the Lua probe speak at startup.
if (config.logFormat === 'json') installJsonConsole();

const { db, sql } = createDb(config.databaseUrl);
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

// The background tasks the turns start, kept until they settle so a shutdown can wait for them.
const background = createBackgroundTasks();
// One set for the routes and the job worker: the memory backfill shares the
// per-chat refresh guard with the turns the reader is sending meanwhile.
const deps: AppDeps = {
  db,
  auth: createHostedAuth(sessions, accounts, fixture),
  chatgpt: { accounts, sessions },
  webOrigin: config.authUrl,
  storage: createStorage(config.storage),
  // One for the process: card scripts' requests, their in-flight cap, and the per-reader rate limit in `rate_limits`.
  scriptFetch: createScriptFetch({ db, ownOrigins: [config.authUrl, ...(config.apiOrigin ? [config.apiOrigin] : [])] }),
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
  onBackgroundTask: background.track,
  // The reader's stop for a reply another instance is streaming (`stopChatGeneration`).
  stopSignal: {
    publish: async (chatId) => {
      await sql.notify(STOP_CHANNEL, chatId);
    },
  },
};
// Every instance hears every stop and stops its own stream of that chat, if it has one.
// postgres.js keeps this on a connection of its own and listens again after a reconnect.
sql.listen(STOP_CHANNEL, (chatId) => stopLocalGeneration(deps, chatId)).catch((error: unknown) => {
  console.error('[api] not listening for stops relayed from other instances', error);
});
// Lazy: the model loads on the first search, not here (`embedder.ts`).
const embedder = createLocalEmbedder(config.env);
if (embedder) deps.embedder = embedder;
const app = createApp(deps);
// Whether this Node can sandbox a card's editRequest Lua, asked now so the log says so at startup.
void probeRequestLua().then((enabled) => luaSandboxEnabled.set(enabled ? 1 : 0));

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[api] listening on http://${config.host}:${info.port}`);
});

// Every instance polls the same queue; `for update skip locked` is what keeps them
// off each other's rows.
const stopJobWorker = startJobWorker({ db, handlers: createJobHandlers(deps) });

// Off unless METRICS_PORT is set, and never on the API's own port (`metrics.ts`).
const metricsServer =
  config.metricsPort === undefined
    ? undefined
    : startMetricsServer(deps, background, { port: config.metricsPort, host: config.metricsHost });

let exitCode = 0;
let stopping = false;

/**
 * The one way this process ends, whatever asks — a signal, an exception nothing
 * caught — and once: a later ask only raises the exit code. Ordered so nothing
 * that can be kept is cut (ARCHITECTURE §12).
 */
function shutdown(code: number): void {
  if (code !== 0) exitCode = code;
  if (stopping) return;
  stopping = true;
  void (async () => {
    // `/api/ready` answers 503 from here on, for a balancer to stop sending readers.
    deps.draining = true;
    // No new connections; the open streams are stopped below.
    server.close();
    metricsServer?.close();
    // Only the claiming is stopped: a job still running is left where it is, and
    // its lease expires two minutes later for the next instance to take over.
    stopJobWorker();
    // A reply mid-stream is stopped as the reader's stop stops it — kept, and its
    // chat freed — rather than cut by the exit. Five seconds is for that storing,
    // which takes well under one, never for the replies.
    await stopGenerations(deps, 5_000);
    // What the turns started — a summary, a relationship, vectors, and those the
    // stopped replies just started — is let finish rather than cut, up to its own
    // deadline (`SHUTDOWN_BACKGROUND_MS`).
    const left = await background.drain(config.shutdownBackgroundMs);
    if (left > 0) {
      const kinds = [...background.inFlight()].map(([kind, count]) => `${kind} ${count}`).join(', ');
      console.warn(`[api] ${left} background tasks still running after ${config.shutdownBackgroundMs} ms (${kinds}); exiting without them`);
    }
    // The embedder's thread last, after everything that may embed: onnxruntime
    // does not survive an exit around it.
    await deps.embedder?.close();
  })()
    .catch((error: unknown) => console.error('[api] shutdown failed', error))
    .finally(() => process.exit(exitCode));
}

// A signal listener replaces node's own, which was the thing that ended the
// process — so `shutdown` has to end it. Once: a second Ctrl-C finds node's own
// again, and ends a shutdown that hangs.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown(0));
// Logged, and the process goes on (`onUnhandledRejection`).
process.on('unhandledRejection', onUnhandledRejection);
// An exception nothing caught leaves the process in a state nobody planned: it
// is logged, and the process ends the way a signal ends it, exiting 1.
process.on('uncaughtException', (error) => {
  console.error('[api] uncaught exception; shutting down', error);
  shutdown(1);
});
