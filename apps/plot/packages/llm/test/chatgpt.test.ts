import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizationUrl, callbackResult, ChatGPTOAuth, createPendingSignIn, loopbackRedirectUri } from '../src/chatgptAuth.js';
import { CHATGPT_IDLE_TIMEOUT_MS, ChatGPTError, createChatGPTAdapter, responseBody, withTrailingSystemJoined } from '../src/chatgptResponses.js';
import type { ChatRequest } from '../src/types.js';

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
async function fixture() {
  const keys = await generateKeyPair('RS256');
  const published = { ...await exportJWK(keys.publicKey), kid: 'key-1' };
  const calls: { url: string; body: URLSearchParams }[] = [];
  let tokenScope = scope;
  let nonce = '';
  let subject = 'user-1';
  let revokeStatus = 200;
  let kid = 'key-1';
  /** `keysAfterGrant`: the JWKS goes down the moment a token request succeeds. */
  const outage = { discovery: false, jwks: false, keysAfterGrant: false };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = new URLSearchParams(init?.body as string);
    calls.push({ url, body });
    if (url.endsWith('openid-configuration')) {
      if (outage.discovery) return new Response('<html>502 Bad Gateway</html>', { status: 502 });
      return json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke' });
    }
    if (url.endsWith('/jwks')) {
      if (outage.jwks) throw new TypeError('fetch failed');
      return json({ keys: [published] });
    }
    if (url.endsWith('/revoke')) return json({}, revokeStatus);
    if (url.endsWith('/models')) return json({ models: [
      { slug: 'gpt-test', display_name: 'GPT test', visibility: 'list', input_modalities: ['text', 'image'] },
      { slug: 'hidden', visibility: 'hidden' },
      { slug: 'next-model', visibility: 'list' },
    ] });
    if (url.endsWith('/oauth/token')) {
      if (body.get('code') === 'bad') return json({ error: 'invalid_grant', error_description: 'SECRET_TOKEN' }, 400);
      if (outage.keysAfterGrant) outage.jwks = true;
      const refresh = body.get('grant_type') === 'refresh_token';
      const id_token = await new SignJWT({ sub: subject, email: 'me@example.com', name: 'Me', ...(refresh ? {} : { nonce }) })
        .setProtectedHeader({ alg: 'RS256', kid }).setIssuer('https://auth.openai.com').setAudience(body.get('client_id')!).setExpirationTime('1h').sign(keys.privateKey);
      return json({ access_token: refresh ? 'NEW_ACCESS' : 'ACCESS', refresh_token: refresh ? 'NEW_REFRESH' : 'REFRESH', id_token, expires_in: 3600, scope: tokenScope });
    }
    throw new Error(`Unexpected test endpoint: ${url}`);
  };
  return {
    oauth: new ChatGPTOAuth({ fetch: fetcher }), calls, outage,
    setScope: (value: string) => { tokenScope = value; },
    setNonce: (value: string) => { nonce = value; },
    setSubject: (value: string) => { subject = value; },
    failRevoke: () => { revokeStatus = 503; },
    /** Signs ID tokens with a key ID the published set may lack, as after a rotation. */
    signWith: (value: string) => { kid = value; },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const previous = { accessToken: 'ACCESS', refreshToken: 'REFRESH', scope, expiresAt: 0 };
/** The two calls that spend something: the callback's code, or the stored refresh token. */
const spend = {
  exchange: (f: Fixture) => {
    const pending = createPendingSignIn(loopbackRedirectUri(47801));
    f.setNonce(pending.nonce);
    return f.oauth.exchange(pending, 'code', 'oaiapp_test');
  },
  refresh: (f: Fixture) => f.oauth.refresh('oaiapp_test', previous, 'user-1'),
};
const paths = (f: Fixture): string[] => f.calls.map((call) => new URL(call.url).pathname);

describe('ChatGPT OAuth', () => {
  it('starts with dynamic registration and PKCE, then reuses an issued registration', () => {
    const pending = createPendingSignIn(loopbackRedirectUri(47801));
    const url = new URL(authorizationUrl(pending, 'urn:uuid:host'));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'dynamic_agent_client', agent_name_hint: 'Shizue Plot', scope, redirect_uri: 'http://127.0.0.1:47801/auth/callback',
      state: pending.state, nonce: pending.nonce, ext_agent_host_id: 'urn:uuid:host', code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
    });
    const again = new URL(authorizationUrl(createPendingSignIn(pending.redirectUri, 'oaiapp_test'), 'urn:uuid:host'));
    expect(again.searchParams.get('client_id')).toBe('oaiapp_test');
    expect(again.searchParams.has('agent_name_hint')).toBe(false);
    expect(again.searchParams.get('state')).not.toBe(pending.state);
  });
  it('exchanges the code with the verifier and verifies who signed in', async () => {
    const f = await fixture();
    const pending = createPendingSignIn(loopbackRedirectUri(47801));
    f.setNonce(pending.nonce);
    const { tokens, identity } = await f.oauth.exchange(pending, 'code', 'oaiapp_test');
    expect(identity).toEqual({ subject: 'user-1', email: 'me@example.com', name: 'Me' });
    expect(tokens).toMatchObject({ accessToken: 'ACCESS', refreshToken: 'REFRESH', scope });
    const exchange = f.calls.find((call) => call.url.endsWith('/oauth/token'))!;
    expect(exchange.body.get('code_verifier')).toBe(pending.verifier);
    expect(exchange.body.get('redirect_uri')).toBe(pending.redirectUri);
    expect(exchange.body.get('resource')).toBe('https://api.openai.com/v1');
  });
  it.each([
    ['a replayed nonce', (f: Awaited<ReturnType<typeof fixture>>) => f.setNonce('other'), 'chatgpt_identity_mismatch'],
    ['a grant without plan access', (f: Awaited<ReturnType<typeof fixture>>) => f.setScope('openid email'), 'chatgpt_missing_plan_scope'],
  ])('rejects %s', async (_name, arrange, code) => {
    const f = await fixture();
    arrange(f);
    await expect(f.oauth.exchange(createPendingSignIn(loopbackRedirectUri(47801)), 'code', 'oaiapp_test')).rejects.toMatchObject({ code });
  });
  it('does not leak provider error bodies', async () => {
    const f = await fixture();
    const error = await f.oauth.exchange(createPendingSignIn(loopbackRedirectUri(47801)), 'bad', 'oaiapp_test').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'invalid_grant' });
    expect(JSON.stringify(error) + String(error)).not.toContain('SECRET_TOKEN');
  });
  it('rotates refresh tokens for the same account only', async () => {
    const f = await fixture();
    const previous = { accessToken: 'ACCESS', refreshToken: 'REFRESH', scope, expiresAt: 0 };
    expect(await f.oauth.refresh('oaiapp_test', previous, 'user-1')).toMatchObject({ accessToken: 'NEW_ACCESS', refreshToken: 'NEW_REFRESH' });
    f.setSubject('someone-else');
    await expect(f.oauth.refresh('oaiapp_test', previous, 'user-1')).rejects.toMatchObject({ code: 'chatgpt_identity_mismatch' });
  });
  it.each(['exchange', 'refresh'] as const)('%s loads discovery and the signing keys before spending anything, once per instance', async (step) => {
    const f = await fixture();
    await spend[step](f);
    await spend[step](f);
    expect(paths(f)).toEqual(['/.well-known/openid-configuration', '/jwks', '/api/accounts/oauth/token', '/api/accounts/oauth/token']);
  });
  it.each([
    ['exchange', 'discovery'], ['exchange', 'jwks'], ['refresh', 'discovery'], ['refresh', 'jwks'],
  ] as const)('%s spends nothing while %s is down, and fails as temporary', async (step, down) => {
    const f = await fixture();
    f.outage[down] = true;
    await expect(spend[step](f)).rejects.toMatchObject({ code: 'chatgpt_unavailable', status: 503 });
    expect(paths(f)).not.toContain('/api/accounts/oauth/token');
    f.outage[down] = false;
    await expect(spend[step](f)).resolves.toBeTruthy();
  });
  it('keeps a rotated refresh token whose new signing key cannot be fetched, for the same account only', async () => {
    const f = await fixture();
    f.signWith('key-2');
    f.outage.keysAfterGrant = true;
    expect(await spend.refresh(f)).toMatchObject({ accessToken: 'NEW_ACCESS', refreshToken: 'NEW_REFRESH' });
    f.setSubject('someone-else');
    await expect(spend.refresh(f)).rejects.toMatchObject({ code: 'chatgpt_identity_mismatch' });
  });
  it('refuses a key the fetched set lacks, and a sign-in whose key cannot be fetched', async () => {
    const f = await fixture();
    f.signWith('key-2');
    // The keys loaded again and still lack it: not an outage, so nothing is kept.
    await expect(spend.refresh(f)).rejects.toMatchObject({ code: 'ERR_JWKS_NO_MATCHING_KEY' });
    f.outage.keysAfterGrant = true;
    await expect(spend.exchange(f)).rejects.toMatchObject({ code: 'chatgpt_unavailable', status: 503 });
  });
  it('reports unconfirmed revocation without throwing and filters the model catalog', async () => {
    const f = await fixture();
    expect(await f.oauth.revoke('oaiapp_test', 'REFRESH')).toBe(true);
    expect(f.calls.at(-1)!.body.get('token')).toBe('REFRESH');
    f.failRevoke();
    expect(await f.oauth.revoke('oaiapp_test', 'REFRESH')).toBe(false);
    expect(await f.oauth.models('ACCESS')).toEqual([{ id: 'gpt-test', label: 'GPT test', vision: true }, { id: 'next-model', label: 'next-model', vision: false }]);
  });
  it('reads the reasoning efforts a model advertises, and only plain words', async () => {
    // Shaped like the Codex `/models` entries these field names were taken from
    // (from the Codex client, unverified against a live account): a list of
    // `{effort, description}` and the default's name.
    const oauth = new ChatGPTOAuth({ fetch: async () => json({ models: [
      { slug: 'gpt-reasoning', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
      ] },
      { slug: 'bare-strings', visibility: 'list', supported_reasoning_levels: ['minimal', 'xhigh', 'xhigh'] },
      { slug: 'odd-values', visibility: 'list', default_reasoning_level: 'High!', supported_reasoning_levels: [{ effort: 'Turbo' }, { effort: 7 }, null, 'a'.repeat(21), { description: 'no effort' }] },
      { slug: 'plain', visibility: 'list' },
    ] }) });
    expect(await oauth.models('ACCESS')).toEqual([
      { id: 'gpt-reasoning', label: 'gpt-reasoning', vision: false, reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
      { id: 'bare-strings', label: 'bare-strings', vision: false, reasoningEfforts: ['minimal', 'xhigh'] },
      // Nothing usable advertised: no selector, and nothing is ever sent.
      { id: 'odd-values', label: 'odd-values', vision: false },
      { id: 'plain', label: 'plain', vision: false },
    ]);
  });
  it('rejects callback substitution and authorization denial', () => {
    const params = (query: string) => new URLSearchParams(query);
    expect(() => callbackResult(params('state=forged&code=c&client_id=app_x'), { state: 's' })).toThrow(expect.objectContaining({ code: 'chatgpt_invalid_state' }));
    expect(() => callbackResult(params('state=s&error=access_denied'), { state: 's' })).toThrow(expect.objectContaining({ code: 'chatgpt_login_declined' }));
    expect(() => callbackResult(params('state=s&code=c&client_id=dynamic_agent_client'), { state: 's' })).toThrow(expect.objectContaining({ code: 'chatgpt_invalid_client' }));
    expect(() => callbackResult(params('state=s&code=c&client_id=oaiapp_other'), { state: 's', clientId: 'oaiapp_test' })).toThrow(expect.objectContaining({ code: 'chatgpt_invalid_client' }));
    // Issued IDs are not assumed to carry a particular prefix; a reauthorization may omit them.
    expect(callbackResult(params('state=s&code=c&client_id=app_x'), { state: 's' })).toEqual({ code: 'c', clientId: 'app_x' });
    expect(callbackResult(params('state=s&code=c'), { state: 's', clientId: 'oaiapp_test' })).toEqual({ code: 'c', clientId: 'oaiapp_test' });
  });
});


