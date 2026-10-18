import { createEchoAdapter } from '../echo.js';
import type { ModelFormat } from './format.js';

/**
 * The automated tests' model: streams the last user message back word by word
 * (`echo.ts`). Only `NODE_ENV=test` has it (`formatOf`); a normal launch never
 * offers it or falls back to it.
 */
export const echoFormat: ModelFormat = {
  id: 'echo',
  places: {},
  key: 'optional',
  testOnly: true,
  defaultBaseUrl: 'http://echo.invalid',
  createAdapter: (config) => createEchoAdapter({ delayMs: Number(config.env['ECHO_STREAM_DELAY_MS']) || 0 }),
  listModels: async () => [{ id: 'echo/echo', label: 'Echo (test)' }],
};
