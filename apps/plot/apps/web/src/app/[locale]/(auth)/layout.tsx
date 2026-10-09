import type { ReactNode } from 'react';
import { Brand } from '@/components/Brand';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { Link } from '@/i18n/navigation';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="brand-dots flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-6 sm:px-8">
        <Link href="/" className="rounded-md"><Brand /></Link>
        <LocaleSwitcher />
      </header>
      <main className="flex flex-1 items-center justify-center px-5 py-6 pb-12 sm:px-8">{children}</main>
    </div>
  );
}
