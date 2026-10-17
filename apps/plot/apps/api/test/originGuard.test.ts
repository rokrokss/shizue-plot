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

describe('origin guard with remote origins', () => {
  // The dev app on loopback, and a tunnel to it a phone opens.
  const app = new Hono<AppEnv>();
  app.use('*', originGuard('http://localhost:13000', ['https://mac.example.ts.net:8444']));
  app.all('*', (c) => c.text('ok'));
  const post = (headers: Record<string, string>): Promise<Response> =>
    Promise.resolve(app.request('http://127.0.0.1:8787/api/devices/claim', { method: 'POST', headers }));

  it('takes the tunnel as the app itself, by Origin and by forwarded Host', async () => {
    expect((await post({ origin: 'https://mac.example.ts.net:8444', 'x-forwarded-host': 'mac.example.ts.net:8444' })).status).toBe(200);
    expect((await post({ origin: 'http://localhost:13000', 'x-forwarded-host': 'localhost:13000' })).status).toBe(200);
    expect((await app.request('http://127.0.0.1:8787/api/chats', { headers: { 'x-forwarded-host': 'mac.example.ts.net:8444' } })).status).toBe(200);
  });
  it('still refuses every other origin and host, and writes without an origin', async () => {
    for (const origin of ['https://mac.example.ts.net', 'http://mac.example.ts.net:8444', 'https://evil.example']) {
      expect((await post({ origin })).status).toBe(403);
    }
    expect((await post({})).status).toBe(403);
    for (const host of ['mac.example.ts.net', 'evil.example', 'mac.example.ts.net:8444, evil.example']) {
      expect((await app.request('http://127.0.0.1:8787/api/chats', { headers: { 'x-forwarded-host': host } })).status).toBe(403);
    }
  });
});

describe('origin guard following a tunnel the settings page opens', () => {
  let tunnel: string | null = null;
  const app = new Hono<AppEnv>();
  app.use('*', originGuard('http://localhost:13000', () => (tunnel ? [tunnel] : [])));
  app.all('*', (c) => c.text('ok'));
  const post = (origin: string): Promise<Response> =>
    Promise.resolve(app.request('http://127.0.0.1:8787/api/devices/claim', { method: 'POST', headers: { origin } }));

  it('takes the tunnel only while it is open', async () => {
    expect((await post('https://words.trycloudflare.com')).status).toBe(403);
    tunnel = 'https://words.trycloudflare.com';
    expect((await post('https://words.trycloudflare.com')).status).toBe(200);
    tunnel = null;
    expect((await post('https://words.trycloudflare.com')).status).toBe(403);
    expect((await post('http://localhost:13000')).status).toBe(200);
  });
});
