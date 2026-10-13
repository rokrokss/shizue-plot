'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { BottomSheet } from './BottomSheet';
import { Button, TextInput, cx } from './ui';

/**
 * What a card's script is asking the reader, waiting on an answer. RisuAI shows
 * these as its own alerts: a notice (`showAlert`, `v2ShowAlert`), a line of text
 * (`v2GetAlertInput`), a choice (`v2GetAlertSelect`). The text is the card's and
 * is shown as text, never as markup.
 */
export type ScriptPrompt =
  | { kind: 'alert'; text: string; error: boolean; resolve: () => void }
  | { kind: 'input'; text: string; resolve: (value: string) => void }
  | { kind: 'select'; text: string; options: string[]; resolve: (value: string) => void };

/**
 * The sheet a script's question comes up in. Closing it without an answer
 * answers with nothing — an empty string, as RisuAI's own dialogs give when
 * dismissed — so a run never waits on a sheet that is gone.
 */
export function ScriptDialog({ prompt, name, onDone }: { prompt: ScriptPrompt; name: string; onDone: () => void }) {
  const t = useTranslations('chat');
  const [value, setValue] = useState('');

  const answer = (text: string): void => {
    if (prompt.kind === 'alert') prompt.resolve();
    else prompt.resolve(text);
    onDone();
  };

  return (
    <BottomSheet title={t('scriptDialogTitle', { name })} onClose={() => answer('')}>
      <div data-testid="script-dialog" className="space-y-4">
        {prompt.text ? (
          <p className={cx('whitespace-pre-wrap text-sm', prompt.kind === 'alert' && prompt.error ? 'text-danger' : 'text-fg')}>
            {prompt.text}
          </p>
        ) : null}
        {prompt.kind === 'input' ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              answer(value);
            }}
          >
            <TextInput
              autoFocus
              aria-label={t('scriptDialogAnswer')}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="primary" size="sm">
              {t('scriptDialogOk')}
            </Button>
          </form>
        ) : prompt.kind === 'select' ? (
          <ul className="flex flex-col gap-2">
            {prompt.options.map((option, index) => (
              <li key={index}>
                <Button variant="secondary" className="w-full justify-start text-left" onClick={() => answer(option)}>
                  {option}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <Button variant="primary" size="sm" className="w-full" onClick={() => answer('')}>
            {t('scriptDialogOk')}
          </Button>
        )}
      </div>
    </BottomSheet>
  );
}
