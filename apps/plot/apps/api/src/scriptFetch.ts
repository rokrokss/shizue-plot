/**
 * Lua `request` — the one network call RisuAI gives a card script — made by
 * this server on the script's behalf.
 *
 * RisuAI on the web sends it through its own proxy server, so the address a
 * script names sees RisuAI's server and never the reader. Here the script runs
 * in the reader's browser, in a sandbox with no network at all
 * (`apps/web/src/lib/scripts/lua/sandboxRuntime.ts`); the page forwards the
 * call to `POST /api/chats/:id/script-fetch`, and this module answers it. The
 * address sees this server, in the same way.
 *
 * Two layers:
 *
 * - `createScriptFetch` is RisuAI's `request` (`process/scriptings.ts`), check
 *   for check and answer for answer: the rate limit, the 120-character cap,
 *   https only, its banned addresses — and this app's own — then a GET, and
 *   `{status, data}`, with `internal error` for anything that threw. RisuAI
 *   keeps one counter per app session; here it is one per reader, in this
 *   process's memory.
 * - `guardedGet` is what a server inside someone's network must add: the GET
 *   never reaches an address that is not public. It resolves the name itself,
 *   refuses the lot when any answer is private, and connects only to the
 *   addresses it vetted (`pinnedLookup`), so a second DNS answer cannot change
 *   where the socket goes. Redirects are followed by hand, each hop vetted the
 *   same way. One deadline covers all of it, the body is capped, and nothing of
 *   the reader's goes out — no cookie, no credentials, no forwarding header.
 *
 * DNS and the connection are both injectable (`resolve`, `transport`), so the
 * tests never touch the network.
 */
import { ADDRCONFIG, promises as dns, type LookupAddress } from 'node:dns';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

/** What a script gets back, before RisuAI's `JSON.stringify`. */
export interface ScriptFetchAnswer {
  status: number;
  data: string;
}

/** RisuAI's answer for anything that threw on the way. */
const INTERNAL_ERROR: ScriptFetchAnswer = { status: 400, data: 'internal error' };

/**
 * RisuAI's rate limit: a window that starts again on the first request more
 * than a minute after it last started, and a refusal once *more than five*
 * came in it. The check comes before the count, so six get through and the
 * seventh is refused — whatever its message says.
 */
const WINDOW_MS = 60_000;
const MORE_THAN = 5;
const MAX_URL_LENGTH = 120;
/** RisuAI's own, matched as it matches them: on the start of the text. */
const BANNED_PREFIXES = ['https://realm.risuai.net', 'https://risuai.net', 'https://risuai.xyz'];

/** One request's whole life: the DNS answers, every hop and the body. */
export const SCRIPT_FETCH_TIMEOUT_MS = 10_000;
/**
 * The most body one request may bring back. RisuAI reads it all; a Lua state
 * here has 32MB, and a script that decodes JSON holds the text and the tables
 * built from it at once, so 2MB is as much as a script can do anything with.
 */
export const SCRIPT_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const SCRIPT_FETCH_MAX_REDIRECTS = 5;
/** Requests this process makes at once, for every reader together; past it, a request fails. */
export const SCRIPT_FETCH_MAX_IN_FLIGHT = 32;

