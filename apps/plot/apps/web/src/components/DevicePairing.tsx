'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { encode } from 'uqr';
import { useRouter } from '@/i18n/navigation';
import { apiSend } from '@/lib/api';
import { refreshSession, useSession } from '@/lib/authClient';
import { DEVICE_PAIRING } from '@/lib/devicePairing';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Button, ErrorText } from './ui';

/** `POST /api/devices/pair`: a one-time code and the origins a phone can open it at. */
interface Pairing { code: string; expiresAt: string; origins: string[] }

/** Where a phone lands with the code. It rides in the fragment, which never reaches a server or a proxy's log. */
const pairUrl = (origin: string, locale: string, code: string): string => `${origin}/${locale}/pair#${code}`;

/** m:ss until `at`, never below zero. */
const remaining = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * The settings card that connects a phone to a shizue running on this machine,
 * through a tunnel (`DEVICE_PAIRING`). Phones cannot finish Sign in with ChatGPT
 * (no extension runs there), so this browser asks for a one-time code and shows
 * it as a QR code; the phone opens it and joins this account.
 */
export function DevicePairing() {
  return DEVICE_PAIRING ? <PairingCard /> : null;
}

function PairingCard() {
  const t = useTranslations('devices');
  const locale = useLocale();
  const toMessage = useErrorMessage();
  const { data: session } = useSession();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const expiresAt = pairing ? new Date(pairing.expiresAt).getTime() : 0;
  const live = pairing !== null && expiresAt > now;

  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  async function start(): Promise<void> {
    setBusy(true); setError('');
    try {
      setPairing(await apiSend<Pairing>('POST', '/api/devices/pair', undefined, AbortSignal.timeout(10_000)));
      setNow(Date.now());
    } catch (e) { setError(toMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <section className="min-w-0 space-y-5 rounded-2xl border border-line bg-surface p-6 shadow-card">
      <h2 className="title2">{t('title')}</h2>
      <p className="text-sm leading-relaxed text-muted">{t('description')}</p>
      {session?.paired ? <p className="rounded-xl border border-line bg-mint-soft/40 px-3 py-3 text-sm">{t('pairedHere')}</p> : null}
      {live ? (
        <div className="space-y-4">
          {pairing.origins.map((origin) => (
            <figure key={origin} className="space-y-2">
              <QrCode value={pairUrl(origin, locale, pairing.code)} label={t('qrLabel')} />
              <figcaption className="text-xs break-all text-muted">{origin}</figcaption>
            </figure>
          ))}
          <p role="status" className="text-sm text-muted">{t('expiresIn', { time: remaining(expiresAt, now) })}</p>
        </div>
      ) : pairing ? <p role="status" className="text-sm text-muted">{t('expired')}</p> : null}
      <Button className="w-full max-w-sm" busy={busy} onClick={() => void start()}>{t(pairing ? 'again' : 'start')}</Button>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

/**
 * Dark modules on white whatever the theme: a phone's camera reads dark on light,
 * and not every scanner reads the inverse.
 */
function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 2 });
    const modules = qr.data.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : '')));
    return { size: qr.size, path: modules.join('') };
  }, [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges"
      className="size-56 rounded-xl border border-line" style={{ background: '#FFFFFF' }}>
      <path d={path} fill="#10302B" />
    </svg>
  );
}

/**
 * The phone's side, opened from the QR code. It asks before it connects: a link
 * alone must not sign a browser into someone else's account.
 */
export function PairDevice() {
  const t = useTranslations('devices');
  const router = useRouter();
  const toMessage = useErrorMessage();
  // `undefined` until the fragment is read, which only the browser can do.
  const [code, setCode] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useDocumentTitle(t('pairTitle'));

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    // A second run (strict mode, a remount) finds the address already cleared and keeps the code it read.
    if (!fragment) { setCode((read) => read ?? ''); return; }
    setCode(fragment);
    // Single use either way: kept out of the history and of a shared address.
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, []);

  async function claim(): Promise<void> {
    if (!code) return;
    setBusy(true); setError('');
    try {
      await apiSend<void>('POST', '/api/devices/claim', { code }, AbortSignal.timeout(15_000));
      await refreshSession();
      router.replace('/');
    } catch (e) { setError(toMessage(e)); setBusy(false); }
  }

  return (
    <section className="w-full max-w-md space-y-5 rounded-3xl border-2 border-fg bg-surface p-7 shadow-[6px_6px_0_var(--color-fg)] sm:p-10">
      <h1 className="title2">{t('pairTitle')}</h1>
      {code === '' ? <p className="text-sm leading-relaxed">{t('pairMissing')}</p> : (
        <>
          <p className="text-sm leading-relaxed text-muted">{t('pairDescription')}</p>
          <Button variant="primary" className="w-full" busy={busy || code === undefined} onClick={() => void claim()}>{t('pairConfirm')}</Button>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
