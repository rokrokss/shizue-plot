import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
/** The loopback port the companion extension's development rule catches (apps/extension). */
const DEV_CALLBACK_PORT = 47801;

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
  /** Additional origins for the NODE_ENV=test email/password fixture. */
  authExtraTrustedOrigins: string[];
  /**
   * The port of OpenAI's `http://127.0.0.1:<port>/auth/callback` redirect. The
   * companion extension rewrites that address to this app, one port per origin.
   */
  chatgptCallbackPort: number;
  env: NodeJS.ProcessEnv;
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
  const bucket = env['S3_BUCKET'];
  if (!bucket) throw new Error('S3_BUCKET is not set, and STORAGE_DRIVER=s3 has nowhere to write');
  return {
    driver: 's3',
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
  const callbackPort = Number(env['CHATGPT_CALLBACK_PORT'] ?? DEV_CALLBACK_PORT);
  if (!Number.isInteger(callbackPort) || callbackPort < 1024 || callbackPort > 65535) {
    throw new Error('CHATGPT_CALLBACK_PORT must be a port number from 1024 to 65535.');
  }

  return {
    port: Number(env['API_PORT'] ?? 8787),
    host: env['API_HOST'] ?? '127.0.0.1',
    databaseUrl,
    storage: readStorageConfig(env),
    authSecret: authSecret ?? DEV_AUTH_SECRET,
    authUrl,
    authExtraTrustedOrigins: [DEV_AUTH_URL],
    chatgptCallbackPort: callbackPort,
    env,
  };
}
