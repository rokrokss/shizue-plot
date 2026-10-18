import { LLMError, type StreamDelta } from './types.js';

/**
 * How long a stream may send nothing before the reply is given up on: Codex's
 * own stream idle timeout for the ChatGPT endpoint, used for every provider. A
 * reasoning model that sends nothing while it thinks, or a local model still
 * reading a long prompt, survives this long; a stream that keeps sending is
 * never cut, however long it runs.
 */
export const IDLE_TIMEOUT_MS = 300_000;
/** The most a stream may hold unparsed: past it, it is not an event stream. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** Whether `error` is a stream that went quiet — what arrived before it is kept as a stopped reply is. */
export const isIdleTimeout = (error: unknown): error is LLMError =>
  error instanceof LLMError && (error.code === 'chatgpt_timeout' || error.code === 'provider_timeout');

/**
 * The idle timer around one request: armed only while waiting on the upstream
 * — a delta the caller is slow to take is not the stream going quiet — and its
 * signal the caller's own abort joined with the timer's.
 */
export class IdleWatch {
  private readonly idle = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal: AbortSignal;

  constructor(
    private readonly caller: AbortSignal | undefined,
    private readonly idleMs = IDLE_TIMEOUT_MS,
  ) {
    this.signal = caller ? AbortSignal.any([caller, this.idle.signal]) : this.idle.signal;
  }

  arm(): void {
    this.disarm();
    this.timer = setTimeout(() => this.idle.abort(), this.idleMs);
  }

  disarm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The upstream went quiet, rather than the caller stopping. */
  get timedOut(): boolean {
    return this.idle.signal.aborted && !this.caller?.aborted;
  }
}

export interface SseEvent {
  /** The block's `event:` name, where it has one (Anthropic's event types). */
  event?: string;
  /** Its `data:` lines, joined by a line break. */
  data: string;
}

/**
 * The events of a server-sent-events body, in order — split UTF-8, CRLF line
 * ends and a last block with no blank line after it are all read. `interrupted`
 * is what a body that ends mid-stream throws, `invalid` what one too large to be
 * events throws; a caller that saw its terminal event returns before either.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  watch: IdleWatch,
  errors: { invalid: () => LLMError },
): AsyncGenerator<SseEvent, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const blockOf = (block: string): SseEvent | null => {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) event = line.slice(6).trim();
    }
    return data.length > 0 ? { ...(event ? { event } : {}), data: data.join('\n') } : null;
  };
  try {
    while (true) {
      watch.arm();
      const { done, value } = await reader.read();
      watch.disarm();
      pending += decoder.decode(value, { stream: !done });
      pending = pending.replace(/\r\n?/g, '\n');
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const block = blockOf(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        if (block) yield block;
      }
      if (pending.length > MAX_PENDING_BYTES) throw errors.invalid();
      if (done) {
        const last = pending.trim() ? blockOf(pending) : null;
        if (last) yield last;
        return;
      }
    }
  } finally {
    watch.disarm();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * The objects of a newline-delimited JSON body (Ollama's `/api/chat`, Cohere's
 * chat stream), in order, read as `readSse` reads events: split UTF-8, CRLF and
 * a last line with no line break after it. A line that is not JSON is
 * `invalid`.
 */
export async function* readJsonLines(
  body: ReadableStream<Uint8Array>,
  watch: IdleWatch,
  errors: { invalid: () => LLMError },
): AsyncGenerator<unknown, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      watch.arm();
      const { done, value } = await reader.read();
      watch.disarm();
      pending += decoder.decode(value, { stream: !done });
      let boundary: number;
      while ((boundary = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, boundary).trim();
        pending = pending.slice(boundary + 1);
        if (line) yield eventJson<unknown>(line, errors.invalid);
      }
      if (pending.length > MAX_PENDING_BYTES) throw errors.invalid();
      if (done) {
        if (pending.trim()) yield eventJson<unknown>(pending.trim(), errors.invalid);
        return;
      }
    }
  } finally {
    watch.disarm();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Parses an event's JSON, or throws `invalid`: an event that is not JSON is not this provider's stream. */
export function eventJson<T>(data: string, invalid: () => LLMError): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    throw invalid();
  }
}

/**
 * The role-play stop boundary, applied as the text arrives: what comes before
 * the first stop string goes out, and nothing after it. The tail a stop could
 * still be starting in is held back until it cannot be. Sending the strings to
 * a provider as well saves its tokens, but this is what holds.
 */
export class StopFilter {
  private held = '';
  private stopped = false;
  private readonly stops: string[];
  private readonly tail: number;

  constructor(stops: readonly string[] | undefined) {
    this.stops = (stops ?? []).filter(Boolean);
    this.tail = Math.max(0, ...this.stops.map((stop) => stop.length - 1));
  }

  /** Whether a stop string has been met: nothing more goes out. */
  get done(): boolean {
    return this.stopped;
  }

  /** What of `text` may go out now. */
  push(text: string): string {
    if (this.stopped) return '';
    this.held += text;
    const indices = this.stops.map((stop) => this.held.indexOf(stop)).filter((at) => at >= 0);
    const at = indices.length ? Math.min(...indices) : -1;
    if (at >= 0) {
      const out = this.held.slice(0, at);
      this.held = '';
      this.stopped = true;
      return out;
    }
    if (this.held.length <= this.tail) return '';
    const out = this.held.slice(0, this.held.length - this.tail);
    this.held = this.held.slice(this.held.length - this.tail);
    return out;
  }

  /** The held tail, at the end of the stream. */
  flush(): string {
    if (this.stopped) return '';
    const out = this.held;
    this.held = '';
    return out;
  }
}

/**
 * A string taken out of a text as it arrives — RisuAI's `.replace(/##\n/g, '')`
 * on a completion — in one pass from the left, as the replace makes it; the
 * tail that may be the start of one is held back until it cannot be.
 */
export class Strip {
  private held = '';

  constructor(private readonly needle: string) {}

  push(text: string): string {
    this.held += text;
    let out = '';
    let at: number;
    while ((at = this.held.indexOf(this.needle)) >= 0) {
      out += this.held.slice(0, at);
      this.held = this.held.slice(at + this.needle.length);
    }
    let keep = Math.min(this.held.length, this.needle.length - 1);
    while (keep > 0 && !this.needle.startsWith(this.held.slice(-keep))) keep -= 1;
    out += this.held.slice(0, this.held.length - keep);
    this.held = this.held.slice(this.held.length - keep);
    return out;
  }

  flush(): string {
    const out = this.held;
    this.held = '';
    return out;
  }
}

/** A text delta, or nothing for an empty piece. */
export const textDelta = (text: string): StreamDelta[] => (text ? [{ type: 'text', text }] : []);
