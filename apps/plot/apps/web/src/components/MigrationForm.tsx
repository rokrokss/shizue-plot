'use client';

/**
 * The one form every source site is drawn with: its sections in the source
 * screen's order, under the source screen's own names, so a creator with the
 * source editor open beside it pastes field for field.
 *
 * The labels, aliases, options and source limits are schema data in Korean as
 * the source shows them — shown verbatim, because they are what the creator has
 * to find on the other screen. Everything around them is this app's copy. The
 * source limit is only advice; our own limits come back from the conversion as
 * warnings and are shown under the field they concern.
 */
import type { MigrationWarning, SiteField, SiteInput, SiteSchema, SiteSection } from '@shizue/core/migrate';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type KeyboardEvent } from 'react';
import {
  fieldPath,
  fieldValue,
  orderAfterAdd,
  orderAfterMove,
  orderAfterRemove,
  sectionRows,
  withField,
  withRowAdded,
  withRowMoved,
  withRowRemoved,
} from '@/lib/migrate/wizard';
import { Badge, Button, cx, TextArea, TextInput } from './ui';

/** A row reorder the caller has to follow with whatever it keys by row. */
export interface RowOrder {
  sectionId: string;
  /** `order[i]` is the old index of what is now row `i`; -1 for a new row. */
  order: number[];
}

/**
 * A warning's sentence, or its code where the catalogue has none. A component
 * subset violation is named the way the studio's component editor names it.
 */
export function useWarningText(): (warning: MigrationWarning) => string {
  const t = useTranslations('migrate.warnings');
  const plot = useTranslations('plot');
  return (warning) => {
    if (!t.has(warning.code)) return warning.code;
    const detail = { ...warning.detail };
    const violation = detail['violation'];
    if (typeof violation === 'string') {
      const rule = `subsetViolation.${violation.split(':')[0]}`;
      detail['violation'] = plot.has(rule) ? plot(rule) : violation;
    }
    return t(warning.code, detail);
  };
}

const PANEL = 'rounded-2xl border border-line bg-surface p-5 sm:p-6';

