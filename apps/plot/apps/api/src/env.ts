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

/** Loads the repo-root .env into process.env (existing vars win). */
export function loadRootEnv(): void {
  config({ path: resolve(REPO_ROOT, '.env'), quiet: true });
}

/** The shortest secret a deployment takes: 32 characters, what `openssl rand -base64 32` prints is 44. */
const MIN_AUTH_SECRET_CHARS = 32;
const DEV_AUTH_URL = 'http://localhost:13000';
/** The loopback port Shizue's development rule catches, for an origin it does not know. */
const DEV_CALLBACK_PORT = 47801;

/**
 * The loopback port each web origin's sign-in comes back on in Shizue, the Chrome
 * Web Store extension readers install (`src/public/plot-signin-rules.json` in
 * rokrokss/shizue). Shizue sends each port to one origin and nowhere else, so an
 * origin asking OpenAI for another port has its readers sent to the wrong place —
 * 47801 is the development rule, and lands on `http://localhost:13000` on the
 * reader's own machine. Changing an entry here means releasing Shizue too.
 */
const SHIZUE_CALLBACK_PORTS: Readonly<Record<string, number>> = {
  'https://plot.shizue.net': 47811,
  'http://localhost:13000': 47801,
};

/**
 * The loopback port to ask OpenAI for. A known origin needs no setting: its port
 * is Shizue's. In production a setting that disagrees with Shizue is refused at
 * boot rather than discovered at the first reader's sign-in — a known origin on
 * another port, another origin on a port Shizue sends elsewhere, or another
 * origin with no port at all. Development takes any port, for offset dev servers
 * and the browser tests' stand-in for Shizue (apps/e2e/shizueStandIn.ts).
 */
function readCallbackPort(env: NodeJS.ProcessEnv, authUrl: string): number {
  const shizuePort = SHIZUE_CALLBACK_PORTS[authUrl];
  const production = env['NODE_ENV'] === 'production';
  const raw = env['CHATGPT_CALLBACK_PORT']?.trim();
  if (!raw) {
    if (shizuePort !== undefined) return shizuePort;
    if (production) {
      throw new Error(
        `CHATGPT_CALLBACK_PORT must be set for ${authUrl}: Shizue carries the sign-in only for ${Object.keys(SHIZUE_CALLBACK_PORTS).join(' and ')}, so another origin needs an extension of its own and the port it catches.`,
      );
    }
    return DEV_CALLBACK_PORT;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('CHATGPT_CALLBACK_PORT must be a port number from 1024 to 65535.');
  }
  if (production && shizuePort !== undefined && port !== shizuePort) {
    throw new Error(
      `CHATGPT_CALLBACK_PORT=${port} would send ${authUrl}'s sign-in elsewhere: Shizue brings it back on ${shizuePort}.`,
    );
  }
  const owner = Object.entries(SHIZUE_CALLBACK_PORTS).find(([origin, shizue]) => shizue === port && origin !== authUrl);
  if (production && owner) {
    throw new Error(
      `CHATGPT_CALLBACK_PORT=${port} is Shizue's port for ${owner[0]}: readers with Shizue would be sent there instead of ${authUrl}.`,
    );
  }
  return port;
}

