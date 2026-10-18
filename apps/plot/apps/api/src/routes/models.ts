import { credentials, modelPresets, user, type Credential } from '@shizue/db';
import {
  availableFormats,
  credentialFits,
  formatOf,
  LLMError,
  listModels,
  LOCAL_ENDPOINTS,
  MODEL_PARAMETERS,
  parseCapabilities,
  parseModelParams,
  PROVIDERS,
  REASONING_EFFORTS,
  validateCredential,
  VERBOSITIES,
  type ModelCredential,
  type ModelFormat,
} from '@shizue/llm';
import { and, asc, count, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  credentialJson,
  keyProvider,
  loadCredential,
  maskKey,
  MAX_CREDENTIALS,
  MAX_LABEL_LENGTH,
  MAX_SECRET_LENGTH,
  openCredential,
  requireHttpUrl,
  vaultOf,
} from '../credentials.js';
import type { AppDeps, AppEnv } from '../deps.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { collect } from '../memory.js';
import { bindingJson, ensureFirstPreset, mergeBinding, modelOf, presetJson, readBindingPatch, releasePreset, testPresets, type PresetView } from '../models.js';
import { requireLocal } from '../session.js';
import { isUuid, readJsonBody, requireUuidParam } from '../util.js';

/** Model presets an owner may keep, and the longest name and model id. */
export const MAX_MODEL_PRESETS = 100;
const MAX_NAME_LENGTH = 100;
const MAX_MODEL_LENGTH = 200;
/** What a preset's test asks for, and how long it may take. */
const TEST_PROMPT = 'Reply with the single word OK.';
const TEST_TIMEOUT_MS = 60_000;

/** A provider's refusal, as a key check or a test answers it: not an error of the route's own. */
function failure(error: unknown): { ok: false; code: string; status?: number } {
  if (error instanceof LLMError) {
    if (error.detail) console.warn(`[models] ${error.code} (${error.status}): ${error.detail}`);
    return { ok: false, code: error.code, status: error.status };
  }
  if (error instanceof ApiError) return { ok: false, code: error.code };
  console.error('[models] check failed', error);
  return { ok: false, code: 'provider_request_failed' };
}

/** A label: trimmed, capped, or the provider's own name where none is given. */
const labelOf = (value: unknown, fallback: string): string => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw badRequest('invalid_request', 'label must be a string');
  return value.trim().slice(0, MAX_LABEL_LENGTH) || fallback;
};

/** An API key as entered: trimmed, at most `MAX_SECRET_LENGTH`, with no line breaks. */
const keyOf = (value: unknown): string => {
  if (typeof value !== 'string') throw badRequest('invalid_request', 'apiKey must be a string');
  const key = value.trim();
  if (key.length > MAX_SECRET_LENGTH || /[\r\n\0]/.test(key)) throw badRequest('invalid_request', 'apiKey must be one line');
  return key;
};

/**
 * `/api/credentials` — the owner's API keys and the ChatGPT connection, as the
 * settings list them. A secret goes in and never comes out: the list carries a
 * masked hint. Adding, changing, removing and checking a key is this
 * computer's alone (`requireLocal`), as connecting ChatGPT is; a paired phone
 * reads the list.
 */
