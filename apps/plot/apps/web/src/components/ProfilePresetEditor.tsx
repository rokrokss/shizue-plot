'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';
import { ApiError, apiSend } from '@/lib/api';
import type { Credential, ModelCapabilities, ModelPreset, ProfileField, ProfileUiField } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { localized } from './ModelProfileBrowser';
import { Badge, Button, Checkbox, ErrorText, Field, Select, TextArea, TextInput } from './ui';

/** What an input holds for a field: the words typed, or a toggle's state. */
type Raw = string | boolean;

/** The fields a preset sets: those that go into the request's body — never the key, an address or a header. */
const editable = (field: ProfileField): boolean => field.mapsTo?.target === 'body' && field.secret !== true;

/** A value as its input shows it: lines for a list, JSON for an object, the words of the rest. */
function rawOf(field: ProfileField, value: unknown): Raw {
  if (value === undefined || value === null) return field.type === 'boolean' ? field.default === true : '';
  if (field.type === 'boolean') return value === true;
  if (field.type === 'stringArray') return Array.isArray(value) ? value.join('\n') : '';
  if (field.type === 'json' || field.type === 'keyValue') return JSON.stringify(value, null, 2);
  return String(value);
}

/** What a field's input means, or `undefined` to send nothing (the field's default applies); throws a field's own words. */
function valueOf(field: ProfileField, raw: Raw): unknown {
  if (field.type === 'boolean') return raw === true;
  const text = typeof raw === 'string' ? raw : '';
  if (field.type === 'stringArray') {
    const lines = text.split('\n').filter((line) => line.length > 0);
    return lines.length > 0 ? lines : undefined;
  }
  if (!text.trim()) return undefined;
  if (field.type === 'number' || field.type === 'integer') {
    const number = Number(text.trim());
    if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) throw new RangeError(field.label);
    return number;
  }
  if (field.type === 'json' || field.type === 'keyValue') {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SyntaxError(field.label);
    }
  }
  // An enum's own value keeps its type (a number or a flag in a select).
  const option = field.enum?.find((entry) => String(entry.value) === text);
  return option ? option.value : text;
}

/** PocketRisu's `showIf`: a field shown only while another holds (or does not hold) a value. */
function shown(ui: ProfileUiField, values: Record<string, unknown>, fields: Map<string, ProfileField>): boolean {
  if (!ui.showIf) return true;
  const other = fields.get(ui.showIf.key);
  const value = values[ui.showIf.key] ?? other?.default;
  if (ui.showIf.equals !== undefined) return value === ui.showIf.equals;
  if (ui.showIf.notEquals !== undefined) return value !== ui.showIf.notEquals;
  return true;
}

/**
 * The editor of a preset made from a registry profile (Settings › Models):
 * PocketRisu's — the profile it holds, with its "update available" and
 * "change profile", the key of the profile's provider, and the profile's own
 * fields in its groups (the basic ones first, the advanced behind a button),
 * each drawn as the profile asks: a model combobox with the profile's models,
 * selects of its choices, numbers within its bounds. Then the pictures and turn
 * flags where they apply, and the additional headers and body.
 */
