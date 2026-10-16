/**
 * One embedder for several API instances (ARCHITECTURE §7.3 서버 임베더, §12):
 * the process that holds the model serves the `Embedder` interface on a
 * listener of its own, and the instances that set `EMBEDDER_URL` use it
 * (`createRemoteEmbedder`) instead of each loading the model.
 *
 * - **Where it listens.** `EMBEDDER_PORT` on `EMBEDDER_HOST` (loopback by
 *   default), never under `/api`, which the web's rewrite makes public — as
 *   `METRICS_PORT`. `pnpm --filter @shizue/api embedder:serve` runs a process
 *   that does only this (`embedderServe.ts`); an API process that sets
 *   `EMBEDDER_PORT` serves its own local embedder as well. Off loopback it needs
 *   `EMBEDDER_TOKEN`, which the instances send as a bearer token.
 * - **Queries first.** The listener hands its embedder one piece at a time: a
 *   search's query whole, ahead of any text to be stored, and those in pieces of
 *   at most `PIECE_CHARS` characters. So a query waits for one piece — about a
 *   second — rather than for another instance's backfill, and its 3-second
 *   deadline holds. What a caller gave up on (its connection closed) loses the
 *   pieces not handed over yet.
 * - **The client** answers `modelFor` from its own `EMBEDDER_ROUTING` and
 *   `EMBEDDER_MODEL`, which must be the serving process's: it asks the listener
 *   once at startup and says where they differ, and a model the listener cannot
 *   run is null from then on, as one never fetched is locally. An answer of
 *   another model throws. `embed` throws as the local one does, and the callers
 *   fall back alike. A connection that cannot be made — refused, or not made
 *   within `CONNECT_TIMEOUT_MS` — also stops it asking for `UNREACHABLE_RETRY_MS`:
 *   every call meanwhile throws at once, so an embedder that is gone costs a
 *   turn nothing rather than its query's whole deadline. Those throws, and the
 *   listener's 503 for an embedder of its own that is unavailable, are
 *   `EmbedderUnavailable`, which the callers log as one short line.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ContentLanguage } from '@shizue/db';
import {
  DEFAULT_TIMEOUT_MS,
  EmbedderUnavailable,
  embedderConfig,
  routeOf,
  type EmbedOptions,
  type Embedder,
  type Embedding,
  type ModelRoutes,
} from './embedder.js';
import { readInteger } from './env.js';
import { embedDuration, embedFailures } from './metrics.js';

const LANGUAGES: readonly ContentLanguage[] = ['ko', 'en', 'ja'];
/** Characters of texts to be stored in one piece: about a second's work for the thread, since a token is at least a character. */
export const PIECE_CHARS = 2_000;
/** The most a request to the listener may carry; a backfill's 64 summary chunks are far less. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** How long making a connection may take before the embedder counts as unreachable. */
export const CONNECT_TIMEOUT_MS = 1_000;
/** How long an unreachable embedder is left before the next try. */
export const UNREACHABLE_RETRY_MS = 15_000;
/** How long the startup check and a warm-up may take. */
const CHECK_TIMEOUT_MS = 5_000;

export interface ListenConfig {
  port: number;
  host: string;
  token?: string;
}

const isLoopback = (host: string): boolean => host === 'localhost' || host === '::1' || host.startsWith('127.');

/**
 * Where `EMBEDDER_PORT`, `EMBEDDER_HOST` and `EMBEDDER_TOKEN` say to serve the
 * embedder, or undefined when `EMBEDDER_PORT` is unset. Throws for a host other
 * machines can reach without a token.
 */
export function embedderListenConfig(env: NodeJS.ProcessEnv): ListenConfig | undefined {
  const port = readInteger(env, 'EMBEDDER_PORT', 1, 65535);
  if (port === undefined) return undefined;
  const host = env['EMBEDDER_HOST']?.trim() || '127.0.0.1';
  const token = env['EMBEDDER_TOKEN']?.trim();
  if (!token && !isLoopback(host)) {
    throw new Error(`EMBEDDER_HOST ${host} can be reached from other machines: set EMBEDDER_TOKEN, and the same on the instances that use it.`);
  }
  return { port, host, ...(token ? { token } : {}) };
}

/* ------------------------------------------------------------------ server */

type Kind = NonNullable<EmbedOptions['kind']>;

/** One request to the listener, and how far it got. */
interface Job {
  pieces: string[][];
  done: number;
  vectors: number[][];
  options: { plotLanguage: ContentLanguage; kind: Kind };
  signal: AbortSignal;
  resolve(embedding: Embedding): void;
  reject(error: unknown): void;
}

