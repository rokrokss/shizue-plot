/**
 * PocketRisu's request builders for a model preset, transcribed line for line
 * from PocketRisu f71e1cc (GPL-3.0, © Kwaroran and PocketRisu's contributors)
 * so the golden test can hold this app's profile requests to what PocketRisu
 * sends for the same profile, values and turns:
 *
 * - `src/ts/preset/registry/snapshot.ts` — `resolveSnapshot` and its merges;
 * - `src/ts/preset/adapter/buildRequest.ts` — `buildPreparedRequest`'s body,
 *   headers and `pickEffective`/`setNested` (static endpoints, no query, no
 *   additional-parameter text: the cases use none);
 * - `src/ts/preset/adapter/auth.ts` — `applyAuth`/`withHeader`;
 * - `src/ts/preset/adapter/wireInvariants.ts` — `resolveWireModelId`;
 * - `src/ts/preset/adapter/googleGemini.ts` — `prepareGeminiBody`,
 *   `collectSystemAndChat`, `toGeminiContents`, `toUserParts`, `toModelParts`
 *   and `streamGoogleChatRequest`'s URL and `Accept`;
 * - `src/ts/preset/adapter/anthropicMessages.ts` — `prepareAnthropicBody`,
 *   `collectSystemAndChat`, `toAnthropicWireMessages`, `toUserBlocks`,
 *   `toAssistantBlocks` and the stream's `Accept`;
 * - `src/ts/preset/adapter/openaiCompatible.ts` — `prepareOpenAiBody`,
 *   `toWireMessage`, `toContentParts` and the stream's `Accept`.
 *
 * Tools, Vertex endpoints, service accounts and Gemini's explicit context cache
 * are left out: no profile this app offers reaches them. Running PocketRisu's
 * own files was not possible here, so this is their code retyped, kept apart
 * from the app's own builders on purpose.
 */

/* eslint-disable */
type Json = Record<string, unknown>;

interface Field {
  key: string;
  default?: unknown;
  mapsTo?: { target: string; path: string };
}
interface Snapshot {
  profileId: string;
  profileVersion: number;
  providerBaseId: string;
  providerBaseVersion: number;
  adapterKind: string;
  auth: { kind: string; fields?: string[] };
  endpoint: { kind: string; url?: string };
  modelId: string;
  schema: Field[];
  uiSchema: { groups: { id: string }[]; fields: { key: string }[] };
  defaults: Json;
  bodyTemplate?: Json;
  headerTemplate?: Record<string, string>;
  capabilities?: string[];
  limits?: Json;
  recommendedTokenizer?: string;
}
export interface OracleMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: { kind: 'image'; base64: string; mime?: string }[];
  cachePoint?: boolean;
}

// --- registry/snapshot.ts -------------------------------------------------

export function resolveSnapshot(catalog: { baseProviders: Record<string, any>; profiles: Record<string, any> }, profileId: string): Snapshot {
  const profile = catalog.profiles[profileId];
  const baseProvider = catalog.baseProviders[profile.providerBaseId];
  return {
    profileId: profile.id,
    profileVersion: profile.version,
    providerBaseId: profile.providerBaseId,
    providerBaseVersion: baseProvider.version,
    adapterKind: baseProvider.adapterKind,
    auth: profile.auth,
    endpoint: profile.endpoint,
    modelId: profile.modelId,
    schema: backfillSchemaDefaults(mergeSchemas(baseProvider.requestSchema, profile.schema), profile),
    uiSchema: mergeUiSchemas(baseProvider.uiSchema, profile.uiSchema),
    defaults: { ...(baseProvider.defaultBody ?? {}), ...profile.defaults },
    bodyTemplate: profile.bodyTemplate,
    headerTemplate: { ...(baseProvider.defaultHeaders ?? {}), ...(profile.headerTemplate ?? {}) },
    capabilities: profile.capabilities ?? baseProvider.capabilities,
    limits: mergeLimits(baseProvider.limits, profile.limits),
    recommendedTokenizer: profile.recommendedTokenizer,
  };
}

