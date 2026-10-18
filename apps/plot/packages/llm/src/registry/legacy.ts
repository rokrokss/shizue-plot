import type { ModelParameter, ModelParams } from '../params.js';
import { offeredSnapshot, profileEntries } from './index.js';
import { editable, newPresetValues, parseProfileValues } from './request.js';
import type { RegistryCatalog, RegistryFieldSchema, ResolvedModelProfileSnapshot } from './types.js';

/** Where each of a preset's values goes in a profile's body, by the format the profile is written in. */
const PLACES: Record<'google' | 'anthropic' | 'openai-chat', Partial<Record<ModelParameter | 'maxTokens' | 'stop', readonly string[]>>> = {
  google: {
    temperature: ['generationConfig.temperature'],
    topP: ['generationConfig.topP'],
    topK: ['generationConfig.topK'],
    presencePenalty: ['generationConfig.presencePenalty'],
    frequencyPenalty: ['generationConfig.frequencyPenalty'],
    thinkingTokens: ['generationConfig.thinkingConfig.thinkingBudget'],
    reasoningEffort: ['generationConfig.thinkingConfig.thinkingLevel'],
    maxTokens: ['generationConfig.maxOutputTokens'],
    stop: ['generationConfig.stopSequences'],
  },
  anthropic: {
    temperature: ['temperature'],
    topP: ['top_p'],
    topK: ['top_k'],
    thinkingTokens: ['thinking.budget_tokens'],
    reasoningEffort: ['output_config.effort'],
    maxTokens: ['max_tokens'],
    stop: ['stop_sequences'],
  },
  'openai-chat': {
    temperature: ['temperature'],
    topP: ['top_p'],
    topK: ['top_k'],
    minP: ['min_p'],
    topA: ['top_a'],
    repetitionPenalty: ['repetition_penalty'],
    frequencyPenalty: ['frequency_penalty'],
    presencePenalty: ['presence_penalty'],
    reasoningEffort: ['reasoning_effort', 'reasoning.effort'],
    verbosity: ['verbosity'],
    maxTokens: ['max_completion_tokens', 'max_tokens'],
    stop: ['stop'],
  },
};

/** RisuAI's effort words as each format wrote them before: Gemini's levels, Claude's efforts. */
const EFFORT_WORDS: Record<string, Record<string, string | null>> = {
  google: { none: 'minimal', minimal: 'minimal', xhigh: 'high' },
  anthropic: { none: null, minimal: 'low' },
};

export interface LegacyPreset {
  /** The credential's provider (`PROVIDERS`). */
  provider: string;
  model: string;
  params: ModelParams;
}

export interface LegacyProfile {
  profileId: string;
  snapshot: ResolvedModelProfileSnapshot;
  updatedAt: number | undefined;
  format: 'google' | 'anthropic' | 'openai-chat';
  /** The profile's defaults with the preset's values over them where the profile takes them. */
  values: Record<string, unknown>;
  /** The preset's values the profile has no field for, or a field that refuses them. */
  dropped: string[];
}

/**
 * The registry profile an existing preset on an API key is: one of `catalog`'s
 * offered profiles for the key's provider that names the preset's model — a
 * catch-all whose model the owner types is not one — preferring, of a model's
 * thinking and plain variants, the one the preset asked for (thinking where it
 * set an effort or a budget), then PocketRisu's order. Its values are the
 * profile's defaults with the preset's own laid over
 * the field at the same place in the body, each held to the field's type,
 * bounds and choices; one that does not fit is `dropped`. Null where no
 * profile names the model: the preset stays a custom one.
 */
export function legacyProfile(catalog: RegistryCatalog, preset: LegacyPreset): LegacyProfile | null {
  const model = preset.model.trim().replace(/^models\//, '');
  if (!model) return null;
  // A model with a thinking variant (DeepSeek's) is the variant the preset asked for: thinking where it set an effort or a budget.
  const wantsThinking = (preset.params.reasoningEffort !== undefined && preset.params.reasoningEffort !== 'none') || (preset.params.thinkingTokens ?? 0) > 0;
  const mismatch = (defaults: Record<string, unknown>): number => {
    const thinking = (defaults['thinking'] as { type?: unknown } | undefined)?.type;
    return thinking === undefined || (thinking === 'enabled') === wantsThinking ? 0 : 1;
  };
  const candidates = profileEntries(catalog)
    .filter((entry) => entry.provider === preset.provider && entry.modelId === model)
    .map((entry) => ({ entry, offered: offeredSnapshot(catalog, entry.id)! }))
    .sort((a, b) =>
      mismatch(a.offered.snapshot.defaults) - mismatch(b.offered.snapshot.defaults)
      || ['current', 'outdated', 'deprecated'].indexOf(a.entry.status) - ['current', 'outdated', 'deprecated'].indexOf(b.entry.status)
      || (a.entry.sortOrder ?? 0) - (b.entry.sortOrder ?? 0));
  const match = candidates[0];
  if (!match) return null;
  const { snapshot, profile, base } = match.offered;
  const values = newPresetValues(snapshot);
  const dropped: string[] = [];
  const places = PLACES[base.format];
  for (const [parameter, raw] of Object.entries(preset.params) as [keyof typeof places | string, unknown][]) {
    if (raw === undefined || parameter === 'extraHeaders' || parameter === 'extraBody' || parameter === 'instructTemplate' || parameter === 'jinjaTemplate') continue;
    const paths = places[parameter as keyof typeof places];
    const field = paths ? fieldAt(snapshot.schema, paths) : undefined;
    let value = raw;
    if (parameter === 'reasoningEffort' && typeof raw === 'string') {
      const word = EFFORT_WORDS[base.format]?.[raw];
      value = word === undefined ? raw : word;
    }
    if (!field || value === null || !fits(field, value)) {
      dropped.push(parameter);
      continue;
    }
    values[field.key] = value;
    // A Claude budget is thinking turned on: `thinking.type` takes `enabled` where the profile offers it.
    if (parameter === 'thinkingTokens' && base.format === 'anthropic') {
      const type = snapshot.schema.find((entry) => entry.mapsTo?.target === 'body' && entry.mapsTo.path === 'thinking.type');
      if (type && fits(type, 'enabled')) values[type.key] = 'enabled';
    }
  }
  return { profileId: profile.id, snapshot, updatedAt: profile.updatedAt, format: base.format, values, dropped };
}

function fieldAt(schema: readonly RegistryFieldSchema[], paths: readonly string[]): RegistryFieldSchema | undefined {
  for (const path of paths) {
    const field = schema.find((entry) => editable(entry) && entry.mapsTo!.path === path);
    if (field) return field;
  }
  return undefined;
}

/** Whether a value is one the field takes: its type and bounds, and one of its choices where it lists them. */
function fits(field: RegistryFieldSchema, value: unknown): boolean {
  try {
    parseProfileValues({ [field.key]: value }, [field]);
  } catch {
    return false;
  }
  return !field.enum || field.enum.some((option) => option.value === value);
}
