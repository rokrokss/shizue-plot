/**
 * The app's one process on one port (`server.ts`), over real sockets: the API
 * answers `/api/*` with the Node request in hand — the owner gate reads the
 * connection from it — the web app everything else, a browser that came by a
 * loopback address is sent to `localhost` while a tunnel's request is not, both
 * loopbacks are served, a reply's stream goes out as it is written, and a port
 * another program holds is refused.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/deps.js';
import { appRequestListener, listenOnLoopback, localhostRedirect, PortTaken, type WebApp } from '../src/server.js';
import { isLocalRequest } from '../src/session.js';

const request = (host: string | undefined, headers: Record<string, string> = {}, url = '/ko/settings'): IncomingMessage =>
  ({ url, headers: { ...(host === undefined ? {} : { host }), ...headers } }) as unknown as IncomingMessage;

describe('the redirect to localhost', () => {
  it('sends a browser that came by a loopback address to localhost, port and path kept', () => {
    expect(localhostRedirect(request('127.0.0.1:13000', {}, '/ko/chats?x=1'))).toBe('http://localhost:13000/ko/chats?x=1');
    expect(localhostRedirect(request('[::1]:13000'))).toBe('http://localhost:13000/ko/settings');
    expect(localhostRedirect(request('127.0.0.1'))).toBe('http://localhost/ko/settings');
  });
  it('leaves localhost, other hosts, and whatever came through a tunnel or a proxy', () => {
    for (const host of ['localhost:13000', 'LOCALHOST:13000', 'mac.example.ts.net:8444', '192.168.0.20:13000', undefined]) {
      expect(localhostRedirect(request(host)), String(host)).toBeNull();
    }
    for (const [name, value] of [
      ['x-forwarded-for', '100.101.102.103'],
      ['x-forwarded-host', 'mac.example.ts.net:8444'],
      ['cf-connecting-ip', '203.0.113.7'],
      ['tailscale-user-login', 'owner@example.com'],
      ['forwarded', 'for=203.0.113.7'],
    ] as const) {
      expect(localhostRedirect(request('127.0.0.1:13000', { [name]: value })), name).toBeNull();
    }
  });
});

/** A port nothing listens on at either loopback, as far as one can tell. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

interface Answer {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

/** Asks `address:port` with these headers, over a socket of its own. */
function ask(port: number, path: string, options: { address?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest({ host: options.address ?? '127.0.0.1', port, path, headers: options.headers ?? {} }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    sent.on('error', reject);
    sent.end();
  });
}

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** The process's listener on a free port: a stand-in web app, and an API whose routes say what the gate saw. */
async function serve(): Promise<{ port: number; pages: string[]; release: () => void }> {
  const pages: string[] = [];
  const web: WebApp = {
    handle: async (incoming, response) => {
      pages.push(incoming.url ?? '');
      response.writeHead(200, { 'content-type': 'text/html' }).end('<p>page</p>');
    },
    close: async () => undefined,
  };
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const api = new Hono<AppEnv>();
  // As app.ts limits every body: a body without a length is read and the request copied.
  api.use('/api/*', bodyLimit({ maxSize: 64, onError: (c) => c.json({ code: 'payload_too_large' }, 413) }));
  api.on(['GET', 'POST', 'DELETE'], '/api/who', (c) => c.json({ local: isLocalRequest(c) }));
  api.delete('/api/thing', (c) => c.json({ deleted: true }));
  api.post('/api/echo', async (c) => c.json({ got: await c.req.text() }));
  api.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: 'first' });
      await held;
      await stream.writeSSE({ data: 'second' });
    }),
  );
  const server: Server = createServer(appRequestListener(api.fetch, web));
  const port = await freePort();
  const stop = await listenOnLoopback(server, port);
  closers.push(() => {
    release();
    stop();
    server.closeAllConnections();
  });
  return { port, pages, release };
}

