'use client';

import { useTranslations } from 'next-intl';
import { useEffect, type ReactNode } from 'react';
import { Spinner } from '@/components/ui';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useSession } from '@/lib/authClient';

/**
 * Every page below this layout requires a session. An anonymous reader is sent
 * to the login page with where they were headed in hand, so signing in puts them
 * back here rather than at the front door.
 */
export default function MemberLayout({ children }: { children: ReactNode }) {
  const common = useTranslations('common');
  const { data, isPending } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (isPending || data) return;
    /*
     * The whole destination, query and all: a deep link like
     * `/chats/:id?panel=notes` is that param, and dropping it would sign the
     * reader in and then land them without their chosen chat panel. The pathname comes from
     * the locale-aware hook — so it is locale-free, the way `next` travels —
     * and the search from the URL itself, since only the browser has it here.
     * Encoded once, as one value.
     */
    const back = `${pathname}${window.location.search}`;
    router.replace(`/login?next=${encodeURIComponent(back)}`);
  }, [isPending, data, router, pathname]);

  if (isPending || !data) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={common('loading')} />
      </div>
    );
  }

  return <>{children}</>;
}
