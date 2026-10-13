import type { ReactNode } from 'react';
import { Brand } from '@/components/Brand';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';
import { Link } from '@/i18n/navigation';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="brand-dots flex min-h-dvh flex-col">
      {/* At 320px the two pickers and the wordmark do not fit one row in every
          language, so the pickers wrap below it, still at the right. */}
      <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-y-3 px-5 py-6 sm:px-8">
        <Link href="/" className="rounded-md"><Brand /></Link>
        <div className="ml-auto flex items-center gap-2">
          <LocaleSwitcher />
          <ThemeSwitcher />
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-5 py-6 pb-12 sm:px-8">{children}</main>
    </div>
  );
}
