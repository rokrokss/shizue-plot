import { credentials, modelPresets, user, type Credential } from '@shizue/db';
import {
  availableFormats,
  compareProfiles,
  credentialFits,
  formatOf,
  INSTRUCT_TEMPLATE_NAMES,
  LLMError,
  listModels,
  LOCAL_ENDPOINTS,
  migrateValues,
  MODEL_PARAMETERS,
  parseCapabilities,
  parseModelParams,
  parseProfileValues,
  profileEntries,
  profileUpdateStatus,
  PROVIDERS,
  readServiceAccount,
  REASONING_EFFORTS,
  registryBaseOf,
  validateCredential,
  VERBOSITIES,
  wireModelId,
  type ModelCapabilities,
  type ModelCredential,
  type ModelFormat,
  type ModelParams,
  type ProviderSpec,
  type RegistryCatalog,
  type ResolvedModelProfileSnapshot,
} from '@shizue/llm';
import { and, asc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  credentialJson,
  keyProvider,
  loadCredential,
  maskKey,
  MAX_LABEL_LENGTH,
  MAX_SECRET_LENGTH,
  openCredential,
  requireHttpUrl,
  vaultOf,
} from '../credentials.js';
import type { AppDeps, AppEnv } from '../deps.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { collect } from '../memory.js';
import {
  bindingJson,
  ensureFirstPreset,
  mergeBinding,
  modelOf,
  presetJson,
  profilePresetColumns,
  readBindingPatch,
  releasePreset,
  testPresets,
  type PresetView,
} from '../models.js';
import { refreshRegistry, registryCatalog, registrySource, registryState } from '../registry.js';
import { requireLocal } from '../session.js';
import { isUuid, readJsonBody, requireUuidParam } from '../util.js';

/** The longest preset name and model id. */
const MAX_NAME_LENGTH = 100;
const MAX_MODEL_LENGTH = 200;
/** What a preset's test asks for, and how long it may take. */
const TEST_PROMPT = 'Reply with the single word OK.';
const TEST_TOKENS = 64;
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

/** A secret as entered: trimmed, at most `MAX_SECRET_LENGTH`, with no line breaks. */
const secretOf = (value: unknown, field = 'apiKey'): string => {
  if (typeof value !== 'string') throw badRequest('invalid_request', `${field} must be a string`);
  const secret = value.trim();
  if (secret.length > MAX_SECRET_LENGTH || /[\r\n\0]/.test(secret)) throw badRequest('invalid_request', `${field} must be one line`);
  return secret;
};

/** AWS's region names (`us-east-1`, `ap-northeast-2`, `us-gov-west-1`). */
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
/** Google Cloud's (`us-central1`, `europe-west4`), or `global`. */
const GCP_REGION = /^(?:global|[a-z]+(?:-[a-z]+)+\d{1,2})$/;
const regionOf = (value: unknown, pattern: RegExp): string => {
  if (typeof value !== 'string' || !pattern.test(value.trim())) throw badRequest('invalid_request', 'region must be a region name');
  return value.trim();
};

type SecretFields = Pick<typeof credentials.$inferInsert, 'baseUrl' | 'secrets' | 'meta' | 'hint'>;

/** AWS keys as a credential holds them: each sealed, the region beside them, the access key's hint. */
function awsFields(vault: ReturnType<typeof vaultOf>, body: Record<string, unknown>): SecretFields {
  const accessKeyId = secretOf(body['accessKeyId'], 'accessKeyId');
  if (!/^[A-Z0-9]{16,128}$/.test(accessKeyId)) throw badRequest('invalid_request', 'accessKeyId must be an AWS access key id');
  const secretAccessKey = secretOf(body['secretAccessKey'], 'secretAccessKey');
  if (!secretAccessKey) throw badRequest('invalid_request', 'secretAccessKey is required');
  const sessionToken = body['sessionToken'] === undefined || body['sessionToken'] === null ? '' : secretOf(body['sessionToken'], 'sessionToken');
  const region = regionOf(body['region'], AWS_REGION);
  return {
    baseUrl: null,
    secrets: {
      accessKeyId: vault.seal(accessKeyId),
      secretAccessKey: vault.seal(secretAccessKey),
      ...(sessionToken ? { sessionToken: vault.seal(sessionToken) } : {}),
    },
    meta: { region },
    hint: `${maskKey(accessKeyId)} · ${region}`,
  };
}

