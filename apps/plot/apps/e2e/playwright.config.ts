import { defineConfig, devices } from '@playwright/test';

// Overridable so a containerized run (e.g. generating another platform's visual
// baselines) can point at the host's dev stack instead of its own localhost.
const WEB_URL = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:8787';

/**
 * Smoke suite against the real dev stack (docker Postgres + Hono API + Next).
 *
 * The web server runs `next dev` rather than a production build: the message
 * catalogs (`apps/web/messages/*.json`) are then read from disk on demand, so a
 * catalog edit does not need a rebuild before the locale assertions see it.
 * First-hit route compilation is slow, hence the generous timeouts below.
 *
 * The suite writes to the dev database with a unique account per run and never
 * truncates anything.
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
      command: 'pnpm --filter @shizue/api exec tsx src/index.ts',
      env: {
        NODE_ENV: 'test', API_PORT: new URL(API_URL).port, BETTER_AUTH_URL: WEB_URL,
        // extension.spec.ts: the sign-in helper's loopback port, and OpenAI stood in for.
        CHATGPT_CALLBACK_PORT: process.env['E2E_CALLBACK_PORT'] ?? '47801', CHATGPT_FAKE_OPENAI: '1',
      },
      // Public route, so a plain 200 means the API is really serving.
      url: `${API_URL}/api/models`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @shizue/web exec next dev --hostname 127.0.0.1 --port ${new URL(WEB_URL).port}`,
      env: { API_ORIGIN: API_URL },
      // Warm the single ChatGPT entrance before the browser suite begins.
      url: `${WEB_URL}/ko/login`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
