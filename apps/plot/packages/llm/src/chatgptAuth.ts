import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { CHATGPT_RESOURCE, providerError, requireOK } from './chatgptResponses.js';

// Sign in with ChatGPT (OpenAI's open-source flow), stateless: the caller keeps the
// pending attempt and the issued tokens, so one server can hold many accounts.
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const AUTH = 'https://auth.openai.com';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = (): string => randomBytes(32).toString('base64url');
const directScope = (scope: string): boolean => scope.split(/\s+/).includes('chatgpt.tokens.use.direct');
interface Discovery { issuer: string; jwks_uri: string; revocation_endpoint: string }
interface TokenResponse { access_token: string; refresh_token?: string; id_token?: string; scope?: string; expires_in: number }

export interface ChatGPTTokens { accessToken: string; refreshToken: string; idToken?: string; scope: string; expiresAt: number }
export interface ChatGPTIdentity { subject: string; email: string | null; name: string | null }
export interface ChatGPTModel { id: string; label: string; vision: boolean }
/** One sign-in attempt, held by the server between the redirect and the callback. */
export interface PendingSignIn { state: string; nonce: string; verifier: string; redirectUri: string; clientId?: string }
/** What a model call needs from one signed-in account. */
export interface ChatGPTAccount {
  accessToken(): Promise<string>;
  models(): Promise<ChatGPTModel[]>;
}

/** OpenAI accepts only this loopback redirect; only the port may differ. */
export const loopbackRedirectUri = (port: number): string => `http://127.0.0.1:${port}/auth/callback`;

/** `clientId` is the registration issued on an earlier sign-in, when one is known. */
export function createPendingSignIn(redirectUri: string, clientId?: string): PendingSignIn {
  return { state: random(), nonce: random(), verifier: random(), redirectUri, ...(clientId ? { clientId } : {}) };
}

