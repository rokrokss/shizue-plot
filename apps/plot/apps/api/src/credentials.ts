import { credentials, type Credential } from '@shizue/db';
import { providerOf, type ModelCredential } from '@shizue/llm';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import { ApiError } from './errors.js';

/**
 * The owner's credentials (`credentials`, ARCHITECTURE §5, §7.1): the API keys,
 * AWS keys and Google service accounts they entered on this computer, and the
 * ChatGPT connection. A secret is sealed on its way in and opened only for the
 * call that sends it; no route answers with one.
 */

/** The longest key, label and address. */
export const MAX_SECRET_LENGTH = 10_000;
export const MAX_LABEL_LENGTH = 100;
export const MAX_URL_LENGTH = 2_000;

/** What the page knows of a key: enough to tell two apart, nothing to use — `sk-…a1b2`. */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '…';
  const head = /^[A-Za-z]{2,4}-/.exec(trimmed)?.[0] ?? trimmed.slice(0, 3);
  return `${head}…${trimmed.slice(-4)}`;
}

/** A credential as the page reads it: never its secret. */
export function credentialJson(row: Credential) {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    label: row.label,
    baseUrl: row.baseUrl,
    hint: row.hint,
    /** The ChatGPT connection has tokens; a key always counts as set. */
    connected: row.kind === 'chatgpt' ? Boolean(row.secrets['accessToken']) : true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const vaultOf = (deps: Pick<AppDeps, 'vault'>): NonNullable<AppDeps['vault']> => {
  if (!deps.vault) throw new ApiError(503, 'credentials_unavailable', 'Credentials are not configured');
  return deps.vault;
};

export async function loadCredential(deps: Pick<AppDeps, 'db'>, userId: string, id: string): Promise<Credential | undefined> {
  const [row] = await deps.db.select().from(credentials).where(and(eq(credentials.id, id), eq(credentials.userId, userId))).limit(1);
  return row;
}

/**
 * A credential with its secrets opened, for the one call that sends them: an
 * API key with its address, AWS keys with their region, a service account
 * with its project and region, or the owner's ChatGPT account. A seal the
 * install's secret no longer opens is `credential_unreadable` — the key must
 * be entered again.
 */
export function openCredential(deps: Pick<AppDeps, 'vault' | 'chatgpt'>, row: Credential): ModelCredential {
  if (row.kind === 'chatgpt') {
    if (!deps.chatgpt) throw new ApiError(503, 'chatgpt_unavailable', 'Sign in with ChatGPT is not configured');
    return { kind: 'chatgpt', account: deps.chatgpt.accounts.forUser(row.userId) };
  }
  const opened = (field: string): string => {
    const sealed = row.secrets[field];
    if (!sealed) return '';
    try {
      return vaultOf(deps).open(sealed);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, 'credential_unreadable', 'This key can no longer be read; enter it again');
    }
  };
  if (row.kind === 'aws') {
    const sessionToken = opened('sessionToken');
    return {
      kind: 'aws',
      provider: row.provider,
      accessKeyId: opened('accessKeyId'),
      secretAccessKey: opened('secretAccessKey'),
      region: row.meta.region ?? '',
      ...(sessionToken ? { sessionToken } : {}),
    };
  }
  if (row.kind === 'gcp_service_account') {
    return {
      kind: 'gcp_service_account',
      provider: row.provider,
      clientEmail: row.meta.clientEmail ?? '',
      privateKey: opened('privateKey'),
      projectId: row.meta.projectId ?? '',
      region: row.meta.region ?? '',
    };
  }
  if (row.kind !== 'api_key') throw new ApiError(400, 'credential_kind_unsupported', `Credentials of kind ${row.kind} are not supported yet`);
  return { kind: 'api_key', provider: row.provider, baseUrl: row.baseUrl, apiKey: opened('apiKey') };
}

/** An http(s) URL without credentials in it, or a 400. */
export function requireHttpUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) {
    throw new ApiError(400, 'invalid_request', `${field} must be a URL`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApiError(400, 'invalid_request', `${field} must be a URL`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new ApiError(400, 'invalid_request', `${field} must be an http(s) URL without a user name or password`);
  }
  return url.href.replace(/\/+$/, '');
}

/** The providers a key may be entered for: every one but the ChatGPT connection, which connects itself. */
export const keyProvider = (id: unknown) => (typeof id === 'string' && id !== 'chatgpt' ? providerOf(id) : undefined);
