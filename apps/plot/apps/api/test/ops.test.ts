import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Db } from '@shizue/db';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppDeps, AppEnv } from '../src/deps.js';
import { errorResponse } from '../src/errors.js';
import { healthRoutes } from '../src/health.js';
import { createBackgroundTasks, onUnhandledRejection } from '../src/lifecycle.js';
import { installJsonConsole, requestLog } from '../src/log.js';
import { originGuard } from '../src/originGuard.js';
import { startMetricsServer } from '../src/metrics.js';

/** A database whose `select 1` does what `execute` says; anything else it is asked fails the test. */
const fakeDb = (execute: () => Promise<unknown>): Db =>
  new Proxy({ execute: vi.fn(execute) }, {
    get: (target, key) => {
      if (key === 'execute') return target.execute;
      throw new Error(`the probe touched db.${String(key)}`);
    },
  }) as unknown as Db;

/** Just enough of the deps for `createApp`: a session lookup that must never run for a probe. */
const fakeDeps = (db: Db, extra: Partial<AppDeps> = {}): AppDeps =>
  ({
    db,
    webOrigin: 'https://plot.example',
    auth: { handler: () => new Response(null, { status: 404 }), api: { getSession: vi.fn(async () => null) } },
    env: {},
    generationStreams: new Set(),
    ...extra,
  }) as unknown as AppDeps;

describe('the probes', () => {
  it('answer health without the database or a session, directly and through the web proxy', async () => {
    const deps = fakeDeps(fakeDb(() => Promise.reject(new Error('down'))));
    const app = createApp(deps);
    // A probe at the API's own address carries no Origin and no forwarded host.
    const direct = await app.request('http://10.0.0.5:8787/api/health');
    expect(direct.status).toBe(200);
    expect(await direct.json()).toEqual({ status: 'ok' });
    // One through Next's rewrite carries the web app's host.
    const proxied = await app.request('http://127.0.0.1:8787/api/health', { headers: { 'x-forwarded-host': 'plot.example' } });
    expect(proxied.status).toBe(200);
    expect((await app.request('http://127.0.0.1:8787/api/ready', { headers: { 'x-forwarded-host': 'plot.example' } })).status).toBe(503);
    expect(deps.auth.api.getSession).not.toHaveBeenCalled();
    expect(deps.db.execute).toHaveBeenCalledTimes(1);
  });

  it('answer ready while the database answers, and 503 once draining or when it fails', async () => {
    const deps = fakeDeps(fakeDb(() => Promise.resolve([{ '?column?': 1 }])));
    const app = createApp(deps);
    const ready = await app.request('http://10.0.0.5:8787/api/ready');
    expect([ready.status, await ready.json()]).toEqual([200, { status: 'ready' }]);

    deps.draining = true;
    const draining = await app.request('http://10.0.0.5:8787/api/ready');
    expect([draining.status, await draining.json()]).toEqual([503, { status: 'draining' }]);

    const down = createApp(fakeDeps(fakeDb(() => Promise.reject(new Error('connection refused')))));
    const failed = await down.request('http://10.0.0.5:8787/api/ready');
    expect([failed.status, await failed.json()]).toEqual([503, { status: 'db_unavailable' }]);
    expect(deps.auth.api.getSession).not.toHaveBeenCalled();
  });

  it('answer not ready when the database leaves select 1 hanging past two seconds', async () => {
    vi.useFakeTimers();
    try {
      const app = new Hono<AppEnv>().route('/api', healthRoutes(fakeDeps(fakeDb(() => new Promise(() => {})))));
      const pending = app.request('/api/ready');
      await vi.advanceTimersByTimeAsync(2_000);
      const res = await pending;
      expect([res.status, await res.json()]).toEqual([503, { status: 'db_unavailable' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pass the origin guard only as the web app or a bare probe', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', originGuard('https://plot.example'));
    app.route('/api', healthRoutes(fakeDeps(fakeDb(() => Promise.resolve([])))));
    expect((await app.request('http://10.0.0.5:8787/api/ready')).status).toBe(200);
    expect((await app.request('http://10.0.0.5:8787/api/ready', { headers: { 'x-forwarded-host': 'plot.example' } })).status).toBe(200);
    expect((await app.request('http://10.0.0.5:8787/api/health', { headers: { 'x-forwarded-host': 'evil.example' } })).status).toBe(403);
  });
});

describe('the json log', () => {
  /** What reached the console's own methods, one entry per call. */
  let written: { method: string; text: string }[];
  let uninstall: () => void;
  beforeEach(() => {
    written = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void written.push({ method, text: args.map(String).join(' ') }));
    }
    uninstall = installJsonConsole();
  });
  afterEach(() => {
    uninstall();
    vi.restoreAllMocks();
  });
  const lines = () => written.map(({ method, text }) => ({ method, record: JSON.parse(text) as Record<string, unknown> }));

  const app = (): Hono<AppEnv> => {
    const app = new Hono<AppEnv>();
    app.use('*', requestLog());
    app.post('/api/plots/:id', async (c) => {
      await c.req.json();
      console.log('[plots] saved', c.req.param('id'));
      return c.json({ ok: true });
    });
    // A handler's own Response, as a stream or the auth handler gives one.
    app.get('/api/raw', () => new Response('raw'));
    app.get('/api/health', (c) => c.json({ status: 'ok' }));
    app.get('/api/boom', () => {
      throw new Error('boom');
    });
    app.onError((error, c) => errorResponse(c, error));
    return app;
  };

  it('says every line of a request under its echoed id, and the access line by its pattern without the body', async () => {
    const secret = 'card text that must never be logged';
    const res = await app().request('/api/plots/0b6f7c1e-1111-4222-8333-444455556666?draft=1', {
      method: 'POST',
      headers: { 'x-request-id': 'edge-42', 'content-type': 'application/json', cookie: 'session=secret-cookie' },
      body: JSON.stringify({ text: secret }),
    });
    expect(res.headers.get('x-request-id')).toBe('edge-42');

    const [said, access] = lines();
    expect(said).toEqual({
      method: 'log',
      record: { time: expect.any(String), level: 'info', msg: 'saved 0b6f7c1e-1111-4222-8333-444455556666', component: 'plots', requestId: 'edge-42' },
    });
    expect(access).toEqual({
      method: 'info',
      record: {
        time: expect.any(String),
        level: 'info',
        msg: 'POST /api/plots/:id 200',
        component: 'http',
        requestId: 'edge-42',
        method: 'POST',
        route: '/api/plots/:id',
        status: 200,
        durationMs: expect.any(Number),
      },
    });
    expect(written).toHaveLength(2);
    for (const { text } of written) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain('secret-cookie');
      expect(text).not.toContain('draft=1');
    }
  });

  it('gives a request without a safe id one of its own, on a raw Response too', async () => {
    const res = await app().request('/api/raw', { headers: { 'x-request-id': `"forged" ${'x'.repeat(80)}` } });
    expect(await res.text()).toBe('raw');
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines().map(({ record }) => record['requestId'])).toEqual([id]);
  });

  it('puts an error in err with its stack, and leaves the probes out', async () => {
    expect((await app().request('/api/health')).status).toBe(200);
    expect(written).toEqual([]);

    const res = await app().request('/api/boom');
    expect(res.status).toBe(500);
    const id = res.headers.get('x-request-id');
    const [error, access] = lines();
    expect(error?.method).toBe('error');
    expect(error?.record).toMatchObject({
      level: 'error',
      msg: `unhandled error in GET /api/boom (request ${id})`,
      component: 'api',
      requestId: id,
      err: { name: 'Error', message: 'boom' },
    });
    expect((error?.record['err'] as { stack: string }).stack).toContain('ops.test.ts');
    expect(access?.record).toMatchObject({ route: '/api/boom', status: 500 });
  });
});

