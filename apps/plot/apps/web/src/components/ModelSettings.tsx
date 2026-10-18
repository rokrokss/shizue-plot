'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiDelete, apiGet, apiSend } from '@/lib/api';
import { OPEN_BINDING } from '@/lib/modelBinding';
import type { Credential, ModelBinding, ModelFormats, ModelPreset, ModelRegistry, RegistryProfile } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { ChatGPTConnection } from './ChatGPTConnection';
import { ModelOptions } from './ModelOptions';
import { ModelProfileBrowser } from './ModelProfileBrowser';
import { ModelPresetEditor } from './ModelPresetEditor';
import { ProfilePresetEditor } from './ProfilePresetEditor';
import { Badge, Button, ErrorText, Field, Select, TextArea, TextInput } from './ui';

/** `GET /api/chatgpt`'s answer, read here only for whether this browser is the computer's. */
interface ChatGPTStatus { local: boolean }

/** What a registry refresh says (`POST /api/model-presets/registry/refresh`). */
interface RegistryRefresh { ok: boolean; changed: boolean; downloaded: boolean; error?: string }

/**
 * Settings › Models (ARCHITECTURE §11): PocketRisu's model presets — the owner's
 * default binding, the presets and their editor — then the API keys a preset
 * authenticates with, and the ChatGPT connection, which is a key of its own. Keys
 * are entered on the computer only; a paired phone reads the list.
 */
