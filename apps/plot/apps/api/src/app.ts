import { chatGPTRoutes } from './routes/chatgpt.js';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import { normalizeAuthResponse } from './auth.js';
import { originGuard } from './originGuard.js';
import type { AppDeps, AppEnv } from './deps.js';
import { errorResponse, type ErrorBody } from './errors.js';
import { healthRoutes } from './health.js';
import { requestLog } from './log.js';
import { chatMemoryRoutes } from './routes/chatMemory.js';
import { chatTranslationRoutes } from './routes/chatTranslation.js';
import { chatRoutes, messageRoutes } from './routes/chats.js';
import { commentRoutes, plotCommentRoutes } from './routes/comments.js';
import { deviceRoutes } from './routes/devices.js';
import { FILE_IMPORT_PART_BYTES, fileImportRoutes, MAX_WORLD_INFO_BYTES } from './fileImports.js';
import { creatorRoutes, exploreRoutes } from './routes/explore.js';
import { chatImportRoutes, importRoutes } from './routes/imports.js';
import { modelRoutes } from './routes/models.js';
import { notificationRoutes } from './routes/notifications.js';
import { noteRoutes } from './routes/notes.js';
import { personaRoutes } from './routes/personas.js';
import { presetRoutes } from './routes/presets.js';
import { readerPresetRoutes } from './routes/readerPresets.js';
import { readerModuleRoutes } from './routes/readerModules.js';
import { plotRoutes } from './routes/plots.js';
import { requireUser } from './session.js';

const MB = 1024 * 1024;
/** Starting a file import, whose body carries the World Info file beside a card (`fileImports.ts`). */
const FILE_IMPORT_PATH = /^\/api\/file-imports$/;
/** A part of a file being imported, sent to this API where the store takes none itself (the local driver). */
const FILE_IMPORT_PART_PATH = /^\/api\/file-imports\/[^/]+\/parts\/\d+$/;
/** `POST /api/chats/:id/attachments` and a chat import's (`…/import/attachments`) — an upload, not the 5MB of JSON. */
const ATTACHMENT_PATH = /^\/api\/chats\/[^/]+\/(?:import\/)?attachments$/;

/**
 * Route order matters: `/api/auth/*`, `/api/presets` and the probes are
 * registered before the session middleware, so they never resolve one.
 *
 * Past that middleware the session is *resolved*, not *required*: the catalogue
 * and the pages it links to are readable without an account, so what a route
 * needs is stated by mounting `requireUser` in front of it (session.ts).
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // First, so every line a request says carries its id, and refusals are logged and counted too (`log.ts`).
  app.use('*', requestLog());
  if (deps.webOrigin) app.use('*', originGuard(deps.webOrigin, deps.remoteOrigins));

  app.onError((error, c) => errorResponse(c, error));
  app.notFound((c) => c.json<ErrorBody>({ error: 'Not found', code: 'not_found' }, 404));

  const tooLarge = (c: Context): Response =>
    c.json<ErrorBody>({ error: 'Payload too large', code: 'payload_too_large' }, 413);
  // Everything is small JSON but for these. A card or module file never comes in
  // a body: the browser uploads it in parts (`fileImports.ts`) — to the store
  // itself, or here a part at a time where the store takes none (the local
  // driver), streamed to disk. Starting an import carries a World Info file, as
  // a JSON string: escaping its quotes, backslashes and line breaks at most
  // doubles it.
  const fileImportLimit = bodyLimit({ maxSize: 2 * MAX_WORLD_INFO_BYTES + MB, onError: tooLarge });
  const partLimit = bodyLimit({ maxSize: FILE_IMPORT_PART_BYTES, onError: tooLarge });
  const jsonLimit = bodyLimit({ maxSize: 5 * MB, onError: tooLarge });
  // One 8MB image plus its multipart framing and the measurement fields. The
  // route caps the file itself; this caps what the parser is handed.
  const attachmentLimit = bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES + MB, onError: tooLarge });

  app.use('/api/*', (c, next) => {
    const path = c.req.path;
    if (ATTACHMENT_PATH.test(path)) return attachmentLimit(c, next);
    if (FILE_IMPORT_PART_PATH.test(path)) return partLimit(c, next);
    return (FILE_IMPORT_PATH.test(path) ? fileImportLimit : jsonLimit)(c, next);
  });

  app.all('/api/auth/*', async (c) => normalizeAuthResponse(await deps.auth.handler(c.req.raw)));
  // A static catalog: nothing user-specific in it.
  app.route('/api/presets', presetRoutes());
  // `/api/health` and `/api/ready`: a probe never resolves a session (`health.ts`).
  app.route('/api', healthRoutes(deps));
  app.use('/api/*', async (c, next) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    c.set('viewerId', session?.user?.id ?? null);
    if (session?.user) c.set('userId', session.user.id);
    await next();
  });

  // Both answer signed-out readers too: sign-in starts here, and the model list of
  // someone without a ChatGPT connection is empty.
  app.route('/api/chatgpt', chatGPTRoutes(deps));
  // A phone joins the reader signed in on this machine here, so its claim answers
  // signed-out browsers too. Only with REMOTE_ORIGINS: the hosted app has none of it.
  app.route('/api/devices', deviceRoutes(deps));
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
    '/api/reader-presets',
    '/api/reader-modules',
    '/api/notifications',
    '/api/chats',
    '/api/messages',
    '/api/imports',
    '/api/file-imports',
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
  // The reader's own presets on top of the catalog's (`chats.reader_preset_id`).
  app.route('/api/reader-presets', readerPresetRoutes(deps));
  // The reader's own RisuAI modules, laid over their chats (`chats.modules`).
  app.route('/api/reader-modules', readerModuleRoutes(deps));
  app.route('/api/notifications', notificationRoutes(deps));
  app.route('/api/chats', chatRoutes(deps));
  // A chat brought over from another app, written in batches (`POST /api/chats/import`).
  app.route('/api/chats', chatImportRoutes(deps));
  // The memory's summaries, as the reader reads and tends them (`GET /api/chats/:id/memory`).
  app.route('/api/chats', chatMemoryRoutes(deps));
  // What the reader's page shows translated, and what they write before it is sent (§7.8).
  app.route('/api/chats', chatTranslationRoutes(deps));
  app.route('/api/messages', messageRoutes(deps));
  app.route('/api/imports', importRoutes(deps));
  // Card and module files: uploaded in parts, read by a job, polled for (`fileImports.ts`).
  app.route('/api/file-imports', fileImportRoutes(deps));

  return app;
}