export function credentialRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });

  app.get('/', async (c) => {
    const rows = await deps.db.select().from(credentials).where(eq(credentials.userId, c.get('userId'))).orderBy(asc(credentials.createdAt));
    return c.json(rows.map(credentialJson));
  });

  app.post('/', requireLocal, async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const provider = keyProvider(body['provider']);
    if (!provider) throw badRequest('invalid_request', 'provider must be one of the providers a key is entered for');
    const apiKey = body['apiKey'] === undefined ? '' : keyOf(body['apiKey']);
    if (!apiKey && provider.key === 'required') throw badRequest('invalid_request', `A ${provider.label} key is required`);
    const baseUrl = body['baseUrl'] === undefined || body['baseUrl'] === null ? null : requireHttpUrl(body['baseUrl'], 'baseUrl');
    if (!baseUrl && !provider.baseUrl) throw badRequest('invalid_request', 'baseUrl is required for this provider');
    const vault = vaultOf(deps);
    const [held] = await deps.db.select({ n: count() }).from(credentials).where(eq(credentials.userId, userId));
    if ((held?.n ?? 0) >= MAX_CREDENTIALS) throw badRequest('credential_limit', `At most ${MAX_CREDENTIALS} credentials`);
    const [row] = await deps.db.insert(credentials).values({
      userId,
      kind: 'api_key',
      provider: provider.id,
      label: labelOf(body['label'], provider.label),
      baseUrl,
      secrets: apiKey ? { apiKey: vault.seal(apiKey) } : {},
      hint: apiKey ? maskKey(apiKey) : '',
    }).returning();
    // An owner with no model preset yet gets one on this key (`ensureFirstPreset`).
    await ensureFirstPreset(deps, row!);
    return c.json(credentialJson(row!), 201);
  });

  const owned = async (c: Context<AppEnv>): Promise<Credential> => {
    const row = await loadCredential(deps, c.get('userId'), requireUuidParam(c));
    if (!row) throw notFound('Credential not found');
    return row;
  };

  app.patch('/:id', requireLocal, async (c) => {
    const row = await owned(c);
    const body = await readJsonBody(c);
    const changes: Partial<typeof credentials.$inferInsert> = { updatedAt: new Date() };
    if (body['label'] !== undefined) changes.label = labelOf(body['label'], row.label);
    if (row.kind === 'chatgpt') {
      if (body['apiKey'] !== undefined || body['baseUrl'] !== undefined) throw badRequest('invalid_request', 'The ChatGPT connection takes a label only');
    } else {
      const provider = keyProvider(row.provider);
      if (body['apiKey'] !== undefined) {
        const apiKey = keyOf(body['apiKey']);
        if (!apiKey && provider?.key === 'required') throw badRequest('invalid_request', 'A key is required');
        changes.secrets = apiKey ? { apiKey: vaultOf(deps).seal(apiKey) } : {};
        changes.hint = apiKey ? maskKey(apiKey) : '';
      }
      if (body['baseUrl'] !== undefined) {
        changes.baseUrl = body['baseUrl'] === null ? null : requireHttpUrl(body['baseUrl'], 'baseUrl');
        if (!changes.baseUrl && !provider?.baseUrl) throw badRequest('invalid_request', 'baseUrl is required for this provider');
      }
    }
    const [updated] = await deps.db.update(credentials).set(changes).where(eq(credentials.id, row.id)).returning();
    return c.json(credentialJson(updated!));
  });

  // The presets on it keep their place and wait for another (`credential_id` set null).
  app.delete('/:id', requireLocal, async (c) => {
    const row = await owned(c);
    if (row.kind === 'chatgpt') throw badRequest('invalid_request', 'Disconnect ChatGPT from its card instead');
    await deps.db.delete(credentials).where(eq(credentials.id, row.id));
    return c.body(null, 204);
  });

  /** Whether the key is good, by a call that needs it (`validateCredential`); a refusal is an answer, not an error. */
  app.post('/:id/test', requireLocal, async (c) => {
    const row = await owned(c);
    try {
      await validateCredential(openCredential(deps, row), deps.env);
      return c.json({ ok: true });
    } catch (error) {
      return c.json(failure(error));
    }
  });

  return app;
}

/** The format a preset names, or a 400. */
function formatFor(deps: AppDeps, value: unknown): ModelFormat {
  const format = typeof value === 'string' ? formatOf(value, deps.env) : undefined;
  if (!format) throw badRequest('format_unavailable', 'Unknown model format');
  return format;
}

