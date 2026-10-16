import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { S3Config } from './s3.js';
import type { StorageConfig } from './storage.js';

/** Repo root, three levels up from both `src/` and the built `dist/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Loads the repo-root .env into process.env (existing vars win). */
export function loadRootEnv(): void {
  config({ path: resolve(REPO_ROOT, '.env'), quiet: true });
}

/** Development defaults. A production launch must set its own secret (readConfig). */
const DEV_AUTH_SECRET = 'dev-secret-change-me';
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

interface ApiConfig {
  port: number;
  /** Where the API listens. Loopback beside the web app; `0.0.0.0` on a server of its own. */
  host: string;
  databaseUrl: string;
  /** Which object-storage driver this process runs on, decided once at boot. */
  storage: StorageConfig;
  /** Seals ChatGPT tokens at rest and derives this server's OpenAI host ID. */
  authSecret: string;
  /** The web app's origin: writes must come from it, and sign-in returns to it. */
  authUrl: string;
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
 * The storage driver, and everything it needs. Read once here rather than
 * branched on per call: `STORAGE_DRIVER` is the only switch, and an unset one
 * means the local directory this repo has always used, so a developer who
 * configures nothing sees no change.
 */
function readStorageConfig(env: NodeJS.ProcessEnv): StorageConfig {
  const driver = env['STORAGE_DRIVER'] ?? 'local';
  if (driver === 'local') {
    // Relative to the repo root, so the cwd of the launching script does not matter.
    return { driver: 'local', dir: resolve(REPO_ROOT, env['UPLOAD_DIR'] ?? './data/uploads') };
  }
  if (driver !== 's3') {
    throw new Error(`STORAGE_DRIVER must be "local" or "s3", got "${driver}"`);
  }
  if (!env['S3_BUCKET']) throw new Error('S3_BUCKET is not set, and STORAGE_DRIVER=s3 has nowhere to write');
  return { driver: 's3', ...readS3Config(env) };
}

/**
 * The S3 store `S3_*` names, whatever `STORAGE_DRIVER` says: the media driver's
 * when it is `s3`, and always where the embedder's own weights are kept
 * (`embedder:fetch`, `embedder:publish`).
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
    ...(env['S3_ACCESS_KEY_ID'] ? { accessKeyId: env['S3_ACCESS_KEY_ID'] } : {}),
    ...(env['S3_SECRET_ACCESS_KEY'] ? { secretAccessKey: env['S3_SECRET_ACCESS_KEY'] } : {}),
    forcePathStyle: readBoolean(env['S3_FORCE_PATH_STYLE']),
  };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const authSecret = env['BETTER_AUTH_SECRET'];
  // Everyone's ChatGPT tokens are sealed with it, so a deployment never runs on the default.
  if (!authSecret && env['NODE_ENV'] === 'production') throw new Error('BETTER_AUTH_SECRET must be set in production.');
  const authUrl = env['BETTER_AUTH_URL'] ?? DEV_AUTH_URL;
  if (!/^https?:$/.test(new URL(authUrl).protocol) || new URL(authUrl).origin !== authUrl) {
    throw new Error('BETTER_AUTH_URL must be the web origin, e.g. https://plot.example.com');
  }
  const callbackPort = readCallbackPort(env, authUrl);
  const logFormat = env['LOG_FORMAT']?.trim() || 'text';
  if (logFormat !== 'text' && logFormat !== 'json') throw new Error(`LOG_FORMAT must be "text" or "json", got "${logFormat}"`);
  const metricsPort = readInteger(env, 'METRICS_PORT', 1, 65535);

  return {
    port: Number(env['API_PORT'] ?? 8787),
    host: env['API_HOST'] ?? '127.0.0.1',
    databaseUrl,
    storage: readStorageConfig(env),
    authSecret: authSecret ?? DEV_AUTH_SECRET,
    authUrl,
    ...(env['API_ORIGIN'] ? { apiOrigin: new URL(env['API_ORIGIN']).origin } : {}),
    authExtraTrustedOrigins: [DEV_AUTH_URL],
    chatgptCallbackPort: callbackPort,
    logFormat,
    ...(metricsPort !== undefined ? { metricsPort } : {}),
    metricsHost: env['METRICS_HOST']?.trim() || '127.0.0.1',
    shutdownBackgroundMs: readInteger(env, 'SHUTDOWN_BACKGROUND_MS', 0, 600_000) ?? 20_000,
    env,
  };
}
