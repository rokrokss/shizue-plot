import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAND_IN_ID } from './shizueStandIn.js';

// Overridable so a containerized run (e.g. generating another platform's visual
// baselines) can point at the host's dev stack instead of its own localhost.
const WEB_URL = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:8787';

/**
 * The app's folder the suite's API runs on: a new empty one per run, so a run
 * never touches the owner's own works (apps/plot/data/app) and starts from a fresh
 * database. Set once in this process; Playwright's workers inherit it.
 */
process.env['E2E_DATA_DIR'] ??= mkdtempSync(join(tmpdir(), 'shizue-e2e-'));
const DATA_DIR = process.env['E2E_DATA_DIR'];

/**
 * Smoke suite against the real stack (Hono API on its own PGlite folder + Next).
 *
 * The web server runs `next dev` rather than a production build: the message
 * catalogs (`apps/web/messages/*.json`) are then read from disk on demand, so a
 * catalog edit does not need a rebuild before the locale assertions see it.
 * First-hit route compilation is slow, hence the generous timeouts below.
 *
 * The API migrates the run's fresh folder and runs on it. Every spec is its one
 * owner — a browser on this computer is (the API's `ownerGate`) — so specs tell
 * their own works apart by the run's unique names; nothing is truncated.
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
      // The API migrates its database itself, at the start.
      command: 'pnpm --filter @shizue/api exec tsx src/index.ts',
      env: {
        SHIZUE_DATA_DIR: DATA_DIR,
        NODE_ENV: 'test', API_PORT: new URL(API_URL).port, BETTER_AUTH_URL: WEB_URL,
        // extension.spec.ts: the Shizue stand-in's loopback port, and OpenAI stood in for.
        CHATGPT_CALLBACK_PORT: process.env['E2E_CALLBACK_PORT'] ?? '47801', CHATGPT_FAKE_OPENAI: '1',
        // The same suite wherever it runs: no 2 GB model loaded when the weights
        // happen to be on disk.
        EMBEDDER: 'off',
      },
      // Public route, so a plain 200 means the API is really serving.
      url: `${API_URL}/api/models`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @shizue/web exec next dev --hostname 127.0.0.1 --port ${new URL(WEB_URL).port}`,
      // extension.spec.ts loads a Shizue stand-in for this origin; the settings card asks it too.
      env: { API_ORIGIN: API_URL, NEXT_PUBLIC_CHATGPT_EXTENSION_ID: STAND_IN_ID },
      // Warm the settings page, where ChatGPT is connected, before the browser suite begins.
      url: `${WEB_URL}/ko/settings`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
