import { bundledCatalog, legacyProfile, OFFICIAL_REGISTRY_ID, wireModelId, type ModelParams } from '@shizue/llm';
import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { credentials, modelPresets } from './schema/index.js';

/**
 * The presets from before the registry (`kind = 'legacy'`, which migration
 * 0001 marks every existing preset) as what they are now: one on an API key
 * whose provider and model a bundled registry profile names becomes that
 * profile's preset — the profile's snapshot and defaults, the preset's own
 * values carried over where the profile has the field (`legacyProfile`), its
 * additional headers and body kept — and any other a custom one, as it was:
 * the ChatGPT connection's, a keyless server's, a key whose model no profile
 * names. The row and its id stay, so every chat's binding and the default
 * still name it. Runs at every start, after the migrations; with nothing
 * marked it does nothing. Returns what it did, for the log.
 */
export async function convertLegacyPresets(db: Db, now = Date.now()): Promise<{ profile: number; custom: number; dropped: string[] }> {
  const rows = await db
    .select({ preset: modelPresets, credential: { kind: credentials.kind, provider: credentials.provider } })
    .from(modelPresets)
    .leftJoin(credentials, eq(credentials.id, modelPresets.credentialId))
    .where(eq(modelPresets.kind, 'legacy'));
  const outcome = { profile: 0, custom: 0, dropped: [] as string[] };
  if (rows.length === 0) return outcome;
  const catalog = bundledCatalog();
  await db.transaction(async (tx) => {
    for (const { preset, credential } of rows) {
      const match = credential?.kind === 'api_key'
        ? legacyProfile(catalog, { provider: credential.provider, model: preset.model, params: preset.params })
        : null;
      if (!match) {
        await tx.update(modelPresets).set({ kind: 'custom' }).where(eq(modelPresets.id, preset.id));
        outcome.custom += 1;
        continue;
      }
      const params: ModelParams = {
        ...(preset.params.extraHeaders ? { extraHeaders: preset.params.extraHeaders } : {}),
        ...(preset.params.extraBody ? { extraBody: preset.params.extraBody } : {}),
      };
      await tx
        .update(modelPresets)
        .set({
          kind: 'profile',
          format: match.format,
          model: wireModelId(match.snapshot, match.values),
          params,
          sourceProfile: {
            registryId: OFFICIAL_REGISTRY_ID,
            profileId: match.profileId,
            profileVersion: match.snapshot.profileVersion,
            providerBaseVersion: match.snapshot.providerBaseVersion,
            fetchedAt: now,
            ...(match.updatedAt !== undefined ? { profileUpdatedAt: match.updatedAt } : {}),
          },
          profileSnapshot: match.snapshot,
          userValues: match.values,
        })
        .where(eq(modelPresets.id, preset.id));
      outcome.profile += 1;
      outcome.dropped.push(...match.dropped.map((parameter) => `${preset.name}: ${parameter}`));
    }
  });
  return outcome;
}
