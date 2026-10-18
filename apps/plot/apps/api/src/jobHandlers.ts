import type { AppDeps } from './deps.js';
import { runFileImport } from './fileImports.js';
import type { JobHandlers } from './jobs.js';
import { memoryBackfill } from './memory.js';

/**
 * The work this API runs off the queue. The memory backfill calls the chat owner's
 * model and shares the per-chat refresh guard with the request path, so it is
 * handed the same deps the app runs on.
 */
export function createJobHandlers(deps: AppDeps): JobHandlers {
  return {
    memory_backfill: (_db, payload) => memoryBackfill(deps, payload),
    file_import: (_db, payload) => runFileImport(deps, payload.importId),
  };
}
