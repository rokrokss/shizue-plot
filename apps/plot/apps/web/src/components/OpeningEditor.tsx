'use client';

import { useTranslations } from 'next-intl';
import { useLayoutEffect, useRef } from 'react';
import { insertSceneHeading } from '@/lib/sceneHeading';
import { PublicBadge } from './AudienceBadge';
import { Icon } from './Icon';
import { Button, Field, TextArea } from './ui';

/**
 * One opening in the studio: its text, the button that removes it, and under it
 * the quiet "장면 제목" action, which writes a `# ` line at the caret's line
 * (`insertSceneHeading`). The action reads the field's own caret, so each opening
 * holds its own textarea. It stands outside the field's `<label>`, whose name
 * would otherwise take its words.
 */
export function OpeningEditor({
  index,
  value,
  maxLength,
  onChange,
  onRemove,
}: {
  index: number;
  value: string;
  maxLength: number;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('plot');
  const common = useTranslations('common');
  const area = useRef<HTMLTextAreaElement>(null);
  /** Where the caret goes once the heading is in the field. */
  const caret = useRef<number | null>(null);

  // After the write lands, since a controlled field moves its caret to the end.
  useLayoutEffect(() => {
    const at = caret.current;
    if (at === null || !area.current) return;
    caret.current = null;
    area.current.focus();
    area.current.setSelectionRange(at, at);
  });

  function addSceneHeading(): void {
    const field = area.current;
    if (!field) return;
    const next = insertSceneHeading(value, field.selectionStart);
    if (next.text.length > maxLength) return;
    caret.current = next.caret;
    if (next.text !== value) onChange(next.text);
    else {
      field.focus();
      field.setSelectionRange(next.caret, next.caret);
    }
  }

  return (
    <div className="space-y-1">
      <Field label={t('introLabel', { index: index + 1 })} badge={<PublicBadge />}>
        <div className="flex gap-2">
          <TextArea
            ref={area}
            rows={5}
            value={value}
            data-testid="plot-intro"
            maxLength={maxLength}
            placeholder={t('introTextPlaceholder')}
            onChange={(event) => onChange(event.target.value)}
          />
          <Button variant="ghost" size="sm" aria-label={common('remove')} onClick={onRemove}>
            ✕
          </Button>
        </div>
      </Field>
      <button
        type="button"
        onClick={addSceneHeading}
        className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <Icon name="menu" className="size-3.5" />
        {t('sceneTitle')}
      </button>
    </div>
  );
}