/** A Google service account's key file as a credential holds it: the private key sealed, its address, project and region beside it. */
async function serviceAccountFields(vault: ReturnType<typeof vaultOf>, body: Record<string, unknown>): Promise<SecretFields> {
  const file = body['serviceAccount'];
  if (typeof file !== 'string' || file.length > MAX_SECRET_LENGTH) throw badRequest('invalid_request', 'serviceAccount must be the JSON key file of a service account');
  let account: Awaited<ReturnType<typeof readServiceAccount>>;
  try {
    account = await readServiceAccount(file);
  } catch (error) {
    throw badRequest('invalid_request', error instanceof TypeError ? error.message : 'serviceAccount cannot be read');
  }
  const region = regionOf(body['region'] ?? 'global', GCP_REGION);
  return {
    baseUrl: null,
    secrets: { privateKey: vault.seal(account.privateKey) },
    meta: { clientEmail: account.clientEmail, projectId: account.projectId, region },
    hint: `${account.clientEmail} · ${region}`,
  };
}

/** An API key and the address it goes to, as a credential holds them. */
function keyFields(vault: ReturnType<typeof vaultOf>, provider: ProviderSpec, body: Record<string, unknown>): SecretFields {
  const apiKey = body['apiKey'] === undefined ? '' : secretOf(body['apiKey']);
  if (!apiKey && provider.key === 'required') throw badRequest('invalid_request', `A ${provider.label} key is required`);
  const baseUrl = body['baseUrl'] === undefined || body['baseUrl'] === null ? null : requireHttpUrl(body['baseUrl'], 'baseUrl');
  if (!baseUrl && !provider.baseUrl) throw badRequest('invalid_request', 'baseUrl is required for this provider');
  return { baseUrl, secrets: apiKey ? { apiKey: vault.seal(apiKey) } : {}, meta: {}, hint: apiKey ? maskKey(apiKey) : '' };
}

/** What a create's body makes of a credential of `provider`'s kind. */
async function fieldsFor(vault: ReturnType<typeof vaultOf>, provider: ProviderSpec, body: Record<string, unknown>): Promise<SecretFields> {
  if (provider.kind === 'aws') return awsFields(vault, body);
  if (provider.kind === 'gcp_service_account') return serviceAccountFields(vault, body);
  return keyFields(vault, provider, body);
}

/**
 * `/api/credentials` — the owner's API keys, AWS keys and Google service
 * accounts (the kind each provider's credential is, `ProviderSpec.kind`) and
 * the ChatGPT connection, as the settings list them. A secret goes in and never
 * comes out: the list carries a masked hint. Adding, changing, removing and
 * checking a key is this computer's alone (`requireLocal`), as connecting
 * ChatGPT is; a paired phone reads the list.
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
    const fields = await fieldsFor(vaultOf(deps), provider, body);
    const [row] = await deps.db.insert(credentials).values({
      userId,
      kind: provider.kind ?? 'api_key',
      provider: provider.id,
      label: labelOf(body['label'], provider.label),
      ...fields,
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
    const keyed = ['apiKey', 'baseUrl', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'serviceAccount', 'region'].filter((field) => body[field] !== undefined);
    if (row.kind === 'chatgpt') {
      if (keyed.length > 0) throw badRequest('invalid_request', 'The ChatGPT connection takes a label only');
    } else if (row.kind === 'aws' || row.kind === 'gcp_service_account') {
      if (keyed.includes('apiKey') || keyed.includes('baseUrl')) throw badRequest('invalid_request', 'This credential has no key or address of that kind');
      const replaced = row.kind === 'aws' ? ['accessKeyId', 'secretAccessKey', 'sessionToken'] : ['serviceAccount'];
      if (keyed.some((field) => replaced.includes(field))) {
        // New secrets replace the old whole, in the region given or the one it had.
        const next = { ...body, region: body['region'] ?? row.meta.region };
        Object.assign(changes, row.kind === 'aws' ? awsFields(vaultOf(deps), next) : await serviceAccountFields(vaultOf(deps), next));
      } else if (body['region'] !== undefined) {
        const region = regionOf(body['region'], row.kind === 'aws' ? AWS_REGION : GCP_REGION);
        changes.meta = { ...row.meta, region };
        changes.hint = `${row.hint.replace(/ · [^·]*$/, '')} · ${region}`;
      }
    } else {
      const provider = keyProvider(row.provider);
      if (body['apiKey'] !== undefined) {
        const apiKey = secretOf(body['apiKey']);
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

/** A key a profile preset may go with: an API key of the provider its base is (`REGISTRY_BASES`). */
async function profileCredential(deps: AppDeps, userId: string, snapshot: ResolvedModelProfileSnapshot, value: unknown): Promise<string | null> {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !isUuid(value)) throw badRequest('invalid_request', 'credentialId must be a credential id or null');
  const credential = await loadCredential(deps, userId, value);
  if (!credential) throw notFound('Credential not found');
  if (credential.kind !== 'api_key' || credential.provider !== registryBaseOf(snapshot)?.provider) {
    throw badRequest('credential_format_mismatch', "This credential is not a key of the profile's provider");
  }
  return credential.id;
}

