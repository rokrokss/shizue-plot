import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { STAND_IN_ID } from './shizueStandIn.js';

// Overridable so a containerized run (e.g. generating another platform's visual
// baselines) can point at the host's dev stack instead of its own localhost.
const WEB_URL = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:8787';

/**
 * The database the suite's API runs on: the scratch `TEST_DATABASE_URL`, from the
 * shell or else `apps/plot/.env`. Left alone the API would load that file's
 * `DATABASE_URL` — the dev database the owner tests on — and every run would
 * leave its accounts and plots in their catalogue. The `_test` name is the mark
 * the API suite asks for too, and that suite truncates this database on every
 * test, so the two must not run at the same time.
 */
function scratchDatabaseUrl(): string {
  let url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    try {
      url = parseEnv(readFileSync(new URL('../../.env', import.meta.url), 'utf8'))['TEST_DATABASE_URL'];
    } catch {
      // No .env to read: the error below says what to set.
    }
  }
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set: the browser suite runs on the scratch database (README §Testing).');
  }
  // Only the name is quoted back: the URL carries credentials.
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL names database "${name}", which is not a scratch one ending in \`_test\`.`);
  }
  return url;
}

/**
 * Smoke suite against the real stack (docker Postgres + Hono API + Next).
 *
 * The web server runs `next dev` rather than a production build: the message
 * catalogs (`apps/web/messages/*.json`) are then read from disk on demand, so a
 * catalog edit does not need a rebuild before the locale assertions see it.
 * First-hit route compilation is slow, hence the generous timeouts below.
 *
 * The API migrates the scratch database and runs on it. The suite writes there
 * with a unique account per run and never truncates anything itself.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env['CI']),
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: WEB_URL,
    locale: 'ko-KR',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @shizue/db db:migrate && pnpm --filter @shizue/api exec tsx src/index.ts',
      env: {
        DATABASE_URL: scratchDatabaseUrl(),
        NODE_ENV: 'test', API_PORT: new URL(API_URL).port, BETTER_AUTH_URL: WEB_URL,
        // extension.spec.ts: the Shizue stand-in's loopback port, and OpenAI stood in for.
        CHATGPT_CALLBACK_PORT: process.env['E2E_CALLBACK_PORT'] ?? '47801', CHATGPT_FAKE_OPENAI: '1',
        // The same suite wherever it runs: no 2 GB model loaded when the weights
        // happen to be on disk, and explore's search is the text one it asserts.
        EMBEDDER: 'off',
      },
      // Public route, so a plain 200 means the API is really serving.
      url: `${API_URL}/api/models`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @shizue/web exec next dev --hostname 127.0.0.1 --port ${new URL(WEB_URL).port}`,
      // extension.spec.ts loads a Shizue stand-in for this origin; the login page asks it too.
      env: { API_ORIGIN: API_URL, NEXT_PUBLIC_CHATGPT_EXTENSION_ID: STAND_IN_ID },
      // Warm the single ChatGPT entrance before the browser suite begins.
      url: `${WEB_URL}/ko/login`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
