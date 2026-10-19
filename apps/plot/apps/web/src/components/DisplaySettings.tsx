'use client';

import { useTranslations } from 'next-intl';
import { LocaleSwitcher } from './LocaleSwitcher';
import { ThemeSwitcher } from './ThemeSwitcher';

/** 설정's 화면 card: the language and the theme (dark or light), a row each. */
export function DisplaySettings() {
  const t = useTranslations('settings');
  const nav = useTranslations('nav');
  return (
    <section className="min-w-0 space-y-3 rounded-2xl border border-line bg-surface p-6 shadow-card">
      <h2 className="title2">{t('sections.display')}</h2>
      <div className="divide-y divide-line">
        {/* The selects carry their own names; the words beside them are for the eye. */}
        <div className="flex items-center justify-between gap-4 py-3">
          <span aria-hidden="true" className="body14">
            {nav('language')}
          </span>
          <LocaleSwitcher />
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <span aria-hidden="true" className="body14">
            {nav('theme')}
          </span>
          <ThemeSwitcher />
        </div>
      </div>
    </section>
  );
}
