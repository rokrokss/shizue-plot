import { chats, modelPresets, user, type Credential, type Db, type ModelPreset } from '@shizue/db';
import { adapterFor, listModels, providerOf, type LLMAdapter, type ModelBinding, type ModelCapabilities, type ModelParams } from '@shizue/llm';
import { and, eq, sql } from 'drizzle-orm';
import { loadCredential, openCredential } from './credentials.js';
import type { AppDeps, Tx } from './deps.js';
import { ApiError, badRequest } from './errors.js';
import { isUuid } from './util.js';

/**
 * Which model a call runs on — PocketRisu's model presets and bindings
 * (ARCHITECTURE §7.1). A chat binds a main preset, for its own turns, and a sub
 * preset, for the side work (the memory's summaries and facts, emotion,
 * translation, suggestions, drafts, lore aliases, a card script's `axLLM`). A
 * slot the chat leaves open follows the owner's default binding
 * (`user.model_binding`), and an open sub runs on the main. One resolver
 * answers every call with the adapter its preset's format and credential make.
 */
export type ModelSlot = 'main' | 'sub';

/** What resolving a slot reads: the presets and the binding, the credentials, and the tests' stand-in. */
export type ModelDeps = Pick<AppDeps, 'db' | 'env' | 'chatgpt' | 'getAdapter' | 'vault'>;

/** A model preset as a binding names it: one of the owner's, or an entry of the test runner's catalog. */
export interface PresetView {
  id: string;
  name: string;
  format: string;
  endpoint: string | null;
  model: string;
  credentialId: string | null;
  params: ModelParams;
  capabilities: ModelCapabilities;
  /** The test runner's own, not a row (`testPresets`). */
  builtIn?: true;
}

/** A slot resolved: the preset, the adapter its calls stream from, and what the prompt needs of it. */
export interface ResolvedModel {
  preset: PresetView;
  adapter: LLMAdapter;
  /** What a request's `model` names. */
  providerModel: string;
  /** Whether a turn's pictures go to it. */
  vision: boolean;
  /** The preset's cap on a reply, which a turn's prompt reserves in place of the plot's. */
  maxTokens?: number;
}

/** Whose binding a call resolves: a chat, or the owner alone (a draft, a lore alias pass). */
export interface BindingOwner {
  userId: string;
  modelBinding: ModelBinding | null;
}

