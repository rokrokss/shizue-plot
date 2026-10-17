import { describe, expect, it } from 'vitest';
import { createPhoneAccess, type RunningCommand, type TunnelTools } from '../src/tunnel.js';

const WEB = 'http://localhost:13000';
const TARGET = 'http://127.0.0.1:13000';
const HOST = 'mac.example.ts.net';

interface FakeOptions {
  tailscale?: boolean;
  cloudflared?: boolean;
  /** Port → what it proxies to, as Tailscale Serve already has it. */
  served?: Record<number, string>;
  /** What cloudflared prints once started; it then keeps running unless `exits`. */
  cloudflareLines?: string[];
  exits?: boolean;
  serveFails?: boolean;
}

/** The commands `tunnel.ts` runs, answered as Tailscale and cloudflared answer them. */
function fakeTools(options: FakeOptions = {}) {
  const served = new Map<number, string>(Object.entries(options.served ?? {}).map(([port, target]) => [Number(port), target]));
  const calls: string[] = [];
  const stopped: string[] = [];
  const tools: TunnelTools = {
    run: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'cloudflared') {
        if (!options.cloudflared) throw new Error('command not found: cloudflared');
        return 'cloudflared version 2026.9.3';
      }
      if (!options.tailscale) throw new Error('command not found: tailscale');
      if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` } });
      if (args[1] === 'status') {
        return JSON.stringify({
          TCP: Object.fromEntries([...served.keys()].map((port) => [port, { HTTPS: true }])),
          Web: Object.fromEntries([...served].map(([port, target]) => [`${HOST}:${port}`, { Handlers: { '/': { Proxy: target } } }])),
        });
      }
      if (args[1] === '--bg') {
        if (options.serveFails) throw new Error('Access denied: serve config denied');
        served.set(Number(args[2]!.split('=')[1]), args[3]!);
        return '';
      }
      if (args[2] === 'off') {
        served.delete(Number(args[1]!.split('=')[1]));
        return '';
      }
      throw new Error(`unexpected: ${command} ${args.join(' ')}`);
    },
    start: (command, args, onLine) => {
      calls.push(`start ${command} ${args.join(' ')}`);
      let end: () => void = () => {};
      const exited = new Promise<void>((resolve) => {
        end = resolve;
      });
      const running: RunningCommand = {
        stop: () => {
          stopped.push(command);
          end();
        },
        exited,
      };
      setTimeout(() => {
        for (const line of options.cloudflareLines ?? []) onLine(line);
        if (options.exits) end();
      }, 5);
      return running;
    },
  };
  return { tools, served, calls, stopped };
}

describe('phone access tunnel', () => {
  it('is never built for a shizue that signs in anywhere but this machine', () => {
    expect(() => createPhoneAccess({ webUrl: 'https://plot.example', tools: fakeTools().tools })).toThrow(/only for a shizue running on this machine/);
  });

  it('opens Tailscale Serve on the first port nothing else serves, and closes that port alone', async () => {
    const fake = fakeTools({ tailscale: true, cloudflared: true, served: { 443: 'http://127.0.0.1:18788', 8443: 'https+insecure://127.0.0.1:18443', 8444: 'http://127.0.0.1:9000' } });
    const access = createPhoneAccess({ webUrl: WEB, tools: fake.tools });
    expect(await access.status()).toEqual({ tunnel: null, available: { tailscale: true, cloudflare: true } });

    expect(await access.open()).toEqual({ kind: 'tailscale', origin: `https://${HOST}:8445` });
    expect(fake.calls).toContain(`tailscale serve --bg --https=8445 ${TARGET}`);
    expect(access.origin()).toBe(`https://${HOST}:8445`);
    // Open already: the same address, nothing run again.
    const runs = fake.calls.length;
    expect(await access.open()).toEqual({ kind: 'tailscale', origin: `https://${HOST}:8445` });
    expect(fake.calls.filter((call) => call.includes('--bg'))).toHaveLength(1);
    expect(fake.calls.length).toBe(runs);

    await access.close();
    expect(fake.calls).toContain('tailscale serve --https=8445 off');
    expect([...fake.served.keys()].sort()).toEqual([443, 8443, 8444]);
    expect(access.origin()).toBeNull();
  });

  it('finds the address Tailscale kept from before a restart, and opens one only once for two clicks', async () => {
    const fake = fakeTools({ tailscale: true, served: { 8446: TARGET } });
    const access = createPhoneAccess({ webUrl: WEB, tools: fake.tools });
    expect((await access.status()).tunnel).toEqual({ kind: 'tailscale', origin: `https://${HOST}:8446` });
    expect(access.origin()).toBe(`https://${HOST}:8446`);

    const fresh = fakeTools({ tailscale: true });
    const clicked = createPhoneAccess({ webUrl: WEB, tools: fresh.tools });
    const [first, second] = await Promise.all([clicked.open(), clicked.open()]);
    expect(first).toEqual(second);
    expect(fresh.calls.filter((call) => call.includes('--bg'))).toHaveLength(1);
  });

  it('says why Tailscale Serve would not open', async () => {
    const access = createPhoneAccess({ webUrl: WEB, tools: fakeTools({ tailscale: true, serveFails: true }).tools });
    await expect(access.open()).rejects.toMatchObject({ code: 'tunnel_failed', message: expect.stringContaining('Access denied') });
    expect(access.origin()).toBeNull();
  });

  it('opens a Cloudflare Quick Tunnel without Tailscale, past the API address cloudflared mentions, and stops it on close', async () => {
    const fake = fakeTools({
      cloudflared: true,
      cloudflareLines: [
        'INF Requesting new quick Tunnel on trycloudflare.com...',
        'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": read: connection reset by peer',
        'INF |  https://lucky-words-here.trycloudflare.com  |',
      ],
    });
    const access = createPhoneAccess({ webUrl: WEB, tools: fake.tools });
    expect(await access.status()).toEqual({ tunnel: null, available: { tailscale: false, cloudflare: true } });
    expect(await access.open()).toEqual({ kind: 'cloudflare', origin: 'https://lucky-words-here.trycloudflare.com' });
    expect(fake.calls).toContain(`start cloudflared tunnel --no-autoupdate --url ${TARGET}`);
    await access.close();
    expect(fake.stopped).toEqual(['cloudflared']);
    expect(access.origin()).toBeNull();
  });

  it('gives up on a Quick Tunnel that names no address in time, or ends, and stops what it started', async () => {
    const silent = fakeTools({ cloudflared: true, cloudflareLines: ['ERR failed to request quick Tunnel'] });
    await expect(createPhoneAccess({ webUrl: WEB, tools: silent.tools, cloudflareWaitMs: 50 }).open())
      .rejects.toMatchObject({ code: 'tunnel_failed', message: expect.stringContaining('in time') });
    expect(silent.stopped).toEqual(['cloudflared']);

    const ended = fakeTools({ cloudflared: true, exits: true });
    await expect(createPhoneAccess({ webUrl: WEB, tools: ended.tools }).open())
      .rejects.toMatchObject({ code: 'tunnel_failed', message: expect.stringContaining('exited') });
  });

  it('forgets a Quick Tunnel that ends on its own, and ends one with the process', async () => {
    const fake = fakeTools({ cloudflared: true, cloudflareLines: ['https://a-b-c.trycloudflare.com'] });
    const access = createPhoneAccess({ webUrl: WEB, tools: fake.tools });
    await access.open();
    access.shutdown();
    expect(fake.stopped).toEqual(['cloudflared']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(access.origin()).toBeNull();
  });

  it('has nothing to open with neither installed', async () => {
    const access = createPhoneAccess({ webUrl: WEB, tools: fakeTools().tools });
    expect(await access.status()).toEqual({ tunnel: null, available: { tailscale: false, cloudflare: false } });
    await expect(access.open()).rejects.toMatchObject({ code: 'tunnel_unavailable' });
  });
});
