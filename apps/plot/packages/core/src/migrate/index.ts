/**
 * Paste migration (`@shizue/core/migrate`): each site's form as data, and the
 * one conversion from what was pasted to a `MigrationDraft`. Pure and
 * Buffer-free — the web runs it for the preview, the API never needs to — and
 * kept off the package root, so only the pages that migrate pull it in.
 */

import { formOf, type Conversion } from './convert.js';
import { ELYN_SCHEMA, elynToDraft } from './elyn.js';
import type {
  ConvertOptions,
  MigrationDraft,
  MigrationPlatform,
  MigrationResult,
  SiteInput,
  SiteSchema,
} from './types.js';
import { ZETA_SCHEMA, zetaToDraft } from './zeta.js';

export * from './types.js';

/** The sites the form opens for; the rest are Phase 2 (D14). */
export const MIGRATION_PLATFORMS_ENABLED: readonly MigrationPlatform[] = ['zeta', 'elyn'];

export const SITE_SCHEMAS: Partial<Record<MigrationPlatform, SiteSchema>> = {
  zeta: ZETA_SCHEMA,
  elyn: ELYN_SCHEMA,
};

const MAPPERS: Partial<Record<MigrationPlatform, (c: Conversion, input: SiteInput) => MigrationDraft>> = {
  zeta: zetaToDraft,
  elyn: elynToDraft,
};

/**
 * A blank form for `schema`: every flat field at the top level, every repeated
 * section as its `min` rows. Text fields are '', `multiChoice` fields [].
 */
export function emptyInput(schema: SiteSchema): SiteInput {
  const input: SiteInput = {};
  for (const section of schema.sections) {
    const record = (): Record<string, unknown> =>
      Object.fromEntries(section.fields.map((field) => [field.id, field.kind === 'multiChoice' ? [] : '']));
    if (section.repeat) input[section.id] = Array.from({ length: section.repeat.min }, record);
    else Object.assign(input, record());
  }
  return input;
}

const emptyDraft = (platform: MigrationPlatform): MigrationDraft => ({
  platform,
  plot: { name: '', intro: '', description: '', tags: [], intros: [], lorebook: [] },
  members: [],
});

/**
 * What the form becomes here, with what the creator must be told and what has
 * nowhere to go. Deterministic — the same form and options give the same draft —
 * and never throws: a malformed form reads as an emptier one.
 */
export function convertToDraft(
  platform: MigrationPlatform,
  input: SiteInput,
  options: ConvertOptions = {},
): MigrationResult {
  const schema = SITE_SCHEMAS[platform];
  const mapper = MAPPERS[platform];
  if (!schema || !mapper) {
    return {
      draft: emptyDraft(platform),
      warnings: [{ code: 'platformUnsupported' }],
      preserved: [],
    };
  }
  const c: Conversion = {
    schema,
    options: options !== null && typeof options === 'object' ? options : {},
    warnings: [],
    preserved: [],
  };
  const draft = mapper(c, formOf(input));
  if (draft.members.length === 0) c.warnings.push({ code: 'noMembers' });
  return { draft, warnings: c.warnings, preserved: c.preserved };
}

/** JSON with every object's keys in one order and undefined members left out. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The draft as one canonical string (D12): keys sorted at every depth, arrays
 * in order. The web hashes it with `crypto.subtle` and the API with
 * `node:crypto` — both sha256 — so the same draft is the same fingerprint on
 * either side and `POST /api/imports/lookup` can tell it was imported before.
 */
export function draftFingerprint(draft: MigrationDraft): string {
  return canonicalJson(draft);
}
