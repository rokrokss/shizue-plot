'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { encode } from 'uqr';
import { useRouter } from '@/i18n/navigation';
import { ApiError, apiDelete, apiGet, apiSend } from '@/lib/api';
import { DEVICE_PAIRING, phoneName, type PairedPhone } from '@/lib/devicePairing';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Button, ErrorText } from './ui';

/** `POST /api/devices/pair`: a one-time code and the origins a phone can open it at. */
interface Pairing { code: string; expiresAt: string; origins: string[] }

/**
 * `GET /api/devices`: the open tunnel, which one the button would open, every
 * address a phone can use, and whether this browser is the computer's (`local`)
 * or a paired phone's.
 */
interface PhoneAccess {
  tunnel: { kind: 'tailscale' | 'cloudflare'; origin: string } | null;
  available: { tailscale: boolean; cloudflare: boolean };
  /** The cloudflared the app downloads for itself, when there is nothing else to open with (the API's `cloudflared.ts`). */
  download?: { version: string; bytes: number; state: 'idle' | 'downloading' | 'failed'; received: number };
  origins: string[];
  local: boolean;
}

/** Where a phone lands with the code. It rides in the fragment, which never reaches a server or a proxy's log. */
const pairUrl = (origin: string, locale: string, code: string): string => `${origin}/${locale}/pair#${code}`;

/** How long the card waits for cloudflared to download before it gives up saying so. */
const DOWNLOAD_WAIT_MS = 15 * 60_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** m:ss until `at`, never below zero. */
const remaining = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * The settings card that opens a shizue running on this machine on a phone
 * (`DEVICE_PAIRING`), as PocketRisu's remote access does: one button opens the
 * tunnel (Tailscale Serve, else a Cloudflare Quick Tunnel — the API's `tunnel.ts`,
 * downloading cloudflared first, as PocketRisu's button does, when this machine
 * has neither) and shows a QR code carrying a one-time pairing code; the phone opens the
 * address and is let in as this computer's owner, using the ChatGPT this computer
 * connected (no extension runs on a phone). The computer lists the phones it let
 * in and can put any of them out. On a paired phone the card only says so, and
 * lets the phone leave.
 */
export function DevicePairing() {
  return DEVICE_PAIRING ? <PairingCard /> : null;
}

