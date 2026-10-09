'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { addTag, MAX_TAGS, RESERVED_TAGS } from '@/lib/hub';
import { TextInput } from './ui';

/**
 * Chip editor for `card.tags`. Enter or a comma commits the draft; the caps
 * mirror the server so what you see is what the explore filter stores. The genre
 * suggestions below are ordinary tags — picking one is the same as typing it.
 */
export function TagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}) {
  const common = useTranslations('common');
  const t = useTranslations('plot');
  const [draft, setDraft] = useState('');

  function commit(raw: string): void {
    setDraft('');
    const next = addTag(value, raw);
    if (next !== value) onChange(next);
  }

  const suggestions = RESERVED_TAGS.filter((tag) => !value.includes(tag));

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                title={common('remove')}
                // The field label wraps this button, so without an explicit name
                // it would inherit the whole label's text.
                aria-label={common('removeItem', { item: tag })}
                onClick={() => onChange(value.filter((item) => item !== tag))}
                className="flex items-center gap-1.5 rounded-full bg-raised px-2.5 py-1 text-xs text-fg transition-colors hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {tag}
                <span aria-hidden>✕</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <TextInput
        data-testid="tag-input"
        value={draft}
        placeholder={placeholder}
        disabled={value.length >= MAX_TAGS}
        onChange={(event) => {
          const text = event.target.value;
          if (text.endsWith(',')) commit(text.slice(0, -1));
          else setDraft(text);
        }}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(draft);
          } else if (event.key === 'Backspace' && !draft && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
      />
      {suggestions.length > 0 && value.length < MAX_TAGS ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted/80">{t('genreSuggestions')}</p>
          <ul className="flex flex-wrap gap-1.5">
            {suggestions.map((tag) => (
              <li key={tag}>
                <button
                  type="button"
                  data-testid="genre-suggestion"
                  onClick={() => commit(tag)}
                  className="rounded-full border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent/60 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {tag}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