const request: ChatRequest = { model: 'gpt-test', system: 'character card', messages: [{ role: 'user', content: 'hello' }], maxTokens: 500, temperature: 0.7, stop: ['\nUser:'] };
const event = (value: unknown): string => `data: ${JSON.stringify(value)}\r\n\r\n`;
function streamFetch(source: string, capture?: (body: Record<string, unknown>) => void): typeof fetch {
  return async (_input, init) => {
    capture?.(JSON.parse(init!.body as string));
    const bytes = new TextEncoder().encode(source);
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
      controller.close();
    } }));
  };
}
async function collect(source: string): Promise<{ text: string; usage: unknown }> {
  const adapter = createChatGPTAdapter(async () => 'TOKEN', streamFetch(source));
  const stream = adapter.stream(request); let text = '';
  while (true) { const value = await stream.next(); if (value.done) return { text, usage: value.value.usage }; text += value.value.text; }
}
describe('ChatGPT Responses adapter', () => {
  it('sends the supported stateless request and preserves system-message ordering', () => {
    const body = responseBody({ ...request, messages: [
      { role: 'system', content: 'lore before history' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', url: 'data:image/png;base64,aA==' }] },
      { role: 'assistant', content: 'partial' }, { role: 'system', content: 'post-history' },
    ] });
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'model', 'store', 'stream']);
    expect(body).toMatchObject({ store: false, stream: true, instructions: 'character card', input: [
      { role: 'developer', content: 'lore before history' },
      { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,aA==' }] },
      { role: 'assistant', content: 'partial' }, { role: 'developer', content: 'post-history' },
    ] });
  });
  it('sends the system turns after the last turn of the conversation as one developer message, and joins nothing else', () => {
    const body = responseBody({ ...request, messages: [
      { role: 'system', content: 'directions of an old shape' }, { role: 'system', content: 'examples' },
      { role: 'user', content: 'hi' }, { role: 'system', content: 'depth lore' }, { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
      { role: 'system', content: 'recall' }, { role: 'system', content: 'post-history' }, { role: 'system', content: 'language' },
    ] });
    expect(body.input).toEqual([
      { role: 'developer', content: 'directions of an old shape' }, { role: 'developer', content: 'examples' },
      { role: 'user', content: 'hi' }, { role: 'developer', content: 'depth lore' }, { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
      { role: 'developer', content: 'recall\n\npost-history\n\nlanguage' },
    ]);
    // A continue ends on its partial: the system turns before it stay apart.
    const continued = [{ role: 'user', content: 'go' }, { role: 'system', content: 'a' }, { role: 'system', content: 'b' }, { role: 'assistant', content: 'part' }] as const;
    expect(responseBody({ ...request, messages: [...continued] }).input).toEqual([
      { role: 'user', content: 'go' }, { role: 'developer', content: 'a' }, { role: 'developer', content: 'b' }, { role: 'assistant', content: 'part' },
    ]);
    // Nothing but system turns: no conversation to close, left alone.
    expect(responseBody({ ...request, messages: [{ role: 'system', content: 'a' }, { role: 'system', content: 'b' }] }).input).toHaveLength(2);
  });
  it('keeps a picture on a trailing system turn in place, the texts around it joined', () => {
    expect(withTrailingSystemJoined([
      { role: 'assistant', content: 'hello' },
      { role: 'system', content: 'one' },
      { role: 'system', content: [{ type: 'text', text: 'two' }, { type: 'image', url: 'data:image/png;base64,aA==' }] },
      { role: 'system', content: 'three' },
    ])).toEqual([
      { role: 'assistant', content: 'hello' },
      { role: 'system', content: [{ type: 'text', text: 'one\n\ntwo' }, { type: 'image', url: 'data:image/png;base64,aA==' }, { type: 'text', text: 'three' }] },
    ]);
  });
  it('leaves the instructions out when there is no system text', () => {
    const body = responseBody({ ...request, system: '', messages: [{ role: 'user', content: 'hi' }] });
    expect(body).not.toHaveProperty('instructions');
    expect(body.input).toEqual([{ role: 'user', content: 'hi' }]);
  });
  it('asks for a reasoning effort only when one is chosen, and never for a summary', () => {
    expect(responseBody({ ...request, reasoningEffort: 'high' }).reasoning).toEqual({ effort: 'high' });
    expect(responseBody(request)).not.toHaveProperty('reasoning');
  });
  it('names the prompt cache, in the body and the session header, only when the caller gives a key', async () => {
    expect(responseBody({ ...request, cacheKey: 'chat-1' }).prompt_cache_key).toBe('chat-1');
    expect(responseBody(request)).not.toHaveProperty('prompt_cache_key');
    const sent: Headers[] = [];
    const done = event({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } });
    const fetcher: typeof fetch = async (input, init) => {
      sent.push(new Headers(init!.headers));
      return streamFetch(done)(input, init);
    };
    const adapter = createChatGPTAdapter(async () => 'TOKEN', fetcher);
    for (const req of [{ ...request, cacheKey: 'chat-1' }, request]) {
      const stream = adapter.stream(req);
      while (!(await stream.next()).done);
    }
    expect([sent[0]!.get('session_id'), sent[0]!.has('conversation_id')]).toEqual(['chat-1', false]);
    expect([sent[1]!.has('session_id'), sent[1]!.has('conversation_id')]).toEqual([false, false]);
  });
  it('handles split UTF-8 / CRLF, local stop strings and terminal usage', async () => {
    const result = await collect(event({ type: 'response.output_text.delta', delta: '안녕\nUs' }) + event({ type: 'response.output_text.delta', delta: 'er: hidden' }) + event({ type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 7 } } }));
    expect(result).toEqual({ text: '안녕', usage: { promptTokens: 9, completionTokens: 7 } });
  });
  it('reads how much of the prompt the provider cached, where the usage says it', async () => {
    const usage = { input_tokens: 2048, output_tokens: 7, input_tokens_details: { cached_tokens: 1536 } };
    const result = await collect(event({ type: 'response.output_text.delta', delta: '네' }) + event({ type: 'response.completed', response: { usage } }));
    expect(result.usage).toEqual({ promptTokens: 2048, completionTokens: 7, cachedPromptTokens: 1536 });
  });
  it.each(['response.failed', 'response.incomplete', 'error', 'interrupted'])('does not accept %s after partial text as success', async (type) => {
    await expect(collect(event({ type: 'response.output_text.delta', delta: 'partial text' }) + (type === 'interrupted' ? '' : event({ type, response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } })))).rejects.toThrow();
  });
  it('preserves quota error codes without leaking provider bodies', async () => {
    const adapter = createChatGPTAdapter(async () => 'TOKEN', async () => json({ detail: 'subscription_sharing_usage_limit_exceeded', token: 'SECRET' }, 429));
    await expect(adapter.stream(request).next()).rejects.toMatchObject({ code: 'subscription_sharing_usage_limit_exceeded', status: 429 });
  });
  /** Answers 401 `token_expired` to the tokens in `rejected` and a reply to any other. */
  function tokenCheckingFetch(rejected: Set<string>): { fetcher: typeof fetch; bearers: string[] } {
    const bearers: string[] = [];
    const reply = streamFetch(event({ type: 'response.output_text.delta', delta: '네' }) + event({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }));
    return {
      bearers,
      fetcher: async (input, init) => {
        const bearer = new Headers(init!.headers).get('authorization')!.slice('Bearer '.length);
        bearers.push(bearer);
        if (rejected.has(bearer)) return json({ error: { message: 'Provided authentication token is expired.', type: 'invalid_request_error', code: 'token_expired' } }, 401);
        return reply(input, init);
      },
    };
  }
  it('asks once for another token when the provider calls a fresh-looking one expired, and sends the request again with it', async () => {
    const asked: (string | undefined)[] = [];
    const access = async (rejected?: string) => { asked.push(rejected); return rejected ? 'NEW' : 'OLD'; };
    const { fetcher, bearers } = tokenCheckingFetch(new Set(['OLD']));
    const stream = createChatGPTAdapter(access, fetcher).stream(request);
    let text = '';
    for (let next = await stream.next(); !next.done; next = await stream.next()) text += next.value.text;
    expect(text).toBe('네');
    expect(asked).toEqual([undefined, 'OLD']);
    expect(bearers).toEqual(['OLD', 'NEW']);
  });
  it('lets a second refusal through rather than asking again', async () => {
    const asked: (string | undefined)[] = [];
    const access = async (rejected?: string) => { asked.push(rejected); return rejected ? 'NEW' : 'OLD'; };
    const { fetcher, bearers } = tokenCheckingFetch(new Set(['OLD', 'NEW']));
    await expect(createChatGPTAdapter(access, fetcher).stream(request).next()).rejects.toMatchObject({ code: 'token_expired', status: 401 });
    expect(asked).toEqual([undefined, 'OLD']);
    expect(bearers).toEqual(['OLD', 'NEW']);
  });
  it('asks for no other token on a refusal that is not about the token', async () => {
    const asked: (string | undefined)[] = [];
    const access = async (rejected?: string) => { asked.push(rejected); return 'TOKEN'; };
    const adapter = createChatGPTAdapter(access, async () => json({ error: { code: 'subscription_sharing_invalid_user' } }, 401));
    await expect(adapter.stream(request).next()).rejects.toMatchObject({ code: 'subscription_sharing_invalid_user', status: 401 });
    expect(asked).toEqual([undefined]);
  });
});