/** A preset's fields as a create or an update takes them, held to what the format and the credential allow. */
async function presetFields(deps: AppDeps, userId: string, body: Record<string, unknown>, current?: PresetView) {
  const nameValue = body['name'] ?? current?.name;
  if (typeof nameValue !== 'string' || !nameValue.trim()) throw badRequest('invalid_request', 'name must not be empty');
  const format = formatFor(deps, body['format'] ?? current?.format);
  const modelValue = body['model'] ?? current?.model;
  if (typeof modelValue !== 'string' || !modelValue.trim() || modelValue.length > MAX_MODEL_LENGTH) {
    throw badRequest('invalid_request', `model must be 1 to ${MAX_MODEL_LENGTH} characters`);
  }
  const credentialValue = 'credentialId' in body ? body['credentialId'] : current?.credentialId ?? null;
  let credential: Credential | undefined;
  if (credentialValue !== null) {
    if (typeof credentialValue !== 'string' || !isUuid(credentialValue)) throw badRequest('invalid_request', 'credentialId must be a credential id or null');
    credential = await loadCredential(deps, userId, credentialValue);
    if (!credential) throw notFound('Credential not found');
    if (!credentialFits(format, credential)) throw badRequest('credential_format_mismatch', "This credential does not speak the preset's format");
  } else if (format.key === 'required') throw badRequest('credential_required', 'This format needs a key');
  const endpointValue = 'endpoint' in body ? body['endpoint'] : current?.endpoint ?? null;
  const endpoint = endpointValue === null || endpointValue === '' ? null : requireHttpUrl(endpointValue, 'endpoint');
  if (!credential && !endpoint && !format.defaultBaseUrl) throw badRequest('endpoint_required', 'A preset without a key needs an address');
  let params;
  let capabilities;
  try {
    params = 'params' in body ? parseModelParams(body['params']) : current?.params ?? {};
    capabilities = 'capabilities' in body ? parseCapabilities(body['capabilities']) : current?.capabilities ?? {};
  } catch (error) {
    if (error instanceof TypeError) throw badRequest('invalid_request', error.message);
    throw error;
  }
  return {
    name: nameValue.trim().slice(0, MAX_NAME_LENGTH),
    format: format.id,
    endpoint,
    model: modelValue.trim(),
    credentialId: credential?.id ?? null,
    params,
    capabilities,
  };
}

/** The credential a listing or a test goes with, opened. */
async function credentialFor(deps: AppDeps, userId: string, id: string | null | undefined): Promise<ModelCredential | undefined> {
  if (!id) return undefined;
  if (!isUuid(id)) throw notFound('Credential not found');
  const row = await loadCredential(deps, userId, id);
  if (!row) throw notFound('Credential not found');
  return openCredential(deps, row);
}

/**
 * `/api/model-presets` — PocketRisu's model presets: a format, a model, the
 * credential it authenticates with or a keyless server's address, and the
 * values its requests carry. `GET /formats` says what each format takes, for
 * the editor; `GET /catalog` and `GET /:id/models` list the models behind an
 * address for the picker; `POST /:id/test` sends one tiny request. A key goes
 * only to its own credential's address, so a preset edited from a paired phone
 * cannot send it anywhere else.
 */
