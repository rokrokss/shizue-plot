import { setPath } from '../params.js';
import type { RegistryFieldSchema, ResolvedModelProfileSnapshot } from './types.js';
import { isMappingPath } from './validate.js';

/**
 * A profile preset's part of a request body, PocketRisu's `buildPreparedRequest`
 * (`src/ts/preset/adapter/buildRequest.ts`) without its URL and auth: the
 * snapshot's defaults with its body template over them, then each schema field
 * that maps into the body at its path — the preset's value, else the field's
 * default; one left unset or empty is not sent — then the preset's additional
 * body fields over all of it. The format's adapter writes its own fields
 * (`messages`, `contents`, `model`, `stream`) after, so nothing here replaces
 * them. Headers, query and custom mappings are never read: where a request goes
 * and what it carries besides the body is the credential's (§7.1).
 */
export function profileBody(
  snapshot: Pick<ResolvedModelProfileSnapshot, 'defaults' | 'bodyTemplate' | 'schema'>,
  values: Record<string, unknown>,
  extraBody?: Record<string, unknown>,
): Record<string, unknown> {
  const body = structuredClone({ ...snapshot.defaults, ...(snapshot.bodyTemplate ?? {}) }) as Record<string, unknown>;
  for (const field of snapshot.schema) {
    if (field.mapsTo?.target !== 'body' || !isMappingPath(field.mapsTo.path)) continue;
    const value = effectiveValue(values, field);
    // An input cleared back to blank is unset, as PocketRisu reads it.
    if (value === undefined || value === '') continue;
    setPath(body, field.mapsTo.path, structuredClone(value));
  }
  for (const [key, value] of Object.entries(extraBody ?? {})) setPath(body, key, structuredClone(value));
  return body;
}

const STOP_KEYS = new Set(['stop', 'stopSequences', 'stop_sequences']);

/**
 * The caller's stop strings (a group turn's other speakers) after the profile's
 * own in its stop field, up to `max` in all — none is added where the profile
 * has no such field, and the stream's own filter keeps them either way. The
 * profile's own come first and are never dropped.
 */
export function addCallerStops(
  body: Record<string, unknown>,
  snapshot: Pick<ResolvedModelProfileSnapshot, 'schema'>,
  values: Record<string, unknown>,
  stops: readonly string[] | undefined,
  max: number,
): void {
  const field = snapshot.schema.find((entry) => STOP_KEYS.has(entry.key) && entry.type === 'stringArray' && editable(entry) && isMappingPath(entry.mapsTo!.path));
  const extra = (stops ?? []).filter((stop) => stop.trim());
  if (!field || extra.length === 0) return;
  const own = effectiveValue(values, field);
  const current = Array.isArray(own) ? own.filter((stop): stop is string => typeof stop === 'string' && stop.length > 0) : [];
  const merged = [...current];
  for (const stop of extra) if (merged.length < max && !merged.includes(stop)) merged.push(stop);
  if (merged.length > current.length) setPath(body, field.mapsTo!.path, merged);
}

/** The value a field sends: the preset's own, else the field's default. */
export function effectiveValue(values: Record<string, unknown>, field: Pick<RegistryFieldSchema, 'key' | 'default'>): unknown {
  if (Object.prototype.hasOwnProperty.call(values, field.key) && values[field.key] !== undefined) return values[field.key];
  return field.default;
}

/**
 * The model a profile preset asks for, PocketRisu's `resolveWireModelId`: the
 * preset's `modelId`, else the field's default, else the profile's model. A
 * body field never decides it, so an additional body field cannot point the
 * request at another model.
 */
export function wireModelId(snapshot: Pick<ResolvedModelProfileSnapshot, 'schema' | 'modelId'>, values: Record<string, unknown>): string {
  const field = snapshot.schema.find((entry) => entry.key === 'modelId');
  const own = values['modelId'];
  if (typeof own === 'string' && own.length > 0) return own;
  if (field && typeof field.default === 'string' && field.default.length > 0) return field.default;
  return snapshot.modelId;
}

/** The body keys a reply's cap goes under, PocketRisu's `OUTPUT_TOKEN_KEYS`. */
const OUTPUT_TOKEN_KEYS = ['max_tokens', 'maxOutputTokens', 'max_output_tokens', 'max_completion_tokens'];

/**
 * The cap a profile preset's replies run under, PocketRisu's
 * `resolvePresetMaxOutputTokens`: the field that maps to the provider's output
 * cap — the preset's value, else the field's default — else that path in the
 * snapshot's defaults. It is what the request sends and what the prompt's
 * budget reserves (§7.2). Undefined where the profile declares none.
 */
export function profileOutputTokens(
  snapshot: Pick<ResolvedModelProfileSnapshot, 'schema' | 'defaults'>,
  values: Record<string, unknown>,
): number | undefined {
  const paths = [...OUTPUT_TOKEN_KEYS];
  for (const field of snapshot.schema) {
    const path = field.mapsTo?.path;
    const output = OUTPUT_TOKEN_KEYS.includes(field.key) || (typeof path === 'string' && OUTPUT_TOKEN_KEYS.some((key) => path === key || path.endsWith(`.${key}`)));
    if (!output) continue;
    if (typeof path === 'string' && !paths.includes(path)) paths.push(path);
    const value = values[field.key] ?? field.default;
    if (positive(value)) return value;
  }
  for (const path of paths) {
    let at: unknown = snapshot.defaults;
    for (const key of path.split('.')) at = typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[key] : undefined;
    if (positive(at)) return at;
  }
  return undefined;
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** The values a new preset on a snapshot starts with: every field's default, as PocketRisu's browser seeds them. */
export function seedValues(snapshot: Pick<ResolvedModelProfileSnapshot, 'schema'>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of snapshot.schema) {
    if (field.default !== undefined && editable(field)) values[field.key] = structuredClone(field.default);
  }
  return values;
}

