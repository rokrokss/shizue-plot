'use client';

import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useSession } from '@/lib/authClient';
import { returnTo } from '@/lib/nav';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { BrandGarden } from './Brand';
import { Icon } from './Icon';
import { ChatGPTConnection } from './ChatGPTConnection';

/** One entrance, including legacy /signup links. `error` is a failed sign-in's code, sent back by the callback. */
export function AuthForm({ next, error }: { next?: string | string[]; error?: string | string[] }) {
  const brand = useTranslations('brand');
  const chatgpt = useTranslations('chatgpt');
  const rebrand = useTranslations('rebrand');
  const router = useRouter();
  const { data: session } = useSession();
  const back = returnTo(next);
  useDocumentTitle(chatgpt('signIn'));

  useEffect(() => {
    if (session) router.replace(back);
  }, [session, router, back]);

  return (
    <div className="grid w-full max-w-5xl overflow-hidden rounded-3xl border-2 border-fg bg-surface shadow-[6px_6px_0_var(--color-fg)] lg:grid-cols-2">
      <div className="brand-dots flex flex-col justify-between border-b-2 border-fg bg-mint-soft p-7 sm:p-10 lg:border-r-2 lg:border-b-0">
        <div>
          <p className="text-xs font-semibold text-link">{rebrand('eyebrow')}</p>
          <h1 className="mt-4 whitespace-pre-line title24 sm:title32">{brand('catchphrase')}</h1>
          <p className="mt-4 hidden max-w-sm text-sm sm:block leading-relaxed text-muted">{brand('tagline')}</p>
        </div>
        <div className="hidden sm:block"><BrandGarden /></div>
        <ol className="mt-7 hidden space-y-3 sm:block">
          {(['stepExplore', 'stepMeet', 'stepWrite'] as const).map((step, index) => (
            <li key={step} className="flex items-center gap-3 text-sm font-medium">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-fg bg-surface font-sans font-semibold text-xs">{index + 1}</span>
              {rebrand(step)}
            </li>
          ))}
        </ol>
      </div>
      <div className="flex min-w-0 flex-col justify-center p-7 sm:p-10 lg:p-12">
        <span className="mb-5 hidden size-11 items-center justify-center rounded-xl border border-fg bg-accent sm:flex"><Icon name="book" /></span>
        <ChatGPTConnection entrance next={back} error={typeof error === 'string' ? error : undefined} />
      </div>
    </div>
  );
}
