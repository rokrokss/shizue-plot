'use client';

import {
  defaultTranslationMode,
  resolveTranslation,
  TRANSLATION_LANGUAGES,
  TRANSLATION_MODES,
  type ChatTranslationSettings,
  type TranslationLanguage,
  type TranslationMode,
} from '@shizue/core/translation';
import { useTranslations } from 'next-intl';
import { useId, type ReactNode } from 'react';
import { effectivePreset } from '@/lib/modelBinding';
import type { ModelBinding, ModelPreset, Persona, ReaderPreset } from '@/lib/types';
import { PersonaFace } from './Avatar';
import { ModelOptions } from './ModelOptions';
import { ReaderPresetField } from './ReaderPresets';
import { Checkbox, Select } from './ui';

/** The chat's language mode as the controls read it (§11 언어 모드). */
export interface LanguageSettingsView {
  /** What the reader picked, as stored; a key left out is decided for them. */
  settings: ChatTranslationSettings;
  /** The work's content language. */
  plotLanguage: TranslationLanguage;
  /** The language the page is read in, which an unpicked language is. */
  locale: TranslationLanguage;
  /** Whether the work's scripts read what the model writes (`recommendsTranslateMode`). */
  recommended: boolean;
}

/**
 * The choices a chat is run with: its main model preset, its auxiliary (sub)
 * one, the reader's own prompt preset in place of the built-in default, and
 * persona — labelled rows at full width, in the chat's settings sheet. A model
 * slot left open follows the default binding, which its "기본 (…)" option names.
 *
 * The caption is a `<label htmlFor>`: pointed at the control by id rather than
 * wrapping it, because wrapping would put every option's text into the
 * control's accessible name. Naming it that way makes the caption clickable,
 * which is the whole reason it is there — and it makes `aria-label` a second,
 * competing name, so the controls do without one.
 */
