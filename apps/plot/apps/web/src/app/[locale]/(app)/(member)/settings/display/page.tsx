'use client';

import { useTranslations } from 'next-intl';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { SettingsPage } from '@/components/SettingsPage';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';

/** 설정 › 화면: the language and the theme, a row each. */
export default function DisplaySettingsPage() {
  const t = useTranslations('settings');
  const nav = useTranslations('nav');
  return (
    <SettingsPage title={t('items.display')}>
      <section className="divide-y divide-line rounded-2xl border border-line bg-surface shadow-card">
        {/* The selects carry their own names; the words beside them are for the eye. */}
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <span aria-hidden="true" className="body14">
            {nav('language')}
          </span>
          <LocaleSwitcher />
        </div>
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <span aria-hidden="true" className="body14">
            {nav('theme')}
          </span>
          <ThemeSwitcher />
        </div>
      </section>
    </SettingsPage>
  );
}
