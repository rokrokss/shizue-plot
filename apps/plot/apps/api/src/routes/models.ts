import { listEnabledModels } from '@shizue/llm';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps.js';

export function modelRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    // A signed-out reader, or one without a ChatGPT connection, has no models.
    const viewer = c.get('viewerId');
    return c.json(await listEnabledModels(deps.env, viewer ? deps.chatgpt?.accounts.forUser(viewer) : undefined));
  });
  return app;
}