function mergeLimits(baseLimits: Json | undefined, profileLimits: Json | undefined): Json | undefined {
  if (!baseLimits) return profileLimits ? { ...profileLimits } : undefined;
  if (!profileLimits) return { ...baseLimits };
  return { ...baseLimits, ...profileLimits };
}

function backfillSchemaDefaults(schema: Field[], profile: { modelId?: string }): Field[] {
  if (!profile.modelId) return schema;
  return schema.map((field) => {
    if (field.key === 'modelId' && field.default === undefined) {
      return { ...field, default: profile.modelId };
    }
    return field;
  });
}

function mergeSchemas(base: Field[], extension: Field[]): Field[] {
  const safeBase = (base ?? []).filter(Boolean);
  const safeExt = (extension ?? []).filter(Boolean);
  if (safeExt.length === 0) return safeBase.slice();
  const merged: Field[] = [];
  const overrideKeys = new Set(safeExt.map((f) => f.key));
  for (const field of safeBase) {
    if (!overrideKeys.has(field.key)) merged.push(field);
  }
  for (const field of safeExt) merged.push(field);
  return merged;
}

function mergeUiSchemas(base: any, extension: any): any {
  const baseGroups = (base?.groups ?? []).filter(Boolean);
  const baseFields = (base?.fields ?? []).filter(Boolean);
  const extGroups = (extension?.groups ?? []).filter(Boolean);
  const extFields = (extension?.fields ?? []).filter(Boolean);
  if (extGroups.length === 0 && extFields.length === 0) {
    return { groups: baseGroups.slice(), fields: baseFields.slice() };
  }
  const groupIds = new Set(extGroups.map((g: any) => g.id));
  const groups = baseGroups.filter((g: any) => !groupIds.has(g.id)).concat(extGroups);
  const fieldKeys = new Set(extFields.map((f: any) => f.key));
  const fields = baseFields.filter((f: any) => !fieldKeys.has(f.key)).concat(extFields);
  return { groups, fields };
}

// --- adapter/buildRequest.ts, auth.ts, wireInvariants.ts -------------------

interface Prepared {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: Json;
}

function buildPreparedRequest(snapshot: Snapshot, userValues: Json, apiKey: string): Prepared {
  const baseUrl = snapshot.endpoint.url!;
  const body: Json = structuredClone({
    ...(snapshot.defaults ?? {}),
    ...(snapshot.bodyTemplate ?? {}),
  });
  const headers: Record<string, string> = { ...(snapshot.headerTemplate ?? {}) };
  for (const field of snapshot.schema) {
    if (!field.mapsTo) continue;
    const effective = pickEffective(userValues, field.key, field.default);
    if (effective === undefined || effective === '') continue;
    switch (field.mapsTo.target) {
      case 'body':
        setNested(body, field.mapsTo.path, effective);
        break;
      case 'header':
        headers[field.mapsTo.path] = String(effective);
        break;
      default:
        break;
    }
  }
  const prepared: Prepared = { method: 'POST', url: baseUrl, headers, body };
  return applyAuth(prepared, snapshot.auth.kind, apiKey);
}

function pickEffective(userValues: Json, key: string, fallback: unknown): unknown {
  if (Object.prototype.hasOwnProperty.call(userValues, key)) {
    const value = userValues[key];
    if (value !== undefined) return value;
  }
  return fallback;
}

function setNested(obj: Json, path: string, value: unknown): void {
  if (path.length === 0) return;
  const parts = path.split('.');
  let cur: Json = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      cur[part] = {};
    }
    cur = cur[part] as Json;
  }
  cur[parts[parts.length - 1]!] = value;
}