/** Whether a web origin is this machine's own — a shizue the reader runs, not a deployment. */
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
 * The sign-in origin itself is dropped, so the list is only the others. It is
 * for a shizue running on the reader's own machine — signing in on loopback —
 * and is refused anywhere else: the hosted app has no phone pairing.
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
  port: number;
  /** Where the API listens. Loopback beside the web app; `0.0.0.0` on a server of its own. */
  host: string;
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
  /** The web app's origin: writes must come from it, and sign-in returns to it. */
  authUrl: string;
  /**
   * Other origins the same web app is reached at — a tunnel to this machine, for
   * a phone (`REMOTE_ORIGINS`), and only on this machine. Writes may come from them
   * too, but sign-in still returns to `authUrl`: a phone joins by pairing
   * (`routes/devices.ts`), which exists only while this list does.
   */
  remoteOrigins: string[];
  /**
   * The API's own origin when it is served apart from the web app — the web's
   * `API_ORIGIN`, read here when the two share an environment. Card scripts'
   * requests are refused there, as at the web origin.
   */
  apiOrigin?: string;
  /** Additional origins for the NODE_ENV=test email/password fixture. */
  authExtraTrustedOrigins: string[];
  /**
   * The port of OpenAI's `http://127.0.0.1:<port>/auth/callback` redirect. The
   * companion extension rewrites that address to this app, one port per origin.
   */
  chatgptCallbackPort: number;
  /** `text` keeps the console as it reads in a terminal; `json` makes every line one JSON object (`log.ts`). */
  logFormat: LogFormat;
  /** Prometheus text on a listener of its own (`metrics.ts`), never under `/api`; unset is off. */
  metricsPort?: number;
  metricsHost: string;
  /** How long a shutdown waits for in-flight background tasks (`lifecycle.ts`). */
  shutdownBackgroundMs: number;
  /**
   * File imports this process reads at once (`fileImports.ts`), each on a job
   * loop of its own: what bounds the memory imports take, at a few parts and a
   * card's text each.
   */
  importWorkers: number;
  env: NodeJS.ProcessEnv;
}

type LogFormat = 'text' | 'json';

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
  const authUrl = env['BETTER_AUTH_URL'] ?? DEV_AUTH_URL;
  if (!/^https?:$/.test(new URL(authUrl).protocol) || new URL(authUrl).origin !== authUrl) {
    throw new Error('BETTER_AUTH_URL must be the web origin, e.g. https://plot.example.com');
  }
  // The ChatGPT tokens are sealed with it, so a deployment never runs on a
  // guessable one. Unset, every install has its own (`readOrCreateSecret`); only a
  // short one set by hand is refused. A deployment is a production run, or any run
  // whose web origin is not this machine's — `node dist/index.js` sets no NODE_ENV.
  const deployed = env['NODE_ENV'] === 'production' || !isLoopback(authUrl);
  if (deployed && authSecret !== undefined && authSecret.length < MIN_AUTH_SECRET_CHARS) {
    throw new Error(`BETTER_AUTH_SECRET must be at least ${MIN_AUTH_SECRET_CHARS} characters to serve ${authUrl} (e.g. openssl rand -base64 32), or unset for this install's own.`);
  }
  const callbackPort = readCallbackPort(env, authUrl);
  const logFormat = env['LOG_FORMAT']?.trim() || 'text';
  if (logFormat !== 'text' && logFormat !== 'json') throw new Error(`LOG_FORMAT must be "text" or "json", got "${logFormat}"`);
  const metricsPort = readInteger(env, 'METRICS_PORT', 1, 65535);
  const remoteOrigins = readRemoteOrigins(env, authUrl);

  return {
    port: Number(env['API_PORT'] ?? 8787),
    host: env['API_HOST'] ?? '127.0.0.1',
    dataDir,
    storage: { driver: 'local', dir: filesDirOf(dataDir) },
    ...(authSecret ? { authSecret } : {}),
    authUrl,
    remoteOrigins,
    ...(env['API_ORIGIN'] ? { apiOrigin: new URL(env['API_ORIGIN']).origin } : {}),
    authExtraTrustedOrigins: [DEV_AUTH_URL],
    chatgptCallbackPort: callbackPort,
    logFormat,
    ...(metricsPort !== undefined ? { metricsPort } : {}),
    metricsHost: env['METRICS_HOST']?.trim() || '127.0.0.1',
    shutdownBackgroundMs: readInteger(env, 'SHUTDOWN_BACKGROUND_MS', 0, 600_000) ?? 20_000,
    importWorkers: readInteger(env, 'IMPORT_WORKERS', 1, 16) ?? 2,
    env,
  };
}
