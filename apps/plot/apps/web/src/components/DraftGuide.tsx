'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { readDraftGuideOpen, writeDraftGuideOpen } from '@/lib/draftPrefs';
import { cx } from './ui';

/** The guide's entries, in reading order: what goes in, who writes it, what comes out, which to pick. */
const ENTRIES = ['Input', 'Model', 'Result', 'Choice'] as const;

/**
 * How the AI draft works, for the creator who wants to know before pressing it
 * — and out of the way of the one who does not. Collapsed until opened; this
 * browser remembers the answer, as it does a folded 상태창.
 *
 * The body stays in the page so it can open and close with a height transition
 * (a grid row from 0fr to 1fr); `inert` is what takes it out of the tab order
 * and the accessibility tree while it is closed. Reduced motion drops the
 * transition, and the global rule in globals.css would anyway.
 *
 * Read from storage in the initial state rather than an effect: the draft panel
 * mounts this only after a click, so it is never server-rendered and an open
 * guide does not animate open on every visit.
 */
export function DraftGuide() {
  const t = useTranslations('plots');
  const id = useId();
  const [open, setOpen] = useState(readDraftGuideOpen);

  return (
    <div>
      <button
        type="button"
        data-testid="draft-guide-toggle"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => {
          writeDraftGuideOpen(!open);
          setOpen(!open);
        }}
        className="inline-flex items-center gap-1.5 rounded-md py-1 text-xs font-medium text-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {/* `aria-expanded` already says which way it is turned. */}
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        {t('draftGuide')}
      </button>
      <div
        id={`${id}-body`}
        data-testid="draft-guide"
        inert={!open}
        className={cx(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <dl className="mt-2 space-y-3 rounded-lg border border-line bg-raised/50 p-3">
            {ENTRIES.map((entry) => (
              <div key={entry} className="space-y-0.5">
                <dt className="text-xs font-medium text-fg">{t(`draftGuide${entry}Term`)}</dt>
                <dd className="text-xs leading-relaxed text-muted">{t(`draftGuide${entry}`)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
