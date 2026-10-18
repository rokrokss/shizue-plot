import { crc32 } from 'node:zlib';
import type { ChatRequest, StreamDelta, StreamDone } from '../src/types.js';

/** One SSE event: `data:` and, where given, `event:`. */
export const sse = (data: unknown, event?: string): string =>
  `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

/** A streamed body that arrives three bytes at a time, splitting UTF-8 and line ends as a network may. */
export function streamed(source: string, init: ResponseInit = {}): Response {
  const bytes = new TextEncoder().encode(source);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 3) controller.enqueue(bytes.slice(at, at + 3));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init },
  );
}

/** A body that arrives as `bytes`, a few at a time (Bedrock's binary event stream). */
export function streamedBytes(bytes: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' }, ...init },
  );
}

/**
 * One AWS event stream message with string headers, as the event stream
 * encoding lays it out: prelude, its CRC32, headers, payload, and the message's
 * CRC32 (checked byte for byte against `@smithy/core`'s `EventStreamCodec`).
 */
export function eventFrame(headers: Record<string, string>, payload: string): Uint8Array {
  const encoder = new TextEncoder();
  const headerBytes: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    headerBytes.push(nameBytes.length, ...nameBytes, 7, valueBytes.length >> 8, valueBytes.length & 0xff, ...valueBytes);
  }
  const body = encoder.encode(payload);
  const total = 12 + headerBytes.length + body.length + 4;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  frame.set(headerBytes, 12);
  frame.set(body, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)));
  return frame;
}

export interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  /** The body as sent, for one that is not JSON (a form, a token request). */
  text: string | undefined;
}

/** A `fetch` that records what it was sent and answers with `respond`. */
export function recordingFetch(respond: (sent: SentRequest) => Response | Promise<Response>): { fetcher: typeof fetch; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const text = typeof init?.body === 'string' ? init.body : undefined;
    let body: Record<string, unknown> | undefined;
    try {
      body = text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      body = undefined;
    }
    const request: SentRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
      text,
    };
    sent.push(request);
    return respond(request);
  };
  return { fetcher, sent };
}

/** Everything a stream gave: its text, its thinking, and how it ended. */
export async function drain(stream: AsyncGenerator<StreamDelta, StreamDone>): Promise<{ text: string; reasoning: string; done: StreamDone }> {
  let text = '';
  let reasoning = '';
  for (let next = await stream.next(); ; next = await stream.next()) {
    if (next.done) return { text, reasoning, done: next.value };
    if (next.value.type === 'text') text += next.value.text;
    else reasoning += next.value.reasoning;
  }
}

/** A response that stays open for the test to feed, and fails when aborted as fetch's own body does. */
export function liveFetch(): { fetcher: typeof fetch; send: (chunk: string) => void } {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
  return {
    send: (chunk) => feed.enqueue(new TextEncoder().encode(chunk)),
    fetcher: async (_input, init) => {
      init?.signal?.addEventListener('abort', () => feed.error(init.signal!.reason));
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  };
}

/** The request every family's contract is pinned with. */
export const REQUEST: ChatRequest = {
  model: 'model-x',
  system: 'You are the narrator.',
  messages: [
    { role: 'system', content: '[Start a new chat]' },
    { role: 'assistant', content: 'The door creaks open.' },
    { role: 'user', content: [{ type: 'text', text: 'Who is there?' }, { type: 'image', url: 'data:image/png;base64,aGk=' }] },
    { role: 'system', content: 'Reply in two paragraphs.' },
  ],
  maxTokens: 1200,
  stop: ['\nUser:'],
};

/** What `run` throws, or undefined. */
export function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
