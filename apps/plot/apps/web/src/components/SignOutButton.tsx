'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { signOut } from '@/lib/authClient';

/** The one control the header can never hand to a sheet: the way back out. */
export function SignOutButton() {
  const t = useTranslations('nav');
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  return (
    <button
      type="button"
      disabled={leaving}
      onClick={async () => {
        setLeaving(true);
        // A sign-out that fails leaves the reader here, so the button has to come
        // back; on the way out the router unmounts it before this ever runs.
        try {
          await signOut();
          router.replace('/login');
        } finally {
          setLeaving(false);
        }
      }}
      className="rounded-lg px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50"
    >
      {t('signOut')}
    </button>
  );
}
