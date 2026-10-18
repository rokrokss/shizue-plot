import { providerOf } from '../providers.js';
import bundledData from './bundled.json' with { type: 'json' };
import { snapshotOf } from './snapshot.js';
import type { AuthKind, AdapterKind, ModelProfile, RegistryCatalog, RegistryProfileStatus, ResolvedModelProfileSnapshot } from './types.js';
import { validateCatalog } from './validate.js';

/**
 * PocketRisu's model registry in this app (ARCHITECTURE §7.1): the bundled
 * copy (`bundled.json` — PocketRisu's `src/ts/preset/registry/bundled` at
 * f71e1cc, the data CC0-1.0 from PocketRisu/pocketrisu-model-registry), a
 * newer catalog the owner refreshes from the registry's own address, and which
 * of its base providers this app offers: those that are one of `PROVIDERS` on
 * one of our formats (`REGISTRY_BASES`).
 */

/** PocketRisu's id for the official registry, which a preset's source names. */
export const OFFICIAL_REGISTRY_ID = 'bundled';
/** Where PocketRisu syncs the official registry from (`remote.ts` `OFFICIAL_BASE`). */
export const OFFICIAL_REGISTRY_URL = 'https://raw.githubusercontent.com/PocketRisu/pocketrisu-model-registry/main/';

let bundled: RegistryCatalog | undefined;
/** The catalog this build carries, checked as a fetched one is. */
export function bundledCatalog(): RegistryCatalog {
  bundled ??= validateCatalog(bundledData).catalog;
  return bundled;
}

/**
 * A PocketRisu base provider as one of ours: the provider whose key it takes,
 * the format its profiles' requests are written in, and the adapter and auth
 * its profiles must name. `prefix` is what the provider's address takes before
 * the format's own path (Ollama Cloud's OpenAI endpoint is under `/v1`).
 */
export interface RegistryBase {
  provider: string;
  format: 'google' | 'anthropic' | 'openai-chat';
  adapterKind: AdapterKind;
  auth: AuthKind;
  prefix: string;
}

const openAICompatible = (provider: string, prefix = ''): RegistryBase => ({ provider, format: 'openai-chat', adapterKind: 'openai-compatible', auth: 'bearer', prefix });

/**
 * The base providers this app offers profiles of. The others — the gateways
 * (Cerebras, LLM Gateway, Lightning AI, NeuralWatt, SQUARE1, Vercel,
 * Wellspring), Bedrock's and Vertex's, and the custom-address ones — are not
 * among `PROVIDERS` or run on this app's own formats, and stay off the list.
 */
export const REGISTRY_BASES: Readonly<Record<string, RegistryBase>> = {
  google: { provider: 'google', format: 'google', adapterKind: 'google-gemini', auth: 'x-goog-api-key', prefix: '' },
  anthropic: { provider: 'anthropic', format: 'anthropic', adapterKind: 'anthropic-messages', auth: 'x-api-key', prefix: '' },
  openai: openAICompatible('openai'),
  openrouter: openAICompatible('openrouter'),
  deepseek: openAICompatible('deepseek'),
  deepinfra: openAICompatible('deepinfra'),
  nanogpt: openAICompatible('nanogpt'),
  'ollama-cloud': openAICompatible('ollama', '/v1'),
};

/** Each format's own path under the address, which the profiles' endpoints end with. */
const FORMAT_PATHS: Record<RegistryBase['format'], string> = { google: '/models', anthropic: '/messages', 'openai-chat': '/chat/completions' };

/**
 * The base a snapshot's requests run on here, or null when this app does not
 * offer it: its base must be one of `REGISTRY_BASES`, with the adapter and
 * auth that base names, and its endpoint must be that provider's own address
 * with the format's path. The endpoint is only checked, never used — a
 * request goes to its credential's address — so a profile that names another
 * address is not offered rather than sent elsewhere.
 */
export function registryBaseOf(snapshot: Pick<ResolvedModelProfileSnapshot, 'providerBaseId' | 'adapterKind' | 'auth' | 'endpoint'>): RegistryBase | null {
  const base = Object.prototype.hasOwnProperty.call(REGISTRY_BASES, snapshot.providerBaseId) ? REGISTRY_BASES[snapshot.providerBaseId] : undefined;
  const provider = base ? providerOf(base.provider) : undefined;
  if (!base || !provider?.baseUrl) return null;
  if (snapshot.adapterKind !== base.adapterKind || snapshot.auth.kind !== base.auth) return null;
  if (snapshot.endpoint.kind !== 'static' || snapshot.endpoint.url !== `${provider.baseUrl}${base.prefix}${FORMAT_PATHS[base.format]}`) return null;
  return base;
}