function applyAuth(prepared: Prepared, kind: string, key: string): Prepared {
  switch (kind) {
    case 'bearer':
      return withHeader(prepared, 'Authorization', `Bearer ${key}`);
    case 'x-api-key':
      return withHeader(prepared, 'x-api-key', key);
    case 'x-goog-api-key':
      return withHeader(prepared, 'x-goog-api-key', key);
    default:
      throw new Error(`auth kind ${kind} is not in the oracle`);
  }
}

function withHeader(prepared: Prepared, name: string, value: string): Prepared {
  const headers: Record<string, string> = {};
  const normalized = name.toLowerCase();
  for (const [existingName, existingValue] of Object.entries(prepared.headers)) {
    if (existingName.toLowerCase() !== normalized) headers[existingName] = existingValue;
  }
  headers[name] = value;
  return { ...prepared, headers };
}

function resolveWireModelId(snapshot: Snapshot, userValues: Json): string {
  const modelField = snapshot.schema.find((field) => field.key === 'modelId');
  if (modelField) {
    if (Object.prototype.hasOwnProperty.call(userValues, modelField.key)) {
      const userValue = userValues[modelField.key];
      if (typeof userValue === 'string' && userValue.length > 0) return userValue;
      if (userValue !== undefined) throw new Error('adapter requires a non-empty string modelId user value');
    }
    if (typeof modelField.default === 'string' && modelField.default.length > 0) return modelField.default;
  }
  if (snapshot.modelId) return snapshot.modelId;
  throw new Error('adapter requires a modelId');
}

// --- adapter/googleGemini.ts ------------------------------------------------

