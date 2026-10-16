/**
 * The log's two shapes (`LOG_FORMAT`, ARCHITECTURE §12 운영) and the request
 * every line of a request is said under.
 *
 * `text`, the default, is the console as it always was — what a developer reads
 * in a terminal, `[cache]` lines and all. `json`, for production, puts a wrapper
 * over the console once at startup (`installJsonConsole`), so every `console.*`
 * call, ours and the libraries', goes out as one JSON line: `{time, level, msg,
 * component?, requestId?, err?}`. `msg` is the call's arguments as the console
 * would print them, less the first Error, which goes to `err` with its stack; a
 * leading `[tag]` becomes `component`; `requestId` is the request the line was
 * said under (`requestContext`), which AsyncLocalStorage carries across its
 * awaits — into the background work a turn starts, too. Json mode also writes
 * one access line per request (`requestLog`); text mode does not, so the
 * terminal reads as it did.
 *
 * Nothing here reads a body, a cookie or an auth header: a line holds what its
 * call passed, and the access line the method, the route's pattern, the
 * status, the time, the request id and who was signed in.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { format } from 'node:util';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import type { AppEnv } from './deps.js';
import { httpDuration, httpRequests } from './metrics.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The request a line is said under. */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

const LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' } as const;
type ConsoleMethod = keyof typeof LEVELS;

/** `[cache] …`, `[embedder] …`: the tag the code's own lines start with. */
const TAG = /^\[([a-z][a-z0-9_:-]{0,31})\]\s*/;

/** Writes a finished JSON line through the console's own method; null in text mode. */
let writeJson: ((method: ConsoleMethod, line: string) => void) | null = null;

/** One console call as a JSON line's fields. */
export function jsonRecord(level: LogLevel, args: readonly unknown[]): Record<string, unknown> {
  const at = args.findIndex((arg) => arg instanceof Error);
  const error = at >= 0 ? (args[at] as Error & { code?: unknown }) : undefined;
  let msg = format(...args.filter((_, index) => index !== at));
  const tag = TAG.exec(msg);
  if (tag) msg = msg.slice(tag[0].length);
  const requestId = requestContext.getStore()?.requestId;
  return {
    time: new Date().toISOString(),
    level,
    msg,
    ...(tag ? { component: tag[1] } : {}),
    ...(requestId ? { requestId } : {}),
    ...(error
      ? {
          err: {
            name: error.name,
            message: error.message,
            stack: error.stack,
            ...(typeof error.code === 'string' || typeof error.code === 'number' ? { code: error.code } : {}),
          },
        }
      : {}),
  };
}

/**
 * Json mode: every `console.log/info/warn/error/debug` from here on writes one
 * JSON line through the method it replaced, so each level keeps its stream.
 * Answers the undoing, for tests.
 */
export function installJsonConsole(target: Pick<Console, ConsoleMethod> = console): () => void {
  const originals = { log: target.log, info: target.info, warn: target.warn, error: target.error, debug: target.debug };
  writeJson = (method, line) => originals[method].call(target, line);
  for (const method of Object.keys(LEVELS) as ConsoleMethod[]) {
    target[method] = (...args: unknown[]) => writeJson?.(method, JSON.stringify(jsonRecord(LEVELS[method], args)));
  }
  return () => {
    Object.assign(target, originals);
    writeJson = null;
  };
}

/** A safe id a proxy in front may already have given the request; anything else gets one of ours. */
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
/** The probes, asked every few seconds: neither logged nor counted. */
const PROBES = new Set(['/api/health', '/api/ready']);

/**
 * First in front of every route: the request's id — echoed as `x-request-id` —
 * for every line said under it, and once it is answered the access line (json
 * mode) and the http metrics, by the route's pattern. A stream is answered when
 * it starts, so its time is to its first byte, not its last.
 */
export function requestLog(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming !== undefined && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const started = performance.now();
    await requestContext.run({ requestId }, next);
    // After `next`: set before it, the header misses a handler's own Response (a stream's, the auth handler's).
    c.header('x-request-id', requestId);
    if (PROBES.has(c.req.path)) return;
    const seconds = (performance.now() - started) / 1000;
    // The pattern of the deepest handler reached — `/api/chats/:id`, or `/api/*` for a request nothing answered.
    const route = routePath(c);
    const { method } = c.req;
    const { status } = c.res;
    httpRequests.inc({ method, route, status });
    httpDuration.observe({ method, route }, seconds);
    const userId = c.get('viewerId') ?? undefined;
    writeJson?.(
      'info',
      JSON.stringify({
        time: new Date().toISOString(),
        level: 'info',
        msg: `${method} ${route} ${status}`,
        component: 'http',
        requestId,
        method,
        route,
        status,
        durationMs: Math.round(seconds * 1000),
        ...(userId ? { userId } : {}),
      }),
    );
  };
}
