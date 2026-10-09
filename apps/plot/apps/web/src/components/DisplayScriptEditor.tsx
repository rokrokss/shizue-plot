'use client';

import { displayScriptPatternError } from '@shizue/core/display-script';
import { useTranslations } from 'next-intl';
import type { DisplayScript } from '@/lib/types';
import { Button, Checkbox, ErrorText, Field, Select, TextArea, TextInput } from './ui';

const emptyScript = (order: number): DisplayScript => ({
  in: '',
  out: '',
  order,
  enabled: true,
});

/** '' stands for "no action"; the field is optional on the card. */
const ACTIONS = ['move_top', 'move_bottom', 'repeat_back'] as const;

/** An empty pattern is simply unfinished, not wrong. */
const patternError = (source: string): string | null =>
  source ? displayScriptPatternError(source) : null;

/**
 * Display scripts, in the shape of the lorebook editor next to it: a collapsed
 * row per entry, opened to edit. The regex is authored raw — it is the same
 * string a RisuAI card carries, so an imported card round-trips through here
 * without translation.
 */
export function DisplayScriptEditor({
  scripts,
  onChange,
}: {
  scripts: DisplayScript[];
  onChange: (scripts: DisplayScript[]) => void;
}) {
  const t = useTranslations('plot');
  const common = useTranslations('common');

  const update = (index: number, patch: Partial<DisplayScript>): void =>
    onChange(scripts.map((script, i) => (i === index ? { ...script, ...patch } : script)));

  return (
    <div className="space-y-3">
      {scripts.length === 0 ? <p className="text-sm text-muted">{t('displayScriptEmpty')}</p> : null}

      {scripts.map((script, index) => (
        <details
          key={index}
          data-testid="display-script"
          className="group rounded-lg border border-line bg-canvas/40 [&[open]]:bg-canvas/70"
        >
          <summary className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
            <span className="text-xs text-muted">{t('displayScriptEntry', { index: index + 1 })}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
              {script.in || t('displayScriptIn')}
            </span>
            {/* Folded shut, the mark is all there is to go on, so it says what is
                wrong rather than only that something is — the same sentence the
                opened row shows against the field. */}
            {patternError(script.in) ? (
              <span className="text-xs text-danger">
                <span aria-hidden>!</span>
                <span className="sr-only">{t(`patternError.${patternError(script.in)}`)}</span>
              </span>
            ) : null}
            {!script.enabled ? (
              <span className="text-xs text-muted line-through">{common('off')}</span>
            ) : null}
          </summary>

          <div className="space-y-4 border-t border-line px-3 py-4">
            <Field label={t('displayScriptIn')} hint={t('displayScriptInHint')}>
              <TextInput
                data-testid="display-script-in"
                value={script.in}
                spellCheck={false}
                className="font-mono"
                onChange={(event) => update(index, { in: event.target.value })}
              />
            </Field>
            {/* The same screen the API applies, run while it is still being typed:
                the save would be refused, and finding that out here is kinder. */}
            <div data-testid="display-script-error">
              <ErrorText>
                {patternError(script.in) ? t(`patternError.${patternError(script.in)}`) : ''}
              </ErrorText>
            </div>

            <Field label={t('displayScriptOut')} hint={t('displayScriptOutHint')}>
              <TextArea
                data-testid="display-script-out"
                rows={5}
                value={script.out}
                spellCheck={false}
                className="font-mono"
                onChange={(event) => update(index, { out: event.target.value })}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('displayScriptOrder')}>
                <TextInput
                  type="number"
                  value={script.order}
                  onChange={(event) => update(index, { order: Number(event.target.value) || 0 })}
                />
              </Field>
              <Field label={t('displayScriptAction')}>
                <Select
                  data-testid="display-script-action"
                  value={script.action ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    const { action: _dropped, ...rest } = script;
                    onChange(
                      scripts.map((entry, i) =>
                        i === index
                          ? value
                            ? { ...rest, action: value as DisplayScript['action'] }
                            : rest
                          : entry,
                      ),
                    );
                  }}
                >
                  <option value="">{t('displayScriptActionNone')}</option>
                  {ACTIONS.map((action) => (
                    <option key={action} value={action}>
                      {t(`displayScriptAction_${action}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => onChange(scripts.filter((_, i) => i !== index))}
                >
                  {common('delete')}
                </Button>
              </div>
            </div>

            <Checkbox
              label={t('displayScriptEnabled')}
              checked={script.enabled}
              onChange={(enabled) => update(index, { enabled })}
            />
          </div>
        </details>
      ))}

      <Button
        size="sm"
        data-testid="add-display-script"
        onClick={() => onChange([...scripts, emptyScript(scripts.length)])}
      >
        {t('addDisplayScript')}
      </Button>
    </div>
  );
}

/**
 * Seed values for the path-derived chat variables. Renaming a key rewrites the
 * map in place, so the row order the creator sees is the order they typed.
 */
export function DefaultVariablesEditor({
  variables,
  onChange,
}: {
  variables: Record<string, string>;
  onChange: (variables: Record<string, string>) => void;
}) {
  const t = useTranslations('plot');
  const common = useTranslations('common');
  const entries = Object.entries(variables);

  const write = (next: [string, string][]): void => {
    // Null-prototype: a creator may name a variable `__proto__`, and assigning
    // that key on an ordinary object drops it without a word.
    const map = Object.create(null) as Record<string, string>;
    for (const [key, value] of next) if (key.trim()) map[key.trim()] = value;
    onChange(map);
  };

  return (
    <div className="space-y-2">
      {entries.length === 0 ? <p className="text-sm text-muted">{t('defaultVariablesEmpty')}</p> : null}

      {entries.map(([key, value], index) => (
        <div key={index} className="flex items-center gap-2">
          <TextInput
            data-testid="variable-key"
            value={key}
            placeholder={t('variableKey')}
            aria-label={t('variableKey')}
            spellCheck={false}
            className="font-mono"
            onChange={(event) =>
              write(entries.map((entry, i) => (i === index ? [event.target.value, value] : entry)))
            }
          />
          <TextInput
            data-testid="variable-value"
            value={value}
            placeholder={t('variableValue')}
            aria-label={t('variableValue')}
            onChange={(event) =>
              write(entries.map((entry, i) => (i === index ? [key, event.target.value] : entry)))
            }
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={common('remove')}
            onClick={() => write(entries.filter((_, i) => i !== index))}
          >
            ✕
          </Button>
        </div>
      ))}

      <Button
        size="sm"
        data-testid="add-variable"
        // A blank key is not stored, so the new row lives in the map under a
        // placeholder name the creator is expected to replace.
        onClick={() => write([...entries, [`var${entries.length + 1}`, '']])}
      >
        {t('addVariable')}
      </Button>
    </div>
  );
}
