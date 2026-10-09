'use client';

import { useTranslations } from 'next-intl';
import { Spinner } from '@/components/ui';

/**
 * What a reader sees while the next page is on its way. It stands in the same
 * place, and looks the same, as the wait for a session one level down under
 * `(member)` — so a navigation that has to do both reads as one wait, not two.
 */
export default function AppLoading() {
  const common = useTranslations('common');

  return (
    <div className="flex flex-1 items-center justify-center">
      <Spinner label={common('loading')} />
    </div>
  );
}
