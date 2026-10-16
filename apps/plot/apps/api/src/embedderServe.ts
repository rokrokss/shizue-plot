/**
 * A process that only embeds, for the API instances that set `EMBEDDER_URL`
 * (`embedderRemote.ts`): `pnpm --filter @shizue/api embedder:serve`, or
 * `node dist/embedderServe.js` once built. No database and no routes — the
 * local embedder `EMBEDDER_*` configures (`embedder.ts`), lazy and unloaded
 * when idle as in an API process, served on `EMBEDDER_PORT`. Its weights are
 * fetched here (`embedder:fetch`), not on the instances. `METRICS_PORT` and
 * `METRICS_HOST` serve its metrics as an API's (`metrics.ts`): the embedder's
 * and the process defaults.
 */
import { createLocalEmbedder } from './embedder.js';
import { embedderListenConfig, serveEmbedder } from './embedderRemote.js';
import { loadRootEnv, readInteger } from './env.js';
import { installJsonConsole } from './log.js';
import { startEmbedderMetricsServer } from './metrics.js';

loadRootEnv();
if (process.env['LOG_FORMAT']?.trim() === 'json') installJsonConsole();

const listen = embedderListenConfig(process.env);
if (!listen) {
  console.error('[embedder] EMBEDDER_PORT is not set: nothing to serve on');
  process.exit(1);
}
if (process.env['EMBEDDER_URL']?.trim()) {
  console.error('[embedder] EMBEDDER_URL is set: this process would serve another embedder rather than run one');
  process.exit(1);
}
const embedder = createLocalEmbedder(process.env);
if (!embedder) {
  console.error('[embedder] no model to serve (above)');
  process.exit(1);
}
const listener = serveEmbedder(embedder, listen);
const metricsPort = readInteger(process.env, 'METRICS_PORT', 1, 65535);
const metricsServer =
  metricsPort === undefined
    ? undefined
    : startEmbedderMetricsServer(embedder, { port: metricsPort, host: process.env['METRICS_HOST']?.trim() || '127.0.0.1' });

let stopping = false;
function shutdown(code: number): void {
  if (stopping) return;
  stopping = true;
  metricsServer?.close();
  // The thread last: onnxruntime does not survive an exit around it.
  void listener
    .close()
    .then(() => embedder!.close())
    .catch((error: unknown) => console.error('[embedder] shutdown failed', error))
    .finally(() => process.exit(code));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown(0));
process.on('uncaughtException', (error) => {
  console.error('[embedder] uncaught exception; shutting down', error);
  shutdown(1);
});
