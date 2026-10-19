'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { Icon } from './Icon';
import { ModelSettings } from './ModelSettings';

/**
 * One section of 설정: its name over its cards. On a narrow
 * screen, where the section is a screen of its own, a way back to the list
 * stands above the name; a wide screen has the sidebar for that. The tab is
 * named after the section unless the page names it (`documentTitle`).
 */
export function SettingsPage({
  title,
  documentTitle,
  children,
}: {
  title: string;
  documentTitle?: string;
  children: ReactNode;
}) {
  const t = useTranslations('settings');
  useDocumentTitle(documentTitle ?? title);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/settings"
          className="-ml-1 mb-3 inline-flex items-center gap-1 rounded-md text-sm text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:hidden"
        >
          <Icon name="back" className="size-4" />
          {t('title')}
        </Link>
        <h1 className="title2 sm:title1">{title}</h1>
      </div>
      {children}
    </div>
  );
}

/**
 * 모델과 연결: the models, ChatGPT and the API keys — `/settings/models`, and
 * `/settings` itself beside the sidebar. `chatgptError` is the code a ChatGPT
 * connection that failed came back with (the API's callback).
 */
export function ModelsSettings({ chatgptError, documentTitle }: { chatgptError?: string; documentTitle?: string }) {
  const t = useTranslations('settings');
  return (
    <SettingsPage title={t('items.models')} {...(documentTitle ? { documentTitle } : {})}>
      <ModelSettings {...(chatgptError ? { chatgptError } : {})} />
    </SettingsPage>
  );
}