const testing = (env: NodeJS.ProcessEnv): boolean => (env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test';

const builtIn = (id: string, name: string, capabilities: ModelCapabilities = {}): PresetView => ({
  id, name, format: 'echo', endpoint: null, model: id, credentialId: null, params: {}, capabilities, builtIn: true,
});

/**
 * `NODE_ENV=test` only: the catalog the suites pick from, which has no rows —
 * `echo/echo`, and with `SHIZUE_TEST_MODELS=1` a text, a vision and a reasoning
 * model. Their ids are the model ids the ChatGPT-only catalog had, which the
 * suites' adapters are still asked with (`deps.getAdapter`).
 */
export function testPresets(env: NodeJS.ProcessEnv): PresetView[] {
  if (!testing(env)) return [];
  return [
    builtIn('echo/echo', 'Echo (test)'),
    ...(env['SHIZUE_TEST_MODELS'] === '1'
      ? [builtIn('test/text', 'Text (test)'), builtIn('test/vision', 'Vision (test)', { vision: true }), builtIn('test/reasoning', 'Reasoning (test)')]
      : []),
  ];
}

export const presetJson = (row: ModelPreset): PresetView & { createdAt: Date; updatedAt: Date } => ({
  id: row.id,
  name: row.name,
  format: row.format,
  endpoint: row.endpoint,
  model: row.model,
  credentialId: row.credentialId,
  params: row.params,
  capabilities: row.capabilities,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * The owner's default binding as stored. Under `NODE_ENV=test`, an owner who
 * set none runs on echo, the side work on `MEMORY_MODEL` (or `test/memory`, which
 * only a suite's own adapter answers — the side work is off without one), as
 * the ChatGPT-only catalog had it.
 */
export async function defaultBinding(deps: Pick<AppDeps, 'db' | 'env'>, userId: string): Promise<ModelBinding> {
  const [row] = await deps.db.select({ binding: user.modelBinding }).from(user).where(eq(user.id, userId)).limit(1);
  if (row?.binding) return row.binding;
  return testing(deps.env) ? { main: 'echo/echo', sub: deps.env['MEMORY_MODEL'] || 'test/memory' } : {};
}

/**
 * The preset `id` names among the owner's. In tests a catalog id names its
 * entry, and a `trusted` id — the default binding's, which nobody picked —
 * stands for itself, for a suite's own adapter to answer; any other is none.
 */
async function presetById(
  deps: Pick<AppDeps, 'db' | 'env'>,
  userId: string,
  id: string | null | undefined,
  trusted = false,
): Promise<PresetView | null> {
  if (!id) return null;
  if (!isUuid(id)) {
    if (!testing(deps.env)) return null;
    return testPresets(deps.env).find((preset) => preset.id === id) ?? (trusted ? builtIn(id, id) : null);
  }
  const [row] = await deps.db.select().from(modelPresets).where(and(eq(modelPresets.id, id), eq(modelPresets.userId, userId))).limit(1);
  return row ? presetJson(row) : null;
}

/**
 * The presets a slot tries, in order. The main: the chat's own pick — one it
 * cannot run is refused, never swapped for another model — or else the
 * default's. The sub: the chat's own pick, which falls back when it is gone or
 * no longer offered, as an auxiliary model the catalog dropped always did; then
 * the default's sub, or the main where the default leaves the sub open.
 */
async function candidatesOf(deps: Pick<AppDeps, 'db' | 'env'>, owner: BindingOwner, slot: ModelSlot): Promise<[PresetView | null, PresetView | null]> {
  const fallback = await defaultBinding(deps, owner.userId);
  const main = owner.modelBinding?.main
    ? await presetById(deps, owner.userId, owner.modelBinding.main)
    : await presetById(deps, owner.userId, fallback.main, true);
  if (slot === 'main') return [null, main];
  const defaultSub = fallback.sub ? await presetById(deps, owner.userId, fallback.sub, true) : null;
  return [await presetById(deps, owner.userId, owner.modelBinding?.sub), defaultSub ?? main];
}

/** The preset a slot resolves to, without asking anything of it (`{{axmodel}}`, a start's check); null when none. */
export async function resolvePreset(deps: Pick<AppDeps, 'db' | 'env'>, owner: BindingOwner, slot: ModelSlot): Promise<PresetView | null> {
  return (await candidatesOf(deps, owner, slot)).find((preset) => preset !== null) ?? null;
}

const unavailable = (detail: string): ApiError => badRequest('model_unavailable', detail);
const isUnavailable = (error: unknown): boolean => error instanceof ApiError && error.code === 'model_unavailable';
/** Sub picks already reported as falling back — a setting, not a per-turn failure. */
const warnedFallbacks = new Set<string>();

/**
 * The adapter a preset's calls stream from. A preset on the ChatGPT connection
 * is held to the account's catalog as the chats on it always were: a model it
 * no longer lists is `model_unavailable`, its pictures are the catalog's unless
 * the preset says, and an effort the model does not advertise is not sent.
 */
export async function modelOf(deps: ModelDeps, userId: string, preset: PresetView): Promise<ResolvedModel> {
  const cap = preset.params.maxTokens !== undefined ? { maxTokens: preset.params.maxTokens } : {};
  if (deps.getAdapter) {
    const { adapter, providerModel } = await deps.getAdapter(preset.model, deps.env);
    return { preset, adapter, providerModel, vision: preset.capabilities.vision === true, ...cap };
  }
  if (preset.builtIn && !testPresets(deps.env).some((entry) => entry.id === preset.id)) {
    throw unavailable(`Model not available: ${preset.model}`);
  }
  const row = preset.credentialId ? await loadCredential(deps, userId, preset.credentialId) : undefined;
  const credential = row ? openCredential(deps, row) : undefined;
  let params = preset.params;
  let vision = preset.capabilities.vision === true;
  if (credential?.kind === 'chatgpt') {
    const listed = (await credential.account.models()).find((model) => model.id === preset.model);
    if (!listed) throw unavailable(`Model not available: ${preset.model}`);
    vision = preset.capabilities.vision ?? listed.vision;
    if (params.reasoningEffort && !listed.reasoningEfforts?.includes(params.reasoningEffort)) {
      const { reasoningEffort: _dropped, ...rest } = params;
      params = rest;
    }
  }
  const adapter = adapterFor(
    { format: preset.format, endpoint: preset.endpoint, model: preset.model, params, capabilities: preset.capabilities },
    credential,
    deps.env,
  );
  return { preset, adapter, providerModel: preset.model, vision, ...cap };
}

/**
 * The model a slot runs on, or `model_unavailable` when the binding names none
 * it can run (`candidatesOf`). A chat's sub pick that falls back is said once.
 */
export async function resolveModel(deps: ModelDeps, owner: BindingOwner, slot: ModelSlot): Promise<ResolvedModel> {
  const [pick, fallback] = await candidatesOf(deps, owner, slot);
  const picked = slot === 'sub' ? owner.modelBinding?.sub : null;
  const fellBack = (): void => {
    if (!picked || warnedFallbacks.has(picked)) return;
    warnedFallbacks.add(picked);
    console.warn(`[models] the sub model preset ${picked} is not available; the side work falls back`);
  };
  if (pick) {
    try {
      return await modelOf(deps, owner.userId, pick);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      fellBack();
    }
  } else if (picked) fellBack();
  if (!fallback) throw unavailable('No model preset is set for this chat; pick one in Settings › Models');
  return modelOf(deps, owner.userId, fallback);
}

/** Whether `id` is a preset a binding may name: one of the owner's, or the test catalog's. */
async function bindable(deps: Pick<AppDeps, 'db' | 'env'>, userId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return testPresets(deps.env).some((preset) => preset.id === id);
  const [row] = await deps.db.select({ id: modelPresets.id }).from(modelPresets).where(and(eq(modelPresets.id, id), eq(modelPresets.userId, userId))).limit(1);
  return Boolean(row);
}

/** The preset a request names for a one-off call (a draft): the owner's, or the test catalog's; 400 otherwise. */
export async function bindablePreset(deps: Pick<AppDeps, 'db' | 'env'>, userId: string, id: string): Promise<PresetView> {
  const preset = (await bindable(deps, userId, id)) ? await presetById(deps, userId, id) : null;
  if (!preset) throw unavailable(`Model preset not available: ${id}`);
  return preset;
}

/**
 * A binding as a request sets it: `{main?, sub?}`, each a preset of the owner's
 * or null to leave the slot to the default. A slot left out of the object is
 * not touched. 400 `model_unavailable` for a preset that is not theirs.
 */
export async function readBindingPatch(deps: Pick<AppDeps, 'db' | 'env'>, userId: string, value: unknown): Promise<ModelBinding> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('invalid_request', 'modelBinding must be an object');
  }
  const patch: ModelBinding = {};
  for (const [slot, id] of Object.entries(value as Record<string, unknown>)) {
    if (slot !== 'main' && slot !== 'sub') throw badRequest('invalid_request', `Unknown model slot: ${slot}`);
    if (id === null) patch[slot] = null;
    else if (typeof id !== 'string') throw badRequest('invalid_request', `modelBinding.${slot} must be a preset id or null`);
    else if (!(await bindable(deps, userId, id))) throw unavailable(`Model preset not available: ${id}`);
    else patch[slot] = id;
  }
  return patch;
}

/** `current` with `patch` laid over it; a binding with no slot set is null. */
export function mergeBinding(current: ModelBinding | null, patch: ModelBinding): ModelBinding | null {
  const next = { ...(current ?? {}), ...patch };
  const kept: ModelBinding = {};
  if (next.main) kept.main = next.main;
  if (next.sub) kept.sub = next.sub;
  return kept.main || kept.sub ? kept : null;
}

/** A binding as the page reads it: both slots, null where it follows the default. */
export const bindingJson = (binding: ModelBinding | null | undefined): { main: string | null; sub: string | null } => ({
  main: binding?.main ?? null,
  sub: binding?.sub ?? null,
});

/** Every binding that names `presetId` lets go of it: the chats' and the default's slots fall back. */
export async function releasePreset(tx: Tx, userId: string, presetId: string): Promise<void> {
  for (const slot of ['main', 'sub'] as const) {
    await tx
      .update(chats)
      .set({ modelBinding: sql`nullif(${chats.modelBinding} - ${slot}::text, '{}'::jsonb)` })
      .where(and(eq(chats.userId, userId), sql`${chats.modelBinding}->>${slot}::text = ${presetId}`));
    await tx
      .update(user)
      .set({ modelBinding: sql`nullif(${user.modelBinding} - ${slot}::text, '{}'::jsonb)` })
      .where(and(eq(user.id, userId), sql`${user.modelBinding}->>${slot}::text = ${presetId}`));
  }
}

/**
 * A first model for an owner who has none, so a new install can chat without
 * building a preset first: connecting ChatGPT or saving an API key while no
 * model preset exists makes one on that credential — the account's first
 * catalog model, or the first model the key's provider lists — and makes it
 * the default main where none is set. Best effort: a listing that fails or
 * comes back empty makes none, and the connection or the key stays saved.
 */
export async function ensureFirstPreset(deps: ModelDeps, row: Credential): Promise<void> {
  const hasPreset = async (db: Db | Tx): Promise<boolean> =>
    (await db.select({ id: modelPresets.id }).from(modelPresets).where(eq(modelPresets.userId, row.userId)).limit(1)).length > 0;
  try {
    if (await hasPreset(deps.db)) return;
    const credential = openCredential(deps, row);
    const format = credential.kind === 'chatgpt' ? 'openai-responses' : providerOf(row.provider)?.formats[0];
    if (!format) return;
    const [first] = credential.kind === 'chatgpt' ? await credential.account.models() : await listModels(format, null, credential, deps.env);
    if (!first) return;
    await deps.db.transaction(async (tx) => {
      if (await hasPreset(tx)) return;
      const [preset] = await tx
        .insert(modelPresets)
        .values({ userId: row.userId, name: (first.label || first.id).slice(0, 100), format, model: first.id, credentialId: row.id })
        .returning({ id: modelPresets.id });
      await tx
        .update(user)
        .set({ modelBinding: sql`coalesce(${user.modelBinding}, '{}'::jsonb) || jsonb_build_object('main', ${preset!.id}::text)` })
        .where(and(eq(user.id, row.userId), sql`${user.modelBinding}->>'main' is null`));
    });
  } catch (error) {
    console.warn(`[models] no first model preset for the new ${row.kind === 'chatgpt' ? 'ChatGPT connection' : 'key'}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
