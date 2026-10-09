import { PRESET_IDS } from '@shizue/core';
import { Hono } from 'hono';
import type { AppEnv } from '../deps.js';

/** The prompt preset catalog. Ids only — the labels live in the client's i18n. */
export function presetRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', (c) => c.json(PRESET_IDS.map((id) => ({ id }))));
  return app;
}
