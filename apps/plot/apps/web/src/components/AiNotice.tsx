'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

/** Remembers the dismissal per browser; there is nothing account-specific in it. */
const AI_NOTICE_KEY = 'shizue.aiNoticeDismissed';

/**
 * One-time disclosure that the conversation is with an AI (SB 243 / EU AI Act
 * Art. 50). Shown on the first chat the browser opens and dismissible from
 * there on; the permanent signal is the badge beside the character name.
 */
export function AiNotice() {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  /** null until the stored dismissal is known — nothing flashes before it is. */
  const [visible, setVisible] = useState<boolean | null>(null);

  useEffect(() => {
    setVisible(window.localStorage.getItem(AI_NOTICE_KEY) !== '1');
  }, []);

  if (!visible) return null;

  // Zeta's small centred line at the top of the conversation, ⓘ first.
  return (
    <div role="note" data-testid="ai-notice" className="flex justify-center">
      <p className="chat-meta inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-muted">
        <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-current text-[0.5625rem] font-semibold leading-none">
          i
        </span>
        <span className="min-w-0">{t('aiNotice')}</span>
        <button
          type="button"
          aria-label={common('close')}
          title={common('close')}
          onClick={() => {
            window.localStorage.setItem(AI_NOTICE_KEY, '1');
            setVisible(false);
          }}
          className="-mr-1 ml-0.5 shrink-0 rounded-full px-1 text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </p>
    </div>
  );
}

/** Permanent "this is an AI" marker, next to whatever names the character. */
export function AiBadge() {
  const t = useTranslations('chat');

  return (
    <span
      data-testid="ai-badge"
      title={t('aiBadgeHint')}
      className="rounded-full bg-raised px-1.5 py-0.5 caption2 text-muted"
    >
      {t('aiBadge')}
    </span>
  );
}
