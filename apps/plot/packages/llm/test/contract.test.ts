/**
 * What every format added for RisuAI's other `LLMFormat`s answers the same
 * way: a provider's refusal as a typed error by its HTTP status, its words in
 * the log's detail with the key taken out; a server nobody answers at; the
 * caller's own abort passed through as an abort; and a provider gone quiet as
 * `provider_timeout`.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapterFor, type ModelCredential, type PresetConfig } from '../src/formats/index.js';
import { GOOGLE_TOKEN_URL } from '../src/formats/vertex.js';
import { IDLE_TIMEOUT_MS } from '../src/stream.js';
import { LLMError } from '../src/types.js';
import { drain, liveFetch, recordingFetch, REQUEST, type SentRequest } from './helpers.js';

const env = { NODE_ENV: 'test' };
const key = (provider: string): ModelCredential => ({ kind: 'api_key', provider, baseUrl: null, apiKey: 'sk-test-key' });
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const gcp: ModelCredential = { kind: 'gcp_service_account', provider: 'vertex', clientEmail: 'contract@my-project.iam.gserviceaccount.com', privateKey, projectId: 'my-project', region: 'us-central1' };
const aws: ModelCredential = { kind: 'aws', provider: 'aws', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
/** Vertex's token, which every call of its asks for first (or has kept). */
const token = (sent: SentRequest): Response | undefined =>
  sent.url === GOOGLE_TOKEN_URL ? Response.json({ access_token: 'ya29.contract', expires_in: 3599 }) : undefined;

interface Case {
  format: string;
  model: string;
  credential?: ModelCredential;
  setup?: (sent: SentRequest) => Response | undefined;
}

const CASES: Case[] = [
  { format: 'openai-legacy', model: 'gpt-3.5-turbo-instruct', credential: key('openai') },
  { format: 'anthropic-legacy', model: 'claude-2.1', credential: key('anthropic') },
  { format: 'mistral', model: 'mistral-small-latest', credential: key('mistral') },
  { format: 'cohere', model: 'command-a-03-2025', credential: key('cohere') },
  { format: 'vertex', model: 'gemini-2.5-flash', credential: gcp, setup: token },
  { format: 'bedrock', model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', credential: aws },
  { format: 'ollama', model: 'qwen3:8b' },
  { format: 'ooba', model: 'loaded' },
  { format: 'ooba-legacy', model: 'loaded' },
  { format: 'kobold', model: 'koboldcpp' },
  { format: 'novelai', model: 'kayra-v1', credential: key('novelai') },
  { format: 'novellist', model: 'supertrin', credential: key('novellist') },
  { format: 'horde', model: 'auto' },
];

const preset = (entry: Case): PresetConfig => ({ format: entry.format, endpoint: null, model: entry.model, params: {}, capabilities: {} });
const ask = (entry: Case, extra: Partial<typeof REQUEST> = {}) => ({ ...REQUEST, model: entry.model, ...extra });

describe.each(CASES)('$format', (entry) => {
  it.each([
    [401, 'provider_unauthorized'],
    [403, 'provider_unauthorized'],
    [429, 'provider_rate_limited'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ])('tells a %i as %s, its words in the detail without the key', async (status, code) => {
    const { fetcher } = recordingFetch((sent) => entry.setup?.(sent)
      ?? Response.json({ error: { message: 'Incorrect API key provided: sk-proj-abcdefghijklmnop1234' }, message: 'Incorrect API key provided: sk-proj-abcdefghijklmnop1234' }, { status }));
    const error = await drain(adapterFor(preset(entry), entry.credential, env, fetcher).stream(ask(entry))).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ code, status });
    expect((error as LLMError).detail).toContain('Incorrect API key provided');
    expect((error as LLMError).detail).not.toContain('sk-proj');
  });

  it('tells a server nobody answers at', async () => {
    const refused: typeof fetch = async (input, init) => {
      const answered = entry.setup?.({ url: String(input), method: init?.method ?? 'GET', headers: {}, body: undefined, text: undefined });
      if (answered) return answered;
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:5000') });
    };
    await expect(drain(adapterFor(preset(entry), entry.credential, env, refused).stream(ask(entry)))).rejects.toMatchObject({ code: 'provider_unreachable' });
  });

  describe('abort and idle timeout', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
    afterEach(() => { vi.useRealTimers(); });

    /** The format's first call answered as it asks, the next left open for the test. */
    function opened() {
      const live = liveFetch();
      const fetcher: typeof fetch = async (input, init) =>
        entry.setup?.({ url: String(input), method: init?.method ?? 'GET', headers: {}, body: undefined, text: undefined }) ?? live.fetcher(input, init);
      return fetcher;
    }

    it("passes the caller's abort through as an abort", async () => {
      const caller = new AbortController();
      const next = adapterFor(preset(entry), entry.credential, env, opened()).stream(ask(entry, { abortSignal: caller.signal })).next();
      next.catch(() => {});
      await vi.advanceTimersByTimeAsync(10);
      caller.abort();
      const error = await next.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(LLMError);
    });

    it('gives up on a provider that goes quiet, as a timeout of its own', async () => {
      const next = adapterFor(preset(entry), entry.credential, env, opened()).stream(ask(entry)).next();
      next.catch(() => {});
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 10);
      await expect(next).rejects.toMatchObject({ code: 'provider_timeout', status: 504 });
    });
  });
});
