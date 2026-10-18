/**
 * PocketRisu's model registry, schema v4 (`src/ts/preset/types.ts` at
 * PocketRisu f71e1cc, GPL-3.0): a base provider is an adapter family with its
 * shared request schema; a profile is one model on it — the request schema
 * merged over the base's, defaults, capabilities, limits and a status. A
 * preset made from a profile keeps a snapshot of the merged profile
 * (`ResolvedModelProfileSnapshot`) and its own values for the schema's fields.
 *
 * The data is the registry's (PocketRisu/pocketrisu-model-registry, CC0-1.0).
 * A profile's `endpoint`, `auth`, `headerTemplate` and non-body mappings are
 * kept as data and never read for a request: a key goes only to its own
 * credential's address (ARCHITECTURE §7.1, `registry/index.ts`).
 */

export type AdapterKind = 'openai-compatible' | 'anthropic-messages' | 'google-gemini';
export type AuthKind = 'none' | 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'query' | 'google-service-account';
export type EndpointKind = 'static' | 'vertex-openai' | 'vertex-gemini';
export type RegistryFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'json' | 'stringArray' | 'keyValue';
export type RegistryWidget =
  | 'text'
  | 'secret'
  | 'textarea'
  | 'number-input'
  | 'slider'
  | 'select'
  | 'segmented'
  | 'toggle'
  | 'combobox'
  | 'string-array'
  | 'json'
  | 'key-value';
export type UiVisibility = 'basic' | 'advanced' | 'hidden';
export type RegistryMappingTarget = 'body' | 'header' | 'query' | 'auth' | 'custom';
export type RegistryCapability = 'streaming' | 'vision' | 'tools' | 'json' | 'reasoning' | 'cache';
export type RegistryProfileStatus = 'current' | 'outdated' | 'deprecated';
export type RegistryTokenizer =
  | 'tik'
  | 'mistral'
  | 'novelai'
  | 'claude'
  | 'llama'
  | 'llama3'
  | 'novellist'
  | 'gemma'
  | 'cohere'
  | 'deepseek';

export interface RegistryMapping {
  target: RegistryMappingTarget;
  path: string;
}

export interface RegistryEnumOption {
  value: string | number | boolean;
  label: string;
}

export interface RegistryFieldSchema {
  key: string;
  type: RegistryFieldType;
  label: string;
  description?: string;
  descriptionI18n?: Record<string, string>;
  default?: unknown;
  enum?: RegistryEnumOption[];
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  secret?: boolean;
  mapsTo?: RegistryMapping;
}

export interface RegistrySimpleCondition {
  key: string;
  equals?: unknown;
  notEquals?: unknown;
}

export interface RegistryUiField {
  key: string;
  widget: RegistryWidget;
  visibility: UiVisibility;
  group?: string;
  order?: number;
  placeholder?: string;
  help?: string;
  showIf?: RegistrySimpleCondition;
}

export interface RegistryUiGroup {
  id: string;
  label: string;
  labelI18n?: Record<string, string>;
  order?: number;
}

export interface RegistryUiSchema {
  groups: RegistryUiGroup[];
  fields: RegistryUiField[];
}

export interface RegistryEndpoint {
  kind: EndpointKind;
  url?: string;
}

export interface RegistryAuth {
  kind: AuthKind;
  fields?: string[];
}

export interface ModelLimits {
  known?: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  sourceUrls?: string[];
  notes?: string;
  notesI18n?: Record<string, string>;
}

export interface BaseProviderDefinition {
  id: string;
  version: number;
  displayName: string;
  adapterKind: AdapterKind;
  authKinds: AuthKind[];
  endpointKinds: EndpointKind[];
  defaultHeaders?: Record<string, string>;
  defaultBody?: Record<string, unknown>;
  requestSchema: RegistryFieldSchema[];
  uiSchema: RegistryUiSchema;
  capabilities?: RegistryCapability[];
  limits?: ModelLimits;
  sourceUrls: string[];
}

export interface ModelProfile {
  id: string;
  version: number;
  /** When the profile was last revised (epoch ms): what "update available" compares. */
  updatedAt?: number;
  displayName: string;
  displayNameI18n?: Record<string, string>;
  providerBaseId: string;
  profileStatus: RegistryProfileStatus;
  statusReason?: string;
  statusSourceUrls?: string[];
  description?: string;
  descriptionI18n?: Record<string, string>;
  tags?: string[];
  sortOrder?: number;
  recommendedTokenizer?: RegistryTokenizer;
  modelId: string;
  endpoint: RegistryEndpoint;
  auth: RegistryAuth;
  defaults: Record<string, unknown>;
  schema: RegistryFieldSchema[];
  uiSchema: RegistryUiSchema;
  bodyTemplate?: Record<string, unknown>;
  headerTemplate?: Record<string, string>;
  capabilities?: RegistryCapability[];
  limits?: ModelLimits;
  sourceUrls: string[];
}

/** Which registry profile a preset was made from, and the revision it holds. */
export interface ModelPresetSourceProfile {
  registryId: string;
  profileId: string;
  profileVersion: number;
  providerBaseVersion?: number;
  fetchedAt: number;
  /** The profile's `updatedAt` when the preset took it; a newer one in the registry is an update. */
  profileUpdatedAt?: number;
}

/** A profile merged over its base provider, as a preset keeps it. */
export interface ResolvedModelProfileSnapshot {
  profileId: string;
  profileVersion: number;
  providerBaseId: string;
  providerBaseVersion: number;
  adapterKind: AdapterKind;
  auth: RegistryAuth;
  endpoint: RegistryEndpoint;
  modelId: string;
  schema: RegistryFieldSchema[];
  uiSchema: RegistryUiSchema;
  defaults: Record<string, unknown>;
  bodyTemplate?: Record<string, unknown>;
  headerTemplate?: Record<string, string>;
  capabilities?: RegistryCapability[];
  limits?: ModelLimits;
  recommendedTokenizer?: RegistryTokenizer;
}

/** The registry's `catalog.json`: every base provider and profile by id. */
export interface RegistryCatalog {
  schemaVersion: 4;
  hash?: string;
  baseProviders: Record<string, BaseProviderDefinition>;
  profiles: Record<string, ModelProfile>;
}
