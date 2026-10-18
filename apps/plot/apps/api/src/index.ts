import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { DataDirBusy, openAppDb } from './appDb.js';
import { createChatGPTAccounts } from './chatgptAccounts.js';
import type { AppDeps } from './deps.js';
import { createLocalEmbedder } from './embedder.js';
import { isLoopback, loadRootEnv, readConfig, readOrCreateSecret } from './env.js';
import { createPhoneAccess } from './tunnel.js';
import { startJobWorker } from './jobs.js';
import { stopGenerations } from './generation.js';
import { createJobHandlers } from './jobHandlers.js';
import { createBackgroundTasks, onUnhandledRejection } from './lifecycle.js';
import { createRemoteFetch } from './localizeAssets.js';
import { probeRequestLua } from './requestLua.js';
import { createScriptFetch } from './scriptFetch.js';
import { createStorage } from './storage.js';
import { fakeChatGPTOAuth } from './testOpenAI.js';

loadRootEnv();
const config = readConfig();

// The one handle on the app's database (PGlite in the app's folder, locked to this
// process), brought to the newest migration before anything reads it.
const { db, close: closeDb } = await openAppDb(config.dataDir).catch((error: unknown) => {
  if (!(error instanceof DataDirBusy)) throw error;
  console.error(`[api] ${error.message}`);
  process.exit(1);
});
const secret = config.authSecret ?? readOrCreateSecret(config.dataDir);
const testing = config.env['NODE_ENV'] === 'test';
const accounts = createChatGPTAccounts(db, {
  secret,
  callbackPort: config.chatgptCallbackPort,
  ...(testing && config.env['CHATGPT_FAKE_OPENAI'] === '1' ? { oauth: fakeChatGPTOAuth() } : {}),
});

// The background tasks the turns start, kept until they settle so a shutdown can wait for them.
const background = createBackgroundTasks();
// A phone's tunnel to this machine, opened from the settings page, for a web origin on loopback.
const phoneAccess = isLoopback(config.authUrl) ? createPhoneAccess({ webUrl: config.authUrl }) : undefined;
// Tailscale Serve outlives the API: an address opened before a restart is trusted again from the start.
void phoneAccess?.status().catch(() => undefined);
// This app at every origin it answers: card scripts' requests and an import's fetches never go there.
const ownOrigins = (): string[] => [
  config.authUrl,
  ...config.remoteOrigins,
  ...(phoneAccess?.origin() ? [phoneAccess.origin()!] : []),
  ...(config.apiOrigin ? [config.apiOrigin] : []),
];

// One set for the routes and the job worker: the memory backfill shares the
// per-chat refresh guard with the turns the reader is sending meanwhile.
const deps: AppDeps = {
  db,
  chatgpt: { accounts },
  webOrigin: config.authUrl,
  remoteOrigins: config.remoteOrigins,
  ...(phoneAccess ? { phoneAccess } : {}),
  storage: createStorage(config.storage),
  // One for the process: card scripts' requests, their in-flight cap and RisuAI's rate limit.
  scriptFetch: createScriptFetch({ ownOrigins }),
  // What an import fetches of a card's pictures and fonts on other hosts, never this app's own.
  remoteFetch: createRemoteFetch({ ownOrigins }),
  env: config.env,
  generating: new Set<string>(),
  generationStreams: new Set(),
  refreshingMemory: new Set<string>(),
  detectingEmotion: new Set<string>(),
  embeddingVectors: new Map(),
  suggesting: new Set<string>(),
  onBackgroundTask: background.track,
};
// Lazy: the model loads on the first search, not here (`embedder.ts`).
const embedder = createLocalEmbedder(config.env);
if (embedder) deps.embedder = embedder;
const app = createApp(deps);
// Whether this Node can sandbox a card's editRequest Lua, asked now so the log says so at startup.
void probeRequestLua();

const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  console.log(`[api] listening on http://127.0.0.1:${info.port}`);
});

// File imports run for minutes, so they have a loop of their own — one import
// read at a time — and the main loop (a chat import's memory backfill) leaves
// them alone.
const handlers = createJobHandlers(deps);
const jobWorkers = [
  startJobWorker({ db, handlers, kinds: { except: ['file_import'] } }),
  startJobWorker({ db, handlers, kinds: { only: ['file_import'] } }),
];
const stopJobWorker = (): void => {
  for (const stop of jobWorkers) stop();
};

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
    // No new connections; the open streams are stopped below.
    server.close();
    // A Cloudflare tunnel ends with the process; a Tailscale one is Tailscale's to keep.
    phoneAccess?.shutdown();
    // Only the claiming is stopped: a job still running is left where it is, and
    // its lease expires two minutes after for the next start to take over.
    stopJobWorker();
    // A reply mid-stream is stopped as the reader's stop stops it — kept, and its
    // chat freed — rather than cut by the exit. Five seconds is for that storing,
    // which takes well under one, never for the replies.
    await stopGenerations(deps, 5_000);
    // What the turns started — a summary, vectors, and those the
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
    // The database last of all, once nothing writes: PGlite flushes its files on close.
    await closeDb();
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
