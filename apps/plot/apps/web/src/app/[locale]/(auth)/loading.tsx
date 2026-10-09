'use client';

import { useTranslations } from 'next-intl';
import { Spinner } from '@/components/ui';

export default function AuthLoading() {
  const common = useTranslations('common');

  // The auth layout already centers whatever it is given, so the spinner needs
  // no frame of its own here.
  return <Spinner label={common('loading')} />;
}
