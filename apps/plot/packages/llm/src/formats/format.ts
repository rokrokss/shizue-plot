import type { ChatGPTModel } from '../chatgptAuth.js';
import type { ModelCapabilities, ModelParameter, ModelParams, ParameterPlaces } from '../params.js';
import type { LLMAdapter } from '../types.js';

export type LLMEnv = Record<string, string | undefined>;

/** How a request proves who it is. */
export type ModelAccess =
  /** A server that asks for nothing: LM Studio, llama.cpp, vLLM, Ollama. */
  | { kind: 'none' }
  /** An API key; the format decides the header it goes in. */
  | { kind: 'key'; apiKey: string }
  /** The owner's ChatGPT connection: its access token, refreshed on a refusal, and its catalog. */
  | { kind: 'chatgpt'; accessToken: (rejected?: string) => Promise<string>; models: () => Promise<ChatGPTModel[]> };

/** What a format's adapter is made from: a model preset with its credential opened. */
export interface AdapterConfig {
  /** Where requests go: the credential's base URL, its provider's, the preset's endpoint, or the format's own. */
  baseUrl: string;
  access: ModelAccess;
  /** The preset's values, laid over every request on it (`withPresetParams`). */
  params: ModelParams;
  capabilities: ModelCapabilities;
  /** Headers the provider asks for (OpenRouter's `HTTP-Referer` and `X-Title`). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  env: LLMEnv;
}

/** What a model listing is asked with: no preset yet, only where and how. */
export type CatalogConfig = Pick<AdapterConfig, 'baseUrl' | 'access' | 'headers' | 'fetch' | 'env'>;

/** One model a provider offers, for the preset editor's picker. */
export interface ModelListing {
  id: string;
  label: string;
  /** Whether it reads pictures, where the provider says; absent where it does not. */
  vision?: boolean;
  /** The reasoning efforts it advertises (a ChatGPT model's catalog). */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

/**
 * One of RisuAI's request formats (`LLMFormat`): how a request is built and sent,
 * how its stream is read, which values it carries, and how the models behind an
 * address are listed. A new format is a module that exports one of these and a
 * line in `FORMATS` (`formats/index.ts`); the API, the preset editor and the
 * picker read everything else from it.
 */
export interface ModelFormat {
  /** The id `model_presets.format` stores. */
  id: string;
  /** The values it sends and where in the body (RisuAI's `applyParameters` list and rename map). */
  places: ParameterPlaces;
  /** Whether a preset on it needs a key, or may go keyless to a server that asks for none. */
  key: 'required' | 'optional';
  /** The values it sends on the ChatGPT connection, where it takes one (the Responses format). */
  chatgpt?: readonly ModelParameter[];
  /** Where requests go when neither a credential nor the preset says. */
  defaultBaseUrl?: string;
  /** Only the automated tests have it: `echo`. */
  testOnly?: boolean;
  createAdapter(config: AdapterConfig): LLMAdapter;
  listModels(config: CatalogConfig): Promise<ModelListing[]>;
}

/** How long a listing or a key check may take. */
export const CATALOG_TIMEOUT_MS = 20_000;
