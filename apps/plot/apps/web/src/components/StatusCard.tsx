'use client';

import { parseStatusEntries } from '@shizue/core/status-block';
import { useTranslations } from 'next-intl';
import { Fragment, useMemo, useState } from 'react';
import { useLinesTranslation, type BodyTranslation } from '@/lib/translation';

/**
 * 상태창 — the state of the scene as the turn left it, drawn under the message it
 * came with.
 *
 * Dimmed and collapsible, because it is the same handful of rows every turn: a
 * reader who wants it reads it, and one who does not folds it away once and never
 * sees it again (the page holds that answer per chat). What is inside is whatever
 * the model chose to report — the keys are its own — so the card only lays the
 * rows out and never expects a particular one.
 *
 * Where the row is translated, the rows are too: each key and each value is
 * text, read as RisuAI reads a message's words, and the card's layout is ours.
 */
export function StatusCard({
  status,
  collapsed,
  onToggle,
  translation,
}: {
  /** The block's contents, as `extractStatusBlock` returned them. */
  status: string;
  /**
   * Whether it is folded. Given by a chat, which remembers the answer for all of
   * its cards at once; without one the card simply answers for itself, so a
   * status block is never left with a fold that does nothing.
   */
  collapsed?: boolean | undefined;
  onToggle?: (() => void) | undefined;
  /** The row's translation, where it has one (`useRowTranslation`). */
  translation?: BodyTranslation | undefined;
}) {
  const t = useTranslations('chat');
  const entries = useMemo(() => parseStatusEntries(status), [status]);
  const [ownCollapsed, setOwnCollapsed] = useState(false);
  const folded = collapsed ?? ownCollapsed;
  // Keys and values apart, so no translator can move the colon; nothing while folded away.
  const words = useMemo(() => (folded ? [] : entries.flatMap((entry) => [entry.key, entry.value])), [folded, entries]);
  const { lines: shown, ref } = useLinesTranslation(words, translation);

  if (entries.length === 0) return null;

  return (
    <div ref={ref} data-testid="status-card" className="mt-3 rounded-lg border border-line bg-surface/40">
      <button
        type="button"
        aria-expanded={!folded}
        onClick={() => (onToggle ? onToggle() : setOwnCollapsed(!folded))}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <span aria-hidden="true">{folded ? '▸' : '▾'}</span>
        {t('statusWindow')}
      </button>
      {folded ? null : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-xs text-muted">
          {entries.map((entry, index) =>
            entry.key ? (
              <Fragment key={index}>
                <dt className="text-muted/70">{shown[index * 2] ?? entry.key}</dt>
                <dd className="min-w-0 text-fg/90">{shown[index * 2 + 1] ?? entry.value}</dd>
              </Fragment>
            ) : (
              // A line the model wrote without a key is a line, not a row.
              <dd key={index} className="col-span-2 text-fg/90">
                {shown[index * 2 + 1] ?? entry.value}
              </dd>
            ),
          )}
        </dl>
      )}
    </div>
  );
}
