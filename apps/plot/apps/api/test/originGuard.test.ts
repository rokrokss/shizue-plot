import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { originGuard } from '../src/originGuard.js';
import type { AppEnv } from '../src/deps.js';

describe('origin guard', () => {
  const app = new Hono<AppEnv>();
  app.use('*', originGuard('https://plot.example'));
  app.all('*', (c) => c.text('ok'));
  it('accepts reads, origin-less navigations and same-origin writes, wherever the API runs', async () => {
    expect((await app.request('http://10.0.0.5:8787/api/models')).status).toBe(200);
    // The sign-in callback: a top-level navigation the extension redirected.
    expect((await app.request('http://10.0.0.5:8787/api/chatgpt/callback?state=s', { headers: { 'sec-fetch-site': 'none' } })).status).toBe(200);
    expect((await app.request('http://10.0.0.5:8787/api/chatgpt/sign-in', { method: 'POST', headers: { origin: 'https://plot.example' } })).status).toBe(200);
  });
  it('rejects foreign origins and writes without an origin', async () => {
    expect((await app.request('http://10.0.0.5:8787/api/chatgpt/sign-in', { method: 'POST' })).status).toBe(403);
    expect((await app.request('http://10.0.0.5:8787/api/chatgpt/sign-in', { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await app.request('http://10.0.0.5:8787/api/chats', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });
  it('rejects DNS rebinding through a proxy that rewrites the upstream Host', async () => {
    for (const host of ['evil.example', 'plot.example:9999', 'plot.example, evil.example', '']) {
      expect((await app.request('http://127.0.0.1:8787/api/chats', { headers: { 'x-forwarded-host': host } })).status).toBe(403);
    }
    expect((await app.request('http://127.0.0.1:8787/api/chats', { headers: { 'x-forwarded-host': 'plot.example' } })).status).toBe(200);
  });
});
