import type { ModelInfo } from '@/lib/types';

/**
 * The models a chat may run on, as a select's options — the one list the
 * settings' model control (`ChatSettings`) and the header's pill (`ModelPill`)
 * both offer.
 */
export function ModelOptions({ model, models }: { model: string; models: ModelInfo[] }) {
  return (
    <>
      {/* Keep a historical model visible until the reader selects an available ChatGPT model. */}
      {models.some((entry) => entry.id === model) ? null : <option value={model}>{model}</option>}
      {models.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.label}
        </option>
      ))}
    </>
  );
}
