'use client';

import { useTranslations } from 'next-intl';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { ApiError, apiGet, apiSend } from '@/lib/api';
import type { Credential, ModelCapabilities, ModelFormats, ModelInfo, ModelParameter, ModelParams, ModelPreset } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Button, Checkbox, ErrorText, Field, Select, TextArea, TextInput } from './ui';

/** The values the editor writes as numbers, with the step their input moves by. */
const NUMBER_STEPS: Partial<Record<ModelParameter, string>> = {
  temperature: '0.05',
  topP: '0.01',
  topK: '1',
  minP: '0.01',
  topA: '0.01',
  repetitionPenalty: '0.01',
  frequencyPenalty: '0.05',
  presencePenalty: '0.05',
  thinkingTokens: '256',
};

type Draft = {
  name: string;
  format: string;
  credentialId: string;
  endpoint: string;
  model: string;
  /** Every value as its input holds it; empty is not sent. */
  values: Partial<Record<ModelParameter, string>>;
  maxTokens: string;
  stop: string;
  extraHeaders: string;
  extraBody: string;
  capabilities: ModelCapabilities;
};

const draftOf = (preset: ModelPreset | undefined, formats: ModelFormats): Draft => ({
  name: preset?.name ?? '',
  format: preset?.format ?? formats.formats[0]?.id ?? 'openai-chat',
  credentialId: preset?.credentialId ?? '',
  endpoint: preset?.endpoint ?? '',
  model: preset?.model ?? '',
  values: Object.fromEntries(
    Object.entries(preset?.params ?? {})
      .filter(([key]) => key in NUMBER_STEPS || key === 'reasoningEffort' || key === 'verbosity')
      .map(([key, value]) => [key, String(value)]),
  ),
  maxTokens: preset?.params.maxTokens !== undefined ? String(preset.params.maxTokens) : '',
  stop: (preset?.params.stop ?? []).join('\n'),
  extraHeaders: preset?.params.extraHeaders ? JSON.stringify(preset.params.extraHeaders, null, 2) : '',
  extraBody: preset?.params.extraBody ? JSON.stringify(preset.params.extraBody, null, 2) : '',
  capabilities: preset?.capabilities ?? {},
});

/**
 * The model preset editor (Settings › Models): PocketRisu's — a request format,
 * the key it goes with (or a keyless server's address), the model picked from
 * the provider's list or typed, and only the values the format sends. A preset
 * on the ChatGPT connection takes only the effort its catalog offers.
 */
