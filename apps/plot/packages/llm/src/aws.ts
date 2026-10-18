import { createHash, createHmac } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { IdleWatch } from './stream.js';
import type { LLMError } from './types.js';

/**
 * What a call to AWS needs without its SDK: Signature Version 4 for the
 * requests (`signAws`), and a reader for the binary event stream Bedrock
 * answers `invoke-with-response-stream` with (`readEventStream`).
 */

export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986's unreserved characters stay; everything else is `%XX` (AWS's `UriEncode`). */
const uriEncode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** `YYYYMMDD'T'HHMMSS'Z'`, the form `x-amz-date` takes. */
export const amzDate = (now: Date): string => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * The headers that sign a request with AWS keys (SigV4): `x-amz-date`,
 * `x-amz-content-sha256`, the session token where the keys have one, and
 * `authorization` over every header given and `host`. The path is signed
 * encoded once more than it is sent, as every service but S3 wants it.
 */
export function signAws(
  request: { method: string; url: string; headers: Record<string, string>; body?: string },
  keys: AwsKeys,
  service: string,
  now: Date = new Date(),
): Record<string, string> {
  const url = new URL(request.url);
  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);
  const payloadHash = sha256Hex(request.body ?? '');
  // One spelling of each name, so what is sent is what is signed.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
  Object.assign(headers, {
    'x-amz-date': stamp,
    'x-amz-content-sha256': payloadHash,
    ...(keys.sessionToken ? { 'x-amz-security-token': keys.sessionToken } : {}),
  });
  const canonical = new Map<string, string>([['host', url.host]]);
  for (const [name, value] of Object.entries(headers)) canonical.set(name, value.trim().replace(/\s+/g, ' '));
  const names = [...canonical.keys()].sort();
  const signedHeaders = names.join(';');
  const path = uriEncode(url.pathname).replace(/%2F/g, '/');
  const query = [...url.searchParams.entries()]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonicalRequest = [
    request.method.toUpperCase(),
    path,
    query,
    names.map((name) => `${name}:${canonical.get(name)}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${day}/${keys.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${keys.secretAccessKey}`, day), keys.region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** One message of an AWS event stream: its headers (the string ones) and its payload. */
export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Uint8Array;
}

/** The most one message may be: past it, the body is not an event stream. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** How many bytes a header value of each type takes after its type byte (`-1`: a 2-byte length, then that many). */
const HEADER_VALUE_BYTES: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 6: -1, 7: -1, 8: 8, 9: 16 };

function headersOf(bytes: Uint8Array, invalid: () => LLMError): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const headers: Record<string, string> = {};
  let at = 0;
  while (at < bytes.length) {
    const nameLength = view.getUint8(at);
    const name = decoder.decode(bytes.subarray(at + 1, at + 1 + nameLength));
    at += 1 + nameLength;
    const type = view.getUint8(at);
    at += 1;
    const size = HEADER_VALUE_BYTES[type];
    if (size === undefined) throw invalid();
    if (size >= 0) {
      at += size;
      continue;
    }
    const length = view.getUint16(at);
    if (type === 7) headers[name] = decoder.decode(bytes.subarray(at + 2, at + 2 + length));
    at += 2 + length;
  }
  if (at !== bytes.length) throw invalid();
  return headers;
}

/**
 * The messages of an `application/vnd.amazon.eventstream` body, in order: each
 * a 12-byte prelude (its length, its headers' length, their CRC32), its
 * headers, its payload and its own CRC32. A message whose lengths or checksums
 * do not hold is `invalid`; a body that ends inside one is `interrupted`.
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  watch: IdleWatch,
  errors: { invalid: () => LLMError; interrupted: () => LLMError },
): AsyncGenerator<EventStreamMessage, void> {
  const reader = body.getReader();
  let pending = new Uint8Array(0);
  try {
    while (true) {
      watch.arm();
      const { done, value } = await reader.read();
      watch.disarm();
      if (value?.length) {
        const joined = new Uint8Array(pending.length + value.length);
        joined.set(pending);
        joined.set(value, pending.length);
        pending = joined;
      }
      while (pending.length >= 12) {
        const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
        const total = view.getUint32(0);
        const headerLength = view.getUint32(4);
        if (total < 16 || total > MAX_MESSAGE_BYTES || headerLength > total - 16 || view.getUint32(8) !== crc32(pending.subarray(0, 8))) throw errors.invalid();
        if (pending.length < total) break;
        const message = pending.subarray(0, total);
        if (view.getUint32(total - 4) !== crc32(message.subarray(0, total - 4))) throw errors.invalid();
        yield { headers: headersOf(message.subarray(12, 12 + headerLength), errors.invalid), payload: message.slice(12 + headerLength, total - 4) };
        pending = pending.slice(total);
      }
      if (done) {
        if (pending.length > 0) throw errors.interrupted();
        return;
      }
    }
  } finally {
    watch.disarm();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
