'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { PublicMember } from '@/lib/types';
import { Button, cx } from './ui';

/**
 * Who the next reply should center on, for a plot with more than one member on
 * the stage. One button in the composer row; the members open above it, since
 * the composer sits at the bottom of the screen. The pick is for one reply only
 * — the page clears it once a reply carrying it has landed.
 */
export function FocusPicker({
  members,
  selected,
  onChange,
}: {
  /** The members on the stage, in the creator's order. */
  members: readonly PublicMember[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useTranslations('chat');
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // A popover, not a dialog: a click anywhere else or Escape puts it away.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const names = members.filter((member) => selected.includes(member.id)).map((member) => member.name);

  return (
    <div ref={wrapper} className="relative min-w-0">
      <Button
        size="sm"
        variant={names.length > 0 ? 'secondary' : 'ghost'}
        data-testid="focus-picker"
        title={t('focusHint')}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="max-w-32 truncate">
          {names.length > 0 ? t('focusSelected', { names: names.join(', ') }) : t('focus')}
        </span>
      </Button>
      {open ? (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-56 space-y-2 rounded-lg border border-line bg-raised p-2 shadow-lg">
          <div role="group" aria-label={t('focus')} className="flex flex-wrap gap-1">
            {members.map((member) => {
              const on = selected.includes(member.id);
              return (
                <button
                  key={member.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    onChange(on ? selected.filter((id) => id !== member.id) : [...selected, member.id])
                  }
                  className={cx(
                    'rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    on ? 'bg-mint-soft font-medium text-fg' : 'text-muted hover:text-fg',
                  )}
                >
                  {member.name}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted/80">{t('focusHint')}</p>
        </div>
      ) : null}
    </div>
  );
}