export function modelPresetRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/formats', (c) =>
    c.json({
      formats: availableFormats(deps.env).map((format) => ({
        id: format.id,
        parameters: MODEL_PARAMETERS.filter((parameter) => format.places[parameter]),
        chatgptParameters: format.chatgpt ?? null,
        key: format.key,
        defaultBaseUrl: format.defaultBaseUrl ?? null,
      })),
      providers: PROVIDERS.map(({ id, label, baseUrl, formats, key }) => ({ id, label, baseUrl: baseUrl ?? null, formats, key })),
      localEndpoints: LOCAL_ENDPOINTS,
      reasoningEfforts: REASONING_EFFORTS,
      verbosities: VERBOSITIES,
    }),
  );

  /** The models a format's address offers, before a preset is saved: `?format=&credentialId=&endpoint=`. */
  app.get('/catalog', async (c) => {
    const format = formatFor(deps, c.req.query('format'));
    const credential = await credentialFor(deps, c.get('userId'), c.req.query('credentialId'));
    const endpoint = c.req.query('endpoint') ? requireHttpUrl(c.req.query('endpoint'), 'endpoint') : null;
    return c.json(await listModels(format.id, endpoint, credential, deps.env));
  });

  app.get('/', async (c) => {
    const rows = await deps.db.select().from(modelPresets).where(eq(modelPresets.userId, c.get('userId'))).orderBy(asc(modelPresets.createdAt));
    return c.json([...testPresets(deps.env), ...rows.map(presetJson)]);
  });

  app.post('/', async (c) => {
    const userId = c.get('userId');
    const fields = await presetFields(deps, userId, await readJsonBody(c));
    const [held] = await deps.db.select({ n: count() }).from(modelPresets).where(eq(modelPresets.userId, userId));
    if ((held?.n ?? 0) >= MAX_MODEL_PRESETS) throw badRequest('model_preset_limit', `At most ${MAX_MODEL_PRESETS} model presets`);
    const [row] = await deps.db.insert(modelPresets).values({ userId, ...fields }).returning();
    return c.json(presetJson(row!), 201);
  });

  const owned = async (c: Context<AppEnv>) => {
    const [row] = await deps.db.select().from(modelPresets)
      .where(and(eq(modelPresets.id, requireUuidParam(c)), eq(modelPresets.userId, c.get('userId')))).limit(1);
    if (!row) throw notFound('Model preset not found');
    return row;
  };

  app.patch('/:id', async (c) => {
    const row = await owned(c);
    const fields = await presetFields(deps, c.get('userId'), await readJsonBody(c), presetJson(row));
    const [updated] = await deps.db.update(modelPresets).set({ ...fields, updatedAt: new Date() }).where(eq(modelPresets.id, row.id)).returning();
    return c.json(presetJson(updated!));
  });

  // The chats on it, and the default if it was, fall back to what their open slot follows.
  app.delete('/:id', async (c) => {
    const row = await owned(c);
    await deps.db.transaction(async (tx) => {
      await releasePreset(tx, row.userId, row.id);
      await tx.delete(modelPresets).where(eq(modelPresets.id, row.id));
    });
    return c.body(null, 204);
  });

  app.get('/:id/models', async (c) => {
    const row = await owned(c);
    return c.json(await listModels(row.format, row.endpoint, await credentialFor(deps, row.userId, row.credentialId), deps.env));
  });

  /** One tiny request on the preset: its words back, or the provider's refusal as the answer. */
  app.post('/:id/test', async (c) => {
    const row = await owned(c);
    const started = Date.now();
    try {
      const resolved = await modelOf(deps, row.userId, presetJson(row));
      const text = await collect(resolved.adapter, {
        model: resolved.providerModel,
        system: '',
        messages: [{ role: 'user', content: TEST_PROMPT }],
        maxTokens: 64,
        abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      return c.json({ ok: true, text: text.slice(0, 500), ms: Date.now() - started });
    } catch (error) {
      return c.json(failure(error));
    }
  });

  return app;
}

/**
 * `/api/model-binding` — the owner's default binding: the presets a chat's
 * open slot follows, and a new chat's until it picks its own. `PUT` replaces
 * it whole; a slot left out or null is open.
 */
export function modelBindingRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const [row] = await deps.db.select({ binding: user.modelBinding }).from(user).where(eq(user.id, c.get('userId'))).limit(1);
    return c.json(bindingJson(row?.binding));
  });

  app.put('/', async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const patch = await readBindingPatch(deps, userId, { main: body['main'] ?? null, sub: body['sub'] ?? null });
    const binding = mergeBinding(null, patch);
    await deps.db.update(user).set({ modelBinding: binding, updatedAt: new Date() }).where(eq(user.id, userId));
    return c.json(bindingJson(binding));
  });

  return app;
}