/** Texts to be stored, in order, in pieces of at most `PIECE_CHARS` characters; a longer text goes alone. */
export function piecesOf(texts: readonly string[], limit = PIECE_CHARS): string[][] {
  const pieces: string[][] = [];
  let piece: string[] = [];
  let chars = 0;
  for (const text of texts) {
    if (piece.length > 0 && chars + text.length > limit) {
      pieces.push(piece);
      piece = [];
      chars = 0;
    }
    piece.push(text);
    chars += text.length;
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

/** Hands the embedder one piece at a time, queries before anything else. */
class Pieces {
  private readonly queries: Job[] = [];
  private readonly documents: Job[] = [];
  private running = false;
  /** Settles when the pump in hand finds nothing more to do. */
  private idle: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly embedder: Embedder) {}

  embed(texts: string[], options: Job['options'], signal: AbortSignal): Promise<Embedding> {
    if (this.closed) return Promise.reject(new EmbedderUnavailable('the embedder is shutting down'));
    if (texts.length === 0) return this.embedder.embed([], options);
    return new Promise((resolve, reject) => {
      const pieces = options.kind === 'query' ? [texts] : piecesOf(texts);
      this.line(options.kind).push({ pieces, done: 0, vectors: [], options, signal, resolve, reject });
      if (!this.running) {
        this.running = true;
        this.idle = this.pump();
      }
    });
  }

  /** Fails what waits, and settles once the piece in hand is done. */
  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queries.splice(0), ...this.documents.splice(0)]) {
      job.reject(new EmbedderUnavailable('the embedder is shutting down'));
    }
    await this.idle;
  }

  private line(kind: Kind): Job[] {
    return kind === 'query' ? this.queries : this.documents;
  }

  private next(): Job | undefined {
    for (const line of [this.queries, this.documents]) {
      while (line[0]?.signal.aborted) line.shift()!.reject(new Error('the caller gave up'));
      if (line[0]) return line[0];
    }
    return undefined;
  }

  private settle(job: Job): void {
    const line = this.line(job.options.kind);
    const at = line.indexOf(job);
    if (at >= 0) line.splice(at, 1);
  }

  private async pump(): Promise<void> {
    try {
      for (let job = this.next(); job; job = this.next()) {
        try {
          const { model, vectors } = await this.embedder.embed(job.pieces[job.done]!, job.options);
          job.vectors.push(...vectors);
          job.done += 1;
          if (job.done === job.pieces.length) {
            this.settle(job);
            job.resolve({ model, vectors: job.vectors });
          }
        } catch (error) {
          this.settle(job);
          job.reject(error);
        }
      }
    } finally {
      // Cleared in the same turn the loop found nothing: a job added after it starts a pump of its own.
      this.running = false;
    }
  }
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        req.resume();
        reject(new TooLarge(`a request may carry at most ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (res.headersSent || res.destroyed) return;
  if (body === undefined) res.writeHead(status).end();
  else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const isLanguage = (value: unknown): value is ContentLanguage => LANGUAGES.includes(value as ContentLanguage);

interface EmbedBody {
  texts: string[];
  plotLanguage: ContentLanguage;
  kind: Kind;
}

function isEmbedBody(body: unknown): body is EmbedBody {
  if (typeof body !== 'object' || body === null) return false;
  const { texts, plotLanguage, kind } = body as Record<string, unknown>;
  return Array.isArray(texts) && texts.every((text) => typeof text === 'string') && isLanguage(plotLanguage) && (kind === 'query' || kind === 'document');
}

export interface EmbedderListener {
  server: Server;
  /** Stops listening, fails what waits, and settles once the piece in hand is done; the embedder itself is the caller's to close. */
  close(): Promise<void>;
}

/** Serves `embedder` as `createRemoteEmbedder` asks it, on `port` at `host`. */
export function serveEmbedder(embedder: Embedder, { port, host, token }: ListenConfig): EmbedderListener {
  const pieces = new Pieces(embedder);
  const expected = token ? digest(`Bearer ${token}`) : null;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://embedder').pathname;
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
    if (expected && !timingSafeEqual(digest(req.headers.authorization ?? ''), expected)) {
      return send(res, 401, { error: 'EMBEDDER_TOKEN does not match' });
    }
    if (req.method === 'GET' && path === '/models') {
      return send(res, 200, { models: Object.fromEntries(LANGUAGES.map((language) => [language, embedder.modelFor(language)])) });
    }
    if (req.method !== 'POST' || (path !== '/embed' && path !== '/warm')) return send(res, 404, { error: 'not found' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      res.setHeader('connection', 'close');
      return send(res, error instanceof TooLarge ? 413 : 400, { error: error instanceof Error ? error.message : String(error) });
    }
    if (path === '/warm') {
      const plotLanguage = (body as { plotLanguage?: unknown } | null)?.plotLanguage;
      if (!isLanguage(plotLanguage)) return send(res, 400, { error: 'expected { plotLanguage }' });
      embedder.warm(plotLanguage);
      return send(res, 204);
    }
    if (!isEmbedBody(body)) return send(res, 400, { error: 'expected { texts, plotLanguage, kind }' });
    // A caller that gives up closes its connection; what it asked is not embedded for nobody.
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    try {
      send(res, 200, await pieces.embed(body.texts, { plotLanguage: body.plotLanguage, kind: body.kind }, gone.signal));
    } catch (error) {
      send(res, error instanceof EmbedderUnavailable ? 503 : 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('[embedder] serving a request failed', error);
      send(res, 500, { error: 'internal error' });
    });
  });
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`[embedder] serving on http://${host}:${typeof address === 'object' && address ? address.port : port}`);
  });
  return {
    server,
    async close() {
      server.close();
      await pieces.close();
      server.closeAllConnections();
    },
  };
}