function prepareGeminiBody(snapshot: Snapshot, userValues: Json, apiKey: string, messages: OracleMessage[]): Prepared {
  const prepared = buildPreparedRequest(snapshot, userValues, apiKey);
  const modelId = resolveWireModelId(snapshot, userValues);
  delete prepared.body['model'];
  const systems: string[] = [];
  const chat: OracleMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') systems.push(message.content);
    else chat.push(message);
  }
  const system = systems.join('\n\n');
  const contents: { role: string; parts: Json[] }[] = [];
  for (const message of chat) {
    if (message.role === 'assistant') {
      const parts: Json[] = [];
      if (message.content.length > 0) parts.push({ text: message.content });
      if (parts.length === 0) parts.push({ text: '' });
      contents.push({ role: 'model', parts });
    } else {
      const parts: Json[] = [];
      if (message.content.length > 0) parts.push({ text: message.content });
      for (const img of message.images ?? []) {
        parts.push({ inlineData: { mimeType: img.mime ?? 'image/png', data: img.base64 } });
      }
      if (parts.length === 0) parts.push({ text: '' });
      contents.push({ role: 'user', parts });
    }
  }
  prepared.body['contents'] = contents;
  if (system.length > 0) {
    prepared.body['systemInstruction'] = { parts: [{ text: system }] };
  } else {
    delete prepared.body['systemInstruction'];
  }
  delete prepared.body['tools'];
  delete prepared.body['toolConfig'];
  prepared.url = `${prepared.url}/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
  return { ...prepared, headers: { ...prepared.headers, Accept: 'text/event-stream' } };
}

// --- adapter/anthropicMessages.ts -------------------------------------------

const ANTHROPIC_FALLBACK_MAX_TOKENS = 4096;
const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

function prepareAnthropicBody(snapshot: Snapshot, userValues: Json, apiKey: string, messages: OracleMessage[]): Prepared {
  const prepared = buildPreparedRequest(snapshot, userValues, apiKey);
  const modelId = resolveWireModelId(snapshot, userValues);
  const systems: string[] = [];
  const chat: OracleMessage[] = [];
  let systemCachePoint = false;
  for (const message of messages) {
    if (message.role === 'system') {
      systems.push(message.content);
      systemCachePoint ||= message.cachePoint === true;
    } else chat.push(message);
  }
  const system = systems.join('\n\n');
  const cacheControl = { type: 'ephemeral' };
  const cacheSystem = system.length > 0 && systemCachePoint;
  const breakpointBudget = ANTHROPIC_MAX_CACHE_BREAKPOINTS - (cacheSystem ? 1 : 0);
  const flagged: number[] = [];
  chat.forEach((message, index) => {
    if (message.cachePoint) flagged.push(index);
  });
  const marked = new Set(breakpointBudget > 0 ? flagged.slice(-breakpointBudget) : []);
  const markCachePoint = (content: Json[]) => {
    const idx = content.length - 1;
    if (idx >= 0) content[idx] = { ...content[idx], cache_control: cacheControl };
  };
  const out: { role: string; content: Json[] }[] = [];
  for (const [index, message] of chat.entries()) {
    if (message.role === 'assistant') {
      const content: Json[] = [];
      if (message.content.length > 0) content.push({ type: 'text', text: message.content });
      if (content.length === 0) content.push({ type: 'text', text: '' });
      if (marked.has(index)) markCachePoint(content);
      out.push({ role: 'assistant', content });
    } else {
      const content: Json[] = [{ type: 'text', text: message.content }];
      for (const img of message.images ?? []) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mime ?? 'image/png', data: img.base64 } });
      }
      if (marked.has(index)) markCachePoint(content);
      out.push({ role: 'user', content });
    }
  }
  prepared.body['messages'] = out;
  if (system.length > 0) {
    prepared.body['system'] = cacheSystem ? [{ type: 'text', text: system, cache_control: cacheControl }] : system;
  } else {
    delete prepared.body['system'];
  }
  delete prepared.body['tools'];
  delete prepared.body['tool_choice'];
  prepared.body['model'] = modelId;
  if (prepared.body['max_tokens'] === undefined) prepared.body['max_tokens'] = ANTHROPIC_FALLBACK_MAX_TOKENS;
  prepared.body['stream'] = true;
  return { ...prepared, headers: { ...prepared.headers, Accept: 'text/event-stream' } };
}

// --- adapter/openaiCompatible.ts --------------------------------------------

function prepareOpenAiBody(snapshot: Snapshot, userValues: Json, apiKey: string, messages: OracleMessage[], collectStreamUsage: boolean): Prepared {
  const prepared = buildPreparedRequest(snapshot, userValues, apiKey);
  const modelId = resolveWireModelId(snapshot, userValues);
  prepared.body['messages'] = messages.map((message) => ({
    role: message.role,
    content: message.role === 'user' && message.images && message.images.length > 0
      ? [
          ...(message.content.length > 0 ? [{ type: 'text', text: message.content }] : []),
          ...message.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime ?? 'image/png'};base64,${img.base64}` } })),
        ]
      : message.content,
  }));
  prepared.body['model'] = modelId;
  prepared.body['stream'] = true;
  if (collectStreamUsage) prepared.body['stream_options'] = { include_usage: true };
  delete prepared.body['tools'];
  delete prepared.body['parallel_tool_calls'];
  delete prepared.body['tool_choice'];
  return { ...prepared, headers: { ...prepared.headers, Accept: 'text/event-stream' } };
}

/** What PocketRisu's `stream*ChatRequest` sends for a preset on `snapshot` with `values`: its URL, headers and JSON body text. */
export function pocketRisuRequest(
  snapshot: Snapshot,
  values: Json,
  messages: OracleMessage[],
  apiKey: string,
  collectStreamUsage: boolean,
): { url: string; headers: Record<string, string>; body: string } {
  const prepared = snapshot.adapterKind === 'google-gemini'
    ? prepareGeminiBody(snapshot, values, apiKey, messages)
    : snapshot.adapterKind === 'anthropic-messages'
      ? prepareAnthropicBody(snapshot, values, apiKey, messages)
      : prepareOpenAiBody(snapshot, values, apiKey, messages, collectStreamUsage);
  return { url: prepared.url, headers: prepared.headers, body: JSON.stringify(prepared.body) };
}
