/**
 * Prometheus metrics (ARCHITECTURE §12 운영). Counted in process memory where
 * the work happens, and served as Prometheus text on a listener of its own —
 * `METRICS_PORT` on `METRICS_HOST` (loopback by default), never under `/api`,
 * which the web's rewrite makes public. Unset, nothing listens and the counts go
 * unread, so a worktree's or the browser suite's own API never takes a port.
 *
 * Every label is low-cardinality: a route's pattern (`/api/chats/:id`), never
 * its ids or its query; a kind, a status, a code, a model.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jobs } from '@shizue/db';
import { inArray, sql } from 'drizzle-orm';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { AppDeps } from './deps.js';
import type { BackgroundTasks } from './lifecycle.js';

export const registry = new Registry();

/** What the collect-time gauges read; set by `startMetricsServer`, so nothing is read with the listener off. */
let watched: { deps: AppDeps; background: BackgroundTasks } | null = null;

/* -------------------------------------------------------------------- http */

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Finished API requests by method, route pattern and status; the probes are not counted.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Time to the response, by method and route pattern; for a stream, until it starts, not until it ends.',
  labelNames: ['method', 'route'] as const,
  registers: [registry],
});

/* -------------------------------------------------------------- generation */

new Gauge({
  name: 'generation_streams_active',
  help: 'Generation streams this instance has open (deps.generationStreams).',
  registers: [registry],
  collect() {
    this.set(watched?.deps.generationStreams.size ?? 0);
  },
});

const generationOutcomes = new Counter({
  name: 'generation_outcomes_total',
  help: 'Generations by how they ended (done, stopped, timeout, error) and, for an error, its code.',
  labelNames: ['result', 'code'] as const,
  registers: [registry],
});

export type GenerationResult = 'done' | 'stopped' | 'timeout' | 'error';

/**
 * The codes a process names. A provider's are its own (`providerError` keeps any
 * that look like a code), so past this many distinct ones the rest count as
 * `other` rather than growing the series without bound.
 */
const MAX_CODES = 32;
const codes = new Set<string>();

/** One generation's end (`runGeneration`). */
export function countGeneration(result: GenerationResult, code = 'none'): void {
  if (!codes.has(code)) {
    if (codes.size >= MAX_CODES) code = 'other';
    else codes.add(code);
  }
  generationOutcomes.inc({ result, code });
}

/* ------------------------------------------------------------ prompt cache */

/** Every request's prompt, as the provider's usage counts it (`cacheHealth.ts`), by site (`chat`, `side`). */
export const promptTokens = new Counter({
  name: 'prompt_input_tokens_total',
  help: 'Prompt tokens the provider counted, by site (chat replies, side calls).',
  labelNames: ['site'] as const,
  registers: [registry],
});

export const cachedPromptTokens = new Counter({
  name: 'prompt_cached_input_tokens_total',
  help: 'Prompt tokens the provider served from its prompt cache, by site, where its usage said.',
  labelNames: ['site'] as const,
  registers: [registry],
});

/* -------------------------------------------------------- background tasks */

export const backgroundStarted = new Counter({
  name: 'background_tasks_started_total',
  help: 'Fire-and-forget tasks started after a response (memory, relationship, emotion, vectors, aliases, search).',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const backgroundFinished = new Counter({
  name: 'background_tasks_finished_total',
  help: 'Background tasks settled, by kind and outcome. The tasks log and swallow their own failures, so those end ok here.',
  labelNames: ['kind', 'outcome'] as const,
  registers: [registry],
});

new Gauge({
  name: 'background_tasks_in_flight',
  help: 'Background tasks running now, by kind.',
  labelNames: ['kind'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const [kind, count] of watched?.background.inFlight() ?? []) this.set({ kind }, count);
  },
});

/* -------------------------------------------------------------------- jobs */

new Gauge({
  name: 'jobs_queue',
  help: 'Pending and failed jobs by kind; done ones are left out, since they are never purged and counting them scans the table.',
  labelNames: ['kind', 'status'] as const,
  registers: [registry],
  async collect() {
    this.reset();
    if (!watched) return;
    try {
      const rows = await watched.deps.db
        .select({ kind: jobs.kind, status: jobs.status, count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(inArray(jobs.status, ['pending', 'failed']))
        .groupBy(jobs.kind, jobs.status);
      for (const row of rows) this.set({ kind: row.kind, status: row.status }, row.count);
    } catch {
      // A database that does not answer leaves the gauge empty and the rest of the
      // scrape whole; `/api/ready` is what says so, and a scrape every few seconds
      // would only repeat it in the log.
    }
  },
});

/* ---------------------------------------------------------------- embedder */

new Gauge({
  name: 'embedder_models_loaded',
  help: 'Embedding models the embedder thread holds or is loading.',
  registers: [registry],
  collect() {
    this.set(watched?.deps.embedder?.loadedModels?.() ?? 0);
  },
});

export const embedDuration = new Histogram({
  name: 'embedder_embed_duration_seconds',
  help: 'Time an embed call that answered took, by model.',
  labelNames: ['model'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const embedFailures = new Counter({
  name: 'embedder_embed_failures_total',
  help: 'Embed calls that threw, by model and reason: timeout (past its deadline), unavailable (a load failed within the last minute), error.',
  labelNames: ['model', 'reason'] as const,
  registers: [registry],
});

/* --------------------------------------------------------------------- lua */

export const luaSandboxEnabled = new Gauge({
  name: 'lua_sandbox_enabled',
  help: "1 when the startup probe found a Lua child kept off the network, so cards' editRequest listeners run; 0 when they do not.",
  registers: [registry],
});

/* ---------------------------------------------------------------- listener */

let defaultsCollected = false;

/**
 * Serves `GET /metrics` on a listener of its own, and starts the process's
 * default collectors (event-loop lag, heap, RSS, GC) — only here, so a process
 * without the listener pays for neither.
 */
export function startMetricsServer(
  deps: AppDeps,
  background: BackgroundTasks,
  { port, host }: { port: number; host: string },
): Server {
  watched = { deps, background };
  if (!defaultsCollected) {
    collectDefaultMetrics({ register: registry });
    defaultsCollected = true;
  }
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry.metrics().then(
      (text) => res.writeHead(200, { 'content-type': registry.contentType }).end(text),
      (error: unknown) => {
        console.error('[metrics] collecting failed', error);
        res.writeHead(500).end();
      },
    );
  });
  server.listen(port, host, () => {
    console.log(`[metrics] listening on http://${host}:${(server.address() as AddressInfo).port}/metrics`);
  });
  return server;
}