describe('the one port', () => {
  it('hands /api to the API with the connection, so the gate reads it, and the rest to the web app', async () => {
    const { port, pages } = await serve();
    const who = async (headers: Record<string, string>, address?: string): Promise<unknown> =>
      JSON.parse((await ask(port, '/api/who', { headers, ...(address ? { address } : {}) })).body);
    expect(await who({ host: `localhost:${port}` })).toEqual({ local: true });
    expect(await who({ host: `localhost:${port}` }, '::1')).toEqual({ local: true });
    // A page on another site whose name resolves here, and a tunnel delivering to 127.0.0.1.
    expect(await who({ host: `evil.example:${port}` })).toEqual({ local: false });
    expect(await who({ host: 'quiet-words.trycloudflare.com', 'cf-connecting-ip': '203.0.113.7' })).toEqual({ local: false });
    expect(await who({ host: `127.0.0.1:${port}`, 'x-forwarded-for': '100.101.102.103' })).toEqual({ local: false });

    const page = await ask(port, '/ko/settings', { headers: { host: `localhost:${port}` } });
    expect(page.status).toBe(200);
    expect(page.body).toBe('<p>page</p>');
    expect(pages).toEqual(['/ko/settings']);
    // `/api` is a prefix of paths, not of names.
    await ask(port, '/apiary', { headers: { host: `localhost:${port}` } });
    expect(pages).toEqual(['/ko/settings', '/apiary']);
  });

  it('gives the API requests it can copy: a body-less DELETE, and a body sent without a length', async () => {
    const { port } = await serve();
    const send = (method: string, path: string, chunks: string[]): Promise<Answer> =>
      new Promise((resolve, reject) => {
        // No content-length: a DELETE sends none, and written chunks go out chunked.
        const sent = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host: `localhost:${port}` } }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
        });
        sent.on('error', reject);
        for (const chunk of chunks) sent.write(chunk);
        sent.end();
      });
    const deleted = await send('DELETE', '/api/thing', []);
    expect([deleted.status, JSON.parse(deleted.body)]).toEqual([200, { deleted: true }]);
    // The remade request keeps what the gate reads: the host it was sent to, and a tunnel's marks.
    const who = async (method: string, headers: Record<string, string>): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const sent = httpRequest({ host: '127.0.0.1', port, path: '/api/who', method, headers }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () => resolve(JSON.parse(body)));
        });
        sent.on('error', reject);
        sent.end();
      });
    for (const method of ['POST', 'DELETE']) {
      expect(await who(method, { host: `localhost:${port}` }), method).toEqual({ local: true });
      expect(await who(method, { host: `evil.example:${port}` }), method).toEqual({ local: false });
      expect(await who(method, { host: `localhost:${port}`, 'x-forwarded-for': '100.101.102.103' }), method).toEqual({ local: false });
    }
    const echoed = await send('POST', '/api/echo', ['hello ', 'there']);
    expect([echoed.status, JSON.parse(echoed.body)]).toEqual([200, { got: 'hello there' }]);
    expect((await send('POST', '/api/echo', ['x'.repeat(40), 'y'.repeat(40)])).status).toBe(413);
  });

  it('sends a browser at 127.0.0.1 to localhost, for the API too, and never caches it', async () => {
    const { port, pages } = await serve();
    for (const path of ['/ko/chats', '/api/who']) {
      const moved = await ask(port, path, { headers: { host: `127.0.0.1:${port}` } });
      expect(moved.status).toBe(307);
      expect(moved.headers.location).toBe(`http://localhost:${port}${path}`);
      expect(moved.headers['cache-control']).toBe('no-store');
    }
    expect(pages).toEqual([]);
  });

  it('sends a reply event by event, as the API writes it', async () => {
    const { port, release } = await serve();
    const { headers, first } = await new Promise<{ headers: IncomingMessage['headers']; first: string }>((resolve, reject) => {
      const sent = httpRequest({ host: '127.0.0.1', port, path: '/api/stream', headers: { host: `localhost:${port}`, 'accept-encoding': 'gzip' } }, (response) => {
        response.setEncoding('utf8');
        // The second event waits on `release`: this arrives only if the first was not held back.
        response.once('data', (chunk: string) => resolve({ headers: response.headers, first: chunk }));
      });
      sent.on('error', reject);
      sent.end();
    });
    expect(headers['content-type']).toMatch(/text\/event-stream/);
    expect(headers['content-encoding']).toBeUndefined();
    expect(first).toContain('data: first');
    release();
  });
});

describe('listening', () => {
  it('serves both loopbacks on the one port', async () => {
    const { port } = await serve();
    for (const address of ['127.0.0.1', '::1']) {
      expect((await ask(port, '/api/who', { address, headers: { host: `localhost:${port}` } })).status, address).toBe(200);
    }
  });

  it('refuses a port another program answers on, at either loopback or on every address', async () => {
    for (const host of ['127.0.0.1', '::1', '0.0.0.0', '::']) {
      const port = await freePort();
      const holder: NetServer = createNetServer((socket) => socket.end());
      await new Promise<void>((resolve) => holder.listen(port, host, resolve));
      const server = createServer();
      await expect(listenOnLoopback(server, port), host).rejects.toBeInstanceOf(PortTaken);
      expect(server.listening).toBe(false);
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});