/* ------------------------------------------------------------------ client */

/** The embedder could not be reached: refused, unknown, or no connection in time. */
class Unreachable extends EmbedderUnavailable {}
/** Connected, and no answer before the deadline. */
class Late extends Error {}

export interface RemoteEmbedderOptions {
  connectTimeoutMs?: number;
  retryMs?: number;
}

/**
 * The embedder at `EMBEDDER_URL`, or undefined — with a line in the log — when
 * `EMBEDDER=off` or the routing is unknown, as `createLocalEmbedder`. Throws
 * for an address that is not `http://`.
 */
export function createRemoteEmbedder(env: NodeJS.ProcessEnv = process.env, options: RemoteEmbedderOptions = {}): Embedder | undefined {
  const config = embedderConfig(env);
  if ('off' in config) {
    console.warn(`[embedder] off: ${config.off}; memory falls back to recent and random summaries`);
    return undefined;
  }
  const raw = env['EMBEDDER_URL']?.trim() ?? '';
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (url?.protocol !== 'http:') throw new Error(`EMBEDDER_URL must be the http:// address of an embedder's EMBEDDER_PORT, got "${raw}".`);
  const token = env['EMBEDDER_TOKEN']?.trim();
  const embedder = new RemoteEmbedder(url, config.routes, token || undefined, {
    connectTimeoutMs: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    retryMs: options.retryMs ?? UNREACHABLE_RETRY_MS,
  });
  console.log(`[embedder] embedding at ${url.origin} (EMBEDDER_URL); this process loads no model`);
  embedder.check();
  return embedder;
}

class RemoteEmbedder implements Embedder {
  private unreachableUntil = 0;
  private lastFailure: Error | null = null;
  /** Languages whose model the listener said it cannot run. */
  private readonly cannotRun = new Set<ContentLanguage>();
  private readonly open = new Set<ClientRequest>();

  constructor(
    private readonly url: URL,
    private readonly routes: ModelRoutes,
    private readonly token: string | undefined,
    private readonly options: Required<RemoteEmbedderOptions>,
  ) {}

  modelFor(plotLanguage: ContentLanguage): string | null {
    return this.cannotRun.has(plotLanguage) ? null : routeOf(this.routes, plotLanguage);
  }

  async embed(texts: readonly string[], { plotLanguage, kind = 'document', timeoutMs = DEFAULT_TIMEOUT_MS }: EmbedOptions): Promise<Embedding> {
    const model = this.modelFor(plotLanguage);
    if (!model) throw new Error(`no embedding model for ${plotLanguage}: the embedder at ${this.url.origin} cannot run ${routeOf(this.routes, plotLanguage)}`);
    if (texts.length === 0) return { model, vectors: [] };
    if (Date.now() < this.unreachableUntil) {
      embedFailures.inc({ model, reason: 'unavailable' });
      throw new Unreachable(`the embedder at ${this.url.origin} is unreachable (${this.lastFailure?.message}); not asking again for a while`);
    }
    const took = embedDuration.startTimer({ model });
    try {
      const answer = (await this.call('POST', '/embed', { texts, plotLanguage, kind }, timeoutMs)) as Partial<Embedding>;
      if (answer.model !== model) {
        throw new Error(
          `the embedder at ${this.url.origin} embedded with ${answer.model} where this server expects ${model}: set the same EMBEDDER_ROUTING and EMBEDDER_MODEL on both`,
        );
      }
      if (!Array.isArray(answer.vectors) || answer.vectors.length !== texts.length) {
        throw new Error(`the embedder at ${this.url.origin} answered ${answer.vectors?.length} vectors for ${texts.length} texts`);
      }
      took();
      return { model, vectors: answer.vectors };
    } catch (error) {
      embedFailures.inc({ model, reason: error instanceof EmbedderUnavailable ? 'unavailable' : error instanceof Late ? 'timeout' : 'error' });
      throw error;
    }
  }

