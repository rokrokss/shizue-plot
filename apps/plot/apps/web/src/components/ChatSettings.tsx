'use client';

import { useTranslations } from 'next-intl';
import { useId, type ReactNode } from 'react';
import type { ModelInfo, Persona, PresetInfo } from '@/lib/types';
import { Select } from './ui';

/** Effort words the catalogues translate; any other word a model advertises is shown as it is. */
const KNOWN_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

/**
 * The choices a chat is run with: model, reasoning effort where the model offers
 * one, preset and persona. The same controls stand in the header on a wide
 * screen and in the settings sheet on a narrow one, so they live here
 * rather than being written twice — `stacked` is the whole difference: labelled
 * rows at full width, or one compact row.
 *
 * The stacked caption is a `<label htmlFor>`: pointed at the control by id
 * rather than wrapping it, because wrapping would put every option's text into
 * the control's accessible name. Naming it that way makes the caption clickable,
 * which is the whole reason it is there — and it makes `aria-label` a second,
 * competing name, so the stacked layout does without one. The compact row has no
 * visible caption at all, so there the `aria-label` is the only name and stays.
 */
export function ChatSettings({
  model,
  reasoningEffort,
  preset,
  personaId,
  models,
  presets,
  personas,
  disabled,
  stacked,
  onChange,
}: {
  model: string;
  reasoningEffort: string | null;
  preset: string;
  personaId: string | null;
  models: ModelInfo[];
  presets: PresetInfo[];
  personas: Persona[];
  disabled: boolean;
  stacked?: boolean;
  onChange: (patch: {
    model?: string;
    reasoningEffort?: string | null;
    preset?: string;
    personaId?: string | null;
  }) => void;
}) {
  const t = useTranslations('chat');
  const locked = disabled ? t('lockedWhileGenerating') : undefined;
  const selectClass = stacked ? undefined : 'h-8 w-auto py-0 text-xs';
  const id = useId();
  // Only a model that advertises efforts gets the control; the server clears a
  // chosen effort when the model is switched to one that does not offer it.
  const current = models.find((entry) => entry.id === model);
  const efforts = current?.reasoningEfforts ?? [];
  const effortLabel = (effort: string): string =>
    KNOWN_EFFORTS.has(effort) ? t(`reasoningEfforts.${effort}`) : effort;

  /** Where a select's accessible name comes from in each layout. */
  const nameOf = (key: string, label: string) =>
    stacked ? { id: `${id}-${key}` } : { 'aria-label': label };

  const field = (key: string, label: string, control: ReactNode): ReactNode =>
    stacked ? (
      <div className="space-y-1.5">
        <label
          htmlFor={`${id}-${key}`}
          className="block text-xs font-medium tracking-wide text-muted uppercase"
        >
          {label}
        </label>
        {control}
      </div>
    ) : (
      control
    );

  return (
    <div className={stacked ? 'space-y-4' : 'flex items-center gap-2'}>
      {field(
        'model',
        t('model'),
        <Select
          value={model}
          disabled={disabled}
          {...(locked ? { title: locked } : {})}
          {...nameOf('model', t('model'))}
          className={selectClass}
          onChange={(event) => onChange({ model: event.target.value })}
        >
          {/* Keep a historical model visible until the reader selects an available ChatGPT model. */}
          {models.some((entry) => entry.id === model) ? null : <option value={model}>{model}</option>}
          {models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </Select>,
      )}
      {efforts.length > 0
        ? field(
            'effort',
            t('reasoningEffort'),
            <Select
              value={reasoningEffort ?? ''}
              disabled={disabled}
              {...(locked ? { title: locked } : {})}
              {...nameOf('effort', t('reasoningEffort'))}
              className={selectClass}
              onChange={(event) => onChange({ reasoningEffort: event.target.value || null })}
            >
              <option value="">
                {current?.defaultReasoningEffort
                  ? t('reasoningEffortDefaultIs', { effort: effortLabel(current.defaultReasoningEffort) })
                  : t('reasoningEffortDefault')}
              </option>
              {/* An effort the catalog has since dropped stays visible, as a historical model does. */}
              {reasoningEffort && !efforts.includes(reasoningEffort) ? (
                <option value={reasoningEffort}>{effortLabel(reasoningEffort)}</option>
              ) : null}
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effortLabel(effort)}
                </option>
              ))}
            </Select>,
          )
        : null}
      {field(
        'preset',
        t('preset'),
        <Select
          value={preset}
          disabled={disabled}
          title={locked ?? t(`presetHints.${preset}`)}
          {...nameOf('preset', t('preset'))}
          className={selectClass}
          onChange={(event) => onChange({ preset: event.target.value })}
        >
          {/* Keeps the current preset selected while the catalogue is loading. */}
          {presets.some((entry) => entry.id === preset) ? null : (
            <option value={preset}>{t(`presets.${preset}`)}</option>
          )}
          {presets.map((entry) => (
            <option key={entry.id} value={entry.id} title={t(`presetHints.${entry.id}`)}>
              {t(`presets.${entry.id}`)}
            </option>
          ))}
        </Select>,
      )}
      {field(
        'persona',
        t('persona'),
        <Select
          value={personaId ?? ''}
          disabled={disabled}
          {...(locked ? { title: locked } : {})}
          {...nameOf('persona', t('persona'))}
          className={selectClass}
          onChange={(event) => onChange({ personaId: event.target.value || null })}
        >
          <option value="">{t('noPersona')}</option>
          {personas.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name}
            </option>
          ))}
        </Select>,
      )}
    </div>
  );
}
