import type {
  BaseProviderDefinition,
  ModelLimits,
  ModelProfile,
  RegistryCatalog,
  RegistryFieldSchema,
  RegistryMappingTarget,
  RegistryUiField,
  RegistryUiGroup,
  RegistryUiSchema,
} from './types.js';

/**
 * A registry catalog as this app takes it: everything checked, because a
 * catalog fetched from the network is untrusted data. The envelope must be
 * schema v4 with its two maps; a base provider or profile that is not well
 * formed is left out, with its id in `dropped`, and so is a profile whose base
 * is gone. Strings are capped, mapping paths are dotted identifiers (never
 * `__proto__`, `constructor` or `prototype`), default bodies are plain JSON
 * within a size, and only the kinds PocketRisu defines are taken. Throws a
 * `TypeError` when the envelope is wrong or nothing usable remains.
 */
export function validateCatalog(raw: unknown): { catalog: RegistryCatalog; dropped: string[] } {
  if (!isRecord(raw)) throw new TypeError('catalog is not an object');
  if (raw['schemaVersion'] !== 4) throw new TypeError(`unsupported catalog schemaVersion ${String(raw['schemaVersion'])}`);
  if (!isRecord(raw['baseProviders']) || !isRecord(raw['profiles'])) throw new TypeError('catalog has no baseProviders or profiles');
  const hash = raw['hash'];
  if (hash !== undefined && (typeof hash !== 'string' || !HASH.test(hash))) throw new TypeError('catalog hash is not a content hash');
  const baseEntries = Object.entries(raw['baseProviders']);
  const profileEntries = Object.entries(raw['profiles']);
  if (baseEntries.length > MAX_BASES || profileEntries.length > MAX_PROFILES) throw new TypeError('catalog is too large');
  const dropped: string[] = [];
  const baseProviders: Record<string, BaseProviderDefinition> = {};
  for (const [id, value] of baseEntries) {
    const base = attempt(() => baseOf(value));
    if (base && base.id === id) baseProviders[id] = base;
    else dropped.push(`base:${id}`);
  }
  const profiles: Record<string, ModelProfile> = {};
  for (const [id, value] of profileEntries) {
    const profile = attempt(() => profileOf(value));
    if (profile && profile.id === id && baseProviders[profile.providerBaseId]) profiles[id] = profile;
    else dropped.push(`profile:${id}`);
  }
  if (Object.keys(profiles).length === 0) throw new TypeError('catalog has no usable profile');
  return { catalog: { schemaVersion: 4, ...(typeof hash === 'string' ? { hash } : {}), baseProviders, profiles }, dropped };
}

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_$-]{1,64}$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const MAX_BASES = 200;
const MAX_PROFILES = 5000;
const MAX_FIELDS = 200;
const MAX_TEXT = 4000;
const MAX_LIST = 200;
const MAX_JSON_BYTES = 64 * 1024;

const ADAPTER_KINDS = new Set(['openai-compatible', 'anthropic-messages', 'google-gemini']);
const AUTH_KINDS = new Set(['none', 'bearer', 'x-api-key', 'x-goog-api-key', 'query', 'google-service-account']);
const ENDPOINT_KINDS = new Set(['static', 'vertex-openai', 'vertex-gemini']);
const FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'json', 'stringArray', 'keyValue']);
const WIDGETS = new Set(['text', 'secret', 'textarea', 'number-input', 'slider', 'select', 'segmented', 'toggle', 'combobox', 'string-array', 'json', 'key-value']);
const VISIBILITIES = new Set(['basic', 'advanced', 'hidden']);
const TARGETS = new Set(['body', 'header', 'query', 'auth', 'custom']);
const CAPABILITIES = new Set(['streaming', 'vision', 'tools', 'json', 'reasoning', 'cache']);
const STATUSES = new Set(['current', 'outdated', 'deprecated']);
const TOKENIZERS = new Set(['tik', 'mistral', 'novelai', 'claude', 'llama', 'llama3', 'novellist', 'gemma', 'cohere', 'deepseek']);

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const fail = (what: string): never => {
  throw new TypeError(what);
};

function text(value: unknown, what: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length > max) fail(`${what} must be a string`);
  return value as string;
}
const optionalText = (value: unknown, what: string, max = MAX_TEXT): string | undefined =>
  value === undefined ? undefined : text(value, what, max);
function id(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${what} is not an id`);
  return value as string;
}
function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${what} must be a number`);
  return value as number;
}
const optionalFinite = (value: unknown, what: string): number | undefined => (value === undefined ? undefined : finite(value, what));
function oneOf<T extends string>(value: unknown, allowed: Set<string>, what: string): T {
  if (typeof value !== 'string' || !allowed.has(value)) fail(`${what} is not one this app knows`);
  return value as T;
}
function list<T>(value: unknown, what: string, item: (entry: unknown, index: number) => T): T[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) fail(`${what} must be a list`);
  return (value as unknown[]).map(item);
}
function i18n(value: unknown, what: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > 20) fail(`${what} must be a map`);
  const out: Record<string, string> = {};
  for (const [locale, words] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z]{2}(?:-[A-Za-z]{2,4})?$/.test(locale)) fail(`${what} has a bad locale`);
    out[locale] = text(words, what);
  }
  return out;
}