/** A response that stays open for the test to feed, and fails when aborted as fetch's own body does. */
function liveFetch(): { fetcher: typeof fetch; send: (value: unknown) => void } {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
  return {
    send: (value) => feed.enqueue(new TextEncoder().encode(event(value))),
    fetcher: async (_input, init) => {
      init?.signal?.addEventListener('abort', () => feed.error(init.signal!.reason));
      return new Response(body);
    },
  };
}
describe('ChatGPT Responses idle timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('gives up on a stream that goes quiet, as a timeout of its own', async () => {
    const live = liveFetch();
    const stream = createChatGPTAdapter(async () => 'TOKEN', live.fetcher).stream(request);
    live.send({ type: 'response.output_text.delta', delta: 'partial text' });
    expect((await stream.next()).value).toMatchObject({ type: 'text' });
    const rest = stream.next();
    let settled = false;
    rest.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(CHATGPT_IDLE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(rest).rejects.toMatchObject({ code: 'chatgpt_timeout', status: 504 });
  });
  it('lets a stream that keeps sending run past the old three-minute cap and the idle window alike', async () => {
    const live = liveFetch();
    const stream = createChatGPTAdapter(async () => 'TOKEN', live.fetcher).stream(request);
    const collected = (async () => {
      let text = '';
      while (true) { const value = await stream.next(); if (value.done) return text; text += value.value.text; }
    })();
    for (let minute = 0; minute < 7; minute += 1) {
      live.send({ type: 'response.output_text.delta', delta: `${minute}분 ` });
      await vi.advanceTimersByTimeAsync(60_000);
    }
    live.send({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 7 } } });
    expect(await collected).toBe('0분 1분 2분 3분 4분 5분 6분 ');
  });
  it("passes the caller's own abort through as an abort, not a timeout", async () => {
    const live = liveFetch();
    const caller = new AbortController();
    const next = createChatGPTAdapter(async () => 'TOKEN', live.fetcher).stream({ ...request, abortSignal: caller.signal }).next();
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    const error = await next.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChatGPTError);
  });
});
