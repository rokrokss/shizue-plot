import { chatGPTRoutes } from './routes/chatgpt.js';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import { normalizeAuthResponse } from './auth.js';
import { originGuard } from './originGuard.js';
import type { AppDeps, AppEnv } from './deps.js';
import { errorResponse, type ErrorBody } from './errors.js';
import { chatRoutes, messageRoutes } from './routes/chats.js';
import { commentRoutes, plotCommentRoutes } from './routes/comments.js';
import { creatorRoutes, exploreRoutes } from './routes/explore.js';
import { modelRoutes } from './routes/models.js';
import { notificationRoutes } from './routes/notifications.js';
import { noteRoutes } from './routes/notes.js';
import { personaRoutes } from './routes/personas.js';
import { presetRoutes } from './routes/presets.js';
import { MAX_CARD_IMPORT_BYTES, plotRoutes } from './routes/plots.js';
import { requireUser } from './session.js';

const MB = 1024 * 1024;
/** The two card-import routes: a card as a new plot, and one as another member. */
const IMPORT_PATH = /^\/api\/plots\/(import|[^/]+\/characters\/import)$/;
/** `POST /api/chats/:id/attachments` — an image upload, not the 5MB of JSON. */
const ATTACHMENT_PATH = /^\/api\/chats\/[^/]+\/attachments$/;

/**
 * Route order matters: `/api/auth/*` and `/api/presets` are registered before
 * the session middleware, so they never resolve one.
 *
 * Past that middleware the session is *resolved*, not *required*: the catalogue
 * and the pages it links to are readable without an account, so what a route
 * needs is stated by mounting `requireUser` in front of it (session.ts).
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  if (deps.webOrigin) app.use('*', originGuard(deps.webOrigin));

  app.onError((error, c) => errorResponse(c, error));
  app.notFound((c) => c.json<ErrorBody>({ error: 'Not found', code: 'not_found' }, 404));

  const tooLarge = (c: Context): Response =>
    c.json<ErrorBody>({ error: 'Payload too large', code: 'payload_too_large' }, 413);
  // Character cards arrive as charx archives and image-laden PNGs; everything
  // else is small JSON. One card file plus its multipart framing and the
  // provenance fields: the route caps the file itself, this caps what the
  // parser is handed.
  const importLimit = bodyLimit({ maxSize: MAX_CARD_IMPORT_BYTES + MB, onError: tooLarge });
  const jsonLimit = bodyLimit({ maxSize: 5 * MB, onError: tooLarge });
  // One 8MB image plus its multipart framing and the measurement fields. The
  // route caps the file itself; this caps what the parser is handed.
  const attachmentLimit = bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES + MB, onError: tooLarge });

  app.use('/api/*', (c, next) => {
    const path = c.req.path;
    if (ATTACHMENT_PATH.test(path)) return attachmentLimit(c, next);
    return (IMPORT_PATH.test(path) ? importLimit : jsonLimit)(c, next);
  });

  app.all('/api/auth/*', async (c) => normalizeAuthResponse(await deps.auth.handler(c.req.raw)));
  // A static catalog: nothing user-specific in it.
  app.route('/api/presets', presetRoutes());
  app.use('/api/*', async (c, next) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    c.set('viewerId', session?.user?.id ?? null);
    if (session?.user) c.set('userId', session.user.id);
    await next();
  });

  // Both answer signed-out readers too: sign-in starts here, and the model list of
  // someone without a ChatGPT connection is empty.
  app.route('/api/chatgpt', chatGPTRoutes(deps));
  app.route('/api/models', modelRoutes(deps));

  /**
   * Routers that are gated whole. `path` and `path/*` both, because the first
   * pattern does not match the second's sub-paths and the second does not match
   * the collection itself.
   */
  const gated = (path: string): void => {
    app.use(path, requireUser);
    app.use(`${path}/*`, requireUser);
  };
  // The mixed routers are missing from this list on purpose: /api/plots,
  // which carries public reads beside writes
  // that belong to somebody, so they gate themselves route by route.
  for (const path of [
    '/api/comments',
    '/api/personas',
    '/api/notes',
    '/api/notifications',
    '/api/chats',
    '/api/messages',
  ]) {
    gated(path);
  }

  app.route('/api/comments', commentRoutes(deps));
  app.route('/api/plots', plotRoutes(deps));
  // The comment section of a plot page, kept in its own module.
  app.route('/api/plots', plotCommentRoutes(deps));
  app.route('/api/explore', exploreRoutes(deps));
  app.route('/api/creators', creatorRoutes(deps));
  app.route('/api/personas', personaRoutes(deps));
  app.route('/api/notes', noteRoutes(deps));
  app.route('/api/notifications', notificationRoutes(deps));
  app.route('/api/chats', chatRoutes(deps));
  app.route('/api/messages', messageRoutes(deps));

  return app;
}