/** Every request says this and nothing else: no cookie, no credentials, nothing of the reader's. */
export const SCRIPT_FETCH_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': 'shizue-plot/1 (a card script request, made by the server)',
  accept: '*/*',
  // A compressed body is refused below rather than decoded.
  'accept-encoding': 'identity',
};

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The ports `fetch` refuses (the Fetch standard's "bad port" list), refused here too. */
const BAD_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109,
  110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/* ------------------------------------------------------------ addresses */

/** IPv4 ranges that are not the public internet. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network", the unspecified address among it
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, the cloud metadata address among it
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and broadcast
];

const v4Number = (address: string): number =>
  address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);

const BLOCKED_V4_NUMBERS = BLOCKED_V4.map(([base, bits]) => [v4Number(base) >>> (32 - bits), bits] as const);

const publicV4 = (value: number): boolean => !BLOCKED_V4_NUMBERS.some(([prefix, bits]) => value >>> (32 - bits) === prefix);

/** An IPv6 address — one `net.isIPv6` accepts — as its eight 16-bit words. */
function v6Words(address: string): number[] {
  let text = address.toLowerCase().replace(/%.*$/, '');
  let tail: number[] = [];
  const dotted = /\d+\.\d+\.\d+\.\d+$/.exec(text);
  if (dotted) {
    const value = v4Number(dotted[0]);
    tail = [value >>> 16, value & 0xffff];
    text = text.slice(0, dotted.index);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const words = (part: string | undefined): number[] => (part ? part.split(':').map((word) => parseInt(word, 16)) : []);
  const [left, right] = text.includes('::') ? text.split('::') : [text, undefined];
  const head = words(left);
  const back = [...words(right), ...tail];
  return [...head, ...new Array<number>(right === undefined ? 0 : 8 - head.length - back.length).fill(0), ...back];
}

function publicV6(words: number[]): boolean {
  const zero = (from: number, to: number): boolean => words.slice(from, to).every((word) => word === 0);
  const v4 = (): number => ((words[6]! << 16) | words[7]!) >>> 0;
  // IPv4 carried in IPv6 is judged as the IPv4 it reaches: mapped (::ffff:0:0/96),
  // compatible (::/96, which holds :: and ::1), and NAT64's (64:ff9b::/96).
  if (zero(0, 5) && (words[5] === 0xffff || words[5] === 0)) return publicV4(v4());
  if (words[0] === 0x64 && words[1] === 0xff9b && zero(2, 6)) return publicV4(v4());
  // Only global unicast (2000::/3) is public. That leaves out loopback, unique local
  // (fc00::/7), link-local (fe80::/10), multicast (ff00::/8), discard (100::/64)…
  const first = words[0]!;
  const second = words[1]!;
  if ((first & 0xe000) !== 0x2000) return false;
  // …and inside it: IETF assignments with Teredo (2001::/23), documentation
  // (2001:db8::/32, 3fff::/20) and 6to4 (2002::/16), which embed or stand for others.
  if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return false;
  if (first === 0x2002) return false;
  if (first === 0x3fff && second < 0x1000) return false;
  return true;
}

/** Whether an IP address is on the public internet. Anything that is not an address is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicV4(v4Number(address));
  if (family === 6) return publicV6(v6Words(address));
  return false;
}

/* -------------------------------------------------------------- the GET */

/** The vetted addresses of a hostname, as `dns.lookup` answers with `all`. */
export type Resolve = (hostname: string) => Promise<LookupAddress[]>;

/** One hop, pinned: the socket may connect to `addresses` and nowhere else. */
export interface PinnedRequest {
  url: URL;
  addresses: readonly LookupAddress[];
  signal: AbortSignal;
}

export interface HopResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  /** Drops the rest of the body and the connection. */
  close(): void;
}

export type Transport = (request: PinnedRequest) => Promise<HopResponse>;

/** The same resolution a socket's own lookup makes. */
const systemResolve: Resolve = (hostname) => dns.lookup(hostname, { all: true, hints: ADDRCONFIG });

/**
 * A socket's `lookup` that answers with the vetted addresses and asks nobody:
 * the connection goes where the check looked. It answers in whichever shape it
 * is asked — a list for `all` (Node's happy-eyeballs connect), else the first.
 */
export function pinnedLookup(addresses: readonly LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    process.nextTick(() => {
      if (options.all) callback(null, addresses.map((entry) => ({ ...entry })));
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

const unbracketed = (hostname: string): string => hostname.replace(/^\[(.*)\]$/, '$1');

/**
 * `https.request` for one hop, connected through the pinned lookup on a fresh
 * connection. SNI and the certificate are checked against the name and the
 * `Host` header carries it, as a browser's would; an address literal has no SNI.
 */
export const httpsTransport: Transport = ({ url, addresses, signal }) =>
  new Promise((resolve, reject) => {
    const host = unbracketed(url.hostname);
    const request = httpsRequest({
      host,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { ...SCRIPT_FETCH_HEADERS },
      ...(isIP(host) ? {} : { servername: host }),
      lookup: pinnedLookup(addresses),
      agent: false,
      signal,
    });
    request.on('response', (response) => {
      // A reset after the body was dropped has nobody else to tell.
      response.on('error', () => undefined);
      resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response, close: () => response.destroy() });
    });
    request.on('error', reject);
    request.end();
  });

export interface GuardOptions {
  resolve?: Resolve;
  transport?: Transport;
  /** A URL not to fetch whatever it resolves to; asked on every hop. */
  refuse?: (url: URL) => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/** `promise`, or the signal's reason once it aborts — for the steps that cannot be aborted themselves. */
function raced<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Where one hop may connect, or a throw: https, no credentials, a port fetch allows, and public addresses only. */
async function vet(url: URL, options: GuardOptions, signal: AbortSignal): Promise<LookupAddress[]> {
  if (url.protocol !== 'https:') throw new Error(`${url.protocol} is not https`);
  // `fetch` refuses a URL with credentials in it, so RisuAI's request fails on one too.
  if (url.username !== '' || url.password !== '') throw new Error('the URL carries credentials');
  if (url.port !== '' && BAD_PORTS.has(Number(url.port))) throw new Error(`port ${url.port} is refused`);
  if (options.refuse?.(url)) throw new Error(`${url.hostname} is refused`);
  // `new URL` has already read every spelling of an IPv4 literal — decimal, octal, hex — as dotted decimal.
  const host = unbracketed(url.hostname);
  const family = isIP(host);
  const addresses = family !== 0 ? [{ address: host, family }] : await raced((options.resolve ?? systemResolve)(host), signal);
  // All or nothing: a name with one private answer is not fetched at all.
  if (addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) {
    throw new Error(`${host} does not resolve to public addresses only`);
  }
  return addresses;
}

/** The body as `Response.text()` reads it — UTF-8 whatever the header says, a BOM dropped — or a throw past the cap. */
async function readText(response: HopResponse, maxBytes: number, signal: AbortSignal): Promise<string> {
  try {
    const coding = response.headers['content-encoding']?.trim().toLowerCase();
    if (coding && coding !== 'identity') throw new Error(`the body is ${coding}-encoded`);
    if (Number(response.headers['content-length']) > maxBytes) throw new Error('the body is too large');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error('the body is too large');
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
  } finally {
    response.close();
  }
}

/**
 * A GET of `address` that reaches public addresses only: `{status, text}` of
 * the response it ends on, or a throw — for a URL that is not https, a name
 * that resolves to anything private, a redirect past the limit or into either,
 * a body past the cap, or the deadline.
 */
export async function guardedGet(address: string, options: GuardOptions = {}): Promise<{ status: number; text: string }> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? SCRIPT_FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const transport = options.transport ?? httpsTransport;
  const maxRedirects = options.maxRedirects ?? SCRIPT_FETCH_MAX_REDIRECTS;
  let url = new URL(address);
  for (let hop = 0; ; hop += 1) {
    const addresses = await vet(url, options, signal);
    const response = await raced(transport({ url, addresses, signal }), signal);
    const location = REDIRECTS.has(response.status) ? response.headers.location : undefined;
    // A redirect without a place to go is the answer, as it is to `fetch`.
    if (location === undefined) {
      return { status: response.status, text: await readText(response, options.maxBytes ?? SCRIPT_FETCH_MAX_BYTES, signal) };
    }
    response.close();
    if (hop >= maxRedirects) throw new Error('too many redirects');
    url = new URL(location, url);
  }
}

/* ----------------------------------------------------- RisuAI's request */

export interface ScriptFetch {
  /** RisuAI's `request(id, url)` for one reader, past its access gate: its answer, as `{status, data}`. */
  request(readerId: string, url: unknown, signal?: AbortSignal): Promise<ScriptFetchAnswer>;
}

export interface ScriptFetchOptions extends Omit<GuardOptions, 'refuse' | 'signal'> {
  /** This app's own origins — the web app, and the API's when it has one of its own — refused as RisuAI refuses its. */
  ownOrigins?: readonly string[];
  now?: () => number;
  maxInFlight?: number;
}

/** A host as two spellings of it compare equal: `new URL` lowercased it; a trailing dot is the same name. */
const sameHost = (hostname: string): string => hostname.replace(/\.$/, '');

export function createScriptFetch(options: ScriptFetchOptions = {}): ScriptFetch {
  const now = options.now ?? Date.now;
  const maxInFlight = options.maxInFlight ?? SCRIPT_FETCH_MAX_IN_FLIGHT;
  const ownHosts = new Set((options.ownOrigins ?? []).map((origin) => sameHost(new URL(origin).hostname)));
  const ours = (url: URL): boolean => ownHosts.has(sameHost(url.hostname));
  /** A redirect may not go where the first address could not. */
  const refuse = (url: URL): boolean => BANNED_PREFIXES.some((prefix) => url.href.startsWith(prefix)) || ours(url);
  /** RisuAI's `lastRequestResetTime` and `lastRequestsCount`, per reader. */
  const counters = new Map<string, { resetAt: number; count: number }>();
  let swept = 0;
  let inFlight = 0;

  /** A reader whose window has ended counts as one never seen, so ended windows are dropped now and then. */
  function sweep(at: number): void {
    if (at - swept <= WINDOW_MS) return;
    swept = at;
    for (const [reader, counter] of counters) if (counter.resetAt + WINDOW_MS < at) counters.delete(reader);
  }

  return {
    async request(readerId, url, signal) {
      const at = now();
      sweep(at);
      let counter = counters.get(readerId);
      if (!counter || counter.resetAt + WINDOW_MS < at) {
        counter = { resetAt: at, count: 0 };
        counters.set(readerId, counter);
      }
      if (counter.count > MORE_THAN) return { status: 429, data: 'Too many requests. you can request 5 times per minute' };
      // Counted before the address is looked at: a refused one spends a request too, as in RisuAI.
      counter.count += 1;

      // RisuAI reads `url.length` and `url.startsWith` inside its `try`: anything but text ends in its catch.
      if (typeof url !== 'string') return INTERNAL_ERROR;
      if (url.length > MAX_URL_LENGTH) return { status: 413, data: 'URL to large. max is 120 characters' };
      if (!url.startsWith('https://')) return { status: 400, data: 'Only https requests are allowed' };
      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {
        // Not an address: the GET below fails on it, as RisuAI's fetch does.
      }
      if (BANNED_PREFIXES.some((prefix) => url.startsWith(prefix)) || (parsed !== null && ours(parsed))) {
        return { status: 400, data: `request to ${url} is not allowed` };
      }

      if (inFlight >= maxInFlight) return INTERNAL_ERROR;
      inFlight += 1;
      try {
        const { status, text } = await guardedGet(url, {
          resolve: options.resolve,
          transport: options.transport,
          timeoutMs: options.timeoutMs,
          maxBytes: options.maxBytes,
          maxRedirects: options.maxRedirects,
          signal,
          refuse,
        });
        return { status, data: text };
      } catch {
        return INTERNAL_ERROR;
      } finally {
        inFlight -= 1;
      }
    },
  };
}
