'use client';

import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocale, useTranslations } from 'next-intl';
import { apiGet, apiSend, ApiError } from '@/lib/api';
import { EXTENSION_URL, detectExtension } from '@/lib/chatgptExtension';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Button, ErrorText } from './ui';

/** `GET /api/chatgpt`: the owner's connection, and whether this browser is the computer's (`local`) or a paired phone's. */
interface Status { connected: boolean; email: string | null; local: boolean }

/**
 * The settings card for the owner's ChatGPT connection: the way to their own
 * plan, not a way into the app. Connecting goes out to OpenAI and comes back by
 * way of the Shizue extension, so it is offered on the computer shizue runs on,
 * with the extension's install guidance until it answers; a paired phone reads
 * what is connected. `error` is the code a failed connection came back with
 * (`/settings?error=`).
 */
export function ChatGPTConnection({ error }: { error?: string }) {
  const t = useTranslations('chatgpt');
  const toMessage = useErrorMessage();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState('');
  /** Said after a disconnect whose revocation OpenAI did not confirm. */
  const [notice, setNotice] = useState('');

  useEffect(() => {
    apiGet<Status>('/api/chatgpt', AbortSignal.timeout(10_000)).then(setStatus, (e) => setLoadError(toMessage(e)));
  }, [toMessage]);

  return (
    <section className="min-w-0 space-y-5 rounded-2xl border border-line bg-surface p-6 shadow-card">
      <h2 className="title2">{t('title')}</h2>
      <p className="text-sm leading-relaxed text-muted">{t('description')}</p>
      {status === null ? (
        <ErrorText>{loadError}</ErrorText>
      ) : status.connected ? (
        <Connected
          status={status}
          onDisconnected={(revocationPending) => {
            setNotice(revocationPending ? t('revocationPending') : '');
            setStatus({ ...status, connected: false, email: null });
          }}
        />
      ) : status.local ? (
        <Connect errorCode={error} />
      ) : (
        <p className="text-sm leading-relaxed">{t('onComputer')}</p>
      )}
      {notice ? <p role="status" className="text-sm text-muted">{notice}</p> : null}
    </section>
  );
}

function Connect({ errorCode }: { errorCode: string | undefined }) {
  const t = useTranslations('chatgpt');
  const locale = useLocale();
  const toMessage = useErrorMessage();
  const [error, setError] = useState(() => errorCode ? toMessage(new ApiError(0, errorCode, t('failed'))) : '');
  const [busy, setBusy] = useState(false);
  const [extension, setExtension] = useState<'checking' | 'ready' | 'missing' | 'stillMissing'>('checking');
  const [rechecking, setRechecking] = useState(false);
  const connectButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void detectExtension().then((found) => setExtension(found ? 'ready' : 'missing'));
    // Back from OpenAI may restore this page mid-navigation from the back/forward cache.
    const restored = (event: PageTransitionEvent): void => { if (event.persisted) setBusy(false); };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);

  async function recheck(): Promise<void> {
    setRechecking(true);
    const found = await detectExtension();
    flushSync(() => { setExtension(found ? 'ready' : 'stillMissing'); setRechecking(false); });
    // The guide, and the button that was focused in it, is gone; the way on is the connect button.
    if (found) connectButton.current?.focus();
  }

  async function connect(): Promise<void> {
    setBusy(true); setError('');
    try {
      const { authorizationUrl } = await apiSend<{ authorizationUrl: string }>('POST', '/api/chatgpt/sign-in', { next: '/settings', locale }, AbortSignal.timeout(15_000));
      const url = new URL(authorizationUrl);
      if (url.origin !== 'https://auth.openai.com') throw new Error(t('failed'));
      // Same tab, and busy until it leaves: Shizue brings this browser back to the callback.
      window.location.assign(url.href);
    } catch (e) { setError(toMessage(e)); setBusy(false); }
  }

  const missing = extension === 'missing' || extension === 'stillMissing';
  return (
    <div className="w-full max-w-sm space-y-3">
      <ErrorText>{error}</ErrorText>
      <Button ref={connectButton} variant="primary" className="w-full" busy={busy || extension === 'checking'} disabled={extension !== 'ready'} onClick={() => void connect()}>{t('connect')}</Button>
      {missing ? (
        <div className="space-y-3 rounded-xl border border-line bg-raised/50 p-4 text-sm leading-relaxed break-words">
          <p>{t('extensionRequired')}</p>
          <a href={EXTENSION_URL} target="_blank" rel="noreferrer" className="inline-block font-semibold text-link underline underline-offset-2">{t('extensionInstall')}</a>
          <Button size="sm" busy={rechecking} onClick={() => void recheck()}>{t('extensionRecheck')}</Button>
          <p role="status" className="text-muted">{extension === 'stillMissing' ? t('extensionStillMissing') : ''}</p>
        </div>
      ) : null}
    </div>
  );
}

/** The connected account, and — on the computer — the way to disconnect it. */
function Connected({ status, onDisconnected }: { status: Status; onDisconnected: (revocationPending: boolean) => void }) {
  const t = useTranslations('chatgpt');
  const toMessage = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function disconnect(): Promise<void> {
    setBusy(true); setError('');
    try {
      const result = await apiSend<{ revocationPending: boolean }>('POST', '/api/chatgpt/disconnect', undefined, AbortSignal.timeout(45_000));
      onDisconnected(result.revocationPending);
    } catch (e) { setError(toMessage(e)); setBusy(false); }
  }

  return (
    <>
      <div className="w-full max-w-sm space-y-3">
        <p className="w-full truncate rounded-xl border border-line bg-mint-soft/40 px-3 py-3 text-sm" title={status.email ?? undefined}>
          {status.email ?? t('connectedAccount')}
        </p>
        <p role="status" className="text-sm text-muted">{t('usingPlan')}</p>
        {status.local ? <Button className="w-full" busy={busy} onClick={() => void disconnect()}>{t('disconnect')}</Button> : null}
      </div>
      <ErrorText>{error}</ErrorText>
    </>
  );
}