export function ModelPresetEditor({
  preset,
  formats,
  credentials,
  onSaved,
  onCancel,
}: {
  /** The preset being edited; absent makes a new one. */
  preset?: ModelPreset;
  formats: ModelFormats;
  credentials: readonly Credential[];
  onSaved: (saved: ModelPreset) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('models');
  const toMessage = useErrorMessage();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(preset, formats));
  const [listed, setListed] = useState<ModelInfo[] | null>(null);
  const [listing, setListing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const set = (change: Partial<Draft>): void => setDraft((current) => ({ ...current, ...change }));

  const format = formats.formats.find((entry) => entry.id === draft.format) ?? formats.formats[0]!;
  /** The keys this format can go with: a key of a provider that speaks it, and the ChatGPT connection where it takes one. */
  const usable = credentials.filter((credential) =>
    credential.kind === 'chatgpt'
      ? Boolean(format.chatgptParameters)
      : formats.providers.find((provider) => provider.id === credential.provider)?.formats.includes(format.id),
  );
  const credential = usable.find((entry) => entry.id === draft.credentialId);
  const onPlan = credential?.kind === 'chatgpt';
  const parameters = onPlan ? format.chatgptParameters ?? [] : format.parameters;
  const keyAddress = credential && !onPlan
    ? credential.baseUrl ?? formats.providers.find((provider) => provider.id === credential.provider)?.baseUrl ?? ''
    : '';
  const listedModel = listed?.find((entry) => entry.id === draft.model);
  /** A ChatGPT model's own efforts where the list says them; RisuAI's words otherwise. */
  const efforts = listedModel?.reasoningEfforts ?? formats.reasoningEfforts;
  const formatLabel = (formatId: string): string => (t.has(`formats.${formatId}`) ? t(`formats.${formatId}`) : formatId);
  const effortLabel = (effort: string): string => (t.has(`efforts.${effort}`) ? t(`efforts.${effort}`) : effort);
  const providerLabel = (credentialEntry: Credential): string =>
    credentialEntry.kind === 'chatgpt'
      ? t('chatgptCredential')
      : `${credentialEntry.label}${credentialEntry.hint ? ` · ${credentialEntry.hint}` : ''}`;

  const query = useMemo(() => {
    const params = new URLSearchParams({ format: draft.format });
    if (draft.credentialId) params.set('credentialId', draft.credentialId);
    else if (draft.endpoint.trim()) params.set('endpoint', draft.endpoint.trim());
    return params.toString();
  }, [draft.format, draft.credentialId, draft.endpoint]);

  async function loadModels(): Promise<void> {
    setListing(true);
    setError('');
    setNotice('');
    try {
      const models = await apiGet<ModelInfo[]>(`/api/model-presets/catalog?${query}`, AbortSignal.timeout(30_000));
      setListed(models);
      setNotice(t('modelsFound', { count: models.length }));
      if (!draft.model && models[0]) set({ model: models[0].id });
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setListing(false);
    }
  }

  /** The values as the API takes them, or a message for the first one that is not. */
  function paramsOf(): ModelParams | string {
    const params: ModelParams = {};
    for (const parameter of parameters) {
      const raw = draft.values[parameter]?.trim();
      if (!raw) continue;
      if (parameter === 'reasoningEffort' || parameter === 'verbosity') params[parameter] = raw;
      else params[parameter] = Number(raw);
    }
    if (!onPlan && draft.maxTokens.trim()) params.maxTokens = Number(draft.maxTokens.trim());
    const stop = draft.stop.split('\n').filter((line) => line.length > 0);
    if (stop.length > 0) params.stop = stop;
    if (!onPlan) {
      for (const [field, key] of [['extraHeaders', t('extraHeaders')], ['extraBody', t('extraBody')]] as const) {
        const text = draft[field].trim();
        if (!text) continue;
        try {
          const value: unknown = JSON.parse(text);
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return t('invalidJson', { field: key });
          (params as Record<string, unknown>)[field] = value;
        } catch {
          return t('invalidJson', { field: key });
        }
      }
    }
    return params;
  }

  async function save(): Promise<void> {
    const params = paramsOf();
    if (typeof params === 'string') {
      setError(params);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = {
        name: draft.name.trim(),
        format: draft.format,
        credentialId: draft.credentialId || null,
        endpoint: draft.credentialId ? null : draft.endpoint.trim() || null,
        model: draft.model.trim(),
        params,
        capabilities: onPlan ? {} : draft.capabilities,
      };
      onSaved(preset
        ? await apiSend<ModelPreset>('PATCH', `/api/model-presets/${preset.id}`, body)
        : await apiSend<ModelPreset>('POST', '/api/model-presets', body));
    } catch (caught) {
      setError(toMessage(caught));
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    if (!preset) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiSend<{ ok: true; text: string; ms: number } | { ok: false; code: string }>(
        'POST', `/api/model-presets/${preset.id}/test`, undefined, AbortSignal.timeout(90_000),
      );
      if (result.ok) setNotice(t('testOk', { text: result.text.trim() || '—', ms: result.ms }));
      else setError(t('checkFailed', { reason: toMessage(new ApiError(0, result.code, '')) }));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const field = (key: string, label: string, control: ReactNode, hint?: string): ReactNode => (
    <div className="space-y-1.5">
      <label htmlFor={`${id}-${key}`} className="block text-xs font-medium text-muted">{label}</label>
      {control}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );

  return (
    <div data-testid="model-preset-editor" className="space-y-4 rounded-xl border border-line bg-raised/40 p-4">
      <Field label={t('presetName')}>
        <TextInput value={draft.name} maxLength={100} onChange={(event) => set({ name: event.target.value })} />
      </Field>
      {field(
        'format',
        t('format'),
        <Select
          id={`${id}-format`}
          value={draft.format}
          onChange={(event) => {
            setListed(null);
            set({ format: event.target.value, credentialId: '' });
          }}
        >
          {formats.formats.map((entry) => (
            <option key={entry.id} value={entry.id}>{formatLabel(entry.id)}</option>
          ))}
        </Select>,
      )}
      {field(
        'credential',
        t('credential'),
        <Select
          id={`${id}-credential`}
          value={draft.credentialId}
          onChange={(event) => {
            setListed(null);
            set({ credentialId: event.target.value });
          }}
        >
          {format.key === 'optional' ? <option value="">{t('noCredential')}</option> : <option value="">{t('noKeyYet')}</option>}
          {usable.map((entry) => (
            <option key={entry.id} value={entry.id}>{providerLabel(entry)}</option>
          ))}
        </Select>,
        keyAddress ? t('endpointFromKey', { url: keyAddress }) : undefined,
      )}
      {!draft.credentialId && format.key === 'optional'
        ? field(
            'endpoint',
            t('endpoint'),
            <>
              <TextInput
                id={`${id}-endpoint`}
                value={draft.endpoint}
                list={`${id}-endpoints`}
                placeholder="http://localhost:1234/v1"
                inputMode="url"
                onChange={(event) => set({ endpoint: event.target.value })}
              />
              <datalist id={`${id}-endpoints`}>
                {formats.localEndpoints.map((entry) => (
                  <option key={entry.id} value={entry.endpoint}>{entry.label}</option>
                ))}
              </datalist>
            </>,
            t('endpointHint'),
          )
        : null}
      {field(
        'model',
        t('model'),
        <div className="flex gap-2">
          <TextInput
            id={`${id}-model`}
            className="min-w-0 flex-1"
            value={draft.model}
            list={`${id}-models`}
            maxLength={200}
            placeholder={t('modelPlaceholder')}
            onChange={(event) => set({ model: event.target.value })}
          />
          <datalist id={`${id}-models`}>
            {(listed ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.label}</option>
            ))}
          </datalist>
          <Button size="sm" className="h-11 shrink-0" busy={listing} onClick={() => void loadModels()}>{t('loadModels')}</Button>
        </div>,
      )}

      {parameters.length > 0 || !onPlan ? (
        <fieldset className="space-y-3">
          <legend className="text-xs font-medium text-muted">{t('parameters')}</legend>
          <p className="text-xs text-muted">{t('parametersHint')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {parameters.map((parameter) => {
              const label = t(`parameterNames.${parameter}`);
              if (parameter === 'reasoningEffort' || parameter === 'verbosity') {
                const options = parameter === 'reasoningEffort' ? efforts : formats.verbosities;
                return (
                  <div key={parameter}>
                    {field(
                      parameter,
                      label,
                      <Select
                        id={`${id}-${parameter}`}
                        value={draft.values[parameter] ?? ''}
                        onChange={(event) => set({ values: { ...draft.values, [parameter]: event.target.value } })}
                      >
                        <option value="">
                          {parameter === 'reasoningEffort' && listedModel?.defaultReasoningEffort
                            ? t('effortDefaultIs', { effort: effortLabel(listedModel.defaultReasoningEffort) })
                            : t('effortDefault')}
                        </option>
                        {options.map((option) => (
                          <option key={option} value={option}>
                            {parameter === 'reasoningEffort' ? effortLabel(option) : t(`verbosities.${option}`)}
                          </option>
                        ))}
                      </Select>,
                    )}
                  </div>
                );
              }
              return (
                <div key={parameter}>
                  {field(
                    parameter,
                    label,
                    <TextInput
                      id={`${id}-${parameter}`}
                      type="number"
                      inputMode="decimal"
                      step={NUMBER_STEPS[parameter]}
                      value={draft.values[parameter] ?? ''}
                      onChange={(event) => set({ values: { ...draft.values, [parameter]: event.target.value } })}
                    />,
                  )}
                </div>
              );
            })}
            {!onPlan ? (
              <div>
                {field(
                  'maxTokens',
                  t('maxTokens'),
                  <TextInput
                    id={`${id}-maxTokens`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step="1"
                    value={draft.maxTokens}
                    onChange={(event) => set({ maxTokens: event.target.value })}
                  />,
                  t('maxTokensHint'),
                )}
              </div>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      <Button size="sm" variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced((open) => !open)}>
        {t('advanced')}
      </Button>
      {advanced ? (
        <div className="space-y-3">
          <Field label={t('stop')} hint={t('stopHint')}>
            <TextArea rows={2} value={draft.stop} onChange={(event) => set({ stop: event.target.value })} />
          </Field>
          {!onPlan ? (
            <>
              <Field label={t('extraHeaders')} hint={t('extraHint')}>
                <TextArea rows={2} spellCheck={false} value={draft.extraHeaders} placeholder='{"X-Example": "1"}' onChange={(event) => set({ extraHeaders: event.target.value })} />
              </Field>
              <Field label={t('extraBody')}>
                <TextArea rows={2} spellCheck={false} value={draft.extraBody} placeholder='{"seed": 1}' onChange={(event) => set({ extraBody: event.target.value })} />
              </Field>
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-muted">{t('capabilities')}</legend>
                <Checkbox
                  label={t('vision')}
                  checked={draft.capabilities.vision === true}
                  onChange={(vision) => set({ capabilities: { ...draft.capabilities, vision } })}
                />
                {format.id === 'openai-chat' ? (
                  <>
                    {field(
                      'systemPrompt',
                      t('systemPrompt'),
                      <Select
                        id={`${id}-systemPrompt`}
                        value={draft.capabilities.systemPrompt ?? 'full'}
                        onChange={(event) => set({ capabilities: { ...draft.capabilities, systemPrompt: event.target.value as ModelCapabilities['systemPrompt'] } })}
                      >
                        {(['full', 'first', 'none'] as const).map((mode) => (
                          <option key={mode} value={mode}>{t(`systemPrompts.${mode}`)}</option>
                        ))}
                      </Select>,
                    )}
                    <Checkbox
                      label={t('alternateRoles')}
                      checked={draft.capabilities.alternateRoles === true}
                      onChange={(alternateRoles) => set({ capabilities: { ...draft.capabilities, alternateRoles } })}
                    />
                    <Checkbox
                      label={t('startWithUser')}
                      checked={draft.capabilities.startWithUser === true}
                      onChange={(startWithUser) => set({ capabilities: { ...draft.capabilities, startWithUser } })}
                    />
                  </>
                ) : null}
              </fieldset>
            </>
          ) : (
            <p className="text-xs text-muted">{t('visionHint')}</p>
          )}
        </div>
      ) : null}

      <ErrorText>{error}</ErrorText>
      {notice ? <p role="status" className="text-sm text-muted">{notice}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        {preset ? <Button size="sm" busy={busy} onClick={() => void test()}>{t('testPreset')}</Button> : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          disabled={!draft.name.trim() || !draft.model.trim()}
          onClick={() => void save()}
        >
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
