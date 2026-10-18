import { chatGPTRoutes } from './routes/chatgpt.js';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import { originGuard } from './originGuard.js';
import { deviceClaimRoutes, remoteOriginsOf } from './routes/devices.js';
import type { AppDeps, AppEnv } from './deps.js';
import { errorResponse, type ErrorBody } from './errors.js';
import { healthRoutes } from './health.js';
import { chatMemoryRoutes } from './routes/chatMemory.js';
import { chatTranslationRoutes } from './routes/chatTranslation.js';
import { chatRoutes, messageRoutes } from './routes/chats.js';
import { deviceRoutes } from './routes/devices.js';
import { FILE_IMPORT_PART_BYTES, fileImportRoutes, MAX_WORLD_INFO_BYTES } from './fileImports.js';
import { chatImportRoutes, importRoutes } from './routes/imports.js';
import { modelRoutes } from './routes/models.js';
import { noteRoutes } from './routes/notes.js';
import { personaRoutes } from './routes/personas.js';
import { presetRoutes } from './routes/presets.js';
import { readerPresetRoutes } from './routes/readerPresets.js';
import { readerModuleRoutes } from './routes/readerModules.js';
import { plotRoutes } from './routes/plots.js';
import { securityHeaders } from './securityHeaders.js';
import { createSessionStore, ownerGate } from './session.js';

const MB = 1024 * 1024;
/** Starting a file import, whose body carries the World Info file beside a card (`fileImports.ts`). */
const FILE_IMPORT_PATH = /^\/api\/file-imports$/;
/** A part of a file being imported, sent to this API where the store takes none itself (the local driver). */
const FILE_IMPORT_PART_PATH = /^\/api\/file-imports\/[^/]+\/parts\/\d+$/;
/** A chat import's attachment (`…/import/attachments`) — an upload, not the 5MB of JSON. */
const ATTACHMENT_PATH = /^\/api\/chats\/[^/]+\/import\/attachments$/;

/**
 * Route order matters: the probe and a phone's claim of its pairing code are
 * registered before `ownerGate`, so they answer before anyone is known. Past it
 * every request is the owner's — from this computer, or from a paired phone —
 * and anything else has been answered 401 (session.ts).
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Paired phones' sessions: the gate reads them, the pairing routes make and end them.
  const sessions = createSessionStore(deps.db, { secure: new URL(deps.webOrigin ?? 'http://localhost').protocol === 'https:' });

  app.use('*', securityHeaders());
  if (deps.webOrigin) app.use('*', originGuard(deps.webOrigin, () => remoteOriginsOf(deps)));

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

  // `/api/health`: the probe never resolves a session (`health.ts`).
  app.route('/api', healthRoutes());
  // A phone trades its pairing code for a session here, so it has none yet.
  app.route('/api/devices', deviceClaimRoutes(deps, sessions));
  app.use('/api/*', ownerGate(deps.db, sessions));

  // A static catalog: nothing user-specific in it.
  app.route('/api/presets', presetRoutes());
  // The owner's ChatGPT connection; connecting it is this computer's alone.
  app.route('/api/chatgpt', chatGPTRoutes(deps));
  // A phone opens this computer's shizue through a tunnel, paired from here.
  app.route('/api/devices', deviceRoutes(deps, sessions));
  app.route('/api/models', modelRoutes(deps));

  app.route('/api/plots', plotRoutes(deps));
  app.route('/api/personas', personaRoutes(deps));
  app.route('/api/notes', noteRoutes(deps));
  // The reader's own presets on top of the catalog's (`chats.reader_preset_id`).
  app.route('/api/reader-presets', readerPresetRoutes(deps));
  // The reader's own RisuAI modules, laid over their chats (`chats.modules`).
  app.route('/api/reader-modules', readerModuleRoutes(deps));
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
