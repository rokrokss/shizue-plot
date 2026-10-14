'use client';

import { useTranslations } from 'next-intl';
import { useId, type ReactNode } from 'react';
import type { ModelInfo, Persona, PresetInfo } from '@/lib/types';
import { PersonaFace } from './Avatar';
import { ModelOptions } from './ModelOptions';
import { Select } from './ui';

/** Effort words the catalogues translate; any other word a model advertises is shown as it is. */
const KNOWN_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

/**
 * The choices a chat is run with: model, reasoning effort where the model offers
 * one, auxiliary model, preset and persona. The same controls stand in the
 * header on a wide screen and in the settings sheet on a narrow one, so they
 * live here rather than being written twice — `stacked` is the whole
 * difference: labelled rows at full width, or one compact row.
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
  subModel,
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
  /** The auxiliary model the reader picked; null runs the side work on the first model. */
  subModel: string | null;
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
    subModel?: string | null;
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
  // What the server falls back to when the reader picked none: the first model
  // the catalog lists. Named once the list is in, so the reader sees what it is.
  const firstModel = models[0];

  /** Where a select's accessible name comes from in each layout. */
  const nameOf = (key: string, label: string) =>
    stacked ? { id: `${id}-${key}` } : { 'aria-label': label };

  /** A hint shows under the control where there is room for it, and only there. */
  const field = (key: string, label: string, control: ReactNode, hint?: string): ReactNode =>
    stacked ? (
      <div className="space-y-1.5">
        <label
          htmlFor={`${id}-${key}`}
          className="block text-xs font-medium text-muted"
        >
          {label}
        </label>
        {control}
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
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
          <ModelOptions model={model} models={models} />
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
      {/* Next to the model it spares: the side work runs here instead. The compact
          row has no room for the hint, so there it is the control's title, as the
          preset's is. */}
      {field(
        'subModel',
        t('subModel'),
        <Select
          value={subModel ?? ''}
          disabled={disabled}
          title={locked ?? t('subModelHint')}
          {...nameOf('subModel', t('subModel'))}
          className={selectClass}
          onChange={(event) => onChange({ subModel: event.target.value || null })}
        >
          <option value="">
            {firstModel ? t('subModelDefaultIs', { model: firstModel.label }) : t('subModelDefault')}
          </option>
          {/* A pick the catalog has since dropped stays visible, as a historical model does;
              the server runs the side work on the default meanwhile. */}
          {subModel && !models.some((entry) => entry.id === subModel) ? (
            <option value={subModel}>{subModel}</option>
          ) : null}
          {models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </Select>,
        t('subModelHint'),
      )}
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
        <PersonaFace persona={personas.find((persona) => persona.id === personaId)} compact={!stacked}>
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
          </Select>
        </PersonaFace>,
      )}
    </div>
  );
}
