'use client';

import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocale, useTranslations } from 'next-intl';
import { apiGet, apiSend, ApiError } from '@/lib/api';
import { refreshSession } from '@/lib/authClient';
import { EXTENSION_URL, detectExtension } from '@/lib/chatgptExtension';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Button, ErrorText, cx } from './ui';

interface Status { connected: boolean; email: string | null }

/**
 * The login entrance (`entrance`) or the account card in settings. `next` is
 * where a finished sign-in lands, and `error` the code the server's callback
 * sent the reader back with.
 */
export function ChatGPTConnection({ entrance = false, next = '/', error }: { entrance?: boolean; next?: string; error?: string }) {
  const t = useTranslations('chatgpt');
  return (
    <section className={cx('min-w-0 space-y-5', !entrance && 'rounded-2xl border border-line bg-surface p-6 shadow-card')}>
      <h2 className="text-2xl font-bold tracking-tight">{t(entrance ? 'welcome' : 'title')}</h2>
      <p className="text-sm leading-relaxed text-muted">{t('description')}</p>
      {entrance ? <SignIn next={next} errorCode={error} /> : <Account />}
    </section>
  );
}

function SignIn({ next, errorCode }: { next: string; errorCode: string | undefined }) {
  const t = useTranslations('chatgpt');
  const locale = useLocale();
  const toMessage = useErrorMessage();
  const [error, setError] = useState(() => errorCode ? toMessage(new ApiError(0, errorCode, t('failed'))) : '');
  const [busy, setBusy] = useState(false);
  const [extension, setExtension] = useState<'checking' | 'ready' | 'missing' | 'stillMissing'>('checking');
  const [rechecking, setRechecking] = useState(false);
  const signInButton = useRef<HTMLButtonElement>(null);

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
    // The guide, and the button that was focused in it, is gone; the way on is the sign-in button.
    if (found) signInButton.current?.focus();
  }

  async function signIn(): Promise<void> {
    setBusy(true); setError('');
    try {
      const { authorizationUrl } = await apiSend<{ authorizationUrl: string }>('POST', '/api/chatgpt/sign-in', { next, locale }, AbortSignal.timeout(15_000));
      const url = new URL(authorizationUrl);
      if (url.origin !== 'https://auth.openai.com') throw new Error(t('failed'));
      // Same tab, and busy until it leaves: the helper extension brings this browser back to the callback.
      window.location.assign(url.href);
    } catch (e) { setError(toMessage(e)); setBusy(false); }
  }

  const missing = extension === 'missing' || extension === 'stillMissing';
  return (
    <div className="w-full max-w-sm space-y-3">
      <ErrorText>{error}</ErrorText>
      <Button ref={signInButton} variant="primary" className="w-full" busy={busy || extension === 'checking'} disabled={extension !== 'ready'} onClick={() => void signIn()}>{t('signIn')}</Button>
      {missing ? (
        <div className="space-y-3 rounded-xl border border-line bg-raised/50 p-4 text-sm leading-relaxed break-words">
          <p>{t('extensionRequired')}</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>{t.rich('extensionStepOpen', { code: (chunks) => <code className="font-mono text-fg">{chunks}</code> })}</li>
            <li>{t('extensionStepDeveloper')}</li>
            <li>{t('extensionStepLoad')}</li>
          </ol>
          {EXTENSION_URL ? (
            <a href={EXTENSION_URL} target="_blank" rel="noreferrer" className="inline-block font-semibold text-link underline underline-offset-2">{t('extensionInstall')}</a>
          ) : null}
          <Button size="sm" busy={rechecking} onClick={() => void recheck()}>{t('extensionRecheck')}</Button>
          <p role="status" className="text-muted">{extension === 'stillMissing' ? t('extensionStillMissing') : ''}</p>
        </div>
      ) : null}
    </div>
  );
}

function Account() {
  const t = useTranslations('chatgpt');
  const toMessage = useErrorMessage();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    apiGet<Status>('/api/chatgpt', AbortSignal.timeout(10_000)).then(setStatus, (e) => setError(toMessage(e)));
  }, [toMessage]);

  async function signOut(): Promise<void> {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiSend<{ revocationPending: boolean }>('POST', '/api/chatgpt/sign-out', undefined, AbortSignal.timeout(45_000));
      if (result.revocationPending) setNotice(t('revocationPending'));
      // The session is gone; the member layout sends the reader to the login page.
      await refreshSession();
    } catch (e) { setError(toMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="w-full max-w-sm space-y-3">
        {status?.connected ? (
          <p className="w-full truncate rounded-xl border border-line bg-mint-soft/40 px-3 py-3 text-sm" title={status.email ?? undefined}>
            {status.email ?? t('connectedAccount')}
          </p>
        ) : null}
        <Button className="w-full" busy={busy} onClick={() => void signOut()}>{t('disconnect')}</Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {notice ? <p role="status" className="text-sm text-muted">{notice}</p> : null}
    </>
  );
}