function Chips({
  field,
  path,
  value,
  onChange,
}: {
  field: SiteField;
  path: string;
  value: string | string[];
  onChange: (value: string | string[]) => void;
}) {
  const t = useTranslations('migrate.form');
  const chosen = Array.isArray(value) ? value : value ? [value] : [];
  const multi = field.kind === 'multiChoice';

  function pick(option: string): void {
    if (!multi) {
      onChange(chosen.includes(option) ? '' : option);
      return;
    }
    if (chosen.includes(option)) {
      onChange(chosen.filter((each) => each !== option));
      return;
    }
    // Past the cap, the oldest choice gives way — the same rule as the style editor's moods.
    const next = [...chosen, option];
    onChange(field.maxChoices && next.length > field.maxChoices ? next.slice(-field.maxChoices) : next);
  }

  return (
    <div className="space-y-1.5">
      <div role="group" aria-label={field.label} className="flex flex-wrap gap-1.5">
        {(field.options ?? []).map((option) => {
          const selected = chosen.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              data-testid={`migrate-choice-${path}-${option.value}`}
              aria-pressed={selected}
              onClick={() => pick(option.value)}
              className={cx(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                selected ? 'border-accent/60 bg-mint-soft text-fg' : 'border-line text-muted hover:text-fg',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <span className="block text-xs text-muted/80">
        {multi && field.maxChoices ? `${t('maxChoices', { max: field.maxChoices })} · ` : ''}
        {t('choiceHint')}
      </span>
    </div>
  );
}

function FieldBlock({
  field,
  path,
  value,
  warnings,
  onChange,
  onKeyDown,
}: {
  field: SiteField;
  path: string;
  value: string | string[];
  warnings: MigrationWarning[];
  onChange: (value: string | string[]) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const t = useTranslations('migrate.form');
  const warningText = useWarningText();
  const text = typeof value === 'string' ? value : '';
  const limit = field.sourceLimit;
  const limitText = limit?.chars
    ? t('sourceLimitChars', { count: limit.chars })
    : limit?.bytes
      ? t('sourceLimitBytes', { count: limit.bytes })
      : '';
  const id = `migrate-${path.replace(/[^\w-]/g, '-')}`;
  const choice = field.kind === 'choice' || field.kind === 'multiChoice';
  const control = {
    id,
    'data-testid': `migrate-field-${path}`,
    'data-field-path': path,
    value: text,
    placeholder: t('placeholder', { label: field.label }),
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    ...(onKeyDown ? { onKeyDown } : {}),
  };

  return (
    <div className="space-y-1.5" data-testid="migrate-field" data-path={path}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {choice ? (
          <span className="text-sm font-medium text-fg">{field.label}</span>
        ) : (
          <label htmlFor={id} className="text-sm font-medium text-fg">
            {field.label}
          </label>
        )}
        <Badge tone={field.visibility === 'ai' || field.visibility === 'meta' ? 'ai' : 'public'}>
          {t(`visibility.${field.visibility}`)}
        </Badge>
        {field.aliases && field.aliases.length > 0 ? (
          <span className="text-xs text-muted">{t('aliases', { names: field.aliases.join(', ') })}</span>
        ) : null}
      </div>

      {field.kind === 'line' ? <TextInput {...control} className="w-full" /> : null}
      {field.kind === 'keywords' ? <TextArea {...control} rows={2} className="w-full" /> : null}
      {field.kind === 'text' || field.kind === 'turns' ? (
        <TextArea {...control} rows={field.kind === 'turns' ? 6 : 5} className="w-full" />
      ) : null}
      {choice ? <Chips field={field} path={path} value={value} onChange={onChange} /> : null}

      {!choice ? (
        <p className="flex flex-wrap gap-x-3 text-xs text-muted/80">
          {field.kind === 'keywords' ? <span>{t('keywordsHint')}</span> : null}
          {field.kind === 'turns' ? <span>{t('turnsHint')}</span> : null}
          <span className="ml-auto tabular-nums">
            {t('length', { count: [...text].length })}
            {limitText ? ` / ${limitText}${limit?.unverified ? ` (${t('unverified')})` : ''}` : ''}
          </span>
        </p>
      ) : null}

      {warnings.map((warning, index) => (
        <p key={index} className="text-xs text-danger" data-testid="migrate-field-warning">
          {warningText(warning)}
        </p>
      ))}
    </div>
  );
}

function SectionBlock({
  section,
  input,
  warnings,
  onChange,
}: {
  section: SiteSection;
  input: SiteInput;
  warnings: MigrationWarning[];
  onChange: (input: SiteInput, reorder?: RowOrder) => void;
}) {
  const t = useTranslations('migrate.form');
  const rows = sectionRows(input, section);
  const repeat = section.repeat;
  const [focusPath, setFocusPath] = useState<string | null>(null);

  // A row added from the keyboard takes the focus, so pasting goes on without the mouse.
  useEffect(() => {
    if (!focusPath) return;
    document.querySelector<HTMLElement>(`[data-field-path="${CSS.escape(focusPath)}"]`)?.focus();
    setFocusPath(null);
  }, [focusPath]);

  const fieldsOf = (index: number | undefined) =>
    section.fields.map((field) => {
      const path = fieldPath(section.id, field.id, index);
      return (
        <FieldBlock
          key={field.id}
          field={field}
          path={path}
          value={fieldValue(rows[index ?? 0] ?? {}, field)}
          warnings={warnings.filter((warning) => warning.field === path)}
          onChange={(value) => onChange(withField(input, section, field.id, value, index ?? 0))}
          {...(index !== undefined && repeat
            ? {
                onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
                  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
                  if (rows.length >= repeat.max) return;
                  event.preventDefault();
                  onChange(withRowAdded(input, section, index), {
                    sectionId: section.id,
                    order: orderAfterAdd(rows.length, index),
                  });
                  const first = section.fields.find((each) => each.kind !== 'choice' && each.kind !== 'multiChoice');
                  if (first) setFocusPath(fieldPath(section.id, first.id, index + 1));
                },
              }
            : {})}
        />
      );
    });

  return (
    <section className={cx(PANEL, 'space-y-4')} data-testid="migrate-section" data-section={section.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="heading3 text-fg">{section.label}</h2>
        {repeat ? (
          <span className="text-xs text-muted tabular-nums">
            {t('rowCount', { count: rows.length, max: repeat.max })}
          </span>
        ) : null}
      </div>
      {!repeat ? <div className="space-y-4">{fieldsOf(undefined)}</div> : null}
      {repeat ? (
        <>
          <ol className="space-y-3">
            {rows.map((_, index) => (
              <li
                key={index}
                data-testid="migrate-row"
                data-section={section.id}
                className="space-y-3 rounded-xl border border-line bg-canvas/40 p-3 sm:p-4"
              >
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-auto text-xs font-medium text-muted">
                    {t('rowLabel', { section: section.label, number: index + 1 })}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() =>
                      onChange(withRowMoved(input, section, index, -1), {
                        sectionId: section.id,
                        order: orderAfterMove(rows.length, index, -1),
                      })
                    }
                  >
                    {t('moveUp')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === rows.length - 1}
                    onClick={() =>
                      onChange(withRowMoved(input, section, index, 1), {
                        sectionId: section.id,
                        order: orderAfterMove(rows.length, index, 1),
                      })
                    }
                  >
                    {t('moveDown')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={rows.length <= repeat.min}
                    aria-label={t('removeRow', { section: section.label, number: index + 1 })}
                    onClick={() =>
                      onChange(withRowRemoved(input, section, index), {
                        sectionId: section.id,
                        order: orderAfterRemove(rows.length, index),
                      })
                    }
                  >
                    {t('remove')}
                  </Button>
                </div>
                {fieldsOf(index)}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              data-testid={`migrate-add-${section.id}`}
              disabled={rows.length >= repeat.max}
              onClick={() =>
                onChange(withRowAdded(input, section), {
                  sectionId: section.id,
                  order: orderAfterAdd(rows.length, undefined),
                })
              }
            >
              {t('addRow', { section: section.label })}
            </Button>
            <span className="text-xs text-muted/80">{t('addRowKey')}</span>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Every section of a site's schema, in order. */
export function SiteForm({
  schema,
  input,
  warnings,
  onChange,
}: {
  schema: SiteSchema;
  input: SiteInput;
  /** The conversion's warnings; each shows under the field it names. */
  warnings: MigrationWarning[];
  onChange: (input: SiteInput, reorder?: RowOrder) => void;
}) {
  return (
    <div className="space-y-4" data-testid="migrate-form">
      {schema.sections.map((section) => (
        <SectionBlock
          key={section.id}
          section={section}
          input={input}
          warnings={warnings}
          onChange={onChange}
        />
      ))}
    </div>
  );
}
