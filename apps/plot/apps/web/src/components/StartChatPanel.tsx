'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { apiGet, apiSend, timeZoneHeaders } from '@/lib/api';
import { useSession } from '@/lib/authClient';
import { signInHref } from '@/lib/nav';
import type { ChatState, ModelInfo, Persona, PlotProfile } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Button, buttonClass, cx, ErrorText, Field, Section, Select } from './ui';

/** Held so a plot with no recommendations gives the panel a stable prop. */
const NO_PROFILES: PlotProfile[] = [];

/**
 * Opens a chat with a plot the viewer may read — their own or a public one.
 * Which opening the chat starts on is decided on the page around this panel, in
 * the picker beside the openings themselves; every one of them becomes a
 * swipeable root either way.
 *
 * A reader with no account gets the way in where the form would be — and the
 * form's two reads, which are the account's own, are never issued.
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
  const chatgpt = useTranslations('chatgpt');
  const toMessage = useErrorMessage();
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const signedIn = Boolean(session);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [model, setModel] = useState('');
  const [personaId, setPersonaId] = useState('');
  /** The recommended profile the reader picked; exclusive with the persona. */
  const [profileId, setProfileId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Both of these are session-only reads: asking for them anonymously would buy
  // a pair of 401s and nothing else.
  useEffect(() => {
    if (!signedIn) return;
    apiGet<ModelInfo[]>('/api/models').then((list) => {
      setModels(list);
      setModel((current) => current || (list[0]?.id ?? ''));
    }, (caught) => setError(toMessage(caught)));
    apiGet<Persona[]>('/api/personas').then(setPersonas, () => undefined);
  }, [signedIn, toMessage]);

  async function start(): Promise<void> {
    if (busy || !model) return;
    setBusy(true);
    setError('');
    try {
      const state = await apiSend<ChatState>(
        'POST',
        '/api/chats',
        {
          plotId,
          model,
          ...(introIndex !== undefined ? { introIndex } : {}),
          // The server refuses both at once, and the picker above never sets both:
          // a profile wins, and choosing a persona is what gives it up.
          ...(profileId ? { profileId } : personaId ? { personaId } : {}),
        },
        undefined,
        // The openings are expanded now, so their clock macros read the reader's zone.
        timeZoneHeaders(),
      );
      router.push(`/chats/${state.chat.id}`);
    } catch (caught) {
      setError(toMessage(caught));
      setBusy(false);
    }
  }

  // Which panel this is depends on the session read, and a form that turns into
  // an invitation a moment later is worse than an empty frame for that moment.
  if (isPending) return null;
  if (!signedIn) return <SignInPanel plotId={plotId} />;

  return (
    <Section title={t('startChat')} busy={busy}>
      <Field label={t('model')}>
        <Select value={model} onChange={(event) => setModel(event.target.value)}>
          {models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
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
          <span className="block text-xs text-muted/80">{t('profilesHint')}</span>
        </div>
      ) : null}

      <Field label={t('persona')} {...(profileId ? { hint: t('profilePicked') } : {})}>
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
      </Field>

      <ErrorText>{error || (models.length === 0 ? t('noModels') : '')}</ErrorText>
      {models.length === 0 ? <Link href="/settings" className={buttonClass('secondary', 'sm', 'w-full')}>{chatgpt('signIn')}</Link> : null}

      <Button
        variant="primary"
        className="w-full"
        busy={busy}
        disabled={!model}
        onClick={() => void start()}
      >
        {t('startChat')}
      </Button>
    </Section>
  );
}

/**
 * The same slot invites a reader to connect ChatGPT. It carries this page back
 * so completing sign-in returns to the plot.
 */
function SignInPanel({ plotId }: { plotId: string }) {
  const t = useTranslations('plot');
  const chatgpt = useTranslations('chatgpt');
  const back = `/p/${plotId}`;

  return (
    <Section title={t('startChat')}>
      <p className="text-sm leading-relaxed text-muted">{t('signInToChat')}</p>
      <Link
        href={signInHref(back)}
        data-testid="start-chat-sign-in"
        className={buttonClass('primary', 'md', 'w-full')}
      >
        {chatgpt('signIn')}
      </Link>
    </Section>
  );
}
