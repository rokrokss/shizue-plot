'use client';

import { useTranslations } from 'next-intl';
import type { LoreEntry } from '@/lib/types';
import { ListInput } from './ListInput';
import { Button, Checkbox, Field, Select, TextArea, TextInput } from './ui';

const emptyEntry = (): LoreEntry => ({
  keys: [],
  secondaryKeys: [],
  selective: false,
  content: '',
  enabled: true,
  constant: false,
  insertionOrder: 0,
  caseSensitive: false,
  useRegex: false,
  position: 'before_char',
});

export function LorebookEditor({
  entries,
  onChange,
}: {
  entries: LoreEntry[];
  onChange: (entries: LoreEntry[]) => void;
}) {
  const t = useTranslations('plot');
  const common = useTranslations('common');

  const update = (index: number, patch: Partial<LoreEntry>): void =>
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  return (
    <div className="space-y-3">
      {entries.length === 0 ? <p className="text-sm text-muted">{t('loreEmpty')}</p> : null}

      {entries.map((entry, index) => (
        <details
          key={index}
          className="group rounded-lg border border-line bg-canvas/40 [&[open]]:bg-canvas/70"
        >
          <summary className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
            <span className="text-xs text-muted">{t('loreEntry', { index: index + 1 })}</span>
            <span className="min-w-0 flex-1 truncate text-fg">
              {entry.keys.join(', ') || entry.content.slice(0, 40)}
            </span>
            {/* The star is shorthand a reader has to have been told about, so it
                carries the word it stands for rather than only its colour. */}
            {entry.constant ? (
              <span className="text-xs text-link/80">
                <span aria-hidden>★</span>
                <span className="sr-only">{t('loreConstant')}</span>
              </span>
            ) : null}
            {!entry.enabled ? (
              <span className="text-xs text-muted line-through">{common('off')}</span>
            ) : null}
          </summary>

          <div className="space-y-4 border-t border-line px-3 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('loreKeys')}>
                <ListInput value={entry.keys} onChange={(keys) => update(index, { keys })} />
              </Field>
              <Field label={t('loreSecondaryKeys')}>
                <ListInput
                  value={entry.secondaryKeys}
                  onChange={(secondaryKeys) => update(index, { secondaryKeys })}
                />
              </Field>
            </div>

            <Field label={t('loreContent')}>
              <TextArea
                rows={4}
                value={entry.content}
                onChange={(event) => update(index, { content: event.target.value })}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('lorePosition')}>
                <Select
                  value={entry.position}
                  onChange={(event) =>
                    update(index, { position: event.target.value as LoreEntry['position'] })
                  }
                >
                  <option value="before_char">{t('positionBeforeChar')}</option>
                  <option value="after_char">{t('positionAfterChar')}</option>
                </Select>
              </Field>
              <Field label={t('loreInsertionOrder')}>
                <TextInput
                  type="number"
                  value={entry.insertionOrder}
                  onChange={(event) =>
                    update(index, { insertionOrder: Number(event.target.value) || 0 })
                  }
                />
              </Field>
              <div className="flex items-end">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => onChange(entries.filter((_, i) => i !== index))}
                >
                  {common('delete')}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1">
              <Checkbox
                label={t('loreEnabled')}
                checked={entry.enabled}
                onChange={(enabled) => update(index, { enabled })}
              />
              <Checkbox
                label={t('loreConstant')}
                checked={entry.constant}
                onChange={(constant) => update(index, { constant })}
              />
              <Checkbox
                label={t('loreSelective')}
                checked={entry.selective}
                onChange={(selective) => update(index, { selective })}
              />
              <Checkbox
                label={t('loreCaseSensitive')}
                checked={entry.caseSensitive}
                onChange={(caseSensitive) => update(index, { caseSensitive })}
              />
              <Checkbox
                label={t('loreUseRegex')}
                checked={entry.useRegex}
                onChange={(useRegex) => update(index, { useRegex })}
              />
            </div>
          </div>
        </details>
      ))}

      <Button size="sm" onClick={() => onChange([...entries, emptyEntry()])}>
        {t('addLore')}
      </Button>
    </div>
  );
}
