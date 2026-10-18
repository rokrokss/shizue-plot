import type { ModelPreset } from '@/lib/types';

/**
 * A model slot's choices as a select's options — the one list the settings'
 * main and sub controls (`ChatSettings`), the header's pill (`ModelPill`), the
 * start panel and the default binding all offer: the slot left to the default
 * (`''`, named by `defaultLabel`), then the owner's model presets.
 */
export function ModelOptions({
  presets,
  value,
  defaultLabel,
}: {
  presets: readonly ModelPreset[];
  /** The slot's pick; null is the default. */
  value: string | null;
  defaultLabel: string;
}) {
  return (
    <>
      <option value="">{defaultLabel}</option>
      {/* A pick the list does not have yet stays visible until the list is in. */}
      {value && !presets.some((preset) => preset.id === value) ? <option value={value}>{value}</option> : null}
      {presets.map((preset) => (
        <option key={preset.id} value={preset.id}>
          {preset.name}
        </option>
      ))}
    </>
  );
}
