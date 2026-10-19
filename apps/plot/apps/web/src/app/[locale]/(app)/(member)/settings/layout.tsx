import type { ReactNode } from 'react';
import { SettingsNav } from '@/components/SettingsNav';

/**
 * 설정, where everything a reader sets up is gathered. A wide screen keeps its
 * sections in a sidebar beside the one that is open; a narrow one opens on the
 * list of them (`/settings`, its page) and gives each a screen of its own.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl gap-10 px-4 py-6 sm:px-5 lg:py-10">
      <aside className="hidden w-52 shrink-0 lg:block">
        <div className="sticky top-20">
          <SettingsNav variant="sidebar" />
        </div>
      </aside>
      <div className="min-w-0 max-w-3xl flex-1">{children}</div>
    </div>
  );
}