/**
 * What a preset made here starts with: PocketRisu's seed (`seedValues`), and
 * Gemini's thoughts asked for (`includeThoughts`, which PocketRisu leaves off)
 * — this app keeps a reply's thinking folded above it, and a model thinking
 * aloud keeps its stream from going quiet. The owner can turn it off.
 */
export function newPresetValues(snapshot: Pick<ResolvedModelProfileSnapshot, 'schema'>): Record<string, unknown> {
  const values = seedValues(snapshot);
  const thoughts = snapshot.schema.find((field) => field.key === 'includeThoughts' && field.type === 'boolean' && editable(field));
  if (thoughts) values[thoughts.key] = true;
  return values;
}

/**
 * A preset's values carried onto another snapshot of a profile, PocketRisu's
 * `migrateUserValues`: a value whose field is still there stays, the rest go
 * (`dropped`), and a new field starts at its default. A value the new field
 * refuses (another type, past its bounds) goes too, where PocketRisu keeps it
 * for the provider to refuse.
 */
export function migrateValues(
  values: Record<string, unknown>,
  schema: readonly RegistryFieldSchema[],
): { values: Record<string, unknown>; dropped: string[] } {
  const fields = new Map(schema.filter(editable).map((field) => [field.key, field]));
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const field = fields.get(key);
    let fits = field !== undefined;
    if (field) {
      try {
        fieldValue(field, value);
      } catch {
        fits = false;
      }
    }
    if (fits) kept[key] = value;
    else dropped.push(key);
  }
  for (const field of schema) {
    if (editable(field) && field.default !== undefined && !(field.key in kept)) kept[field.key] = structuredClone(field.default);
  }
  return { values: kept, dropped };
}

/**
 * The fields a preset holds a value for: those that go into the body. The key
 * is the credential's and the address its too, so a field that maps to the
 * auth, a header, the query or an address is never set here.
 */
export const editable = (field: Pick<RegistryFieldSchema, 'mapsTo' | 'secret'>): boolean =>
  field.mapsTo?.target === 'body' && field.secret !== true;

const MAX_STRING = 10_000;
const MAX_ARRAY = 64;
const MAX_JSON_BYTES = 16 * 1024;

/**
 * A preset's values as the API takes them, against the snapshot's schema: each
 * key a field the preset may set (`editable`), each value of the field's type
 * and within its bounds. `null` clears a value. Throws a `TypeError` that says
 * what is wrong.
 */
export function parseProfileValues(value: unknown, schema: readonly RegistryFieldSchema[]): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('values must be an object');
  const fields = new Map(schema.filter(editable).map((field) => [field.key, field]));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === undefined || raw === null) continue;
    const field = fields.get(key);
    if (!field) throw new TypeError(`Unknown value: ${key}`);
    out[key] = fieldValue(field, raw);
  }
  return out;
}

function fieldValue(field: RegistryFieldSchema, raw: unknown): unknown {
  const bounded = (number: number): number => {
    if ((field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) {
      throw new TypeError(`${field.key} must be from ${field.min ?? '-∞'} to ${field.max ?? '∞'}`);
    }
    return number;
  };
  switch (field.type) {
    case 'string':
      if (typeof raw !== 'string' || raw.length > MAX_STRING || raw.includes('\0')) throw new TypeError(`${field.key} must be a string`);
      return raw;
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new TypeError(`${field.key} must be a number`);
      return bounded(raw);
    case 'integer':
      if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new TypeError(`${field.key} must be an integer`);
      return bounded(raw);
    case 'boolean':
      if (typeof raw !== 'boolean') throw new TypeError(`${field.key} must be true or false`);
      return raw;
    case 'stringArray':
      if (!Array.isArray(raw) || raw.length > MAX_ARRAY || raw.some((entry) => typeof entry !== 'string' || entry.length > 1000)) {
        throw new TypeError(`${field.key} must be a list of strings`);
      }
      return raw;
    case 'keyValue':
      if (typeof raw !== 'object' || Array.isArray(raw) || Object.values(raw as object).some((entry) => typeof entry !== 'string')) {
        throw new TypeError(`${field.key} must be a map of strings`);
      }
      return jsonValue(field, raw);
    case 'json':
      return jsonValue(field, raw);
  }
}

function jsonValue(field: RegistryFieldSchema, raw: unknown): unknown {
  let text: string;
  try {
    text = JSON.stringify(raw);
  } catch {
    throw new TypeError(`${field.key} must be JSON`);
  }
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new TypeError(`${field.key} holds at most ${MAX_JSON_BYTES} bytes`);
  // What comes back from the wire's own parse: plain JSON, no prototype keys.
  return JSON.parse(text, (key, entry: unknown) => (key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : entry));
}
