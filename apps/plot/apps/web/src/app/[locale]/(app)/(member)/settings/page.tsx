import { getTranslations } from 'next-intl/server';
import { BackupSettings } from '@/components/BackupSettings';
import { DevicePairing } from '@/components/DevicePairing';
import { DisplaySettings } from '@/components/DisplaySettings';
import { ModelSettings } from '@/components/ModelSettings';
import { SettingsNav } from '@/components/SettingsNav';
import { DEVICE_PAIRING } from '@/lib/devicePairing';

/**
 * 설정, everything a reader sets up, on one page that scrolls: AI (모델과 연결
 * — the models, ChatGPT, the API keys), then 앱 (화면, 휴대폰 연결, 백업과 복원).
 * A wide screen keeps a sidebar of the sections beside it (`SettingsNav`).
 * `error` is the code a ChatGPT connection that failed came back with (the
 * API's callback).
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  const t = await getTranslations('settings');
  // Each section clears the sticky header when the sidebar jumps to it.
  const section = 'scroll-mt-20 space-y-6';
  const group = 'mt-10 space-y-6';
  const label = 'text-xs font-medium text-muted';

  return (
    <div className="mx-auto flex w-full max-w-5xl gap-10 px-4 py-8 sm:px-5 lg:py-10">
      <aside className="hidden w-52 shrink-0 lg:block">
        <div className="sticky top-20">
          <SettingsNav />
        </div>
      </aside>
      <div className="min-w-0 max-w-3xl flex-1">
        <h1 className="title2 sm:title1">{t('title')}</h1>

        <div role="group" aria-label={t('groups.ai')} className={group}>
          <p aria-hidden="true" className={label}>
            {t('groups.ai')}
          </p>
          <div id="models" className={section}>
            <ModelSettings {...(typeof error === 'string' ? { chatgptError: error } : {})} />
          </div>
        </div>

        <div role="group" aria-label={t('groups.app')} className={group}>
          <p aria-hidden="true" className={label}>
            {t('groups.app')}
          </p>
          <div id="display" className={section}>
            <DisplaySettings />
          </div>
          {DEVICE_PAIRING ? (
            <div id="devices" className={section}>
              <DevicePairing />
            </div>
          ) : null}
          <div id="backup" className={section}>
            <BackupSettings />
          </div>
        </div>
      </div>
    </div>
  );
}
