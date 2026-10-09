'use client';

import { useTranslations } from 'next-intl';
import type { AssetUnlockKind } from '@/lib/types';

/**
 * A plot image this conversation has not opened yet, where the image would be.
 *
 * The condition itself is the creator's — its keywords are the spoiler the
 * reveal is worth having — so all the card carries is which *kind* of thing it
 * waits on. It stands in a message, which markdown gives it as a paragraph, so
 * every element here is phrasing content the way the failed-image card is.
 */
export function LockedImage({ kind }: { kind: AssetUnlockKind }) {
  const t = useTranslations('chat');
  const hint = t(`lockedHints.${kind}`);

  return (
    <span
      data-testid="locked-image"
      // One thing with one name, like the image it stands for. Not a live
      // region: a reply may hold several, and none of them is an interruption.
      role="img"
      aria-label={`${t('lockedImage')} — ${hint}`}
      className="my-2 flex max-w-full flex-col items-center gap-1 rounded-xl border border-dashed border-line bg-raised/40 px-4 py-8 text-center"
    >
      <span aria-hidden="true" className="text-base leading-none">
        🔒
      </span>
      <span className="text-xs text-muted">{t('lockedImage')}</span>
      <span className="text-xs tracking-wide text-fg/80">{hint}</span>
    </span>
  );
}
