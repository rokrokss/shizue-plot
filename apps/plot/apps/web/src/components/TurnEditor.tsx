'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toggleDirectionMarkup } from '@/lib/directionMarkup';
import { Icon } from './Icon';
import { Button, TextArea, cx } from './ui';

/** The round icon buttons beside the field, as the composer's. */
const ROUND =
  'flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-muted transition-colors hover:text-fg disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/**
 * Zeta's editor (2026-10-17 owner decision): it opens in the composer's place, the
 * chat still in view above it, and holds the text being edited whole — a scene in
 * `@이름:` marks (`lib/turnText`), or the reader's own turn as they wrote it. ✕
 * leaves it as it was, `*` wraps a direction as the composer's does, ✓ saves.
 * The caret starts at the end, where the reader most often has something to fix.
 *
 * A save that fails keeps the panel and the text: the page says what went wrong.
 */
export function TurnEditor({
  initial,
  label,
  disabled,
  onCancel,
  onSave,
}: {
  /** The text the panel opens with. */
  initial: string;
  /** What the field is, for a reader who hears it. */
  label: string;
  /** True while a reply streams — saving would fork under a moving head. */
  disabled: boolean;
  onCancel: () => void;
  onSave: (text: string) => Promise<void>;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  /** Where the caret goes once React has written a value the `*` button made. */
  const selection = useRef<[number, number] | null>(null);

  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    node.scrollTop = node.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const range = selection.current;
    if (!range) return;
    selection.current = null;
    field.current?.focus();
    field.current?.setSelectionRange(range[0], range[1]);
  }, [text]);

  const empty = !text.trim();

  async function save(): Promise<void> {
    if (busy || disabled || empty) return;
    if (text === initial) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      await onSave(text);
    } catch {
      // The page presents the error; the reader's text stays to try again with.
    } finally {
      setBusy(false);
    }
  }

  function direction(): void {
    const node = field.current;
    if (!node) return;
    const next = toggleDirectionMarkup(node.value, node.selectionStart, node.selectionEnd);
    selection.current = [next.selStart, next.selEnd];
    setText(next.value);
  }

  return (
    <div
      data-testid="turn-editor"
      className="mx-auto max-w-[1120px] px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
    >
      <fieldset disabled={busy} aria-busy={busy || undefined} className="min-w-0">
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 rounded-full bg-line" />
        <TextArea
          ref={field}
          aria-label={label}
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
          // Enter is the text's own, so the ways out are a field's usual two:
          // Escape leaves it as it was, Cmd/Ctrl+Enter saves. Never mid-composition.
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
              return;
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
          // 16px on a touch screen, below which iOS zooms the page in on focus.
          className="block max-h-[40dvh] min-h-24 w-full resize-none! overflow-y-auto rounded-none border-0 bg-transparent px-1! py-1 text-[0.938rem]/6 focus:outline-none! pointer-coarse:text-base/6"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <button type="button" aria-label={common('cancel')} title={common('cancel')} onClick={onCancel} className={ROUND}>
            <Icon name="close" className="size-4" />
          </button>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label={t('direction')}
              title={t('directionHint')}
              onClick={direction}
              className={ROUND}
            >
              {/* The asterisk sits high in its em box; the nudge centres the glyph. */}
              <span aria-hidden="true" className="translate-y-[0.18em] text-base leading-none">*</span>
            </button>
            <Button
              className={cx('size-8! shrink-0 rounded-full! px-0!')}
              variant="primary"
              aria-label={common('save')}
              title={disabled ? t('lockedWhileGenerating') : common('save')}
              busy={busy}
              disabled={disabled || empty}
              onClick={() => void save()}
            >
              <Icon name="check" className="size-4" />
            </Button>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
