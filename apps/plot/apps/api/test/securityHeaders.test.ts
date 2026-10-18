import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/deps.js';
import { originGuard } from '../src/originGuard.js';
import { securityHeaders } from '../src/securityHeaders.js';

function appFor(webOrigin: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', securityHeaders());
  app.use('*', originGuard(webOrigin));
  app.onError((_error, c) => c.json({ error: 'Internal error', code: 'internal' }, 500));
  app.get('/api/json', (c) => c.json({ ok: true }));
  // A stored file, answered as `assetResponse` does: a Response of its own, not Hono's.
  app.get('/api/file', () => new Response('<svg onload="alert(1)"/>', { headers: { 'Content-Type': 'image/png' } }));
  app.get('/api/throws', () => {
    throw new Error('boom');
  });
  return app;
}

describe('security headers', () => {
  const app = appFor('https://plot.example');

  it('are on every answer: JSON, a file, an error and a refusal', async () => {
    const answers = [
      await app.request('http://10.0.0.5:8787/api/json'),
      await app.request('http://10.0.0.5:8787/api/file'),
      await app.request('http://10.0.0.5:8787/api/throws'),
      await app.request('http://10.0.0.5:8787/api/json', { headers: { origin: 'https://evil.example' } }),
    ];
    expect(answers.map((res) => res.status)).toEqual([200, 200, 500, 403]);
    for (const res of answers) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    }
  });
});