/** A profile as the browser lists it: what PocketRisu's profile card shows, and whose key it takes. */
export interface ProfileEntry {
  id: string;
  displayName: string;
  displayNameI18n?: Record<string, string>;
  description?: string;
  descriptionI18n?: Record<string, string>;
  status: RegistryProfileStatus;
  statusReason?: string;
  sortOrder?: number;
  updatedAt?: number;
  modelId: string;
  /** PocketRisu's base provider: its id and name, the browser's groups. */
  baseId: string;
  baseLabel: string;
  /** Ours, whose key a preset on it takes. */
  provider: string;
  format: RegistryBase['format'];
  capabilities: string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

/** The profiles this app offers from `catalog`, in no particular order. */
export function profileEntries(catalog: RegistryCatalog): ProfileEntry[] {
  const entries: ProfileEntry[] = [];
  for (const profile of Object.values(catalog.profiles)) {
    const baseDefinition = catalog.baseProviders[profile.providerBaseId];
    if (!baseDefinition) continue;
    const snapshot = snapshotOf(baseDefinition, profile);
    const base = registryBaseOf(snapshot);
    if (!base) continue;
    entries.push({
      id: profile.id,
      displayName: profile.displayName,
      ...(profile.displayNameI18n ? { displayNameI18n: profile.displayNameI18n } : {}),
      ...(profile.description ? { description: profile.description } : {}),
      ...(profile.descriptionI18n ? { descriptionI18n: profile.descriptionI18n } : {}),
      status: profile.profileStatus,
      ...(profile.statusReason ? { statusReason: profile.statusReason } : {}),
      ...(profile.sortOrder !== undefined ? { sortOrder: profile.sortOrder } : {}),
      ...(profile.updatedAt !== undefined ? { updatedAt: profile.updatedAt } : {}),
      modelId: profile.modelId,
      baseId: baseDefinition.id,
      baseLabel: baseDefinition.displayName,
      provider: base.provider,
      format: base.format,
      capabilities: snapshot.capabilities ?? [],
      ...(snapshot.limits?.contextWindowTokens ? { contextWindowTokens: snapshot.limits.contextWindowTokens } : {}),
      ...(snapshot.limits?.maxOutputTokens ? { maxOutputTokens: snapshot.limits.maxOutputTokens } : {}),
    });
  }
  return entries;
}

const STATUS_ORDER: RegistryProfileStatus[] = ['current', 'outdated', 'deprecated'];

/** PocketRisu's order within a provider: current first, then the profile's own order, then its name. */
export const compareProfiles = (a: Pick<ProfileEntry, 'status' | 'sortOrder' | 'displayName'>, b: Pick<ProfileEntry, 'status' | 'sortOrder' | 'displayName'>): number =>
  STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.displayName.localeCompare(b.displayName);

/**
 * The profile a new key of `provider` starts on: its first current profile in
 * PocketRisu's order — never an outdated or deprecated one, which PocketRisu's
 * browser hides by default — preferring one that names a model over a
 * catch-all whose model the owner types. Undefined where the registry has none
 * for the provider.
 */
export function firstProfileOf(catalog: RegistryCatalog, provider: string): ProfileEntry | undefined {
  const current = profileEntries(catalog).filter((entry) => entry.provider === provider && entry.status === 'current').sort(compareProfiles);
  return current.find((entry) => entry.modelId) ?? current[0];
}

/** The snapshot `profileId` resolves to in `catalog`, where this app offers it. */
export function offeredSnapshot(catalog: RegistryCatalog, profileId: string): { snapshot: ResolvedModelProfileSnapshot; profile: ModelProfile; base: RegistryBase } | null {
  const profile = Object.prototype.hasOwnProperty.call(catalog.profiles, profileId) ? catalog.profiles[profileId] : undefined;
  const definition = profile ? catalog.baseProviders[profile.providerBaseId] : undefined;
  if (!profile || !definition) return null;
  const snapshot = snapshotOf(definition, profile);
  const base = registryBaseOf(snapshot);
  return base ? { snapshot, profile, base } : null;
}

/**
 * Whether a preset's profile has a newer revision, PocketRisu's
 * `getProfileUpdateStatus`: `missing` where the catalog no longer has it,
 * `updatable` where the catalog's `updatedAt` is later than the one the preset
 * took, `none` otherwise (or where either is unknown).
 */
export function profileUpdateStatus(catalog: RegistryCatalog, profileId: string, takenAt: number | undefined): 'none' | 'updatable' | 'missing' {
  const current = offeredSnapshot(catalog, profileId);
  if (!current) return 'missing';
  if (takenAt !== undefined && current.profile.updatedAt !== undefined && current.profile.updatedAt > takenAt) return 'updatable';
  return 'none';
}

export { resolveSnapshot, snapshotOf } from './snapshot.js';
export { validateCatalog, isMappingPath } from './validate.js';
export { editable, effectiveValue, migrateValues, newPresetValues, parseProfileValues, profileBody, profileOutputTokens, seedValues, wireModelId } from './request.js';
export type * from './types.js';
