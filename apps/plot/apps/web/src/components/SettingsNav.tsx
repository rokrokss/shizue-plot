'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { DEVICE_PAIRING } from '@/lib/devicePairing';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { cx } from './ui';

export type SettingsSection = 'models' | 'display' | 'devices' | 'backup';

/** 설정's sections in their groups, in the page's order; 휴대폰 연결 only where this app can pair a phone. */
export const SETTINGS_GROUPS: readonly { key: 'ai' | 'app'; sections: readonly SettingsSection[] }[] = [
  { key: 'ai', sections: ['models'] },
  { key: 'app', sections: DEVICE_PAIRING ? ['display', 'devices', 'backup'] : ['display', 'backup'] },
];

const SECTIONS = SETTINGS_GROUPS.flatMap((group) => group.sections);

/** How far below the top of the window a section's top has to come to count as the one being read. */
const READING_LINE = 120;

/**
 * 설정 is one page that scrolls through its sections; on a wide screen this
 * sidebar stands beside it. Each name jumps to its section (smoothly, unless
 * the reader asked for less motion), and the one being read is marked as the
 * page scrolls — the last once the page can scroll no further. It also names
 * the tab, as it is the page's one client piece that is always there.
 */
export function SettingsNav() {
  const t = useTranslations('settings');
  useDocumentTitle(t('title'));
  const [reading, setReading] = useState<SettingsSection>(SECTIONS[0]!);

  useEffect(() => {
    const update = (): void => {
      const height = document.documentElement.scrollHeight;
      const atEnd = height > window.innerHeight + 2 && window.innerHeight + window.scrollY >= height - 2;
      let current = SECTIONS[0]!;
      for (const section of SECTIONS) {
        const top = document.getElementById(section)?.getBoundingClientRect().top;
        if (top !== undefined && top <= READING_LINE) current = section;
      }
      setReading(atEnd ? SECTIONS[SECTIONS.length - 1]! : current);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <nav aria-label={t('title')} className="space-y-5">
      {SETTINGS_GROUPS.map((group) => (
        <div key={group.key}>
          <p className="px-3 pb-2 text-xs font-medium text-muted">{t(`groups.${group.key}`)}</p>
          <ul className="space-y-0.5">
            {group.sections.map((section) => (
              <li key={section}>
                <a
                  href={`#${section}`}
                  aria-current={reading === section ? 'location' : undefined}
                  onClick={(event) => {
                    const target = document.getElementById(section);
                    if (!target) return;
                    event.preventDefault();
                    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                    target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
                    history.replaceState(null, '', `#${section}`);
                  }}
                  className={cx(
                    'block rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                    reading === section ? 'bg-mint-soft text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg',
                  )}
                >
                  {t(`sections.${section}`)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