function PairingCard() {
  const t = useTranslations('devices');
  const locale = useLocale();
  const toMessage = useErrorMessage();
  const router = useRouter();
  const [access, setAccess] = useState<PhoneAccess | null>(null);
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

  useEffect(() => {
    apiGet<PhoneAccess>('/api/devices').then(setAccess, (e: unknown) => setError(toMessage(e)));
  }, [toMessage]);

  /** The phones this computer let in; only the computer may ask. */
  const [phones, setPhones] = useState<PairedPhone[] | null>(null);
  const loadPhones = useCallback(() => {
    apiGet<PairedPhone[]>('/api/devices/phones').then(setPhones, (e: unknown) => setError(toMessage(e)));
  }, [toMessage]);
  const local = access?.local === true;
  useEffect(() => {
    if (local) loadPhones();
  }, [local, loadPhones]);

  /** Puts one phone out, or all of them: their next request is refused until they pair again. */
  async function revoke(id?: string): Promise<void> {
    setBusy(true); setError('');
    try {
      await apiDelete(id ? `/api/devices/phones/${id}` : '/api/devices/phones');
      loadPhones();
    } catch (e) { setError(toMessage(e)); }
    finally { setBusy(false); }
  }

  const reachable = (access?.origins.length ?? 0) > 0;
  const tool = access?.available.tailscale ? 'tailscale' : access?.available.cloudflare ? 'cloudflare' : null;
  /** cloudflared to download before the tunnel can open. */
  const download = tool === null ? access?.download : undefined;
  const downloading = access?.download?.state === 'downloading';

  // A download this page did not start (a reload mid-way) still says how far it has come.
  useEffect(() => {
    if (!downloading || busy) return;
    const timer = setInterval(() => {
      apiGet<PhoneAccess>('/api/devices').then(setAccess, () => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [downloading, busy]);

  /** Downloads cloudflared on the server, saying how far it has come, until it is in place or has failed. */
  async function downloadCloudflared(): Promise<void> {
    let state = await apiSend<PhoneAccess>('POST', '/api/devices/cloudflared', undefined, AbortSignal.timeout(10_000));
    setAccess(state);
    const deadline = Date.now() + DOWNLOAD_WAIT_MS;
    while (state.download?.state === 'downloading' && Date.now() < deadline) {
      await wait(1000);
      state = await apiGet<PhoneAccess>('/api/devices', AbortSignal.timeout(10_000));
      setAccess(state);
    }
    if (!state.available.cloudflare) throw new Error(t('downloadFailed'));
  }

  async function pair(): Promise<void> {
    setPairing(await apiSend<Pairing>('POST', '/api/devices/pair', undefined, AbortSignal.timeout(10_000)));
    setNow(Date.now());
  }

  /** Opens the tunnel when none is open — Cloudflare takes up to half a minute — then makes the code. */
  async function start(): Promise<void> {
    setBusy(true); setError('');
    try {
      if (!reachable) {
        if (download) await downloadCloudflared();
        const openTunnel = () => apiSend<PhoneAccess>('POST', '/api/devices/tunnel', undefined, AbortSignal.timeout(45_000));
        try {
          setAccess(await openTunnel());
        } catch (e) {
          // The app's copy was not the pinned one (a newer pin, a damaged file): it is gone, so it comes again.
          if (!(e instanceof ApiError && e.code === 'cloudflared_unavailable')) throw e;
          await downloadCloudflared();
          setAccess(await openTunnel());
        }
      }
      await pair();
    } catch (e) { setError(toMessage(e)); }
    finally { setBusy(false); }
  }

  /** This phone leaves: its session ends, and the pairing page says how to come back. */
  async function leave(): Promise<void> {
    setBusy(true); setError('');
    try {
      await apiDelete('/api/devices/session');
      router.replace('/pair');
    } catch (e) { setError(toMessage(e)); setBusy(false); }
  }

  async function close(): Promise<void> {
    setBusy(true); setError('');
    try {
      setAccess(await apiSend<PhoneAccess>('DELETE', '/api/devices/tunnel', undefined, AbortSignal.timeout(20_000)));
      setPairing(null);
    } catch (e) { setError(toMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <section className="min-w-0 space-y-5 rounded-2xl border border-line bg-surface p-6 shadow-card">
      <h2 className="title2">{t('title')}</h2>
      <p className="text-sm leading-relaxed text-muted">{t('description')}</p>
      {access?.local === false ? (
        <>
          <p className="rounded-xl border border-line bg-mint-soft/40 px-3 py-3 text-sm">{t('pairedHere')}</p>
          <Button className="w-full max-w-sm" busy={busy} onClick={() => void leave()}>{t('leave')}</Button>
        </>
      ) : (
        <>
          {access?.tunnel ? (
            <p className="text-sm">
              {t(access.tunnel.kind === 'tailscale' ? 'openTailscale' : 'openCloudflare')}{' '}
              <span className="break-all text-muted">{access.tunnel.origin}</span>
            </p>
          ) : access && !reachable ? (
            <p className="text-sm leading-relaxed text-muted">
              {download?.state === 'downloading'
                ? t('downloading', { version: download.version, percent: Math.min(100, Math.floor((download.received / download.bytes) * 100)) })
                : download
                  ? t('viaDownload', { version: download.version, size: Math.round(download.bytes / 1e6) })
                  : t(tool === 'tailscale' ? 'viaTailscale' : tool === 'cloudflare' ? 'viaCloudflare' : 'noTool')}
            </p>
          ) : null}
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
          <div className="flex flex-wrap gap-2">
            <Button className="w-full max-w-sm" busy={busy || downloading} disabled={!access || (!reachable && tool === null && !download)} onClick={() => void start()}>
              {t(!reachable ? (download ? 'openDownload' : 'open') : pairing ? 'again' : 'start')}
            </Button>
            {access?.tunnel ? <Button variant="secondary" busy={busy} onClick={() => void close()}>{t('close')}</Button> : null}
          </div>
          {phones ? <PairedPhones phones={phones} busy={busy} onRevoke={(id) => void revoke(id)} /> : null}
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

/** The phones paired with this computer, each with the way to put it out — and all of them at once. */
function PairedPhones({
  phones,
  busy,
  onRevoke,
}: {
  phones: readonly PairedPhone[];
  busy: boolean;
  /** One phone by id, or every phone without one. */
  onRevoke: (id?: string) => void;
}) {
  const t = useTranslations('devices');
  const format = useFormatter();
  const [now] = useState(() => new Date());
  return (
    <div data-testid="paired-phones" className="space-y-3 border-t border-line pt-5">
      <h3 className="heading3">{t('phonesTitle')}</h3>
      {phones.length === 0 ? (
        <p className="text-sm text-muted">{t('phonesEmpty')}</p>
      ) : (
        <>
          <ul className="space-y-2">
            {phones.map((phone) => (
              <li key={phone.id} data-testid="paired-phone" className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{phoneName(phone.userAgent) ?? t('unknownDevice')}</p>
                  <p className="text-xs text-muted">
                    {t('pairedAt', { date: format.dateTime(new Date(phone.pairedAt), { dateStyle: 'medium' }) })} ·{' '}
                    {t('lastSeen', { time: format.relativeTime(new Date(phone.lastSeenAt), now) })}
                  </p>
                </div>
                <Button size="sm" variant="secondary" busy={busy} onClick={() => onRevoke(phone.id)}>{t('revoke')}</Button>
              </li>
            ))}
          </ul>
          {phones.length > 1 ? (
            <Button size="sm" variant="secondary" busy={busy} onClick={() => onRevoke()}>{t('revokeAll')}</Button>
          ) : null}
        </>
      )}
    </div>
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
 * alone must not let a browser into someone else's shizue.
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
      router.replace('/');
    } catch (e) { setError(toMessage(e)); setBusy(false); }
  }

  return (
    <section className="w-full max-w-md space-y-5 rounded-3xl border border-line bg-surface p-7 sm:p-10">
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