export function ModelSettings({ chatgptError }: { chatgptError?: string }) {
  const t = useTranslations('models');
  const toMessage = useErrorMessage();
  const [formats, setFormats] = useState<ModelFormats | null>(null);
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [defaults, setDefaults] = useState<ModelBinding>(OPEN_BINDING);
  const [registry, setRegistry] = useState<ModelRegistry | null>(null);
  const [local, setLocal] = useState(false);
  /** The preset in the editor: an existing one's id, `new` (a custom one), or none. */
  const [editing, setEditing] = useState<string | null>(null);
  /** The profile browser: making a preset, or putting another profile in a preset's place. */
  const [browser, setBrowser] = useState<{ mode: 'create' } | { mode: 'replace'; presetId: string } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [formatList, presetList, credentialList, binding, catalog] = await Promise.all([
        apiGet<ModelFormats>('/api/model-presets/formats'),
        apiGet<ModelPreset[]>('/api/model-presets'),
        apiGet<Credential[]>('/api/credentials'),
        apiGet<ModelBinding>('/api/model-binding'),
        apiGet<ModelRegistry>('/api/model-presets/registry'),
      ]);
      setFormats(formatList);
      setPresets(presetList);
      setCredentials(credentialList);
      setDefaults(binding);
      setRegistry(catalog);
    } catch (caught) {
      setError(toMessage(caught));
    }
  }, [toMessage]);

  useEffect(() => {
    void load();
    apiGet<ChatGPTStatus>('/api/chatgpt').then((status) => setLocal(status.local), () => undefined);
    // PocketRisu syncs the registry when its model menu opens: a newer catalog is taken quietly, the bundled one stands otherwise.
    apiSend<RegistryRefresh>('POST', '/api/model-presets/registry/refresh', {}).then((result) => {
      if (result.changed) void load();
    }, () => undefined);
  }, [load]);

  /** The refresh button: PocketRisu's forced sync, and what it said. */
  async function refresh(): Promise<void> {
    setRefreshing(true);
    setRefreshNote('');
    try {
      const result = await apiSend<RegistryRefresh>('POST', '/api/model-presets/registry/refresh', { force: true }, AbortSignal.timeout(90_000));
      setRefreshNote(!result.ok ? t('registryFailed', { reason: result.error ?? '' }) : result.changed ? t('registryUpdated') : t('registryUpToDate'));
      await load();
    } catch (caught) {
      setRefreshNote(t('registryFailed', { reason: toMessage(caught) }));
    } finally {
      setRefreshing(false);
    }
  }

  /** A profile picked in the browser: a new preset on it, on the provider's first key, or the replaced preset's new profile. */
  async function pick(profile: RegistryProfile): Promise<void> {
    if (!browser) return;
    setError('');
    if (browser.mode === 'replace' && !window.confirm(t('profileReplaceConfirm'))) return;
    setBrowsing(true);
    try {
      const preset = browser.mode === 'create'
        ? await apiSend<ModelPreset>('POST', '/api/model-presets', {
            profileId: profile.id,
            credentialId: credentials.find((credential) => credential.kind === 'api_key' && credential.provider === profile.provider)?.id ?? null,
          })
        : await apiSend<ModelPreset>('PATCH', `/api/model-presets/${browser.presetId}`, { profileId: profile.id });
      setBrowser(null);
      await load();
      setEditing(preset.id);
      // The first preset made is the one chats start on, until the owner picks another.
      if (browser.mode === 'create' && !defaults.main) await saveDefaults({ main: preset.id });
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBrowsing(false);
    }
  }

  async function saveDefaults(change: Partial<ModelBinding>): Promise<void> {
    setError('');
    try {
      setDefaults(await apiSend<ModelBinding>('PUT', '/api/model-binding', { ...defaults, ...change }));
    } catch (caught) {
      setError(toMessage(caught));
    }
  }

  async function saved(preset: ModelPreset): Promise<void> {
    setEditing(null);
    await load();
    // The first preset made is the one chats start on, until the owner picks another.
    if (!defaults.main) await saveDefaults({ main: preset.id });
  }

  async function removePreset(preset: ModelPreset): Promise<void> {
    if (!window.confirm(t('removePresetConfirm'))) return;
    try {
      await apiDelete(`/api/model-presets/${preset.id}`);
      await load();
    } catch (caught) {
      setError(toMessage(caught));
    }
  }

  const formatLabel = (formatId: string): string => (t.has(`formats.${formatId}`) ? t(`formats.${formatId}`) : formatId);
  const keyOf = (preset: ModelPreset): string => {
    const credential = credentials.find((entry) => entry.id === preset.credentialId);
    if (credential) return credential.kind === 'chatgpt' ? t('chatgptCredential') : credential.label;
    if (preset.kind === 'profile') return t('noKeyYet');
    return preset.endpoint ?? t('keyless');
  };
  /** What a preset's row says under its name: a profile preset's provider and model, a custom one's format. */
  const detailOf = (preset: ModelPreset): string =>
    preset.builtIn
      ? t('builtIn')
      : preset.kind === 'profile'
        ? [preset.profile?.baseLabel ?? preset.profileSnapshot?.providerBaseId, preset.model, keyOf(preset)].filter(Boolean).join(' · ')
        : `${t('customModelTitle')} · ${formatLabel(preset.format)} · ${preset.model} · ${keyOf(preset)}`;
  const owned = presets.filter((preset) => !preset.builtIn);
  const editorOpen = editing !== null || browser !== null;

  return (
    <>
      <section className="min-w-0 space-y-5 rounded-2xl border border-line bg-surface p-6 shadow-card">
        <h2 className="title2">{t('title')}</h2>
        <p className="text-sm leading-relaxed text-muted">{t('description')}</p>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t('defaultTitle')}</h3>
          <p className="text-xs text-muted">{t('defaultDescription')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('mainModel')}>
              <Select value={defaults.main ?? ''} onChange={(event) => void saveDefaults({ main: event.target.value || null })}>
                <ModelOptions presets={presets} value={defaults.main} defaultLabel={t('unset')} />
              </Select>
            </Field>
            <Field label={t('subModel')}>
              <Select value={defaults.sub ?? ''} onChange={(event) => void saveDefaults({ sub: event.target.value || null })}>
                <ModelOptions presets={presets} value={defaults.sub} defaultLabel={t('sameAsMain')} />
              </Select>
            </Field>
          </div>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{t('presetsTitle')}</h3>
            {formats && !editorOpen ? <Button size="sm" onClick={() => setBrowser({ mode: 'create' })}>{t('addPreset')}</Button> : null}
          </div>
          {browser ? (
            <ModelProfileBrowser
              registry={registry}
              mode={browser.mode}
              busy={browsing}
              refreshing={refreshing}
              refreshNote={refreshNote}
              onPick={(profile) => void pick(profile)}
              onCustom={() => {
                setBrowser(null);
                setEditing('new');
              }}
              onRefresh={() => void refresh()}
              onClose={() => setBrowser(null)}
            />
          ) : null}
          {editing === 'new' && formats ? (
            <ModelPresetEditor formats={formats} credentials={credentials} onSaved={(preset) => void saved(preset)} onCancel={() => setEditing(null)} />
          ) : null}
          {owned.length === 0 && !editorOpen ? <p className="text-sm text-muted">{t('presetsEmpty')}</p> : null}
          <ul className="space-y-2">
            {presets.map((preset) =>
              editing === preset.id && formats && !browser ? (
                <li key={preset.id}>
                  {preset.kind === 'profile' && preset.profileSnapshot ? (
                    <ProfilePresetEditor
                      // A taken update brings another snapshot: the editor starts over on it.
                      key={`${preset.sourceProfile?.profileId}:${preset.sourceProfile?.fetchedAt}`}
                      preset={preset}
                      credentials={credentials}
                      onSaved={(updated, close) => void (close ? saved(updated) : load())}
                      onCancel={() => setEditing(null)}
                      onReplace={() => setBrowser({ mode: 'replace', presetId: preset.id })}
                    />
                  ) : (
                    <ModelPresetEditor preset={preset} formats={formats} credentials={credentials} onSaved={(updated) => void saved(updated)} onCancel={() => setEditing(null)} />
                  )}
                </li>
              ) : (
                <li key={preset.id} data-testid="model-preset" className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{preset.name}</span>
                      {preset.profile && preset.profile.status !== 'current' ? <Badge>{t(`profileStatus.${preset.profile.status}`)}</Badge> : null}
                      {preset.profileUpdate === 'updatable' ? <Badge>{t('profileUpdateAvailable')}</Badge> : null}
                      {preset.profileUpdate === 'missing' ? <Badge>{t('profileMissing')}</Badge> : null}
                    </p>
                    <p className="truncate text-xs text-muted">{detailOf(preset)}</p>
                    {preset.profile?.statusReason && preset.profile.status !== 'current' ? (
                      <p className="text-xs text-muted">{preset.profile.statusReason}</p>
                    ) : null}
                  </div>
                  {preset.builtIn ? null : (
                    <>
                      <Button size="sm" variant="ghost" disabled={editorOpen} onClick={() => setEditing(preset.id)}>{t('editPreset')}</Button>
                      <Button size="sm" variant="ghost" disabled={editorOpen} onClick={() => void removePreset(preset)}>{t('removePreset')}</Button>
                    </>
                  )}
                </li>
              ),
            )}
          </ul>
        </div>
        <ErrorText>{error}</ErrorText>
      </section>
      <ChatGPTConnection error={chatgptError} />
      <CredentialSettings
        credentials={credentials.filter((credential) => credential.kind !== 'chatgpt')}
        formats={formats}
        local={local}
        onChanged={() => void load()}
      />
    </>
  );
}

