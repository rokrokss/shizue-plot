import { createServer } from 'node:http';
import { createApp } from './app.js';
import { DataDirBusy, openAppDb } from './appDb.js';
import { createChatGPTAccounts, tokenCipher } from './chatgptAccounts.js';
import type { AppDeps } from './deps.js';
import { createLocalEmbedder } from './embedder.js';
import { APP_PORT, isLoopback, loadRootEnv, readConfig, readOrCreateSecret, SHIZUE_CALLBACK_PORT } from './env.js';
import { appRequestListener, listenOnLoopback, loadWebApp, PortTaken, portTaken } from './server.js';
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
// The API's own copy of the environment, taken before Next is loaded. Next runs
// `next dev` as `development` only (under `test` it keeps stale page paths and
// writes its route types elsewhere), so a test run — `NODE_ENV=test`, which gives
// the API the echo model and the stand-in OpenAI (§4) — tells Next `development`
// while the API reads `test` from this copy.
const apiEnv = { ...process.env };
if (process.env['NODE_ENV'] === 'test') process.env['NODE_ENV'] = 'development';
const config = readConfig(apiEnv);
// The web origin next.config.ts reads, which lets a phone in only from a loopback
// one, when it is the default `readConfig` made rather than one set.
process.env['BETTER_AUTH_URL'] ??= config.authUrl;

function portInUse(): never {
  console.error(
    `[shizue] Port ${config.port} is already in use on this computer. Is shizue already running? ` +
      `Stop what holds it, or start shizue on another port (\`shizue-plot --port <n>\`, or SHIZUE_PORT) — ` +
      `though ChatGPT sign-in comes back to port ${APP_PORT} only.`,
  );
  process.exit(1);
}
// Asked first, before the folder is opened and the web app compiled for nothing.
if (await portTaken(config.port)) portInUse();

// The one handle on the app's database (PGlite in the app's folder, locked to this
// process), brought to the newest migration before anything reads it.
const { db, client, close: closeDb } = await openAppDb(config.dataDir).catch((error: unknown) => {
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
];

// One set for the routes and the job worker: the memory backfill shares the
// per-chat refresh guard with the turns the reader is sending meanwhile.
const deps: AppDeps = {
  db,
  chatgpt: { accounts },
  // The API keys' seal, the same as the ChatGPT tokens' (§7.1).
  vault: tokenCipher(secret),
  webOrigin: config.authUrl,
  remoteOrigins: config.remoteOrigins,
  ...(phoneAccess ? { phoneAccess } : {}),
  storage: createStorage(config.storage),
  // The folder a backup is made of and a restore is put beside (`backup.ts`).
  appFolder: { dataDir: config.dataDir, filesDir: config.storage.dir, client },
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

// One process, one port: the API at /api/*, and the web app for everything else —
// Next in this process, `next dev` on its sources or, in production, its build (`server.ts`).
const server = createServer();
const web = await loadWebApp({ dir: config.webDir, dev: config.env['NODE_ENV'] !== 'production', port: config.port, server });
server.on('request', appRequestListener(app.fetch, web));
let closeServer = (): void => undefined;
try {
  closeServer = await listenOnLoopback(server, config.port);
} catch (error) {
  if (!(error instanceof PortTaken)) throw error;
  await web.close();
  await closeDb();
  portInUse();
}
console.log(`[shizue] running at ${config.authUrl} — Ctrl-C to stop`);
// The memory model's weights, when they are not here yet: downloaded now, in the
// background, while the app serves (`embedder.ts`). The shutdown stops it.
embedder?.downloadMissing();
if (config.port !== APP_PORT && config.chatgptCallbackPort === SHIZUE_CALLBACK_PORT) {
  console.warn(
    `[shizue] The Shizue extension brings ChatGPT's sign-in back to http://localhost:${APP_PORT}, so on port ${config.port} ` +
      'connecting ChatGPT will not come back; models on an API key work as ever.',
  );
}

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
    closeServer();
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
    // The web app's compiler and watchers, under `next dev`.
    await web.close();
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
