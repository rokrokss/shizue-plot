/**
 * The formats whose credential is not a key in a header: Gemini on Vertex AI
 * (a service account that mints its bearer token) and Claude on AWS Bedrock
 * (keys that sign each request, an event stream of binary frames).
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { jwtVerify, importSPKI } from 'jose';
import { describe, expect, it } from 'vitest';
import { readEventStream, signAws } from '../src/aws.js';
import { bedrockBody, bedrockModel } from '../src/formats/bedrock.js';
import { adapterFor, listModels, readServiceAccount, validateCredential, type ModelCredential, type PresetConfig } from '../src/formats/index.js';
import { GOOGLE_TOKEN_URL } from '../src/formats/vertex.js';
import { IdleWatch } from '../src/stream.js';
import { LLMError } from '../src/types.js';
import { drain, eventFrame, recordingFetch, REQUEST as BASE, sse, streamed, streamedBytes } from './helpers.js';

const env = { NODE_ENV: 'test' };
const preset = (format: string, model: string, overrides: Partial<PresetConfig> = {}): PresetConfig => ({
  format, endpoint: null, model, params: {}, capabilities: {}, ...overrides,
});

describe('Gemini on Vertex AI', () => {
  /** A service account of the test's own, so no two tests share a minted token. */
  function account(region = 'us-central1') {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const clientEmail = `shizue-${randomUUID().slice(0, 8)}@my-project.iam.gserviceaccount.com`;
    const credential: ModelCredential = { kind: 'gcp_service_account', provider: 'vertex', clientEmail, privateKey, projectId: 'my-project', region };
    return { credential, publicKey, clientEmail, privateKey };
  }
  const REPLY = sse({ candidates: [{ content: { role: 'model', parts: [{ text: '누구세요?' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3 } });
  const token = () => Response.json({ access_token: 'ya29.minted', expires_in: 3599, token_type: 'Bearer' });

  it("mints a token from the service account's signed assertion, keeps it, and streams from the region's endpoint", async () => {
    const { credential, publicKey, clientEmail } = account();
    const { fetcher, sent } = recordingFetch((request) => (request.url === GOOGLE_TOKEN_URL ? token() : streamed(REPLY)));
    const adapter = adapterFor(preset('vertex', 'gemini-2.5-flash', { params: { temperature: 0.9 } }), credential, env, fetcher);
    expect((await drain(adapter.stream({ ...BASE, model: 'gemini-2.5-flash' }))).text).toBe('누구세요?');
    await drain(adapter.stream({ ...BASE, model: 'gemini-2.5-flash' }));
    expect(sent.map((request) => request.url)).toEqual([
      GOOGLE_TOKEN_URL,
      'https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      'https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    ]);
    const form = new URLSearchParams(sent[0]!.text);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const { payload, protectedHeader } = await jwtVerify(form.get('assertion')!, await importSPKI(publicKey, 'RS256'), { issuer: clientEmail, audience: GOOGLE_TOKEN_URL });
    expect(protectedHeader).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(payload).toMatchObject({ scope: 'https://www.googleapis.com/auth/cloud-platform' });
    expect(payload.exp! - payload.iat!).toBe(3600);
    expect(sent[1]!.headers['authorization']).toBe('Bearer ya29.minted');
    expect(sent[1]!.body).toMatchObject({ generationConfig: { maxOutputTokens: 1200, temperature: 0.9 }, systemInstruction: { parts: [{ text: 'You are the narrator.\n\n[Start a new chat]' }] } });
  });

  it('sends the models only the global endpoint serves there, and the region global everything', async () => {
    const regional = account();
    const one = recordingFetch((request) => (request.url === GOOGLE_TOKEN_URL ? token() : streamed(REPLY)));
    await drain(adapterFor(preset('vertex', 'gemini-3.5-flash'), regional.credential, env, one.fetcher).stream({ ...BASE, model: 'gemini-3.5-flash' }));
    expect(one.sent[1]!.url).toBe('https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/google/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
    const global = account('global');
    const two = recordingFetch((request) => (request.url === GOOGLE_TOKEN_URL ? token() : streamed(REPLY)));
    await drain(adapterFor(preset('vertex', 'gemini-2.5-pro'), global.credential, env, two.fetcher).stream({ ...BASE, model: 'gemini-2.5-pro' }));
    expect(two.sent[1]!.url).toBe('https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
  });

  it('tells a refused account as unauthorized, checks a key by minting a token, and offers Gemini models to pick', async () => {
    const refused = account();
    const { fetcher } = recordingFetch(() => Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: 400 }));
    await expect(drain(adapterFor(preset('vertex', 'gemini-2.5-flash'), refused.credential, env, fetcher).stream({ ...BASE, model: 'gemini-2.5-flash' })))
      .rejects.toMatchObject({ code: 'provider_unauthorized', status: 400, detail: 'Invalid JWT Signature.' });
    await expect(validateCredential(refused.credential, env, fetcher)).rejects.toMatchObject({ code: 'provider_unauthorized' });
    const good = account();
    const minted = recordingFetch(() => token());
    await validateCredential(good.credential, env, minted.fetcher);
    expect(minted.sent.map((request) => request.url)).toEqual([GOOGLE_TOKEN_URL]);
    expect((await listModels('vertex', null, good.credential, env)).map((model) => model.id)).toContain('gemini-2.5-flash');
  });

  it("reads a service account's key file, and says what one is missing", async () => {
    const { privateKey, clientEmail } = account();
    const file = JSON.stringify({ type: 'service_account', project_id: 'my-project', private_key_id: 'k1', private_key: privateKey, client_email: clientEmail });
    expect(await readServiceAccount(file)).toEqual({ clientEmail, privateKey, projectId: 'my-project' });
    for (const bad of ['nope', JSON.stringify({ project_id: 'my-project', private_key: privateKey }), JSON.stringify({ client_email: clientEmail, project_id: 'my-project', private_key: 'not a key' })]) {
      await expect(readServiceAccount(bad)).rejects.toBeInstanceOf(TypeError);
    }
  });
});

describe('AWS Signature Version 4', () => {
  const keys = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
  const now = new Date('2026-10-18T12:34:56Z');
  // Each signature as `@smithy/signature-v4` 5.6.12 (the AWS SDK's signer) gives it for the same request.
  it('signs as the AWS SDK does: a path encoded once more, a query, a session token', () => {
    const invoke = signAws({
      method: 'POST',
      url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke-with-response-stream',
      headers: { 'content-type': 'application/json', accept: 'application/vnd.amazon.eventstream', 'x-amzn-bedrock-accept': 'application/json' },
      body: '{"anthropic_version":"bedrock-2023-05-31","max_tokens":10}',
    }, keys, 'bedrock', now);
    expect(invoke.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261018/us-east-1/bedrock/aws4_request, '
      + 'SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date;x-amzn-bedrock-accept, '
      + 'Signature=6f36f81aff66d1db2a06e044a438d115a30c2b197bdf576ee740f0c7e3014aa8',
    );
    expect(invoke['x-amz-date']).toBe('20261018T123456Z');
    const list = signAws({ method: 'GET', url: 'https://bedrock.us-east-1.amazonaws.com/foundation-models?byProvider=Anthropic&byOutputModality=TEXT', headers: {} }, keys, 'bedrock', now);
    expect(list.authorization).toContain('Signature=173a9b3d8cde6f01394c5f623d44ae89e3fa5c7bc052099e0bb7ec9e8f0d7bc8');
    const session = signAws({
      method: 'POST',
      url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke-with-response-stream',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, { ...keys, sessionToken: 'FQoGZXIvYXdzEXAMPLETOKEN' }, 'bedrock', now);
    expect(session['x-amz-security-token']).toBe('FQoGZXIvYXdzEXAMPLETOKEN');
    expect(session.authorization).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=ffc6655eadcd57b329887a332db2e13ac9736551e79ffc8bbdcc1de3682e4dd9');
  });
});

describe('the AWS event stream', () => {
  const errors = { invalid: () => new LLMError('invalid', 'invalid'), interrupted: () => new LLMError('interrupted', 'interrupted') };
  const read = async (bytes: Uint8Array) => {
    const out: { headers: Record<string, string>; payload: string }[] = [];
    for await (const message of readEventStream(streamedBytes(bytes).body!, new IdleWatch(undefined), errors)) {
      out.push({ headers: message.headers, payload: new TextDecoder().decode(message.payload) });
    }
    return out;
  };

  it('reads messages split anywhere, and refuses a bad checksum or a body cut inside one', async () => {
    const first = eventFrame({ ':message-type': 'event', ':event-type': 'chunk' }, '{"a":1}');
    const second = eventFrame({ ':message-type': 'exception', ':exception-type': 'throttlingException' }, '{"message":"slow"}');
    expect(await read(new Uint8Array([...first, ...second]))).toEqual([
      { headers: { ':message-type': 'event', ':event-type': 'chunk' }, payload: '{"a":1}' },
      { headers: { ':message-type': 'exception', ':exception-type': 'throttlingException' }, payload: '{"message":"slow"}' },
    ]);
    const corrupt = first.slice();
    corrupt[corrupt.length - 6] ^= 1;
    await expect(read(corrupt)).rejects.toThrow('invalid');
    await expect(read(first.slice(0, first.length - 3))).rejects.toThrow('interrupted');
  });
});

describe('Claude on AWS Bedrock', () => {
  const aws: ModelCredential = { kind: 'aws', provider: 'aws', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
  /** A `chunk` event carrying one Messages event, as Bedrock frames them. */
  const chunk = (event: unknown) => eventFrame(
    { ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event' },
    JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64'), p: 'abcdefgh' }),
  );
  const REPLY = new Uint8Array([
    ...chunk({ type: 'message_start', message: { usage: { input_tokens: 21, output_tokens: 1 } } }),
    ...chunk({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '문을 본다' } }),
    ...chunk({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '누구' } }),
    ...chunk({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '세요?' } }),
    ...chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    ...chunk({ type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 21, outputTokenCount: 5 } }),
  ]);

  it("signs the Messages body to invoke-with-response-stream, through RisuAI's inference profile, and reads its frames", async () => {
    const { fetcher, sent } = recordingFetch(() => streamedBytes(REPLY));
    const model = 'anthropic.claude-sonnet-4-5-20250929-v1:0';
    const adapter = adapterFor(preset('bedrock', model, { params: { temperature: 0.8, topK: 30 } }), aws, env, fetcher);
    const { text, reasoning, done } = await drain(adapter.stream({ ...BASE, model }));
    expect(text).toBe('누구세요?');
    expect(reasoning).toBe('문을 본다');
    expect(done.usage).toEqual({ promptTokens: 21, completionTokens: 5 });
    expect(sent[0]!.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke-with-response-stream');
    expect(sent[0]!.headers).toMatchObject({ accept: 'application/vnd.amazon.eventstream', 'content-type': 'application/json', 'x-amzn-bedrock-accept': 'application/json' });
    expect(sent[0]!.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date;x-amzn-bedrock-accept, Signature=[0-9a-f]{64}$/,
    );
    expect(sent[0]!.body).toEqual({ anthropic_version: 'bedrock-2023-05-31', ...bedrockBody({ ...BASE, model, temperature: 0.8, topK: 30 }) });
    expect(sent[0]!.body).not.toHaveProperty('model');
    expect(sent[0]!.body).not.toHaveProperty('stream');
    expect(sent[0]!.body).toMatchObject({ max_tokens: 1200, temperature: 0.8, top_k: 30, system: 'You are the narrator.\n\n[Start a new chat]' });
  });

  it('asks a base id through its geography or the global profile, and a profile or an ARN as it is', () => {
    expect(bedrockModel('anthropic.claude-3-5-sonnet-20241022-v2:0', 'us-west-2')).toBe('us.anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(bedrockModel('anthropic.claude-3-5-sonnet-20241022-v2:0', 'eu-central-1')).toBe('eu.anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(bedrockModel('anthropic.claude-3-7-sonnet-20250219-v1:0', 'ap-northeast-2')).toBe('apac.anthropic.claude-3-7-sonnet-20250219-v1:0');
    expect(bedrockModel('anthropic.claude-opus-4-6-v1', 'ap-northeast-2')).toBe('global.anthropic.claude-opus-4-6-v1');
    expect(bedrockModel('us.anthropic.claude-sonnet-4-20250514-v1:0', 'us-east-1')).toBe('us.anthropic.claude-sonnet-4-20250514-v1:0');
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc';
    expect(bedrockModel(arn, 'us-east-1')).toBe(arn);
  });

  it("tells a stream exception by its type, and lists Anthropic's models with the keys", async () => {
    const { fetcher } = recordingFetch(() => streamedBytes(new Uint8Array([
      ...chunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: '부분' } }),
      ...eventFrame({ ':message-type': 'exception', ':exception-type': 'throttlingException', ':content-type': 'application/json' }, '{"message":"Too many tokens, please wait."}'),
    ])));
    await expect(drain(adapterFor(preset('bedrock', 'x'), aws, env, fetcher).stream({ ...BASE, model: 'us.anthropic.claude-3-haiku-20240307-v1:0' })))
      .rejects.toMatchObject({ code: 'provider_rate_limited', detail: 'throttlingException: Too many tokens, please wait.' });
    const listing = recordingFetch(() => Response.json({ modelSummaries: [
      { modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0', modelName: 'Claude Sonnet 4.5', providerName: 'Anthropic', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], responseStreamingSupported: true },
      { modelId: 'anthropic.claude-v2:1:200k', modelName: 'Claude', inputModalities: ['TEXT'], responseStreamingSupported: false },
    ] }));
    expect(await listModels('bedrock', null, aws, env, listing.fetcher)).toEqual([{ id: 'anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude Sonnet 4.5', vision: true }]);
    expect(listing.sent[0]!.url).toBe('https://bedrock.us-east-1.amazonaws.com/foundation-models?byProvider=Anthropic&byOutputModality=TEXT');
    expect(listing.sent[0]!.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request/);
    // The key check is the listing: it needs the keys.
    await validateCredential(aws, env, listing.fetcher);
    expect(listing.sent).toHaveLength(2);
  });
});
