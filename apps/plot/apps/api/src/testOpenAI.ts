import { ChatGPTOAuth } from '@shizue/llm';

/**
 * NODE_ENV=test only (CHATGPT_FAKE_OPENAI=1): OpenAI's sign-in endpoints answered
 * in-process, so the browser suite can run the whole extension round trip. The
 * suite routes auth.openai.com itself and puts the identity it chose — nonce
 * included — into the authorization code as `fake.<base64url JSON>`.
 */
export function fakeChatGPTOAuth(): ChatGPTOAuth {
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = new URLSearchParams(init?.body as string);
    if (url.endsWith('openid-configuration')) {
      return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke' });
    }
    if (url.endsWith('/revoke')) return Response.json({});
    if (url.endsWith('/oauth/token')) {
      const code = body.get('code') ?? '';
      const identity = code.startsWith('fake.') ? JSON.parse(Buffer.from(code.slice(5), 'base64url').toString('utf8')) as Record<string, unknown> : null;
      if (!identity && body.get('grant_type') !== 'refresh_token') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({
        access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600,
        scope: 'openid email offline_access chatgpt.tokens.use.direct',
        ...(identity ? { id_token: JSON.stringify(identity) } : {}),
      });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  // The identity is the test's own JSON, not a signed token.
  return new ChatGPTOAuth({ fetch: fetcher, verify: (async (token: string) => ({ payload: JSON.parse(token) })) as never });
}
