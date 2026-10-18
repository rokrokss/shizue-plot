import type { ChatGPTAccount } from '../chatgptAuth.js';
import { CHATGPT_RESOURCE } from '../chatgptResponses.js';
import { joinUrl, providerFailure, providerFetch, providerHttpError } from '../http.js';
import type { ModelCapabilities, ModelParams } from '../params.js';
import { providerOf } from '../providers.js';
import type { LLMAdapter } from '../types.js';
import { anthropic } from './anthropic.js';
import { echoFormat } from './echo.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type LLMEnv, type ModelAccess, type ModelFormat, type ModelListing } from './format.js';
import { google } from './google.js';
import { openAIChat } from './openaiChat.js';
import { openAIResponses } from './openaiResponses.js';

/**
 * Every request format this build speaks, RisuAI's `LLMFormat` by string ids.
 * Wave 4 adds the rest of RisuAI's formats here, one module each.
 */
export const FORMATS: readonly ModelFormat[] = [openAIChat, openAIResponses, anthropic, google, echoFormat];

const testing = (env: LLMEnv): boolean => (env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test';

/** The format `id` names, where this launch has it: `echo` only under `NODE_ENV=test`. */
export function formatOf(id: string, env: LLMEnv): ModelFormat | undefined {
  const format = FORMATS.find((entry) => entry.id === id);
  return format && (!format.testOnly || testing(env)) ? format : undefined;
}

/** The formats this launch offers, in the order the editor lists them. */
export const availableFormats = (env: LLMEnv): ModelFormat[] => FORMATS.filter((format) => !format.testOnly || testing(env));

/** A model preset as the adapters read it (`model_presets`). */
export interface PresetConfig {
  format: string;
  /** A keyless preset's address; a keyed one goes to its credential's. */
  endpoint: string | null;
  model: string;
  params: ModelParams;
  capabilities: ModelCapabilities;
}

/** A credential with its secret opened (`credentials`). */
export type ModelCredential =
  | { kind: 'api_key'; provider: string; baseUrl: string | null; apiKey: string }
  | { kind: 'chatgpt'; account: ChatGPTAccount };

/** Whether a preset of `format` may use `credential`: the ChatGPT connection on the Responses format, a key on its provider's. */
export function credentialFits(format: ModelFormat, credential: { kind: string; provider?: string }): boolean {
  if (credential.kind === 'chatgpt') return Boolean(format.chatgpt);
  if (credential.kind !== 'api_key') return false;
  return providerOf(credential.provider ?? '')?.formats.includes(format.id) ?? false;
}

/**
 * Where a preset's requests go and what they carry. A key goes only to its own
 * credential's address — the base URL it was entered with, or its provider's —
 * never to the preset's endpoint, which only a keyless preset uses.
 */
export function connectionOf(
  format: ModelFormat,
  endpoint: string | null,
  credential: ModelCredential | undefined,
): Pick<AdapterConfig, 'baseUrl' | 'access' | 'headers'> {
  if (credential?.kind === 'chatgpt') {
    if (!format.chatgpt) throw providerFailure('credential_format_mismatch', 400);
    const { account } = credential;
    return { baseUrl: CHATGPT_RESOURCE, access: { kind: 'chatgpt', accessToken: (rejected) => account.accessToken(rejected), models: () => account.models() } };
  }
  if (credential?.kind === 'api_key') {
    const provider = providerOf(credential.provider);
    if (!provider || !provider.formats.includes(format.id)) throw providerFailure('credential_format_mismatch', 400);
    const baseUrl = credential.baseUrl ?? provider.baseUrl;
    if (!baseUrl) throw providerFailure('endpoint_required', 400);
    const access: ModelAccess = credential.apiKey ? { kind: 'key', apiKey: credential.apiKey } : { kind: 'none' };
    return { baseUrl, access, ...(provider.headers ? { headers: provider.headers } : {}) };
  }
  if (format.key === 'required') throw providerFailure('credential_required', 400);
  const baseUrl = endpoint ?? format.defaultBaseUrl;
  if (!baseUrl) throw providerFailure('endpoint_required', 400);
  return { baseUrl, access: { kind: 'none' } };
}

/** The adapter a model preset runs on — RisuAI's `requestChatDataMain` choosing by format. */
export function adapterFor(preset: PresetConfig, credential: ModelCredential | undefined, env: LLMEnv, fetcher?: typeof fetch): LLMAdapter {
  const format = formatOf(preset.format, env);
  if (!format) throw providerFailure('format_unavailable', 400);
  return format.createAdapter({
    ...connectionOf(format, preset.endpoint, credential),
    params: preset.params,
    capabilities: preset.capabilities,
    env,
    ...(fetcher ? { fetch: fetcher } : {}),
  });
}

/** The models behind a format's address, for the preset editor's picker. */
export async function listModels(
  formatId: string,
  endpoint: string | null,
  credential: ModelCredential | undefined,
  env: LLMEnv,
  fetcher?: typeof fetch,
): Promise<ModelListing[]> {
  const format = formatOf(formatId, env);
  if (!format) throw providerFailure('format_unavailable', 400);
  return format.listModels({ ...connectionOf(format, endpoint, credential), env, ...(fetcher ? { fetch: fetcher } : {}) });
}

/**
 * Whether a credential's key is good, by a call that needs it: OpenRouter's
 * `/key` (its `/models` answers anyone), the ChatGPT connection's catalog, and
 * otherwise the model listing of the provider's first format. Resolves or
 * throws the provider's refusal.
 */
export async function validateCredential(credential: ModelCredential, env: LLMEnv, fetcher?: typeof fetch): Promise<void> {
  if (credential.kind === 'chatgpt') {
    await credential.account.models();
    return;
  }
  const provider = providerOf(credential.provider);
  const format = provider ? formatOf(provider.formats[0]!, env) : undefined;
  if (!provider || !format) throw providerFailure('credential_format_mismatch', 400);
  const connection = connectionOf(format, null, credential);
  if (provider.checkPath) {
    const response = await providerFetch(fetcher ?? fetch, joinUrl(connection.baseUrl, provider.checkPath), {
      headers: { ...connection.headers, ...(connection.access.kind === 'key' ? { Authorization: `Bearer ${connection.access.apiKey}` } : {}) },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) throw await providerHttpError(response);
    return;
  }
  await format.listModels({ ...connection, env, ...(fetcher ? { fetch: fetcher } : {}) });
}

export type { AdapterConfig, CatalogConfig, LLMEnv, ModelAccess, ModelFormat, ModelListing } from './format.js';