/** A plain JSON value, within `MAX_JSON_BYTES`, with no key a dotted path may not name. */
function json(value: unknown, what: string): unknown {
  const walk = (node: unknown, depth: number): void => {
    if (depth > 16) fail(`${what} is nested too deep`);
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) fail(`${what} has a number JSON cannot hold`);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }
    if (!isRecord(node) || Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) fail(`${what} is not JSON`);
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_SEGMENTS.has(key)) fail(`${what} names ${key}`);
      walk(entry, depth + 1);
    }
  };
  walk(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_JSON_BYTES) fail(`${what} is too large`);
  return value;
}
function jsonObject(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${what} must be an object`);
  return json(value, what) as Record<string, unknown>;
}

/** A dotted body path, each segment a plain name. */
export function isMappingPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  return path.split('.').every((segment) => PATH_SEGMENT.test(segment) && !FORBIDDEN_SEGMENTS.has(segment));
}

function headers(value: unknown, what: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > 32) fail(`${what} must be a map`);
  const out: Record<string, string> = {};
  for (const [name, header] of Object.entries(value as Record<string, unknown>)) {
    if (!HEADER_NAME.test(name)) fail(`${what}: ${name} is not a header name`);
    if (typeof header !== 'string' || header.length > 1000 || /[\r\n\0]/.test(header)) fail(`${what}: ${name} is not a header value`);
    out[name] = header as string;
  }
  return out;
}

function fieldOf(value: unknown, index: number): RegistryFieldSchema {
  const what = `field ${index}`;
  if (!isRecord(value)) fail(`${what} is not an object`);
  const raw = value as Record<string, unknown>;
  const key = raw['key'];
  if (typeof key !== 'string' || !KEY.test(key)) fail(`${what} has a bad key`);
  const field: RegistryFieldSchema = {
    key: key as string,
    type: oneOf(raw['type'], FIELD_TYPES, `${what} type`),
    label: text(raw['label'], `${what} label`, 200),
  };
  const description = optionalText(raw['description'], `${what} description`);
  if (description !== undefined) field.description = description;
  const descriptionI18n = i18n(raw['descriptionI18n'], `${what} descriptionI18n`);
  if (descriptionI18n) field.descriptionI18n = descriptionI18n;
  if (raw['default'] !== undefined) field.default = json(raw['default'], `${what} default`);
  if (raw['enum'] !== undefined) {
    field.enum = list(raw['enum'], `${what} enum`, (entry) => {
      if (!isRecord(entry)) fail(`${what} enum entry is not an object`);
      const option = entry as Record<string, unknown>;
      const optionValue = option['value'];
      if (typeof optionValue === 'string') text(optionValue, `${what} enum value`, 200);
      else if (typeof optionValue === 'number') finite(optionValue, `${what} enum value`);
      else if (typeof optionValue !== 'boolean') fail(`${what} enum value`);
      return { value: optionValue as string | number | boolean, label: text(option['label'], `${what} enum label`, 200) };
    });
  }
  for (const bound of ['min', 'max', 'step'] as const) {
    const number = optionalFinite(raw[bound], `${what} ${bound}`);
    if (number !== undefined) field[bound] = number;
  }
  for (const flag of ['required', 'secret'] as const) {
    if (raw[flag] === undefined) continue;
    if (typeof raw[flag] !== 'boolean') fail(`${what} ${flag} must be a boolean`);
    field[flag] = raw[flag] as boolean;
  }
  if (raw['mapsTo'] !== undefined) {
    if (!isRecord(raw['mapsTo'])) fail(`${what} mapsTo must be an object`);
    const mapsTo = raw['mapsTo'] as Record<string, unknown>;
    const target = oneOf<RegistryMappingTarget>(mapsTo['target'], TARGETS, `${what} mapsTo target`);
    const path = text(mapsTo['path'], `${what} mapsTo path`, 200);
    if (target === 'body' && !isMappingPath(path)) fail(`${what} mapsTo path is not a body path`);
    if (target === 'header' && !HEADER_NAME.test(path)) fail(`${what} mapsTo path is not a header name`);
    field.mapsTo = { target, path };
  }
  return field;
}

function uiSchemaOf(value: unknown, what: string): RegistryUiSchema {
  if (!isRecord(value)) fail(`${what} must be an object`);
  const raw = value as Record<string, unknown>;
  const groups = list<RegistryUiGroup>(raw['groups'], `${what} groups`, (entry, index) => {
    if (!isRecord(entry)) fail(`${what} group ${index}`);
    const group = entry as Record<string, unknown>;
    const out: RegistryUiGroup = { id: text(group['id'], `${what} group id`, 100), label: text(group['label'], `${what} group label`, 200) };
    const labelI18n = i18n(group['labelI18n'], `${what} group labelI18n`);
    if (labelI18n) out.labelI18n = labelI18n;
    const order = optionalFinite(group['order'], `${what} group order`);
    if (order !== undefined) out.order = order;
    return out;
  });
  const fields = list<RegistryUiField>(raw['fields'], `${what} fields`, (entry, index) => {
    if (!isRecord(entry)) fail(`${what} field ${index}`);
    const field = entry as Record<string, unknown>;
    const key = field['key'];
    if (typeof key !== 'string' || !KEY.test(key)) fail(`${what} field ${index} key`);
    const out: RegistryUiField = {
      key: key as string,
      widget: oneOf(field['widget'], WIDGETS, `${what} field widget`),
      visibility: oneOf(field['visibility'], VISIBILITIES, `${what} field visibility`),
    };
    const group = optionalText(field['group'], `${what} field group`, 100);
    if (group !== undefined) out.group = group;
    const order = optionalFinite(field['order'], `${what} field order`);
    if (order !== undefined) out.order = order;
    for (const words of ['placeholder', 'help'] as const) {
      const value = optionalText(field[words], `${what} field ${words}`, 1000);
      if (value !== undefined) out[words] = value;
    }
    if (field['showIf'] !== undefined) {
      if (!isRecord(field['showIf'])) fail(`${what} field showIf`);
      const showIf = field['showIf'] as Record<string, unknown>;
      const conditionKey = showIf['key'];
      if (typeof conditionKey !== 'string' || !KEY.test(conditionKey)) fail(`${what} field showIf key`);
      out.showIf = {
        key: conditionKey as string,
        ...(showIf['equals'] !== undefined ? { equals: json(showIf['equals'], `${what} showIf`) } : {}),
        ...(showIf['notEquals'] !== undefined ? { notEquals: json(showIf['notEquals'], `${what} showIf`) } : {}),
      };
    }
    return out;
  });
  return { groups, fields };
}

function limitsOf(value: unknown, what: string): ModelLimits | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail(`${what} must be an object`);
  const raw = value as Record<string, unknown>;
  const out: ModelLimits = {};
  if (raw['known'] !== undefined) {
    if (typeof raw['known'] !== 'boolean') fail(`${what} known`);
    out.known = raw['known'] as boolean;
  }
  for (const count of ['contextWindowTokens', 'maxOutputTokens'] as const) {
    if (raw[count] === undefined || raw[count] === null) continue;
    const tokens = finite(raw[count], `${what} ${count}`);
    if (!Number.isInteger(tokens) || tokens < 1) fail(`${what} ${count}`);
    out[count] = tokens;
  }
  if (raw['sourceUrls'] !== undefined) out.sourceUrls = list(raw['sourceUrls'], `${what} sourceUrls`, (url) => text(url, `${what} url`, 1000));
  const notes = optionalText(raw['notes'], `${what} notes`);
  if (notes !== undefined) out.notes = notes;
  const notesI18n = i18n(raw['notesI18n'], `${what} notesI18n`);
  if (notesI18n) out.notesI18n = notesI18n;
  return out;
}

function capabilitiesOf(value: unknown, what: string): ModelProfile['capabilities'] {
  if (value === undefined) return undefined;
  return list(value, what, (entry) => oneOf(entry, CAPABILITIES, what));
}

function schemaOf(value: unknown, what: string): RegistryFieldSchema[] {
  if (!Array.isArray(value) || value.length > MAX_FIELDS) fail(`${what} must be a list`);
  const fields = (value as unknown[]).map(fieldOf);
  if (new Set(fields.map((field) => field.key)).size !== fields.length) fail(`${what} repeats a key`);
  return fields;
}

function baseOf(value: unknown): BaseProviderDefinition {
  if (!isRecord(value)) fail('base provider is not an object');
  const raw = value as Record<string, unknown>;
  const version = finite(raw['version'], 'base version');
  const base: BaseProviderDefinition = {
    id: id(raw['id'], 'base id'),
    version,
    displayName: text(raw['displayName'], 'base displayName', 200),
    adapterKind: oneOf(raw['adapterKind'], ADAPTER_KINDS, 'base adapterKind'),
    authKinds: list(raw['authKinds'], 'base authKinds', (entry) => oneOf(entry, AUTH_KINDS, 'base authKind')),
    endpointKinds: list(raw['endpointKinds'], 'base endpointKinds', (entry) => oneOf(entry, ENDPOINT_KINDS, 'base endpointKind')),
    requestSchema: schemaOf(raw['requestSchema'], 'base requestSchema'),
    uiSchema: uiSchemaOf(raw['uiSchema'], 'base uiSchema'),
    sourceUrls: list(raw['sourceUrls'], 'base sourceUrls', (url) => text(url, 'base url', 1000)),
  };
  const defaultHeaders = headers(raw['defaultHeaders'], 'base defaultHeaders');
  if (defaultHeaders) base.defaultHeaders = defaultHeaders;
  if (raw['defaultBody'] !== undefined) base.defaultBody = jsonObject(raw['defaultBody'], 'base defaultBody');
  const capabilities = capabilitiesOf(raw['capabilities'], 'base capabilities');
  if (capabilities) base.capabilities = capabilities;
  const limits = limitsOf(raw['limits'], 'base limits');
  if (limits) base.limits = limits;
  return base;
}

function profileOf(value: unknown): ModelProfile {
  if (!isRecord(value)) fail('profile is not an object');
  const raw = value as Record<string, unknown>;
  if (!isRecord(raw['endpoint'])) fail('profile endpoint');
  if (!isRecord(raw['auth'])) fail('profile auth');
  const endpoint = raw['endpoint'] as Record<string, unknown>;
  const auth = raw['auth'] as Record<string, unknown>;
  const profile: ModelProfile = {
    id: id(raw['id'], 'profile id'),
    version: finite(raw['version'], 'profile version'),
    displayName: text(raw['displayName'], 'profile displayName', 200),
    providerBaseId: id(raw['providerBaseId'], 'profile providerBaseId'),
    profileStatus: oneOf(raw['profileStatus'] ?? 'current', STATUSES, 'profile status'),
    modelId: text(raw['modelId'], 'profile modelId', 200),
    endpoint: {
      kind: oneOf(endpoint['kind'], ENDPOINT_KINDS, 'profile endpoint kind'),
      ...(endpoint['url'] !== undefined ? { url: text(endpoint['url'], 'profile endpoint url', 1000) } : {}),
    },
    auth: {
      kind: oneOf(auth['kind'], AUTH_KINDS, 'profile auth kind'),
      ...(auth['fields'] !== undefined ? { fields: list(auth['fields'], 'profile auth fields', (field) => text(field, 'auth field', 64)) } : {}),
    },
    defaults: raw['defaults'] === undefined ? {} : jsonObject(raw['defaults'], 'profile defaults'),
    schema: schemaOf(raw['schema'], 'profile schema'),
    uiSchema: uiSchemaOf(raw['uiSchema'], 'profile uiSchema'),
    sourceUrls: raw['sourceUrls'] === undefined ? [] : list(raw['sourceUrls'], 'profile sourceUrls', (url) => text(url, 'profile url', 1000)),
  };
  const updatedAt = optionalFinite(raw['updatedAt'], 'profile updatedAt');
  if (updatedAt !== undefined) profile.updatedAt = updatedAt;
  const displayNameI18n = i18n(raw['displayNameI18n'], 'profile displayNameI18n');
  if (displayNameI18n) profile.displayNameI18n = displayNameI18n;
  for (const words of ['statusReason', 'description'] as const) {
    const value = optionalText(raw[words], `profile ${words}`);
    if (value !== undefined) profile[words] = value;
  }
  const descriptionI18n = i18n(raw['descriptionI18n'], 'profile descriptionI18n');
  if (descriptionI18n) profile.descriptionI18n = descriptionI18n;
  if (raw['statusSourceUrls'] !== undefined) profile.statusSourceUrls = list(raw['statusSourceUrls'], 'profile statusSourceUrls', (url) => text(url, 'url', 1000));
  if (raw['tags'] !== undefined) profile.tags = list(raw['tags'], 'profile tags', (tag) => text(tag, 'tag', 100));
  const sortOrder = optionalFinite(raw['sortOrder'], 'profile sortOrder');
  if (sortOrder !== undefined) profile.sortOrder = sortOrder;
  if (raw['recommendedTokenizer'] !== undefined) profile.recommendedTokenizer = oneOf<NonNullable<ModelProfile['recommendedTokenizer']>>(raw['recommendedTokenizer'], TOKENIZERS, 'profile tokenizer');
  if (raw['bodyTemplate'] !== undefined) profile.bodyTemplate = jsonObject(raw['bodyTemplate'], 'profile bodyTemplate');
  const headerTemplate = headers(raw['headerTemplate'], 'profile headerTemplate');
  if (headerTemplate) profile.headerTemplate = headerTemplate;
  const capabilities = capabilitiesOf(raw['capabilities'], 'profile capabilities');
  if (capabilities) profile.capabilities = capabilities;
  const limits = limitsOf(raw['limits'], 'profile limits');
  if (limits) profile.limits = limits;
  return profile;
}
