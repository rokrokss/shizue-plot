/**
 * The app's one process on one port (ARCHITECTURE §2): the API answers `/api/*`
 * and the web app — Next, run inside this process — everything else, on both of
 * this computer's loopbacks. Nothing here decides who is asking: the API's own
 * gate does (`session.ts`), from the Node request this hands it.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { connect, createServer as createNetServer, type Server as NetServer } from 'node:net';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';

/** The web app as this process runs it. */
export interface WebApp {
  /** Answers a request that is not the API's. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** Lets go of what it holds: under `next dev`, the compiler and its watchers. */
  close(): Promise<void>;
}

/** The part of Next's custom server (`next({…})`) this uses. */
interface NextServer {
  prepare(): Promise<void>;
  getRequestHandler(): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  close(): Promise<void>;
}
type CreateNext = (options: { dev: boolean; dir: string; hostname: string; port: number; httpServer: Server }) => NextServer;

/**
 * Next for the web app in `dir`: `next dev` on its sources, or its production
 * build (`.next`). Next is the web app's dependency rather than the API's, so it
 * is found from that folder — the checkout's `apps/web`, or the published
 * package's `web/`. `server` is the HTTP server it is served on: Next answers the
 * dev server's socket upgrades there (its hot reload) by itself.
 *
 * The process works from that folder from here on, as `next dev` and `next build`
 * do: Next loads `next.config.ts` as a module with no file of its own, whose
 * relative imports resolve against the working directory. Nothing else in the
 * app depends on the working directory: every path it opens is absolute.
 */
export async function loadWebApp(options: { dir: string; dev: boolean; port: number; server: Server }): Promise<WebApp> {
  process.chdir(options.dir);
  const next = createRequire(join(options.dir, 'package.json'))('next') as CreateNext;
  const app = next({ dev: options.dev, dir: options.dir, hostname: 'localhost', port: options.port, httpServer: options.server });
  await app.prepare();
  return { handle: app.getRequestHandler(), close: () => app.close() };
}

/** `/api` and everything under it is the API's; the rest is the web app's. */
const API_PATH = /^\/api(?:[/?#]|$)/;

/**
 * What a tunnel or a proxy in front of the app leaves on a request — the marks
 * the owner gate reads (`session.ts`) and `x-forwarded-host`. Such a request came
 * to this computer from elsewhere, so it is never sent on to `localhost`: a
 * phone's `localhost` is the phone.
 */
const FORWARDED = ['x-forwarded-host', 'x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'tailscale-user-login', 'tailscale-user-name'];

/**
 * Where a browser on this computer that opened the app at `127.0.0.1` or `[::1]`
 * is sent instead: the same port and path at `localhost`, the one origin the
 * ChatGPT connection's attempt cookie lives on (the Shizue extension brings the
 * sign-in back there). Null for every other request.
 */
export function localhostRedirect(request: IncomingMessage): string | null {
  const host = request.headers.host;
  if (!host || FORWARDED.some((name) => request.headers[name] !== undefined)) return null;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return null;
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') return null;
  const path = request.url?.startsWith('/') ? request.url : '/';
  return `http://localhost${url.port ? `:${url.port}` : ''}${path}`;
}

/**
 * A request that may carry a body, as the global `Request` makes it.
 * @hono/node-server hands out a lightweight request of its own, which only its
 * own `Request` class can copy — and Hono's body limit copies the request whose
 * body it read without a length (`new Request(c.req.raw, …)`), with the global
 * class here, which takes the lightweight one for a URL and throws. The copy's
 * signal follows the original's, which ends when the browser goes away.
 */
function standardRequest(request: Request): Request {
  if (request.method === 'GET' || request.method === 'HEAD') return request;
  return new Request(request.url, { method: request.method, headers: request.headers, body: request.body, duplex: 'half', signal: request.signal });
}

/**
 * The process's request listener: the redirect above, then `/api/*` to the API
 * — through `@hono/node-server`, which hands it the Node request as
 * `c.env.incoming`, the connection the owner gate reads the address of — and the
 * rest to the web app. No compression and no buffering stand in between, so an
 * event stream goes out as the API writes it. The global `Request` and
 * `Response` stay the platform's (`overrideGlobalObjects`): they are Next's as well.
 */
export function appRequestListener(
  api: Parameters<typeof getRequestListener>[0],
  web: WebApp,
): (request: IncomingMessage, response: ServerResponse) => void {
  const answerApi = getRequestListener((request, env) => api(standardRequest(request), env), { overrideGlobalObjects: false });
  return (request, response) => {
    const redirect = localhostRedirect(request);
    if (redirect) {
      response.writeHead(307, { location: redirect, 'cache-control': 'no-store' }).end();
      return;
    }
    if (API_PATH.test(request.url ?? '/')) {
      void answerApi(request, response);
      return;
    }
    web.handle(request, response).catch((error: unknown) => {
      console.error('[web] request failed', error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  };
}

/** Another program already answers on the port, or holds it. */
export class PortTaken extends Error {
  constructor(readonly port: number) {
    super(`port ${port} is already in use`);
  }
}

/** Whether something accepts a connection on `port` at this loopback address. */
function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const settle = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2_000, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

/**
 * Whether another program answers on `port` at either loopback. Asked before
 * binding, as the bind alone does not tell: macOS lets a bind to a loopback
 * address through under another program's wildcard one, which would then lose
 * its `localhost` connections to this app.
 */
export async function portTaken(port: number): Promise<boolean> {
  const answered = await Promise.all(['127.0.0.1', '::1'].map((host) => answers(port, host)));
  return answered.includes(true);
}

function listen(target: NetServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: NodeJS.ErrnoException): void => reject(error.code === 'EADDRINUSE' ? new PortTaken(port) : error);
    target.once('error', fail);
    target.listen({ port, host }, () => {
      target.off('error', fail);
      resolve();
    });
  });
}

/**
 * Serves `server` on `port` at both loopbacks: 127.0.0.1, where the phone
 * tunnels deliver (`tunnel.ts`), and ::1, where macOS sends `localhost` first.
 * The server listens on 127.0.0.1 itself and is handed every connection ::1
 * accepts, so the two share its timeouts and its upgrades (Next's hot reload).
 * A computer without IPv6 is served on 127.0.0.1 alone. Throws `PortTaken`;
 * resolves to what stops both from taking new connections.
 */
export async function listenOnLoopback(server: Server, port: number): Promise<() => void> {
  if (await portTaken(port)) throw new PortTaken(port);
  await listen(server, port, '127.0.0.1');
  const v6 = createNetServer((socket) => server.emit('connection', socket));
  try {
    await listen(v6, port, '::1');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT') {
      server.close();
      throw error;
    }
    console.warn('[shizue] this computer has no IPv6 loopback; listening on 127.0.0.1 alone');
    return () => void server.close();
  }
  return () => {
    v6.close();
    server.close();
  };
}
