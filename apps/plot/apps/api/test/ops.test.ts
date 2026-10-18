import type { Db } from '@shizue/db';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppDeps, AppEnv } from '../src/deps.js';
import { healthRoutes } from '../src/health.js';
import { createBackgroundTasks, onUnhandledRejection } from '../src/lifecycle.js';
import { originGuard } from '../src/originGuard.js';

/** A database that fails the test if the probe touches it at all. */
const untouchedDb = (): Db =>
  new Proxy({}, {
    get: (_target, key) => {
      throw new Error(`the probe touched db.${String(key)}`);
    },
  }) as unknown as Db;

/**
 * Just enough of the deps for `createApp`. The gate in front of everything but
 * the probe reads the database for the owner and a phone's session (`ownerGate`),
 * and `untouchedDb` fails the test if the probe gets that far.
 */
const fakeDeps = (db: Db, extra: Partial<AppDeps> = {}): AppDeps =>
  ({
    db,
    webOrigin: 'https://plot.example',
    env: {},
    generationStreams: new Set(),
    ...extra,
  }) as unknown as AppDeps;

describe('the probe', () => {
  it('answers health without the database or a session, directly and through the web proxy', async () => {
    const app = createApp(fakeDeps(untouchedDb()));
    // A probe at the API's own address carries no Origin and no forwarded host.
    const direct = await app.request('http://10.0.0.5:8787/api/health');
    expect(direct.status).toBe(200);
    expect(await direct.json()).toEqual({ status: 'ok' });
    // One through Next's rewrite carries the web app's host.
    const proxied = await app.request('http://127.0.0.1:8787/api/health', { headers: { 'x-forwarded-host': 'plot.example' } });
    expect(proxied.status).toBe(200);
    // The readiness probe a balancer asked for is gone with the balancer.
    expect((await app.request('http://10.0.0.5:8787/api/ready')).status).toBe(401);
  });

  it('passes the origin guard only as the web app or a bare probe', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', originGuard('https://plot.example'));
    app.route('/api', healthRoutes());
    expect((await app.request('http://10.0.0.5:8787/api/health')).status).toBe(200);
    expect((await app.request('http://10.0.0.5:8787/api/health', { headers: { 'x-forwarded-host': 'plot.example' } })).status).toBe(200);
    expect((await app.request('http://10.0.0.5:8787/api/health', { headers: { 'x-forwarded-host': 'evil.example' } })).status).toBe(403);
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
