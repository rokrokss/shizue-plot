'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { PublicMember } from '@/lib/types';
import { Avatar } from './Avatar';
import { Button, cx } from './ui';

/**
 * Whom the reader writes the turn as (Zeta's write-as): themselves, or a member
 * whose line they write for them — the composer then sends every line as
 * `@이름: …` (`composeTurn`); the narrator is written `@: …`. One button at the
 * top of the chat's settings sheet whose choices open under it; the choice stays
 * until the reader changes it.
 */
export function WriteAsPicker({
  members,
  selected,
  onChange,
}: {
  /** The members a line may be written as, in the creator's order. */
  members: readonly PublicMember[];
  /** A member's id, or null for the reader's own voice. */
  selected: string | null;
  onChange: (id: string | null) => void;
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

  const chosen = members.find((member) => member.id === selected);
  const pick = (id: string | null): void => {
    onChange(id);
    setOpen(false);
  };
  const option = (on: boolean): string =>
    cx(
      'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
      on ? 'bg-mint-soft font-medium text-fg' : 'text-muted hover:text-fg',
    );

  return (
    <div ref={wrapper} className="relative min-w-0">
      <Button
        size="sm"
        variant={chosen ? 'secondary' : 'ghost'}
        data-testid="write-as"
        title={t('writeAsHint')}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="max-w-32 truncate">{chosen ? t('writeAsMember', { name: chosen.name }) : t('writeAsSelf')}</span>
      </Button>
      {open ? (
        <div className="absolute top-full left-0 z-20 mt-1 w-56 space-y-2 rounded-lg border border-line bg-raised p-2 shadow-card">
          <div role="group" aria-label={t('writeAs')} className="space-y-0.5">
            <button type="button" aria-pressed={!chosen} onClick={() => pick(null)} className={option(!chosen)}>
              {t('writeAsSelf')}
            </button>
            {members.map((member) => (
              <button
                key={member.id}
                type="button"
                aria-pressed={member.id === chosen?.id}
                onClick={() => pick(member.id)}
                className={option(member.id === chosen?.id)}
              >
                {/* The name follows; the face is decoration beside it. */}
                <span aria-hidden="true">
                  <Avatar src={member.avatarUrl} name={member.name} className="size-5 text-[10px]" />
                </span>
                <span className="truncate">{t('writeAsMember', { name: member.name })}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">{t('writeAsHint')}</p>
        </div>
      ) : null}
    </div>
  );
}
