import type { LLMEnv } from '../../src/registry.js';
import { LLMError } from '../../src/types.js';

export interface Embedder {
  /** One vector per input, in input order. */
  embed(input: string[]): Promise<number[][]>;
}

export interface EmbeddingOptions {
  /** e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Request deadline. Callers on the response path cannot wait indefinitely. */
  timeoutMs?: number;
}

/** Default deadline: retrieval runs before the SSE stream opens. */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 3000;

interface EmbeddingResponse {
  data?: { index?: number; embedding?: number[] }[];
}

/** OpenAI-compatible `POST /embeddings`. */
export function createEmbedderFrom(options: EmbeddingOptions): Embedder {
  const { baseUrl, apiKey, model, timeoutMs = DEFAULT_EMBEDDING_TIMEOUT_MS } = options;

  return {
    async embed(input: string[]): Promise<number[][]> {
      if (input.length === 0) return [];

      const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new LLMError(`Embedding upstream ${response.status}: ${detail.slice(0, 500)}`);
      }

      const payload = (await response.json()) as EmbeddingResponse;
      const data = payload.data;
      if (!Array.isArray(data) || data.length !== input.length) {
        throw new LLMError(`Embedding response did not cover all ${input.length} inputs`);
      }

      // `index` is authoritative; providers are not required to preserve order.
      const vectors = new Array<number[] | undefined>(input.length).fill(undefined);
      for (const [position, entry] of data.entries()) {
        const vector = entry.embedding;
        const index = entry.index ?? position;
        if (!Array.isArray(vector)) throw new LLMError('Embedding response is missing a vector');
        if (index < 0 || index >= input.length) throw new LLMError('Embedding response index is out of range');
        vectors[index] = vector;
      }
      if (vectors.some((vector) => vector === undefined)) {
        throw new LLMError('Embedding response has gaps in its indices');
      }
      return vectors as number[][];
    },
  };
}

/**
 * Env-gated embedder. Returns undefined unless all three EMBEDDING_* variables are
 * set — callers then skip fact extraction and retrieval entirely.
 *
 * `timeoutMs` overrides both the default and `EMBEDDING_TIMEOUT_MS`; background
 * callers use it to buy more time than a request-path retrieval may take.
 */
export function createEmbedder(env: LLMEnv, timeoutMs?: number): Embedder | undefined {
  // ChatGPT plan sharing has no embeddings route; retain only the isolated test seam.
  if ((env['NODE_ENV'] ?? process.env['NODE_ENV']) !== 'test') return undefined;
  const baseUrl = env['EMBEDDING_BASE_URL'];
  const apiKey = env['EMBEDDING_API_KEY'];
  const model = env['EMBEDDING_MODEL'];
  if (!baseUrl || !apiKey || !model) return undefined;
  const configured = Number(env['EMBEDDING_TIMEOUT_MS']);
  return createEmbedderFrom({
    baseUrl,
    apiKey,
    model,
    timeoutMs: timeoutMs ?? (configured > 0 ? configured : DEFAULT_EMBEDDING_TIMEOUT_MS),
  });
}