export function authorizationUrl(pending: PendingSignIn, hostId: string): string {
  const url = new URL(`${AUTH}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    // A first sign-in registers this app for the account; later ones reuse the issued ID.
    client_id: pending.clientId ?? 'dynamic_agent_client', response_type: 'code',
    resource: CHATGPT_RESOURCE, scope: SCOPE, redirect_uri: pending.redirectUri,
    state: pending.state, nonce: pending.nonce,
    code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'), code_challenge_method: 'S256',
    ext_agent_host_id: hostId,
    ...(pending.clientId ? {} : { agent_name_hint: 'shizue' }),
  }).toString();
  return url.href;
}

export function callbackResult(params: URLSearchParams, pending: Pick<PendingSignIn, 'state' | 'clientId'>): { code: string; clientId: string } {
  if (params.get('state') !== pending.state) throw providerError('chatgpt_invalid_state', 400);
  if (params.has('error')) throw providerError('chatgpt_login_declined', 400);
  // A reauthorization may omit client_id; a different one is never accepted.
  const clientId = params.get('client_id') || pending.clientId;
  if (!clientId || clientId === 'dynamic_agent_client' || (pending.clientId && pending.clientId !== clientId)) throw providerError('chatgpt_invalid_client', 400);
  const code = params.get('code');
  if (!code) throw providerError('chatgpt_missing_code', 400);
  return { code, clientId };
}

const endpoint = (url: string): URL => {
  const parsed = new URL(url);
  if (parsed.origin !== AUTH) throw providerError('chatgpt_invalid_issuer');
  return parsed;
};

export class ChatGPTOAuth {
  private oidc?: Discovery;
  private keys?: ReturnType<typeof createRemoteJWKSet>;
  private readonly fetcher: typeof fetch;
  private readonly verify: typeof jwtVerify;

  constructor(options: { fetch?: typeof fetch; verify?: typeof jwtVerify } = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.verify = options.verify ?? jwtVerify;
  }

  private async discovery(): Promise<Discovery> {
    if (!this.oidc) {
      const response = await requireOK(await this.fetcher(`${AUTH}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) }));
      const config = await response.json() as Discovery;
      if (config.issuer !== AUTH) throw providerError('chatgpt_invalid_issuer');
      this.keys = createRemoteJWKSet(endpoint(config.jwks_uri));
      this.oidc = config;
    }
    return this.oidc;
  }

  private async tokenRequest(parameters: Record<string, string>): Promise<TokenResponse> {
    const response = await requireOK(await this.fetcher(`${AUTH}/api/accounts/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...parameters, resource: CHATGPT_RESOURCE }),
      signal: AbortSignal.timeout(25_000),
    }));
    return await response.json() as TokenResponse;
  }

  private async validate(result: TokenResponse, clientId: string, nonce?: string, subject?: string, previous?: ChatGPTTokens): Promise<{ tokens: ChatGPTTokens; identity?: JWTPayload }> {
    const scope = result.scope ?? previous?.scope ?? '';
    if (typeof result.access_token !== 'string' || !result.access_token || !directScope(scope)) throw providerError('chatgpt_missing_plan_scope', 401);
    if (!Number.isFinite(result.expires_in) || result.expires_in <= 0) throw providerError('chatgpt_invalid_token');
    let identity: JWTPayload | undefined;
    if (result.id_token) {
      const config = await this.discovery();
      const verified = await this.verify(result.id_token, this.keys!, { issuer: config.issuer, audience: clientId, requiredClaims: ['sub', 'exp', ...(nonce ? ['nonce'] : [])] });
      identity = verified.payload;
      if ((nonce && identity.nonce !== nonce) || (subject && identity.sub !== subject)) throw providerError('chatgpt_identity_mismatch', 401);
    } else if (nonce) throw providerError('chatgpt_missing_identity', 401);
    const refreshToken = result.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) throw providerError('chatgpt_missing_offline_scope', 401);
    return {
      identity,
      tokens: { accessToken: result.access_token, refreshToken, idToken: result.id_token ?? previous?.idToken, scope, expiresAt: Date.now() + result.expires_in * 1000 },
    };
  }

  /** Exchanges the callback's code and verifies who signed in. */
  async exchange(pending: PendingSignIn, code: string, clientId: string): Promise<{ tokens: ChatGPTTokens; identity: ChatGPTIdentity }> {
    const result = await this.tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier });
    const { tokens, identity } = await this.validate(result, clientId, pending.nonce);
    const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
    return { tokens, identity: { subject: identity!.sub!, email: text(identity!['email']), name: text(identity!['name']) } };
  }

  /** Rotates the refresh token; the caller stores the result before using it. */
  async refresh(clientId: string, previous: ChatGPTTokens, subject: string): Promise<ChatGPTTokens> {
    const result = await this.tokenRequest({ grant_type: 'refresh_token', client_id: clientId, refresh_token: previous.refreshToken });
    return (await this.validate(result, clientId, undefined, subject, previous)).tokens;
  }

  /** Best effort: false when OpenAI could not confirm the revocation. */
  async revoke(clientId: string, refreshToken: string): Promise<boolean> {
    try {
      const config = await this.discovery();
      const response = await this.fetcher(endpoint(config.revocation_endpoint), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch { return false; }
  }

  /** The account's own catalog, in its order; only models it lists for use. */
  async models(accessToken: string): Promise<ChatGPTModel[]> {
    const response = await requireOK(await this.fetcher(`${CHATGPT_RESOURCE}/models`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) }));
    const body = await response.json() as { models?: { slug: string; display_name?: string; visibility: string; input_modalities?: string[] }[] };
    if (!Array.isArray(body.models)) throw providerError('chatgpt_invalid_catalog');
    return body.models.filter((model) => model.visibility === 'list' && typeof model.slug === 'string').map((model) => ({
      id: model.slug, label: model.display_name || model.slug,
      // Do not assume an unknown model can read images.
      vision: Array.isArray(model.input_modalities) && model.input_modalities.includes('image'),
    }));
  }
}
