import { createHash } from 'node:crypto';
import { generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { authorizationUrl, callbackResult, ChatGPTOAuth, createPendingSignIn, loopbackRedirectUri } from '../src/chatgptAuth.js';
import { createChatGPTAdapter, responseBody } from '../src/chatgptResponses.js';
import type { ChatRequest } from '../src/types.js';

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
async function fixture() {
  const keys = await generateKeyPair('RS256');
  const calls: { url: string; body: URLSearchParams }[] = [];
  let tokenScope = scope;
  let nonce = '';
  let subject = 'user-1';
  let revokeStatus = 200;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = new URLSearchParams(init?.body as string);
    calls.push({ url, body });
    if (url.endsWith('openid-configuration')) return json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke' });
    if (url.endsWith('/revoke')) return json({}, revokeStatus);
    if (url.endsWith('/models')) return json({ models: [
      { slug: 'gpt-test', display_name: 'GPT test', visibility: 'list', input_modalities: ['text', 'image'] },
      { slug: 'hidden', visibility: 'hidden' },
      { slug: 'next-model', visibility: 'list' },
    ] });
    if (url.endsWith('/oauth/token')) {
      if (body.get('code') === 'bad') return json({ error: 'invalid_grant', error_description: 'SECRET_TOKEN' }, 400);
      const refresh = body.get('grant_type') === 'refresh_token';
      const id_token = await new SignJWT({ sub: subject, email: 'me@example.com', name: 'Me', ...(refresh ? {} : { nonce }) })
        .setProtectedHeader({ alg: 'RS256' }).setIssuer('https://auth.openai.com').setAudience(body.get('client_id')!).setExpirationTime('1h').sign(keys.privateKey);
      return json({ access_token: refresh ? 'NEW_ACCESS' : 'ACCESS', refresh_token: refresh ? 'NEW_REFRESH' : 'REFRESH', id_token, expires_in: 3600, scope: tokenScope });
    }
    throw new Error(`Unexpected test endpoint: ${url}`);
  };
  const verify = ((token: string, _keys: unknown, options: Parameters<typeof jwtVerify>[2]) => jwtVerify(token, keys.publicKey, options)) as typeof jwtVerify;
  return {
    oauth: new ChatGPTOAuth({ fetch: fetcher, verify }), calls,
    setScope: (value: string) => { tokenScope = value; },
    setNonce: (value: string) => { nonce = value; },
    setSubject: (value: string) => { subject = value; },
    failRevoke: () => { revokeStatus = 503; },
  };
}

describe('ChatGPT OAuth', () => {
  it('starts with dynamic registration and PKCE, then reuses an issued registration', () => {
    const pending = createPendingSignIn(loopbackRedirectUri(47801));
    const url = new URL(authorizationUrl(pending, 'urn:uuid:host'));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'dynamic_agent_client', agent_name_hint: 'shizue', scope, redirect_uri: 'http://127.0.0.1:47801/auth/callback',
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
  it('asks for a reasoning effort only when one is chosen, and never for a summary', () => {
    expect(responseBody({ ...request, reasoningEffort: 'high' }).reasoning).toEqual({ effort: 'high' });
    expect(responseBody(request)).not.toHaveProperty('reasoning');
  });
  it('handles split UTF-8 / CRLF, local stop strings and terminal usage', async () => {
    const result = await collect(event({ type: 'response.output_text.delta', delta: '안녕\nUs' }) + event({ type: 'response.output_text.delta', delta: 'er: hidden' }) + event({ type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 7 } } }));
    expect(result).toEqual({ text: '안녕', usage: { promptTokens: 9, completionTokens: 7 } });
  });
  it.each(['response.failed', 'response.incomplete', 'error', 'interrupted'])('does not accept %s after partial text as success', async (type) => {
    await expect(collect(event({ type: 'response.output_text.delta', delta: 'partial text' }) + (type === 'interrupted' ? '' : event({ type, response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } })))).rejects.toThrow();
  });
  it('preserves quota error codes without leaking provider bodies', async () => {
    const adapter = createChatGPTAdapter(async () => 'TOKEN', async () => json({ detail: 'subscription_sharing_usage_limit_exceeded', token: 'SECRET' }, 429));
    await expect(adapter.stream(request).next()).rejects.toMatchObject({ code: 'subscription_sharing_usage_limit_exceeded', status: 429 });
  });
});
