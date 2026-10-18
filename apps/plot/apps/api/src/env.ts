import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from 'dotenv';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { S3Config } from './s3.js';
import type { StorageConfig } from './storage.js';

/** Repo root, three levels up from both `src/` and the built `dist/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The app's own folder (`SHIZUE_DATA_DIR`): its database, its files and its
 * secret, everything that is the reader's. Development keeps it under
 * `apps/plot/data/app`; the published app points it at the OS's app-data folder.
 */
export const dataDirOf = (env: NodeJS.ProcessEnv): string =>
  resolve(REPO_ROOT, env['SHIZUE_DATA_DIR']?.trim() || './data/app');

/** Where PGlite keeps the database inside the app's folder. */
export const dbDirOf = (dataDir: string): string => join(dataDir, 'db');

/** Where the files are kept inside the app's folder: avatars, assets, attachments, imports. */
export const filesDirOf = (dataDir: string): string => join(dataDir, 'files');

/**
 * This install's secret, `secret` in the app's folder: made once, readable by
 * its owner only, and read back on every start. It seals the ChatGPT tokens at
 * rest and derives this install's OpenAI host ID, so it never changes once made.
 */
export function readOrCreateSecret(dataDir: string): string {
  const path = join(dataDir, 'secret');
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('base64');
  // `wx`: a second process starting at the same moment fails here rather than writing another.
  writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: 'wx' });
  return secret;
}

/**
 * Loads the repo-root .env into process.env (existing vars win) — in a checkout
 * only: the published app (`shizue-plot`, whose command sets `SHIZUE_PACKAGED`)
 * takes its settings from its command line and the environment, never from a
 * file beside wherever npm put it.
 */
export function loadRootEnv(): void {
  if (process.env['SHIZUE_PACKAGED'] === '1') return;
  config({ path: resolve(REPO_ROOT, '.env'), quiet: true });
}

/**
 * The port the app answers on, the API and the web app both: the one the
 * Shizue extension sends ChatGPT's sign-in back to (`http://localhost:13000`).
 */
export const APP_PORT = 13000;
/**
 * The loopback port OpenAI's callback comes back on: the one Shizue, the Chrome
 * Web Store extension, sends on to `http://localhost:13000` on this computer
 * (`src/public/plot-signin-rules.json` in rokrokss/shizue).
 */
export const SHIZUE_CALLBACK_PORT = 47801;

/**
 * The loopback port to ask OpenAI for: Shizue's unless `CHATGPT_CALLBACK_PORT`
 * names another, for offset dev servers and the browser tests' stand-in for
 * Shizue (apps/e2e/shizueStandIn.ts), whose rules send it to their own origin.
 */
function readCallbackPort(env: NodeJS.ProcessEnv): number {
  const raw = env['CHATGPT_CALLBACK_PORT']?.trim();
  if (!raw) return SHIZUE_CALLBACK_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('CHATGPT_CALLBACK_PORT must be a port number from 1024 to 65535.');
  }
  return port;
}

/** Whether a web origin is this machine's own — a loopback one. */
export const isLoopback = (origin: string): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);

/** Whether `value` is an http(s) origin and nothing more — no path, no user. */
function isWebOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}

/**
 * `REMOTE_ORIGINS`: comma-separated origins, each as `BETTER_AUTH_URL` is written.
 * The web origin itself is dropped, so the list is only the others. It is for
 * a shizue whose web origin is this machine's — a loopback one — and is refused
 * anywhere else.
 */