/**
 * The API keys — and AWS keys and Google service accounts, the credentials
 * Bedrock and Vertex take: listed everywhere, entered, checked and removed on
 * the computer only.
 */
function CredentialSettings({
  credentials,
  formats,
  local,
  onChanged,
}: {
  credentials: readonly Credential[];
  formats: ModelFormats | null;
  local: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('models');
  const toMessage = useErrorMessage();
  const providers = formats?.providers ?? [];
  const [provider, setProvider] = useState('openai');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [region, setRegion] = useState('');
  const [serviceAccount, setServiceAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** What the last check of each key said. */
  const [checked, setChecked] = useState<Record<string, string>>({});
  const spec = providers.find((entry) => entry.id === provider);
  const kind = spec?.kind ?? 'api_key';
  /** What the provider's credential needs before it can be added. */
  const ready = kind === 'aws'
    ? Boolean(accessKeyId.trim() && secretAccessKey.trim() && region.trim())
    : kind === 'gcp_service_account'
      ? Boolean(serviceAccount.trim())
      : !(spec?.key === 'required' && !apiKey.trim()) && Boolean(spec?.baseUrl || baseUrl.trim());

  async function add(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await apiSend('POST', '/api/credentials', {
        provider,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(kind === 'aws'
          ? { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(), region: region.trim(), ...(sessionToken.trim() ? { sessionToken: sessionToken.trim() } : {}) }
          : kind === 'gcp_service_account'
            ? { serviceAccount, ...(region.trim() ? { region: region.trim() } : {}) }
            : { ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
      });
      for (const clear of [setLabel, setBaseUrl, setApiKey, setAccessKeyId, setSecretAccessKey, setSessionToken, setRegion, setServiceAccount]) clear('');
      onChanged();
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function check(credential: Credential): Promise<void> {
    setChecked((current) => ({ ...current, [credential.id]: '…' }));
    try {
      const result = await apiSend<{ ok: boolean; code?: string }>('POST', `/api/credentials/${credential.id}/test`, undefined, AbortSignal.timeout(30_000));
      setChecked((current) => ({
        ...current,
        [credential.id]: result.ok ? t('keyOk') : t('checkFailed', { reason: toMessage(new ApiError(0, result.code ?? 'unknown', '')) }),
      }));
    } catch (caught) {
      setChecked((current) => ({ ...current, [credential.id]: t('checkFailed', { reason: toMessage(caught) }) }));
    }
  }

  async function remove(credential: Credential): Promise<void> {
    if (!window.confirm(t('removeKeyConfirm'))) return;
    try {
      await apiDelete(`/api/credentials/${credential.id}`);
      onChanged();
    } catch (caught) {
      setError(toMessage(caught));
    }
  }

  return (
    <section className="min-w-0 space-y-5 rounded-2xl border border-line bg-surface p-6 shadow-card">
      <h2 className="title2">{t('keysTitle')}</h2>
      <p className="text-sm leading-relaxed text-muted">{local ? t('keysDescription') : t('keysOnComputer')}</p>
      {credentials.length === 0 ? <p className="text-sm text-muted">{t('keysEmpty')}</p> : null}
      <ul className="space-y-2">
        {credentials.map((credential) => (
          <li key={credential.id} data-testid="credential" className="space-y-1 rounded-xl border border-line px-3 py-2.5">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{credential.label}</p>
                <p className="truncate text-xs text-muted">
                  {[providers.find((entry) => entry.id === credential.provider)?.label ?? credential.provider, credential.hint, credential.baseUrl].filter(Boolean).join(' · ')}
                </p>
              </div>
              {local ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void check(credential)}>{t('testKey')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(credential)}>{t('removeKey')}</Button>
                </>
              ) : null}
            </div>
            {checked[credential.id] ? <p role="status" className="text-xs text-muted">{checked[credential.id]}</p> : null}
          </li>
        ))}
      </ul>
      {local && providers.length > 0 ? (
        <div className="space-y-3 rounded-xl border border-line bg-raised/40 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('provider')}>
              <Select value={provider} onChange={(event) => setProvider(event.target.value)}>
                {providers.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('label')}>
              <TextInput value={label} maxLength={100} placeholder={spec?.label ?? ''} onChange={(event) => setLabel(event.target.value)} />
            </Field>
          </div>
          {kind === 'aws' ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('accessKeyId')}>
                  <TextInput autoComplete="off" spellCheck={false} value={accessKeyId} placeholder="AKIA…" onChange={(event) => setAccessKeyId(event.target.value)} />
                </Field>
                <Field label={t('region')} hint={t('awsRegionHint')}>
                  <TextInput autoComplete="off" spellCheck={false} value={region} placeholder="us-east-1" onChange={(event) => setRegion(event.target.value)} />
                </Field>
              </div>
              <Field label={t('secretAccessKey')}>
                <TextInput type="password" autoComplete="off" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} />
              </Field>
              <Field label={t('sessionToken')}>
                <TextInput type="password" autoComplete="off" value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} />
              </Field>
            </>
          ) : kind === 'gcp_service_account' ? (
            <>
              <Field label={t('serviceAccount')} hint={t('serviceAccountHint')}>
                <TextArea rows={4} spellCheck={false} autoComplete="off" value={serviceAccount} placeholder='{"type": "service_account", …}' onChange={(event) => setServiceAccount(event.target.value)} />
              </Field>
              <Field label={t('region')} hint={t('gcpRegionHint')}>
                <TextInput autoComplete="off" spellCheck={false} value={region} placeholder="global" onChange={(event) => setRegion(event.target.value)} />
              </Field>
            </>
          ) : (
            <>
              <Field label={t('baseUrl')} hint={spec?.baseUrl ? t('baseUrlHint') : t('baseUrlRequired')}>
                <TextInput value={baseUrl} inputMode="url" placeholder={spec?.baseUrl ?? 'http://localhost:8000/v1'} onChange={(event) => setBaseUrl(event.target.value)} />
              </Field>
              <Field label={spec?.key === 'optional' ? t('apiKeyOptional') : t('apiKey')}>
                <TextInput type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
              </Field>
            </>
          )}
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              busy={busy}
              disabled={!ready}
              onClick={() => void add()}
            >
              {t('addKey')}
            </Button>
          </div>
        </div>
      ) : (
        <ErrorText>{error}</ErrorText>
      )}
    </section>
  );
}
