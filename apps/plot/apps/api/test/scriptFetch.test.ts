/**
 * The guard in front of Lua `request` (`scriptFetch.ts`): which addresses are
 * public, and that a GET reaches only those — through every spelling of an
 * address, every DNS answer and every redirect. No database and no network:
 * DNS and the connection are stubs, except the one test that hands Node's own
 * `https.request` the pinned lookup and a socket on this machine to prove where
 * it connects.
 */
import type { LookupAddress } from 'node:dns';
import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  guardedGet,
  httpsTransport,
  isPublicAddress,
  pinnedLookup,
  SCRIPT_FETCH_HEADERS,
  type HopResponse,
  type PinnedRequest,
  type Resolve,
  type Transport,
} from '../src/scriptFetch.js';

const PUBLIC_V4 = '93.184.215.14';
const PUBLIC_V6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2c';

/** A response the stub connection gives, its body in one chunk; `closed` says whether it was dropped. */
function respond(status: number, body: string | Uint8Array = '', headers: Record<string, string> = {}): HopResponse & { closed: boolean } {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const response = {
    status,
    headers,
    body: (async function* () {
      yield bytes;
    })(),
    closed: false,
    close: () => void (response.closed = true),
  };
  return response;
}

/** A stub DNS from a table, recording each question. A function answers differently each time it is asked. */
function dnsOf(table: Record<string, string[] | ((asked: number) => string[])>): { resolve: Resolve; asked: string[] } {
  const asked: string[] = [];
  const resolve: Resolve = async (hostname) => {
    asked.push(hostname);
    const entry = table[hostname];
    if (entry === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    const answers = typeof entry === 'function' ? entry(asked.filter((name) => name === hostname).length) : entry;
    return answers.map((address): LookupAddress => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { resolve, asked };
}

/** A stub connection, answering by URL and recording every pinned request it is handed. */
function connectionOf(answer: (url: URL) => HopResponse): { transport: Transport; seen: PinnedRequest[] } {
  const seen: PinnedRequest[] = [];
  return {
    seen,
    transport: async (request) => {
      seen.push(request);
      return answer(request.url);
    },
  };
}

const publicDns = (...names: string[]) => dnsOf(Object.fromEntries(names.map((name) => [name, [PUBLIC_V4]])));

describe('public addresses', () => {
  it('refuses every range that is not the public internet, in IPv4 and in every IPv6 form of it', () => {
    const blocked = [
      // IPv4: this network, private, CGNAT, loopback, link-local (the metadata address), IETF,
      // documentation, 6to4 relay, benchmarking, multicast, reserved and broadcast.
      '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1',
      '127.255.255.254', '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.170',
      '192.0.2.1', '192.88.99.1', '192.168.0.1', '192.168.255.255', '198.18.0.1', '198.19.255.255',
      '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
      // IPv6: unspecified, loopback, and IPv4 inside IPv6 — mapped, compatible, NAT64 — judged as that IPv4.
      '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
      '::127.0.0.1', '::a00:1', '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1',
      // Unique local, link-local (with a zone too), site-local, multicast, discard, local NAT64.
      'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fe80::1%lo0', 'febf:ffff::1', 'fec0::1', 'ff02::1', '100::1', '64:ff9b:1::1',
      // Inside 2000::/3: IETF with Teredo, documentation, 6to4.
      '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', '2002:7f00:1::1', '3fff::1',
      // Not an address at all.
      'example.com', '', '127.0.0.1.',
    ];
    for (const address of blocked) expect(isPublicAddress(address), address).toBe(false);

    const open = [
      '1.1.1.1', '8.8.8.8', PUBLIC_V4, '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0',
      '192.169.0.1', '198.17.255.255', '198.20.0.0', '223.255.255.255',
      PUBLIC_V6, '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e',
      // A public IPv4 reached through IPv6 is that public IPv4.
      '::ffff:8.8.8.8', '64:ff9b::8.8.8.8',
    ];
    for (const address of open) expect(isPublicAddress(address), address).toBe(true);
  });
});

describe('the guarded GET', () => {
  it('reads every spelling of an address literal as `new URL` does, and refuses a private one without DNS or a connection', async () => {
    // WHATWG's host parser turns the decimal, octal, hex, short and full-width forms into dotted decimal.
    expect(new URL('https://2130706433/').hostname).toBe('127.0.0.1');
    expect(new URL('https://0x7f.1/').hostname).toBe('127.0.0.1');
    expect(new URL('https://0177.0.0.1/').hostname).toBe('127.0.0.1');
    expect(new URL('https://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');
    const dns = dnsOf({});
    const { transport, seen } = connectionOf(() => respond(200, 'should not be here'));
    const literals = [
      'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f.1/', 'https://0x7f000001/', 'https://0177.0.0.1/',
      'https://017700000001/', 'https://127.1/', 'https://１２７.０.０.１/', 'https://192.168.0.1./', 'https://0/',
      'https://0.0.0.0/', 'https://169.254.169.254/latest/meta-data/', 'https://0xa9.0xfe.0xa9.0xfe/',
      'https://10.0.0.1:8443/', 'https://100.100.100.200/', 'https://[::1]/', 'https://[::]/',
      'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[0:0:0:0:0:ffff:a9fe:a9fe]/',
      'https://[::127.0.0.1]/', 'https://[64:ff9b::7f00:1]/', 'https://[fe80::1]/', 'https://[fd00::1]/', 'https://[ff02::1]/',
    ];
    for (const url of literals) {
      await expect(guardedGet(url, { resolve: dns.resolve, transport }), url).rejects.toThrow(/public addresses/);
    }
    expect(dns.asked).toEqual([]);
    expect(seen).toEqual([]);

    // A public literal goes straight to the connection, pinned to itself.
    const { transport: direct, seen: reached } = connectionOf(() => respond(200, 'ok'));
    expect(await guardedGet(`https://[${PUBLIC_V6}]/x`, { resolve: dns.resolve, transport: direct })).toEqual({ status: 200, text: 'ok' });
    expect(reached[0]!.addresses).toEqual([{ address: PUBLIC_V6, family: 6 }]);
  });

  it('refuses a name when any of its answers is private, all of them or one among public ones', async () => {
    const dns = dnsOf({
      'loopback.test': ['127.0.0.1'],
      'mixed.test': [PUBLIC_V4, '10.0.0.5'],
      'mixed6.test': [PUBLIC_V6, 'fd00::5'],
      'mapped.test': [PUBLIC_V4, '::ffff:169.254.169.254'],
      'empty.test': [],
    });
    const { transport, seen } = connectionOf(() => respond(200));
    for (const name of ['loopback.test', 'mixed.test', 'mixed6.test', 'mapped.test', 'empty.test']) {
      await expect(guardedGet(`https://${name}/`, { resolve: dns.resolve, transport }), name).rejects.toThrow(/public addresses/);
    }
    // A name that does not resolve fails as DNS failed.
    await expect(guardedGet('https://nowhere.test/', { resolve: dns.resolve, transport })).rejects.toThrow(/ENOTFOUND/);
    expect(seen).toEqual([]);
  });

  it('connects only to what it vetted, by name: a second DNS answer is never asked for', async () => {
    // Rebinding: public the first time, loopback every time after.
    const dns = dnsOf({ 'rebind.test': (asked) => (asked === 1 ? [PUBLIC_V4, PUBLIC_V6] : ['127.0.0.1']) });
    const { transport, seen } = connectionOf(() => respond(200, '본문'));
    expect(await guardedGet('https://rebind.test:8443/path?q=1#frag', { resolve: dns.resolve, transport })).toEqual({
      status: 200,
      text: '본문',
    });
    expect(dns.asked).toEqual(['rebind.test']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.href).toBe('https://rebind.test:8443/path?q=1#frag');
    expect(seen[0]!.addresses).toEqual([
      { address: PUBLIC_V4, family: 4 },
      { address: PUBLIC_V6, family: 6 },
    ]);

    // The lookup the socket is given answers with those, in either shape it is asked in, and asks nobody.
    const lookup = pinnedLookup(seen[0]!.addresses);
    const all = await new Promise((resolve) => lookup('rebind.test', { all: true }, (error, addresses) => resolve([error, addresses])));
    expect(all).toEqual([null, [{ address: PUBLIC_V4, family: 4 }, { address: PUBLIC_V6, family: 6 }]]);
    const one = await new Promise((resolve) =>
      lookup('rebind.test', {}, (error, address, family) => resolve([error, address, family])),
    );
    expect(one).toEqual([null, PUBLIC_V4, 4]);
    expect(dns.asked).toEqual(['rebind.test']);
  });

  it('hands Node’s own https.request the pinned address and keeps the name for SNI', async () => {
    // `.test` names never resolve: a connection here can only have come through the pinned lookup.
    const hello = new Promise<{ remote: string; bytes: Buffer }>((resolve) => {
      const server = createServer((socket) => {
        socket.once('data', (bytes) => {
          resolve({ remote: socket.remoteAddress ?? '', bytes });
          socket.destroy();
          server.close();
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        void httpsTransport({
          url: new URL(`https://pinned.test:${port}/x`),
          addresses: [{ address: '127.0.0.1', family: 4 }],
          signal: AbortSignal.timeout(5_000),
        }).catch(() => undefined);
      });
    });
    const { remote, bytes } = await hello;
    expect(remote).toBe('127.0.0.1');
    // A TLS ClientHello (handshake record) whose SNI is the name, not the address.
    expect(bytes[0]).toBe(0x16);
    expect(bytes.includes(Buffer.from('pinned.test'))).toBe(true);
  });

  it('follows redirects by hand, every hop vetted again: https, a public address, and never home', async () => {
    const dns = dnsOf({
      'start.test': [PUBLIC_V4],
      'next.test': [PUBLIC_V4],
      'inside.test': ['10.1.2.3'],
      'home.test': [PUBLIC_V4],
    });
    const hops: HopResponse[] = [];
    const { transport, seen } = connectionOf((url) => {
      const to = url.searchParams.get('to');
      const response = to === null ? respond(200, `at ${url.host}${url.pathname}`) : respond(302, 'moved', { location: to });
      hops.push(response);
      return response;
    });
    const refuse = (url: URL): boolean => url.hostname === 'home.test';
    const get = (url: string) => guardedGet(url, { resolve: dns.resolve, transport, refuse });

    // Relative and absolute, across hosts: each name is asked when it is reached.
    expect(await get('https://start.test/a?to=/b%3Fto%3Dhttps://next.test/c')).toEqual({ status: 200, text: 'at next.test/c' });
    expect(seen.map((hop) => hop.url.href)).toEqual([
      'https://start.test/a?to=/b%3Fto%3Dhttps://next.test/c',
      'https://start.test/b?to=https://next.test/c',
      'https://next.test/c',
    ]);
    expect(dns.asked).toEqual(['start.test', 'start.test', 'next.test']);
    // A redirect's body is dropped, not read.
    expect(hops.slice(0, 2).every((hop) => (hop as HopResponse & { closed: boolean }).closed)).toBe(true);

    for (const [to, why] of [
      ['https://inside.test/', /public addresses/],
      ['https://169.254.169.254/latest/meta-data/', /public addresses/],
      ['https://[::ffff:10.0.0.1]/', /public addresses/],
      ['http://next.test/', /not https/],
      ['https://home.test/', /refused/],
      ['https://next.test:22/', /port 22/],
      ['https://user:pass@next.test/', /credentials/],
    ] as const) {
      seen.length = 0;
      await expect(get(`https://start.test/?to=${encodeURIComponent(to)}`), to).rejects.toThrow(why);
      expect(seen).toHaveLength(1);
    }

    // A redirect without a place to go is the answer.
    const { transport: nowhere } = connectionOf(() => respond(302, 'stay'));
    expect(await guardedGet('https://start.test/', { resolve: dns.resolve, transport: nowhere })).toEqual({ status: 302, text: 'stay' });
  });

  it('follows five redirects and not a sixth', async () => {
    const dns = publicDns('loop.test');
    const chain = (hops: number) =>
      connectionOf((url) => {
        const at = Number(url.pathname.slice(1));
        return at < hops ? respond(307, '', { location: `/${at + 1}` }) : respond(200, `after ${at}`);
      }).transport;
    expect(await guardedGet('https://loop.test/0', { resolve: dns.resolve, transport: chain(5) })).toEqual({ status: 200, text: 'after 5' });
    await expect(guardedGet('https://loop.test/0', { resolve: dns.resolve, transport: chain(6) })).rejects.toThrow(/too many redirects/);
  });

  it('refuses credentials, the ports fetch refuses, and anything but https, as the first address too', async () => {
    const dns = publicDns('site.test');
    const { transport, seen } = connectionOf(() => respond(200, 'ok'));
    for (const url of ['http://site.test/', 'https://user:pw@site.test/', 'https://site.test:25/', 'https://site.test:6697/', 'ftp://site.test/']) {
      await expect(guardedGet(url, { resolve: dns.resolve, transport }), url).rejects.toThrow();
    }
    expect(seen).toEqual([]);
    expect(await guardedGet('https://site.test:8443/', { resolve: dns.resolve, transport })).toEqual({ status: 200, text: 'ok' });
  });

  it('reads the body as Response.text() does, up to the cap, and refuses a compressed one', async () => {
    const dns = publicDns('site.test');
    const get = (response: HopResponse, maxBytes = 16) =>
      guardedGet('https://site.test/', { resolve: dns.resolve, transport: async () => response, maxBytes });

    // UTF-8 whatever the header claims, a BOM dropped, a broken sequence replaced.
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xea, 0xb0, 0x80, 0xff, 0x41]);
    expect(await get(respond(200, bytes, { 'content-type': 'text/plain; charset=latin1' }))).toEqual({ status: 200, text: '가�A' });

    expect((await get(respond(200, 'x'.repeat(16)))).text).toHaveLength(16);
    await expect(get(respond(200, 'x'.repeat(17)))).rejects.toThrow(/too large/);
    // Refused on the header alone, before a byte is read.
    const announced = respond(200, '', { 'content-length': '17' });
    await expect(get(announced)).rejects.toThrow(/too large/);
    expect((announced as HopResponse & { closed: boolean }).closed).toBe(true);
    // Streamed past the cap in pieces.
    const pieces: HopResponse = {
      status: 200,
      headers: {},
      body: (async function* () {
        for (let i = 0; i < 10; i += 1) yield new TextEncoder().encode('abc');
      })(),
      close: () => undefined,
    };
    await expect(get(pieces)).rejects.toThrow(/too large/);

    await expect(get(respond(200, 'zz', { 'content-encoding': 'gzip' }))).rejects.toThrow(/gzip/);
    expect(await get(respond(200, 'ok', { 'content-encoding': 'identity' }))).toEqual({ status: 200, text: 'ok' });
  });

  it('gives up at one deadline, whether DNS, the connection or the body is what stalls', async () => {
    const stalled: Resolve = () => new Promise(() => undefined);
    const dns = publicDns('site.test');
    const hanging: Transport = ({ signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    const trickle: Transport = async ({ signal }) => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield new TextEncoder().encode('a');
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        yield new TextEncoder().encode('b');
      })(),
      close: () => undefined,
    });
    for (const [resolve, transport] of [
      [stalled, hanging],
      [dns.resolve, hanging],
      [dns.resolve, trickle],
    ] as const) {
      const began = performance.now();
      await expect(guardedGet('https://site.test/', { resolve, transport, timeoutMs: 100 })).rejects.toThrow(/timeout|aborted/i);
      expect(performance.now() - began).toBeLessThan(1_000);
    }
    // The caller's own signal ends it as well: a reader who left.
    const left = new AbortController();
    const pending = guardedGet('https://site.test/', { resolve: dns.resolve, transport: hanging, signal: left.signal });
    left.abort();
    await expect(pending).rejects.toThrow();
  });

  it('sends nothing of the reader’s: a fixed, plain set of headers', () => {
    expect(Object.keys(SCRIPT_FETCH_HEADERS).sort()).toEqual(['accept', 'accept-encoding', 'user-agent']);
    // A header must be plain text, or Node refuses the request before it is sent.
    for (const value of Object.values(SCRIPT_FETCH_HEADERS)) expect(value).toMatch(/^[\x20-\x7e]+$/);
  });
});
