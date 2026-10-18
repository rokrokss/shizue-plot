'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { apiGet, apiSend, readerHeaders } from '@/lib/api';
import { effectivePreset, OPEN_BINDING } from '@/lib/modelBinding';
import type { ChatState, ModelBinding, ModelPreset, Persona, PlotProfile } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { PersonaFace } from './Avatar';
import { ModelOptions } from './ModelOptions';
import { Button, buttonClass, cx, ErrorText, Field, Section, Select } from './ui';

/** Held so a plot with no recommendations gives the panel a stable prop. */
const NO_PROFILES: PlotProfile[] = [];

/**
 * Opens a chat with a plot the viewer may read — their own or a public one.
 * Which opening the chat starts on is decided on the page around this panel, in
 * the picker beside the openings themselves; every one of them becomes a
 * swipeable root either way.
 */
export function StartChatPanel({
  plotId,
  introIndex,
  profiles = NO_PROFILES,
}: {
  plotId: string;
  /**
   * Which opening the chat opens on; the roots are all created regardless.
   * Undefined when the plot has no openings — an explicit index is validated
   * against the intro count, so a plot without intros must not send one.
   */
  introIndex?: number;
  /** The profiles the work recommends; a pick copies one into the reader's own. */
  profiles?: PlotProfile[];
}) {
  const t = useTranslations('plot');
  const chat = useTranslations('chat');
  const toMessage = useErrorMessage();
  const router = useRouter();

  /** The owner's model presets; null until they are read. */
  const [presets, setPresets] = useState<ModelPreset[] | null>(null);
  const [defaults, setDefaults] = useState<ModelBinding>(OPEN_BINDING);
  const [personas, setPersonas] = useState<Persona[]>([]);
  /** The main and sub presets picked here; empty follows the default binding. */
  const [model, setModel] = useState('');
  const [subModel, setSubModel] = useState('');
  const [personaId, setPersonaId] = useState('');
  /** The recommended profile the reader picked; exclusive with the persona. */
  const [profileId, setProfileId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      apiGet<ModelPreset[]>('/api/model-presets'),
      apiGet<ModelBinding>('/api/model-binding').catch(() => OPEN_BINDING),
    ]).then(([list, binding]) => {
      setPresets(list);
      setDefaults(binding);
      // With no default to follow, the first preset, as the first model of the catalog once was.
      if (!binding.main) setModel((current) => current || (list[0]?.id ?? ''));
    }, (caught) => setError(toMessage(caught)));
    apiGet<Persona[]>('/api/personas').then(setPersonas, () => undefined);
  }, [toMessage]);

  const picked: ModelBinding = { main: model || null, sub: subModel || null };
  // What the chat would open on — the picks, else the default's — named in the
  // "기본 (…)" options. With none at all there is nothing to start it on.
  const defaultMain = effectivePreset(presets ?? [], { ...picked, main: null }, defaults, 'main');
  const defaultSub = effectivePreset(presets ?? [], { ...picked, sub: null }, defaults, 'sub');
  const runnable = Boolean(model || defaultMain);

  async function start(): Promise<void> {
    if (busy || !runnable) return;
    setBusy(true);
    setError('');
    try {
      const state = await apiSend<ChatState>(
        'POST',
        '/api/chats',
        {
          plotId,
          ...(model || subModel ? { modelBinding: { ...(model ? { main: model } : {}), ...(subModel ? { sub: subModel } : {}) } } : {}),
          ...(introIndex !== undefined ? { introIndex } : {}),
          // The server refuses both at once, and the picker above never sets both:
          // a profile wins, and choosing a persona is what gives it up.
          ...(profileId ? { profileId } : personaId ? { personaId } : {}),
        },
        undefined,
        // The openings are expanded now, so their clock macros read the reader's zone.
        readerHeaders(),
      );
      router.push(`/chats/${state.chat.id}`);
    } catch (caught) {
      setError(toMessage(caught));
      setBusy(false);
    }
  }

  return (
    <Section title={t('startChat')} busy={busy}>
      <Field label={t('model')}>
        <Select value={model} onChange={(event) => setModel(event.target.value)}>
          <ModelOptions
            presets={presets ?? []}
            value={model || null}
            defaultLabel={defaultMain ? chat('modelDefaultIs', { model: defaultMain.name }) : chat('modelDefault')}
          />
        </Select>
      </Field>
      {/* The chat settings' own control, so the copy is theirs too: next to the
          model it spares, defaulting to what the open sub runs on, by name. */}
      <Field label={chat('subModel')} hint={chat('subModelHint')}>
        <Select value={subModel} onChange={(event) => setSubModel(event.target.value)}>
          <ModelOptions
            presets={presets ?? []}
            value={subModel || null}
            defaultLabel={defaultSub ? chat('subModelDefaultIs', { model: defaultSub.name }) : chat('subModelDefault')}
          />
        </Select>
      </Field>
      {/* Who the reader is in this plot. The work's own suggestions come first —
          they are written for it — and the reader's saved personas below them;
          picking either gives up the other, because the chat carries one. */}
      {profiles.length > 0 ? (
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-muted">
            {t('profiles')}
          </span>
          <ul className="flex flex-wrap gap-2">
            {profiles.map((profile) => (
              <li key={profile.id} className="min-w-0">
                <button
                  type="button"
                  data-testid="profile-pick"
                  aria-pressed={profileId === profile.id}
                  onClick={() => {
                    setProfileId((current) => (current === profile.id ? '' : profile.id));
                    setPersonaId('');
                  }}
                  className={cx(
                    'max-w-xs rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    profileId === profile.id
                      ? 'border-accent/60 bg-raised text-fg'
                      : 'border-line text-muted hover:text-fg',
                  )}
                >
                  <span className="block font-medium">{profile.name}</span>
                  {profile.description ? (
                    <span className="mt-0.5 line-clamp-2 block">{profile.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          <span className="block text-xs text-muted">{t('profilesHint')}</span>
        </div>
      ) : null}

      <Field label={t('persona')} {...(profileId ? { hint: t('profilePicked') } : {})}>
        <PersonaFace persona={personas.find((persona) => persona.id === personaId)}>
          <Select
            value={personaId}
            // Disabled rather than quietly overruled: the exclusivity is the
            // server's rule, and a select that could be set but never sent would
            // only be a lie about which of the two the chat is starting on.
            disabled={Boolean(profileId)}
            onChange={(event) => {
              setPersonaId(event.target.value);
              setProfileId('');
            }}
          >
            <option value="">{t('noPersona')}</option>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </Select>
        </PersonaFace>
      </Field>

      <ErrorText>{error || (presets !== null && !runnable ? t('noModels') : '')}</ErrorText>
      {presets !== null && !runnable ? <Link href="/settings" className={buttonClass('secondary', 'sm', 'w-full')}>{t('openModelSettings')}</Link> : null}

      <Button
        variant="primary"
        className="w-full"
        busy={busy}
        disabled={!runnable}
        onClick={() => void start()}
      >
        {t('startChat')}
      </Button>
    </Section>
  );
}