export function ChatSettings({
  binding,
  presets,
  defaults,
  personaId,
  personas,
  readerPresetId = null,
  readerPresets,
  onReaderPresetsChange,
  disabled,
  language,
  retrieval,
  onChange,
}: {
  /** The chat's own picks; a null slot follows the default. */
  binding: ModelBinding;
  /** The owner's model presets. */
  presets: readonly ModelPreset[];
  /** The owner's default binding, which an open slot follows. */
  defaults: ModelBinding;
  personaId: string | null;
  personas: Persona[];
  /** This chat's reader preset ("내 프리셋"); null runs the built-in default. */
  readerPresetId?: string | null;
  /** The reader's own presets. Without them the "내 프리셋" control is not drawn. */
  readerPresets?: ReaderPreset[];
  onReaderPresetsChange?: (presets: ReaderPreset[]) => void;
  disabled: boolean;
  /** The language mode's controls; none until the plot read says what language the work is in. */
  language?: LanguageSettingsView;
  /** Whether the chat brings back its earlier messages by meaning; without it, no control. */
  retrieval?: boolean;
  onChange: (patch: {
    /** The slots the pick sets; null hands one back to the default. */
    modelBinding?: Partial<ModelBinding>;
    readerPresetId?: string | null;
    personaId?: string | null;
    translation?: ChatTranslationSettings;
    retrieval?: { enabled: boolean };
  }) => void;
}) {
  const t = useTranslations('chat');
  const locales = useTranslations('locales');
  const locked = disabled ? t('lockedWhileGenerating') : undefined;
  const id = useId();
  // What an open slot runs on, named once the lists are in: the default's main,
  // and for the sub the default's sub — or the main where that is open too.
  const defaultMain = effectivePreset(presets, { ...binding, main: null }, defaults, 'main');
  const defaultSub = effectivePreset(presets, { ...binding, sub: null }, defaults, 'sub');

  /** The select's id, which its caption names it by. */
  const nameOf = (key: string) => ({ id: `${id}-${key}` });

  /** A captioned control, with its hint under it. */
  const field = (key: string, label: string, control: ReactNode, hint?: string): ReactNode => (
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
  );

  return (
    <div className="space-y-4">
      {field(
        'model',
        t('model'),
        <Select
          value={binding.main ?? ''}
          disabled={disabled}
          {...(locked ? { title: locked } : {})}
          {...nameOf('model')}
          onChange={(event) => onChange({ modelBinding: { main: event.target.value || null } })}
        >
          <ModelOptions
            presets={presets}
            value={binding.main}
            defaultLabel={defaultMain ? t('modelDefaultIs', { model: defaultMain.name }) : t('modelDefault')}
          />
        </Select>,
      )}
      {/* Next to the model it spares: the side work runs here instead. */}
      {field(
        'subModel',
        t('subModel'),
        <Select
          value={binding.sub ?? ''}
          disabled={disabled}
          title={locked ?? t('subModelHint')}
          {...nameOf('subModel')}
          onChange={(event) => onChange({ modelBinding: { sub: event.target.value || null } })}
        >
          <ModelOptions
            presets={presets}
            value={binding.sub}
            defaultLabel={defaultSub ? t('subModelDefaultIs', { model: defaultSub.name }) : t('subModelDefault')}
          />
        </Select>,
        t('subModelHint'),
      )}
      {/* The reader's own preset, which replaces the built-in default. */}
      {readerPresets && onReaderPresetsChange ? (
        <ReaderPresetField
          presets={readerPresets}
          selectedId={readerPresetId}
          disabled={disabled}
          onSelect={(id) => onChange({ readerPresetId: id })}
          onPresetsChange={onReaderPresetsChange}
        />
      ) : null}
      {field(
        'persona',
        t('persona'),
        <PersonaFace persona={personas.find((persona) => persona.id === personaId)}>
          <Select
            value={personaId ?? ''}
            disabled={disabled}
            {...(locked ? { title: locked } : {})}
            {...nameOf('persona')}
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
      {language ? languageFields(language) : null}
      {/* SillyTavern's chat vectorization, off as there. */}
      {retrieval !== undefined ? (
        <div className="space-y-1.5">
          <Checkbox
            label={t('retrieval')}
            checked={retrieval}
            disabled={disabled}
            onChange={(enabled) => onChange({ retrieval: { enabled } })}
          />
          <p className="text-xs text-muted">{t('retrievalHint')}</p>
        </div>
      ) : null}
    </div>
  );

  /**
   * The language mode: what the reader reads the work in. Decided for them until
   * they pick — the work's own language reads as written, another one is
   * answered in theirs — and a card whose scripts read the model's words is
   * recommended the translation mode, quietly, never switched to it.
   */
  function languageFields({ settings, plotLanguage, locale, recommended }: LanguageSettingsView): ReactNode {
    const resolved = resolveTranslation(settings, plotLanguage, locale);
    const reader = settings.language ?? locale;
    const same = reader === plotLanguage;
    // A work in the reader's own language has nothing to choose between: the
    // controls stay out of the way until the page is read in another language —
    // or the reader picked something here, which they can take back.
    if (same && settings.mode === undefined && settings.language === undefined) return null;
    const save = (change: ChatTranslationSettings) => {
      const next: ChatTranslationSettings = { ...settings, ...change };
      for (const key of Object.keys(next) as (keyof ChatTranslationSettings)[]) {
        if (next[key] === undefined) delete next[key];
      }
      onChange({ translation: next });
    };
    const recommend = recommended && !same && resolved.mode !== 'translate';
    const modeName = (mode: TranslationMode) => t(`languageModes.${mode}`);
    const hint = same
      ? t('languageSame', { language: locales(plotLanguage) })
      : t(`languageModeHints.${resolved.mode}`, { language: locales(reader), work: locales(plotLanguage) });
    return (
      <>
        {field(
          'languageMode',
          t('languageMode'),
          <Select
            value={settings.mode ?? ''}
            disabled={disabled}
            title={locked ?? (recommend ? t('translateRecommended') : hint)}
            data-recommended={recommend || undefined}
            {...nameOf('languageMode')}
            onChange={(event) => save({ mode: (event.target.value || undefined) as TranslationMode | undefined })}
          >
            <option value="">{t('languageModeAuto', { mode: modeName(defaultTranslationMode(plotLanguage, reader)) })}</option>
            {TRANSLATION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {modeName(mode)}
              </option>
            ))}
          </Select>,
          hint,
        )}
        {recommend ? (
          <p data-testid="translate-recommended" className="-mt-2 text-xs text-link">
            {t('translateRecommended')}
          </p>
        ) : null}
        {field(
          'readerLanguage',
          t('readerLanguage'),
          <Select
            value={settings.language ?? ''}
            disabled={disabled}
            {...(locked ? { title: locked } : {})}
            {...nameOf('readerLanguage')}
            onChange={(event) =>
              save({ language: (event.target.value || undefined) as TranslationLanguage | undefined })
            }
          >
            <option value="">{t('readerLanguageAuto', { language: locales(locale) })}</option>
            {TRANSLATION_LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {locales(code)}
              </option>
            ))}
          </Select>,
        )}
        {resolved.mode === 'translate' ? (
          <div className="space-y-1.5">
            <Checkbox
              label={t('translateInput', { work: locales(plotLanguage) })}
              checked={settings.input === true}
              disabled={disabled}
              onChange={(input) => save({ input: input || undefined })}
            />
            <p className="text-xs text-muted">{t('translateInputHint')}</p>
          </div>
        ) : null}
      </>
    );
  }
}