describe('an unhandled rejection', () => {
  it('is logged and leaves the process running', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const reason = new Error('a promise nobody awaited');
      onUnhandledRejection(reason);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('unhandled promise rejection'), reason);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('the metrics', () => {
  it('are served as Prometheus text on their own listener, and never under /api', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = fakeDeps(fakeDb(() => Promise.resolve([])));
    const server = startMetricsServer(deps, createBackgroundTasks(), { port: 0, host: '127.0.0.1' });
    try {
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      // A request through the app first, so its counter has a series to show.
      expect((await createApp(deps).request('http://10.0.0.5:8787/api/metrics')).status).toBe(404);
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const text = await res.text();
      expect(text).toContain('http_requests_total{method="GET",route="/api/*",status="404"}');
      expect(text).toContain('generation_streams_active 0');
      expect(text).toContain('process_resident_memory_bytes');
      expect((await fetch(`http://127.0.0.1:${port}/api/metrics`)).status).toBe(404);
    } finally {
      server.close();
      info.mockRestore();
    }
  });
});

describe('the background drain', () => {
  it('waits for a running task, and gives up at its deadline', async () => {
    const background = createBackgroundTasks();
    let finish!: () => void;
    background.track(new Promise<void>((resolve) => (finish = resolve)), 'memory');
    expect(background.inFlight()).toEqual(new Map([['memory', 1]]));
    const drained = background.drain(5_000);
    setTimeout(finish, 20);
    expect(await drained).toBe(0);
    expect(background.inFlight()).toEqual(new Map());

    background.track(new Promise<void>(() => {}), 'vectors');
    const started = Date.now();
    expect(await background.drain(50)).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(background.inFlight()).toEqual(new Map([['vectors', 1]]));
  });
});