/**
 * A profile preset's fields as an update takes them: its name and key, its
 * values (`userValues`, held to the snapshot's schema), the additional headers
 * and body (`params`, those two only), the picture and turn flags; and with
 * `profileId`, the profile itself taken again from the catalog — the same one
 * is PocketRisu's "update available", another its "replace profile" — with the
 * values carried over where the new snapshot has the field (`migrateValues`).
 * The format and model follow the snapshot and values.
 */
async function profileFields(deps: AppDeps, userId: string, body: Record<string, unknown>, current: PresetView) {
  let snapshot = current.profileSnapshot!;
  let sourceProfile = current.sourceProfile;
  let values = current.userValues;
  if (body['profileId'] !== undefined) {
    if (typeof body['profileId'] !== 'string') throw badRequest('invalid_request', 'profileId must be a profile id');
    const columns = profilePresetColumns(await registryCatalog(deps), body['profileId']);
    if (!columns) throw badRequest('profile_unavailable', 'This profile is not in the model registry');
    // Another profile's model is its own: PocketRisu carries `modelId` over like any value, and the
    // preset would go on asking for the old model under the new profile's name.
    const replaced = body['profileId'] !== current.sourceProfile?.profileId;
    const { modelId: _carried, ...kept } = values;
    snapshot = columns.profileSnapshot;
    sourceProfile = columns.sourceProfile;
    values = migrateValues(replaced ? kept : values, snapshot.schema).values;
  }
  const nameValue = body['name'] ?? current.name;
  if (typeof nameValue !== 'string' || !nameValue.trim()) throw badRequest('invalid_request', 'name must not be empty');
  let params: ModelParams;
  let capabilities: ModelCapabilities;
  try {
    if ('userValues' in body) values = parseProfileValues(body['userValues'], snapshot.schema);
    const parsed = 'params' in body ? parseModelParams(body['params']) : current.params;
    params = {
      ...(parsed.extraHeaders ? { extraHeaders: parsed.extraHeaders } : {}),
      ...(parsed.extraBody ? { extraBody: parsed.extraBody } : {}),
    };
    capabilities = 'capabilities' in body ? parseCapabilities(body['capabilities']) : current.capabilities;
  } catch (error) {
    if (error instanceof TypeError) throw badRequest('invalid_request', error.message);
    throw error;
  }
  const model = wireModelId(snapshot, values);
  if (!model || model.length > MAX_MODEL_LENGTH) throw badRequest('invalid_request', `model must be 1 to ${MAX_MODEL_LENGTH} characters`);
  // A replaced profile keeps the key where it is one of the new provider's, and waits for one otherwise.
  const credentialId = 'credentialId' in body
    ? await profileCredential(deps, userId, snapshot, body['credentialId'])
    : body['profileId'] !== undefined
      ? await profileCredential(deps, userId, snapshot, current.credentialId).catch(() => null)
      : current.credentialId;
  return {
    name: nameValue.trim().slice(0, MAX_NAME_LENGTH),
    kind: 'profile' as const,
    format: registryBaseOf(snapshot)?.format ?? current.format,
    endpoint: null,
    model,
    credentialId,
    params,
    capabilities,
    sourceProfile,
    profileSnapshot: snapshot,
    userValues: values,
  };
}

/**
 * What the presets' list says of a profile preset beside the preset itself:
 * the profile's name and status in the catalog read now, and whether it has a
 * newer revision (`profileUpdateStatus` — PocketRisu's update dot) or is gone.
 */
