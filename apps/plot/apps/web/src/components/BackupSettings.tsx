'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiDelete, apiGet, toApiError } from '@/lib/api';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Button, buttonClass, ErrorText } from './ui';

/** `GET /api/backup/restore`: whether this browser is the computer's, what waits for the next start, what was restored. */
interface RestoreStatus {
  local: boolean;
  pending: { stagedAt: string; backupCreatedAt: string } | null;
  restored: { restoredAt: string; backupCreatedAt: string; previous: string } | null;
}

/**
 * The settings card for a backup of the whole app folder and its restore
 * (the API's `backup.ts`), as RisuAI's and PocketRisu's backup pages offer
 * them: the backup is a download; a restore uploads the file, which the app
 * checks and unpacks beside its folder, and is switched to on the next start.
 * A restore is this computer's alone; a phone sees only the download.
 */
export function BackupSettings() {
  const t = useTranslations('backup');
  const format = useFormatter();
  const toMessage = useErrorMessage();
  const [status, setStatus] = useState<RestoreStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    apiGet<RestoreStatus>('/api/backup/restore').then(setStatus, (caught: unknown) => setError(toMessage(caught)));
  }, [toMessage]);
  useEffect(load, [load]);

  const when = (iso: string): string => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  /** The file goes up as the request's body, read by the API as it arrives. */
  async function restore(file: File): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/backup/restore', {
        method: 'PUT',
        headers: { 'content-type': 'application/x-tar' },
        body: file,
      });
      if (!res.ok) throw await toApiError(res);
      load();
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await apiDelete('/api/backup/restore');
      load();
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="backup-settings" className="min-w-0 space-y-5 rounded-2xl border border-line bg-surface p-6 shadow-card">
      <h2 className="title2">{t('title')}</h2>
      <p className="text-sm leading-relaxed text-muted">{t('description')}</p>
      <p className="text-sm leading-relaxed text-muted">{t('secretNote')}</p>
      <a href="/api/backup" download className={buttonClass('primary', 'md', 'w-full max-w-sm')}>
        {t('download')}
      </a>

      <div className="space-y-3 border-t border-line pt-5">
        <h3 className="heading3">{t('restoreTitle')}</h3>
        {status?.local === false ? (
          <p className="text-sm text-muted">{t('localOnly')}</p>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-muted">{t('restoreDescription')}</p>
            {status?.pending ? (
              <div role="status" className="space-y-3 rounded-xl border border-line bg-mint-soft/40 px-3 py-3 text-sm">
                <p>{t('pending', { date: when(status.pending.backupCreatedAt) })}</p>
                <Button size="sm" variant="secondary" busy={busy} onClick={() => void cancel()}>
                  {t('cancel')}
                </Button>
              </div>
            ) : null}
            <Button variant="secondary" className="w-full max-w-sm" busy={busy} disabled={!status} onClick={() => picker.current?.click()}>
              {busy ? t('restoring') : t('restoreChoose')}
            </Button>
            <input
              ref={picker}
              type="file"
              accept=".tar"
              className="hidden"
              data-testid="backup-file-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void restore(file);
              }}
            />
          </>
        )}
        {status?.restored ? (
          <p className="text-xs leading-relaxed break-all text-muted">
            {t('restored', { date: when(status.restored.backupCreatedAt), path: status.restored.previous })}
          </p>
        ) : null}
      </div>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