function readRemoteOrigins(env: NodeJS.ProcessEnv, authUrl: string): string[] {
  const listed = (env['REMOTE_ORIGINS'] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const wrong = listed.find((value) => !isWebOrigin(value));
  if (wrong !== undefined) {
    throw new Error(`REMOTE_ORIGINS must list web origins, e.g. https://my-mac.example.ts.net:8443 — got "${wrong}".`);
  }
  if (listed.length > 0 && !isLoopback(authUrl)) {
    throw new Error(`REMOTE_ORIGINS is only for a shizue running on this machine, whose BETTER_AUTH_URL is a loopback origin such as http://localhost:13000 — not ${authUrl}.`);
  }
  return [...new Set(listed)].filter((value) => value !== authUrl);
}

interface ApiConfig {
  /** `SHIZUE_PORT`, `APP_PORT` unless set: where the one process answers, on both loopbacks (`server.ts`). */
  port: number;
  /**
   * The web app the process serves beside the API (`SHIZUE_WEB_DIR`): its sources
   * under `next dev`, its production build in the published package.
   */
  webDir: string;
  /** The app's own folder (`dataDirOf`): the database, the files and the secret. */
  dataDir: string;
  /** Where the files are kept: the local directory in the app's folder. */
  storage: StorageConfig;
  /**
   * Seals ChatGPT tokens at rest and derives this server's OpenAI host ID:
   * `BETTER_AUTH_SECRET` when set, else this install's own (`readOrCreateSecret`),
   * which the entry point reads so that reading the config writes nothing.
   */
  authSecret?: string;
  /** The web app's origin: writes must come from it, and the ChatGPT connection returns to it. */
  authUrl: string;
  /**
   * Other origins the same web app is reached at — a tunnel to this machine, for
   * a phone (`REMOTE_ORIGINS`), and only on this machine. Writes may come from them
   * too, but the ChatGPT connection still returns to `authUrl`: a phone joins by
   * pairing (`routes/devices.ts`).
   */
  remoteOrigins: string[];
  /**
   * The port of OpenAI's `http://127.0.0.1:<port>/auth/callback` redirect. The
   * Shizue extension rewrites that address to this app.
   */
  chatgptCallbackPort: number;
  /** How long a shutdown waits for in-flight background tasks (`lifecycle.ts`). */
  shutdownBackgroundMs: number;
  env: NodeJS.ProcessEnv;
}

/** A whole number from `min` to `max`, or the error naming `name`. */
export function readInteger(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
}

/** `true`/`1` and nothing else; an unset switch is off. */
const readBoolean = (value: string | undefined): boolean => value === 'true' || value === '1';

/**
 * The S3 store `S3_*` names, where the embedder's own weights are kept
 * (`embedder:fetch`, `embedder:publish`). The app's files are never there: they
 * are in the app's folder.
 */
export function readS3Config(env: NodeJS.ProcessEnv): S3Config {
  const bucket = env['S3_BUCKET'];
  if (!bucket) throw new Error('S3_BUCKET is not set');
  return {
    bucket,
    // Every S3-compatible store wants a region in the signature; a local one ignores
    // which one, so the AWS default is as good a name as any.
    region: env['S3_REGION'] ?? 'us-east-1',
    ...(env['S3_ENDPOINT'] ? { endpoint: env['S3_ENDPOINT'] } : {}),
    ...(env['S3_PUBLIC_ENDPOINT'] ? { publicEndpoint: env['S3_PUBLIC_ENDPOINT'] } : {}),
    ...(env['S3_ACCESS_KEY_ID'] ? { accessKeyId: env['S3_ACCESS_KEY_ID'] } : {}),
    ...(env['S3_SECRET_ACCESS_KEY'] ? { secretAccessKey: env['S3_SECRET_ACCESS_KEY'] } : {}),
    forcePathStyle: readBoolean(env['S3_FORCE_PATH_STYLE']),
  };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const dataDir = dataDirOf(env);
  const authSecret = env['BETTER_AUTH_SECRET'];
  const port = readInteger(env, 'SHIZUE_PORT', 1, 65_535) ?? APP_PORT;
  const authUrl = env['BETTER_AUTH_URL'] ?? `http://localhost:${port}`;
  if (!/^https?:$/.test(new URL(authUrl).protocol) || new URL(authUrl).origin !== authUrl) {
    throw new Error('BETTER_AUTH_URL must be the web origin, e.g. http://localhost:13000');
  }
  // On this computer the web origin is the app's own port, which one process answers.
  const web = new URL(authUrl);
  if (isLoopback(authUrl) && Number(web.port || (web.protocol === 'https:' ? 443 : 80)) !== port) {
    throw new Error(`BETTER_AUTH_URL is ${authUrl}, but the app answers on port ${port} (SHIZUE_PORT): leave it unset, or give the two the same port.`);
  }
  const callbackPort = readCallbackPort(env);
  const remoteOrigins = readRemoteOrigins(env, authUrl);

  return {
    port,
    webDir: resolve(REPO_ROOT, env['SHIZUE_WEB_DIR']?.trim() || './apps/web'),
    dataDir,
    storage: { driver: 'local', dir: filesDirOf(dataDir) },
    ...(authSecret ? { authSecret } : {}),
    authUrl,
    remoteOrigins,
    chatgptCallbackPort: callbackPort,
    shutdownBackgroundMs: readInteger(env, 'SHUTDOWN_BACKGROUND_MS', 0, 600_000) ?? 20_000,
    env,
  };
}
