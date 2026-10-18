import { createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { codeForStatus, errorMessageOf, providerFailure, providerFetch, redact } from '../http.js';
import { withPresetParams } from '../params.js';
import { StopFilter } from '../stream.js';
import type { LLMAdapter } from '../types.js';
import type { AdapterConfig, CatalogConfig, ModelAccess, ModelFormat, ModelListing } from './format.js';
import { GEMINI_PLACES, generateContentBody, modelPath, readGeminiStream } from './google.js';
import { postJson, watched } from './send.js';

/** Where a service account's assertion is exchanged for an access token, and the scope it asks for. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

type GcpAccess = Extract<ModelAccess, { kind: 'gcp' }>;

/** A service account's key as the page pastes it (the JSON file Google gives), or a `TypeError` that says what is missing. */
export async function readServiceAccount(text: string): Promise<{ clientEmail: string; privateKey: string; projectId: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError('serviceAccount must be the JSON key file of a service account');
  }
  const fields = (parsed ?? {}) as { client_email?: unknown; private_key?: unknown; project_id?: unknown };
  if (typeof fields.client_email !== 'string' || !fields.client_email.includes('@')) throw new TypeError('serviceAccount has no client_email');
  if (typeof fields.project_id !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(fields.project_id)) throw new TypeError('serviceAccount has no project_id');
  if (typeof fields.private_key !== 'string') throw new TypeError('serviceAccount has no private_key');
  try {
    await importPKCS8(fields.private_key, 'RS256');
  } catch {
    throw new TypeError('serviceAccount has a private_key that cannot be read');
  }
  return { clientEmail: fields.client_email, privateKey: fields.private_key, projectId: fields.project_id };
}

/** The access tokens minted in this process, by the account and its key, until shortly before they expire. */
const tokens = new Map<string, { token: string; expiresAt: number }>();

/**
 * A bearer token for the service account (RisuAI's `generateToken`): a JWT it
 * signs (RS256, the cloud-platform scope, an hour) exchanged at Google's token
 * endpoint, and kept until a minute before it expires. A refused account is
 * `provider_unauthorized`.
 */
export async function vertexToken(access: GcpAccess, fetcher: typeof fetch, signal?: AbortSignal): Promise<string> {
  const id = `${access.clientEmail}\0${createHash('sha256').update(access.privateKey).digest('hex')}`;
  const held = tokens.get(id);
  if (held && held.expiresAt - 60_000 > Date.now()) return held.token;
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(access.privateKey, 'RS256');
  } catch {
    throw providerFailure('provider_unauthorized', 401, 'The service account key cannot be read');
  }
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(access.clientEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
  const response = await providerFetch(fetcher, GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    ...(signal ? { signal } : {}),
  });
  const body = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } | null;
  if (!response.ok || typeof body?.access_token !== 'string') {
    // Google answers a key or an account it refuses with 400 `invalid_grant`.
    const code = response.status === 400 || response.status === 401 || response.status === 403 ? 'provider_unauthorized' : codeForStatus(response.status);
    throw providerFailure(code, response.status, redact(typeof body?.error_description === 'string' ? body.error_description : errorMessageOf(body)));
  }
  const seconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  tokens.set(id, { token: body.access_token, expiresAt: Date.now() + seconds * 1000 });
  return body.access_token;
}

/** The models served only from the global endpoint (RisuAI's `isVertexGlobalOnlyModel`). */
const GLOBAL_ONLY = [/^gemini-3-.*-preview$/, /^gemini-3\.[5678]-flash/];

/**
 * Where a project's Gemini models are: the region's endpoint, or the global one
 * for the region `global` and for the models only it serves.
 */
export function vertexBase(access: Pick<GcpAccess, 'projectId' | 'region'>, model = ''): string {
  const region = GLOBAL_ONLY.some((pattern) => pattern.test(model)) ? 'global' : access.region;
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(access.projectId)}/locations/${region}`;
}

/**
 * Gemini on Vertex AI (RisuAI's `VertexAIGemini`): the AI Studio body
 * (`generateContentBody`) to `…/publishers/google/models/<model>:streamGenerateContent?alt=sse`
 * on the project's endpoint, with the service account's bearer token
 * (`vertexToken`), read as AI Studio's stream is (`readGeminiStream`).
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        if (config.access.kind !== 'gcp') throw providerFailure('credential_required', 400);
        const access = config.access;
        watch.arm();
        const token = await vertexToken(access, config.fetch ?? fetch, watch.signal);
        watch.disarm();
        const url = `${vertexBase(access, req.model)}/publishers/google/models/${modelPath(req.model)}:streamGenerateContent?alt=sse`;
        const response = await postJson(config, url, generateContentBody(req), { ...config.headers }, { Authorization: `Bearer ${token}` }, watch);
        return yield* readGeminiStream(response, watch, new StopFilter(req.stop));
      });
    },
  };
}

/**
 * Vertex has no listing of the Gemini models a project may call, so the picker
 * offers RisuAI's (its Gemini list, which it sends Vertex the same); any other
 * id may be typed.
 */
const MODELS: ModelListing[] = [
  'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite',
].map((id) => ({ id, label: id, vision: true }));

export const vertex: ModelFormat = {
  id: 'vertex',
  places: GEMINI_PLACES,
  key: 'required',
  createAdapter,
  listModels: async () => MODELS,
  /** A token minted for the account is the key working. */
  async checkKey(config: CatalogConfig) {
    if (config.access.kind !== 'gcp') throw providerFailure('credential_required', 400);
    await vertexToken(config.access, config.fetch ?? fetch, AbortSignal.timeout(20_000));
  },
};
