import type {
  BaseProviderDefinition,
  ModelLimits,
  ModelProfile,
  RegistryCatalog,
  RegistryFieldSchema,
  RegistryUiField,
  RegistryUiSchema,
  ResolvedModelProfileSnapshot,
} from './types.js';

/**
 * PocketRisu's `resolveSnapshot` (`src/ts/preset/registry/snapshot.ts`): a
 * profile merged over its base provider — the profile's fields replace the
 * base's of the same key and follow them, its UI groups and fields likewise,
 * the base's default body under the profile's defaults, the base's headers
 * under the profile's, and the `modelId` field's default backfilled with the
 * profile's model.
 */
export function resolveSnapshot(catalog: RegistryCatalog, profileId: string): ResolvedModelProfileSnapshot | null {
  const profile = catalog.profiles[profileId];
  const base = profile ? catalog.baseProviders[profile.providerBaseId] : undefined;
  if (!profile || !base) return null;
  return snapshotOf(base, profile);
}

export function snapshotOf(base: BaseProviderDefinition, profile: ModelProfile): ResolvedModelProfileSnapshot {
  const limits = mergeLimits(base.limits, profile.limits);
  const capabilities = profile.capabilities ?? base.capabilities;
  return {
    profileId: profile.id,
    profileVersion: profile.version,
    providerBaseId: profile.providerBaseId,
    providerBaseVersion: base.version,
    adapterKind: base.adapterKind,
    auth: profile.auth,
    endpoint: profile.endpoint,
    modelId: profile.modelId,
    schema: backfillSchemaDefaults(mergeSchemas(base.requestSchema, profile.schema), profile),
    uiSchema: mergeUiSchemas(base.uiSchema, profile.uiSchema),
    defaults: { ...(base.defaultBody ?? {}), ...profile.defaults },
    ...(profile.bodyTemplate ? { bodyTemplate: profile.bodyTemplate } : {}),
    headerTemplate: { ...(base.defaultHeaders ?? {}), ...(profile.headerTemplate ?? {}) },
    ...(capabilities ? { capabilities } : {}),
    ...(limits ? { limits } : {}),
    ...(profile.recommendedTokenizer ? { recommendedTokenizer: profile.recommendedTokenizer } : {}),
  };
}

function mergeLimits(base: ModelLimits | undefined, profile: ModelLimits | undefined): ModelLimits | undefined {
  if (!base) return profile ? { ...profile } : undefined;
  if (!profile) return { ...base };
  return { ...base, ...profile };
}

function backfillSchemaDefaults(schema: RegistryFieldSchema[], profile: ModelProfile): RegistryFieldSchema[] {
  if (!profile.modelId) return schema;
  return schema.map((field) => (field.key === 'modelId' && field.default === undefined ? { ...field, default: profile.modelId } : field));
}

function mergeSchemas(base: RegistryFieldSchema[], extension: RegistryFieldSchema[]): RegistryFieldSchema[] {
  if (extension.length === 0) return base.slice();
  const overridden = new Set(extension.map((field) => field.key));
  return [...base.filter((field) => !overridden.has(field.key)), ...extension];
}

function mergeUiSchemas(base: RegistryUiSchema, extension: RegistryUiSchema): RegistryUiSchema {
  if (extension.groups.length === 0 && extension.fields.length === 0) {
    return { groups: base.groups.slice(), fields: base.fields.slice() };
  }
  const groupIds = new Set(extension.groups.map((group) => group.id));
  const fieldKeys = new Set(extension.fields.map((field) => field.key));
  return {
    groups: [...base.groups.filter((group) => !groupIds.has(group.id)), ...extension.groups],
    fields: [...base.fields.filter((field: RegistryUiField) => !fieldKeys.has(field.key)), ...extension.fields],
  };
}