function profileNotes(catalog: RegistryCatalog, preset: PresetView) {
  if (preset.kind !== 'profile' || !preset.sourceProfile) return {};
  const profile = catalog.profiles[preset.sourceProfile.profileId];
  const provider = preset.profileSnapshot ? registryBaseOf(preset.profileSnapshot)?.provider : undefined;
  return {
    profileUpdate: profileUpdateStatus(catalog, preset.sourceProfile.profileId, preset.sourceProfile.profileUpdatedAt),
    // Whose key it takes (`REGISTRY_BASES`), for the editor's key picker.
    ...(provider ? { profileProvider: provider } : {}),
    ...(profile
      ? {
          profile: {
            displayName: profile.displayName,
            ...(profile.displayNameI18n ? { displayNameI18n: profile.displayNameI18n } : {}),
            ...(profile.description ? { description: profile.description } : {}),
            ...(profile.descriptionI18n ? { descriptionI18n: profile.descriptionI18n } : {}),
            status: profile.profileStatus,
            ...(profile.statusReason ? { statusReason: profile.statusReason } : {}),
            ...(profile.updatedAt !== undefined ? { updatedAt: profile.updatedAt } : {}),
            baseLabel: catalog.baseProviders[profile.providerBaseId]?.displayName ?? profile.providerBaseId,
          },
        }
      : {}),
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
        // RisuAI's flags for the format's models, which the preset's own lay over; null: the format places system turns itself.
        reformat: format.reformat ?? null,
        instructTemplate: format.instructTemplate === true,
      })),
      providers: PROVIDERS.map(({ id, label, baseUrl, formats, key, kind }) => ({ id, label, baseUrl: baseUrl ?? null, formats, key, kind: kind ?? 'api_key' })),
      localEndpoints: LOCAL_ENDPOINTS,
      reasoningEfforts: REASONING_EFFORTS,
      verbosities: VERBOSITIES,
      instructTemplates: INSTRUCT_TEMPLATE_NAMES,
    }),
  );

  /** The models a format's address offers, before a preset is saved: `?format=&credentialId=&endpoint=`. */
  app.get('/catalog', async (c) => {
    const format = formatFor(deps, c.req.query('format'));
    const credential = await credentialFor(deps, c.get('userId'), c.req.query('credentialId'));
    const endpoint = c.req.query('endpoint') ? requireHttpUrl(c.req.query('endpoint'), 'endpoint') : null;
    return c.json(await listModels(format.id, endpoint, credential, deps.env));
  });

  /**
   * The model registry's profiles this app offers (`profileEntries` — every
   * status: the browser hides outdated and deprecated ones until asked) and
   * where the catalog came from.
   */
  app.get('/registry', async (c) => {
    const state = await registryState(deps);
    return c.json({
      origin: state.origin,
      source: state.source,
      hash: state.hash,
      fetchedAt: state.fetchedAt,
      refreshable: registrySource(deps.env) !== null,
      profiles: profileEntries(state.catalog).sort(compareProfiles),
    });
  });

  /** PocketRisu's registry sync (`refreshRegistry`); `{force: true}` downloads whatever the index says. */
  app.post('/registry/refresh', async (c) => {
    const body = await readJsonBody(c).catch(() => ({}) as Record<string, unknown>);
    return c.json(await refreshRegistry(deps, body['force'] === true));
  });

  app.get('/', async (c) => {
    const rows = await deps.db.select().from(modelPresets).where(eq(modelPresets.userId, c.get('userId'))).orderBy(asc(modelPresets.createdAt));
    const catalog = await registryCatalog(deps);
    return c.json([...testPresets(deps.env), ...rows.map((row) => {
      const preset = presetJson(row);
      return { ...preset, ...profileNotes(catalog, preset) };
    })]);
  });

  /**
   * A new preset: on a registry profile (`{profileId, credentialId?, name?}` —
   * PocketRisu's "create from profile", its defaults seeded) or a custom one
   * on a format (`presetFields`).
   */
  app.post('/', async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    if (body['profileId'] !== undefined) {
      if (typeof body['profileId'] !== 'string') throw badRequest('invalid_request', 'profileId must be a profile id');
      const catalog = await registryCatalog(deps);
      const columns = profilePresetColumns(catalog, body['profileId']);
      if (!columns) throw badRequest('profile_unavailable', 'This profile is not in the model registry');
      const credentialId = await profileCredential(deps, userId, columns.profileSnapshot, body['credentialId']);
      const name = typeof body['name'] === 'string' && body['name'].trim() ? body['name'].trim().slice(0, MAX_NAME_LENGTH) : columns.name;
      const [row] = await deps.db.insert(modelPresets).values({ userId, ...columns, name, credentialId }).returning();
      const preset = presetJson(row!);
      return c.json({ ...preset, ...profileNotes(catalog, preset) }, 201);
    }
    const fields = await presetFields(deps, userId, body);
    const [row] = await deps.db.insert(modelPresets).values({ userId, ...fields, kind: 'custom' }).returning();
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
    const current = presetJson(row);
    const body = await readJsonBody(c);
    const fields = current.kind === 'profile'
      ? await profileFields(deps, c.get('userId'), body, current)
      : await presetFields(deps, c.get('userId'), body, current);
    const [updated] = await deps.db.update(modelPresets).set({ ...fields, updatedAt: new Date() }).where(eq(modelPresets.id, row.id)).returning();
    const preset = presetJson(updated!);
    return c.json({ ...preset, ...profileNotes(await registryCatalog(deps), preset) });
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

  /**
   * One tiny request on the preset: its words back, or the provider's refusal
   * as the answer. A profile preset's goes with the profile's own output cap,
   * as its every request does — a thinking model given 64 tokens answers nothing.
   */
  app.post('/:id/test', async (c) => {
    const row = await owned(c);
    const started = Date.now();
    try {
      const resolved = await modelOf(deps, row.userId, presetJson(row));
      const text = await collect(resolved.adapter, {
        model: resolved.providerModel,
        system: '',
        messages: [{ role: 'user', content: TEST_PROMPT }],
        maxTokens: resolved.preset.kind === 'profile' ? resolved.maxTokens ?? TEST_TOKENS : TEST_TOKENS,
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

