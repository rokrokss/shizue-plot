'use client';

import { useTranslations } from 'next-intl';
import { LORE_SELECTIVE_LOGICS, type LoreEntry, type LoreRole, type LoreSelectiveLogic } from '@/lib/types';
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

/** The advanced fields that hold a number, each absent until the creator sets it. */
type LoreNumberField =
  | 'depth'
  | 'probability'
  | 'groupWeight'
  | 'scanDepth'
  | 'sticky'
  | 'cooldown'
  | 'delay';

type LorePosition = LoreEntry['position'];

/**
 * Every position an entry may take, with its label: the two around the cast,
 * then SillyTavern's — around the author's note, around the example dialogue,
 * and an outlet. Mirrors `LORE_POSITIONS` in @shizue/core.
 */
const POSITION_LABELS = {
  before_char: 'positionBeforeChar',
  after_char: 'positionAfterChar',
  before_author_note: 'positionBeforeAuthorNote',
  after_author_note: 'positionAfterAuthorNote',
  before_examples: 'positionBeforeExamples',
  after_examples: 'positionAfterExamples',
  outlet: 'positionOutlet',
} as const satisfies Record<LorePosition, string>;
const LORE_POSITIONS = Object.keys(POSITION_LABELS) as LorePosition[];

/** Roles a depth entry may speak in; absent reads as system. */
const LORE_ROLES = ['system', 'user', 'assistant'] as const satisfies readonly LoreRole[];

/** The message-count fields, in the order a timeline reads them. */
const TIMING_FIELDS = [
  ['scanDepth', 'loreScanDepth', 1000],
  ['delay', 'loreDelay', 10_000],
  ['sticky', 'loreSticky', 10_000],
  ['cooldown', 'loreCooldown', 10_000],
] as const;

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

  // An outlet's name only means something on an outlet, so it leaves with it.
  const setPosition = (index: number, position: LorePosition): void =>
    onChange(
      entries.map((entry, i) => {
        if (i !== index) return entry;
        const next = { ...entry, position };
        if (position !== 'outlet') delete next.outletName;
        return next;
      }),
    );

  // An emptied field goes back to absent — the default — rather than to 0, which
  // for most of these means something else entirely.
  const setOptional = (index: number, field: LoreNumberField | 'group', raw: string): void =>
    onChange(
      entries.map((entry, i) => {
        if (i !== index) return entry;
        const next = { ...entry };
        if (field === 'group') {
          if (raw.trim()) next.group = raw;
          else delete next.group;
        } else if (raw.trim() && Number.isFinite(Number(raw))) {
          next[field] = Number(raw);
        } else {
          delete next[field];
          // A role only means something on a depth entry, so it leaves with the depth.
          if (field === 'depth') delete next.role;
        }
        return next;
      }),
    );

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
              {entry.name || entry.keys.join(', ') || entry.content.slice(0, 40)}
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
            <Field label={t('loreName')} hint={t('loreNameHint')}>
              <TextInput
                value={entry.name ?? ''}
                onChange={(event) => update(index, { name: event.target.value })}
              />
            </Field>

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
                  onChange={(event) => setPosition(index, event.target.value as LorePosition)}
                >
                  {LORE_POSITIONS.map((position) => (
                    <option key={position} value={position}>
                      {t(POSITION_LABELS[position])}
                    </option>
                  ))}
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

            {entry.position === 'outlet' ? (
              <Field label={t('loreOutletName')} hint={t('loreOutletNameHint')}>
                <TextInput
                  value={entry.outletName ?? ''}
                  onChange={(event) => update(index, { outletName: event.target.value })}
                />
              </Field>
            ) : null}

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

            <details className="rounded-lg border border-line bg-surface/60">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-muted">
                {t('loreAdvanced')}
              </summary>
              <div className="space-y-4 border-t border-line px-3 py-3">
                <p className="text-xs text-muted/80">{t('loreAdvancedHint')}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('loreDepth')} hint={t('loreDepthHint')}>
                    <TextInput
                      type="number"
                      min={0}
                      max={1000}
                      value={entry.depth ?? ''}
                      onChange={(event) => setOptional(index, 'depth', event.target.value)}
                    />
                  </Field>
                  <Field label={t('loreRole')}>
                    <Select
                      value={entry.role ?? 'system'}
                      disabled={entry.depth === undefined}
                      onChange={(event) => update(index, { role: event.target.value as LoreRole })}
                    >
                      {LORE_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t(`loreRoles.${role}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('loreSelectiveLogic')}>
                    <Select
                      value={entry.selectiveLogic ?? 'and_any'}
                      disabled={!entry.selective}
                      onChange={(event) =>
                        update(index, { selectiveLogic: event.target.value as LoreSelectiveLogic })
                      }
                    >
                      {LORE_SELECTIVE_LOGICS.map((logic) => (
                        <option key={logic} value={logic}>
                          {t(`loreLogic.${logic}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('loreProbability')}>
                    <TextInput
                      type="number"
                      min={0}
                      max={100}
                      placeholder="100"
                      value={entry.probability ?? ''}
                      onChange={(event) => setOptional(index, 'probability', event.target.value)}
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
                  <Field label={t('loreGroup')} hint={t('loreGroupHint')}>
                    <TextInput
                      value={entry.group ?? ''}
                      onChange={(event) => setOptional(index, 'group', event.target.value)}
                    />
                  </Field>
                  <Field label={t('loreGroupWeight')}>
                    <TextInput
                      type="number"
                      min={1}
                      max={1000}
                      placeholder="100"
                      value={entry.groupWeight ?? ''}
                      onChange={(event) => setOptional(index, 'groupWeight', event.target.value)}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {TIMING_FIELDS.map(([field, label, max]) => (
                    <Field key={field} label={t(label)}>
                      <TextInput
                        type="number"
                        min={0}
                        max={max}
                        value={entry[field] ?? ''}
                        onChange={(event) => setOptional(index, field, event.target.value)}
                      />
                    </Field>
                  ))}
                </div>
              </div>
            </details>
          </div>
        </details>
      ))}

      <Button size="sm" onClick={() => onChange([...entries, emptyEntry()])}>
        {t('addLore')}
      </Button>
    </div>
  );
}