  warm(plotLanguage: ContentLanguage): void {
    if (!this.modelFor(plotLanguage) || Date.now() < this.unreachableUntil) return;
    this.call('POST', '/warm', { plotLanguage }, CHECK_TIMEOUT_MS).catch(() => undefined);
  }

  async close(): Promise<void> {
    for (const req of this.open) req.destroy(new Error('embedder closed'));
    this.open.clear();
  }

  /** Asks the listener which model it runs for each language, and says where that is not this server's. */
  check(): void {
    this.call('GET', '/models', undefined, CHECK_TIMEOUT_MS).then(
      (answer) => {
        const models = (answer as { models?: Partial<Record<ContentLanguage, string | null>> }).models ?? {};
        for (const language of LANGUAGES) {
          const ours = routeOf(this.routes, language);
          const theirs = models[language] ?? null;
          if (theirs === null) {
            this.cannotRun.add(language);
            console.warn(`[embedder] the embedder at ${this.url.origin} cannot run ${ours} (never fetched there); ${language} plots search nothing by meaning`);
          } else if (theirs !== ours) {
            console.warn(
              `[embedder] the embedder at ${this.url.origin} runs ${theirs} for ${language} plots where this server expects ${ours}; ` +
                'their embeds fail until EMBEDDER_ROUTING and EMBEDDER_MODEL agree',
            );
          }
        }
      },
      (error: unknown) => {
        console.warn(`[embedder] the embedder at ${this.url.origin} did not answer (${error instanceof Error ? error.message : error}); searches fall back until it does`);
      },
    );
  }

  /** One request, on a connection of its own: a dead embedder shows in the connecting, which is timed apart from the answer. */
  private call(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(new URL(path, this.url), {
        method,
        agent: false,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
      });
      this.open.add(req);
      let connected = false;
      let settled = false;
      let connecting: NodeJS.Timeout | undefined;
      const finish = (error: Error | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(connecting);
        this.open.delete(req);
        if (!error) return resolve(value);
        if (connected) return reject(error);
        this.unreachableUntil = Date.now() + this.options.retryMs;
        this.lastFailure = error;
        console.warn(`[embedder] cannot reach the embedder at ${this.url.origin} (${error.message}); searches fall back for ${this.options.retryMs / 1000} s`);
        reject(new Unreachable(`cannot reach the embedder at ${this.url.origin}: ${error.message}`, { cause: error }));
      };
      const deadline = setTimeout(() => {
        finish(connected ? new Late(`embedding took longer than ${timeoutMs} ms`) : new Error(`no connection within ${timeoutMs} ms`));
        req.destroy();
      }, timeoutMs);
      req.on('socket', (socket) => {
        if (!socket.connecting) {
          connected = true;
          return;
        }
        connecting = setTimeout(() => {
          finish(new Error(`no connection within ${this.options.connectTimeoutMs} ms`));
          req.destroy();
        }, this.options.connectTimeoutMs);
        socket.once('connect', () => {
          connected = true;
          clearTimeout(connecting);
        });
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (error) => finish(error));
        res.on('close', () => {
          if (!res.complete) finish(new Error(`the embedder at ${this.url.origin} closed the connection mid-answer`));
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // Said below by its status.
          }
          if (res.statusCode === 200 || res.statusCode === 204) return finish(null, parsed);
          const said = (parsed as { error?: unknown } | null)?.error;
          const message = `the embedder at ${this.url.origin} answered ${res.statusCode}${typeof said === 'string' ? `: ${said}` : ''}`;
          finish(res.statusCode === 503 ? new EmbedderUnavailable(message) : new Error(message));
        });
      });
      req.on('error', (error) => finish(error));
      req.end(payload);
    });
  }
}
