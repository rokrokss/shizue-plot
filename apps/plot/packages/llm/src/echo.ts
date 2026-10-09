import { contentText, type ChatRequest, type LLMAdapter, type StreamDelta, type StreamDone } from './types.js';

/** Chunks between the stalls the burst simulation inserts. */
const STALL_EVERY = 12;
/** How many ordinary gaps long a stall runs. */
const STALL_FACTOR = 4;
/** Chunks released back to back straight after a stall. */
const BURST_CHUNKS = 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** ±50% around the configured gap, so no two chunks are evenly spaced. */
const jitter = (): number => 0.5 + Math.random();

/**
 * The gap in front of the chunk at `index`. Every twelfth one stalls for four
 * ordinary gaps and the three chunks behind it come out with no gap at all,
 * which is how a hosted model behaves when a slow leg is followed by a flush.
 * The first chunk stalls too — that is time to first token.
 */
function chunkDelay(delayMs: number, index: number): number {
  const phase = index % STALL_EVERY;
  if (phase === 0) return delayMs * STALL_FACTOR * jitter();
  if (phase <= BURST_CHUNKS) return 0;
  return delayMs * jitter();
}

export interface EchoOptions {
  /**
   * Milliseconds between chunks. 0 — the default — streams the whole text in one
   * tick, which is what the tests and CI want; anything positive gets the gaps,
   * the jitter and the stall-then-burst rhythm of a real stream, which is the
   * only way to see the client's pacing do its work locally. Set from
   * `ECHO_STREAM_DELAY_MS` (see `.env.example`): 25 is a fair likeness.
   */
  delayMs?: number;
}

/** Test/development adapter: streams the last user message back word by word. */
export function createEchoAdapter(options: EchoOptions = {}): LLMAdapter {
  const delayMs = Math.max(0, options.delayMs ?? 0);

  return {
    async *stream(req: ChatRequest): AsyncGenerator<StreamDelta, StreamDone> {
      const lastUser = [...req.messages].reverse().find((message) => message.role === 'user');
      // Words only: this adapter has no eyes, and an image part is simply not
      // part of what it echoes back.
      const text = lastUser ? contentText(lastUser.content) : '';
      const words = text.split(/(\s+)/).filter((part) => part.length > 0);

      let completion = '';
      let index = 0;
      for (const word of words) {
        if (req.abortSignal?.aborted) break;
        if (delayMs > 0) {
          const gap = chunkDelay(delayMs, index);
          if (gap > 0) await sleep(gap);
        }
        index += 1;
        completion += word;
        yield { type: 'text', text: word };
      }

      return {
        usage: {
          promptTokens:
            req.system.length + req.messages.reduce((sum, m) => sum + contentText(m.content).length, 0),
          completionTokens: completion.length,
        },
      };
    },
  };
}