export function ProfilePresetEditor({
  preset,
  credentials,
  onSaved,
  onCancel,
  onReplace,
}: {
  preset: ModelPreset;
  credentials: readonly Credential[];
  onSaved: (saved: ModelPreset, close: boolean) => void;
  onCancel: () => void;
  /** Opens the profile browser to put another profile in this one's place. */
  onReplace: () => void;
}) {
  const t = useTranslations('models');
  const locale = useLocale();
  const toMessage = useErrorMessage();
  const id = useId();
  const snapshot = preset.profileSnapshot!;
  const schema = snapshot.schema.filter(editable);
  const fields = new Map(schema.map((field) => [field.key, field]));
  const [name, setName] = useState(preset.name);
  const [credentialId, setCredentialId] = useState(preset.credentialId ?? '');
  const [raws, setRaws] = useState<Record<string, Raw>>(() =>
    Object.fromEntries(schema.map((field) => [field.key, rawOf(field, (preset.userValues ?? {})[field.key])])));
  const [capabilities, setCapabilities] = useState<ModelCapabilities>(preset.capabilities);
  const [extraHeaders, setExtraHeaders] = useState(preset.params.extraHeaders ? JSON.stringify(preset.params.extraHeaders, null, 2) : '');
  const [extraBody, setExtraBody] = useState(preset.params.extraBody ? JSON.stringify(preset.params.extraBody, null, 2) : '');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const usable = credentials.filter((credential) => credential.kind === 'api_key' && credential.provider === preset.profileProvider);
  const readsPictures = (snapshot.capabilities ?? []).includes('vision');
  const date = (ms: number | undefined): string => (ms ? new Date(ms).toLocaleDateString(locale) : '');
  const profileName = preset.profile ? localized(preset.profile.displayName, preset.profile.displayNameI18n, locale) : snapshot.profileId;

  /** The values as typed so far, for `showIf` — what does not parse yet counts as unset. */
  const current: Record<string, unknown> = {};
  for (const field of schema) {
    try {
      const value = valueOf(field, raws[field.key] ?? '');
      if (value !== undefined) current[field.key] = value;
    } catch {
      /* still being typed */
    }
  }

  const groups = [...snapshot.uiSchema.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const uiFields = snapshot.uiSchema.fields
    .filter((ui) => ui.visibility !== 'hidden' && fields.has(ui.key))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const ungrouped = uiFields.filter((ui) => !groups.some((group) => group.id === ui.group));

  function payload(): Record<string, unknown> | string {
    const userValues: Record<string, unknown> = {};
    for (const field of schema) {
      try {
        const value = valueOf(field, raws[field.key] ?? '');
        if (value !== undefined) userValues[field.key] = value;
      } catch (caught) {
        return caught instanceof SyntaxError ? t('invalidJson', { field: field.label }) : t('invalidNumber', { field: field.label });
      }
    }
    const params: Record<string, unknown> = {};
    for (const [key, text, label] of [['extraHeaders', extraHeaders, t('extraHeaders')], ['extraBody', extraBody, t('extraBody')]] as const) {
      if (!text.trim()) continue;
      try {
        const value: unknown = JSON.parse(text);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return t('invalidJson', { field: label });
        params[key] = value;
      } catch {
        return t('invalidJson', { field: label });
      }
    }
    return { name: name.trim(), credentialId: credentialId || null, userValues, params, capabilities };
  }

  async function save(): Promise<void> {
    const body = payload();
    if (typeof body === 'string') {
      setError(body);
      return;
    }
    setBusy(true);
    setError('');
    try {
      onSaved(await apiSend<ModelPreset>('PATCH', `/api/model-presets/${preset.id}`, body), true);
    } catch (caught) {
      setError(toMessage(caught));
      setBusy(false);
    }
  }

  /** PocketRisu's one-click update: the same profile taken again from the registry, the values carried over. */
  async function update(): Promise<void> {
    if (!window.confirm(t('profileUpdateConfirm'))) return;
    setBusy(true);
    setError('');
    try {
      onSaved(await apiSend<ModelPreset>('PATCH', `/api/model-presets/${preset.id}`, { profileId: preset.sourceProfile!.profileId }), false);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiSend<{ ok: true; text: string; ms: number } | { ok: false; code: string }>(
        'POST', `/api/model-presets/${preset.id}/test`, undefined, AbortSignal.timeout(180_000),
      );
      if (result.ok) setNotice(t('testOk', { text: result.text.trim() || '—', ms: result.ms }));
      else setError(t('checkFailed', { reason: toMessage(new ApiError(0, result.code, '')) }));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const control = (field: ProfileField, ui: ProfileUiField): ReactNode => {
    const inputId = `${id}-${field.key}`;
    const raw = raws[field.key] ?? '';
    const set = (next: Raw): void => setRaws((all) => ({ ...all, [field.key]: next }));
    const placeholder = ui.placeholder ?? (field.default !== undefined && field.type !== 'boolean' ? String(rawOf(field, field.default)) : undefined);
    switch (ui.widget) {
      case 'toggle':
        return <Checkbox label={field.label} checked={raw === true} onChange={set} />;
      case 'select':
      case 'segmented':
        return (
          <Select id={inputId} value={String(raw)} onChange={(event) => set(event.target.value)}>
            <option value="">
              {field.default !== undefined ? t('fieldDefaultIs', { value: field.enum?.find((option) => option.value === field.default)?.label ?? String(field.default) }) : t('effortDefault')}
            </option>
            {(field.enum ?? []).map((option) => (
              <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
            ))}
          </Select>
        );
      case 'combobox':
        return (
          <>
            <TextInput id={inputId} list={`${inputId}-options`} value={String(raw)} placeholder={placeholder} maxLength={200} onChange={(event) => set(event.target.value)} />
            <datalist id={`${inputId}-options`}>
              {(field.enum ?? []).map((option) => (
                <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
              ))}
            </datalist>
          </>
        );
      case 'string-array':
      case 'json':
      case 'key-value':
      case 'textarea':
        return <TextArea id={inputId} rows={field.type === 'json' || field.type === 'keyValue' ? 3 : 2} spellCheck={false} value={String(raw)} placeholder={placeholder} onChange={(event) => set(event.target.value)} />;
      default:
        return field.type === 'number' || field.type === 'integer' ? (
          <TextInput
            id={inputId}
            type="number"
            inputMode="decimal"
            {...(field.min !== undefined ? { min: field.min } : {})}
            {...(field.max !== undefined ? { max: field.max } : {})}
            step={field.step ?? (field.type === 'integer' ? 1 : 'any')}
            value={String(raw)}
            placeholder={placeholder}
            onChange={(event) => set(event.target.value)}
          />
        ) : (
          <TextInput id={inputId} value={String(raw)} placeholder={placeholder} onChange={(event) => set(event.target.value)} />
        );
    }
  };

  const fieldBlock = (ui: ProfileUiField): ReactNode => {
    const field = fields.get(ui.key)!;
    if ((ui.visibility === 'advanced' && !advanced) || !shown(ui, current, fields)) return null;
    const description = localized(field.description, field.descriptionI18n, locale) || ui.help;
    const range = field.min !== undefined || field.max !== undefined ? t('fieldRange', { min: field.min ?? '−∞', max: field.max ?? '∞' }) : '';
    const hint = [description, range].filter(Boolean).join(' · ');
    return (
      <div key={ui.key} data-testid="profile-field" data-field={ui.key} className="space-y-1.5">
        {ui.widget === 'toggle' ? null : <label htmlFor={`${id}-${ui.key}`} className="block text-xs font-medium text-muted">{field.label}</label>}
        {control(field, ui)}
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
    );
  };

  return (
    <div data-testid="profile-preset-editor" className="space-y-4 rounded-xl border border-line bg-raised/40 p-4">
      <Field label={t('presetName')}>
        <TextInput value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
      </Field>

      <div className="space-y-1.5 rounded-xl border border-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{profileName}</span>
          {preset.profile && preset.profile.status !== 'current' ? <Badge>{t(`profileStatus.${preset.profile.status}`)}</Badge> : null}
          {preset.profileUpdate === 'missing' ? <Badge>{t('profileMissing')}</Badge> : null}
          {preset.profileUpdate === 'updatable' ? (
            <Button size="sm" disabled={busy} onClick={() => void update()}>{t('profileUpdateAvailable')}</Button>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted">{snapshot.profileId}</p>
        {preset.profile?.statusReason ? <p className="text-xs text-muted">{preset.profile.statusReason}</p> : null}
        {preset.profile?.description ? <p className="text-xs text-muted">{localized(preset.profile.description, preset.profile.descriptionI18n, locale)}</p> : null}
        <p className="text-xs text-muted">
          {[
            preset.profile?.baseLabel,
            t('profileModel', { model: preset.model }),
            snapshot.limits?.contextWindowTokens ? t('profileContext', { tokens: snapshot.limits.contextWindowTokens }) : '',
            preset.sourceProfile?.profileUpdatedAt ? t('profileTaken', { date: date(preset.sourceProfile.profileUpdatedAt) }) : '',
          ].filter(Boolean).join(' · ')}
        </p>
        {snapshot.capabilities?.length ? (
          <div className="flex flex-wrap gap-1">
            {snapshot.capabilities.map((capability) => <Badge key={capability}>{t.has(`capabilityNames.${capability}`) ? t(`capabilityNames.${capability}`) : capability}</Badge>)}
          </div>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onReplace}>{t('profileReplace')}</Button>
      </div>

      <Field label={t('credential')}>
        <Select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
          <option value="">{t('noKeyYet')}</option>
          {usable.map((credential) => (
            <option key={credential.id} value={credential.id}>{`${credential.label}${credential.hint ? ` · ${credential.hint}` : ''}`}</option>
          ))}
        </Select>
      </Field>

      <fieldset className="space-y-4" disabled={busy}>
        <legend className="text-xs font-medium text-muted">{t('parameters')}</legend>
        <p className="text-xs text-muted">{t('profileFieldsHint')}</p>
        {groups.map((group) => {
          const blocks = uiFields.filter((ui) => ui.group === group.id).map(fieldBlock).filter(Boolean);
          if (blocks.length === 0) return null;
          return (
            <div key={group.id} className="space-y-3">
              <h5 className="text-xs font-semibold">{localized(group.label, group.labelI18n, locale)}</h5>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{blocks}</div>
            </div>
          );
        })}
        {ungrouped.length > 0 ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{ungrouped.map(fieldBlock)}</div> : null}
      </fieldset>

      <Button size="sm" variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced((open) => !open)}>{t('advanced')}</Button>
      {advanced ? (
        <div className="space-y-3">
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted">{t('capabilities')}</legend>
            {readsPictures ? (
              <p className="text-xs text-muted">{t('profileReadsPictures')}</p>
            ) : (
              <Checkbox label={t('profileSendPictures')} checked={capabilities.vision === true} onChange={(vision) => setCapabilities({ ...capabilities, vision })} />
            )}
            {preset.format === 'openai-chat' ? (
              <>
                <Field label={t('systemPrompt')}>
                  <Select value={capabilities.systemPrompt ?? 'full'} onChange={(event) => setCapabilities({ ...capabilities, systemPrompt: event.target.value as ModelCapabilities['systemPrompt'] })}>
                    {(['full', 'first', 'none'] as const).map((mode) => (
                      <option key={mode} value={mode}>{t(`systemPrompts.${mode}`)}</option>
                    ))}
                  </Select>
                </Field>
                <Checkbox label={t('alternateRoles')} checked={capabilities.alternateRoles === true} onChange={(alternateRoles) => setCapabilities({ ...capabilities, alternateRoles })} />
                <Checkbox label={t('startWithUser')} checked={capabilities.startWithUser === true} onChange={(startWithUser) => setCapabilities({ ...capabilities, startWithUser })} />
              </>
            ) : null}
          </fieldset>
          <Field label={t('extraHeaders')} hint={t('extraHint')}>
            <TextArea rows={2} spellCheck={false} value={extraHeaders} placeholder='{"X-Example": "1"}' onChange={(event) => setExtraHeaders(event.target.value)} />
          </Field>
          <Field label={t('extraBody')}>
            <TextArea rows={2} spellCheck={false} value={extraBody} placeholder='{"seed": 1}' onChange={(event) => setExtraBody(event.target.value)} />
          </Field>
        </div>
      ) : null}

      <ErrorText>{error}</ErrorText>
      {notice ? <p role="status" className="text-sm text-muted">{notice}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" busy={busy} onClick={() => void test()}>{t('testPreset')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
        <Button size="sm" variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()}>{t('save')}</Button>
      </div>
    </div>
  );
}
