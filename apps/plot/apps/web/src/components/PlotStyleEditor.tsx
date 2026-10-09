'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { withNarratorField } from '@/lib/narrator';
import { withPlotStyleField } from '@/lib/plotStyle';
import {
  CHOICES_MODES,
  MAX_PLOT_MOODS,
  NARRATIVE_DELIVERIES,
  REPLY_LENGTHS,
  PLOT_DIFFICULTIES,
  PLOT_MOODS,
  PLOT_PACINGS,
  PLOT_TENSES,
  STORYTELLING_STYLES,
  type ChoicesMode,
  type NarrativeDelivery,
  type NarratorConfig,
  type NarratorPov,
  type ReplyLength,
  type PlotDifficulty,
  type PlotMood,
  type PlotPacing,
  type PlotStyle,
  type PlotTense,
  type StorytellingStyle,
} from '@/lib/types';
import { AiBadge } from './AudienceBadge';
import { Checkbox, Field, Select, TextArea, cx } from './ui';

/** The option a row shows for "the model decides", which is no option at all. */
const UNSET = '';

/**
 * One option, as a chip. The tag pill's shape and the intro picker's two states —
 * the chosen one carries the accent line, the rest stay in the warm greys until
 * they are pointed at.
 */
function Chip({
  name,
  value,
  label,
  selected,
  onSelect,
}: {
  name: string;
  value: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`style-${name}-${value || 'unset'}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={cx(
        'rounded-full border px-3 py-1 text-xs transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        selected ? 'border-accent/60 bg-raised text-fg' : 'border-line text-muted hover:text-fg',
      )}
    >
      {label}
    </button>
  );
}

/**
 * One style option and its chips. The label, every chip's name and the one-line
 * guide are all read off the option's own key, so a row is named once: `tense`
 * has `tenseOptions.past` beside it and `tenseHints.past` under it.
 *
 * The guide is the chosen option's rather than one line per chip: eight styles
 * with a sentence each is a wall of text to pick from, and what a creator wants
 * to read is what the thing they just pressed will do.
 */
function OptionRow({
  name,
  options,
  value,
  onSelect,
}: {
  /** The style key this row sets, and the prefix of its label and hint keys. */
  name: string;
  options: readonly string[];
  /** The chosen option; '' is the row's own "unset". */
  value: string;
  onSelect: (value: string) => void;
}) {
  const t = useTranslations('style');
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-fg">{t(name)}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <Chip
            key={option || 'unset'}
            name={name}
            value={option}
            label={t(`${name}Options.${option || 'unset'}`)}
            selected={option === value}
            onSelect={() => onSelect(option)}
          />
        ))}
      </div>
      <span className="block text-xs text-muted/80">
        {t(`${name}Hints.${value || 'unset'}`)}
      </span>
    </div>
  );
}

/** A group of rows, set apart the way the notes panel sets its sections apart. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4 border-t border-line pt-5 first:border-0 first:pt-0">
      <h3 className="text-xs font-medium text-muted">{title}</h3>
      {children}
    </section>
  );
}

/**
 * How the creator wants the work written: the directives the assembler compiles,
 * and the two features derived from them. Four groups — the prose itself, how the
 * plot moves, the genre it is played in, and what the reader gets on top.
 *
 * The narrator lives here too rather than beside the world's description: the
 * voice and the point of view are style, and a creator setting the tense wants
 * them within reach. Nothing saves on its own — the plot editor's one Save carries the
 * style as it carries every other field of the plot.
 */
export function PlotStyleEditor({
  style,
  narrator,
  onChange,
  onChangeNarrator,
}: {
  /** Null while the creator left every option alone. */
  style: PlotStyle | null;
  narrator: NarratorConfig | null;
  /** Null once the style says nothing at all, which is how the column empties. */
  onChange: (style: PlotStyle | null) => void;
  onChangeNarrator: (narrator: NarratorConfig | null) => void;
}) {
  const t = useTranslations('style');
  const plot = useTranslations('plot');

  const set = (values: Partial<PlotStyle>): void => onChange(withPlotStyleField(style, values));

  const moods = style?.moods ?? [];
  /**
   * The cap holds by making room rather than refusing: a third pick drops the
   * oldest, so a creator changing their mind never has to clear a chip first.
   */
  function toggleMood(mood: PlotMood): void {
    set({
      moods: moods.includes(mood)
        ? moods.filter((current) => current !== mood)
        : [...moods, mood].slice(-MAX_PLOT_MOODS),
    });
  }

  return (
    <div data-testid="plot-style" className="space-y-5">
      <Group title={t('groupProse')}>
        <Field label={plot('narratorVoice')} hint={plot('narratorVoiceHint')} badge={<AiBadge />}>
          <TextArea
            rows={3}
            value={narrator?.voice ?? ''}
            onChange={(event) =>
              onChangeNarrator(withNarratorField(narrator, { voice: event.target.value }))
            }
          />
        </Field>
        <Field label={plot('narratorPov')} hint={plot('narratorPovHint')} badge={<AiBadge />}>
          <Select
            value={narrator?.pov ?? ''}
            onChange={(event) =>
              onChangeNarrator(
                withNarratorField(narrator, {
                  pov: (event.target.value as NarratorPov | '') || undefined,
                }),
              )
            }
          >
            <option value="">{plot('narratorPovUnset')}</option>
            <option value="first">{plot('narratorPovFirst')}</option>
            <option value="third">{plot('narratorPovThird')}</option>
            <option value="omniscient">{plot('narratorPovOmniscient')}</option>
          </Select>
        </Field>
        <OptionRow
          name="tense"
          options={[UNSET, ...PLOT_TENSES]}
          value={style?.tense ?? UNSET}
          onSelect={(value) => set({ tense: (value as PlotTense) || undefined })}
        />
        <OptionRow
          name="replyLength"
          options={REPLY_LENGTHS}
          value={style?.replyLength ?? 'auto'}
          onSelect={(value) => set({ replyLength: value as ReplyLength })}
        />
        <OptionRow
          name="delivery"
          options={NARRATIVE_DELIVERIES}
          value={style?.delivery ?? 'balanced'}
          onSelect={(value) => set({ delivery: value as NarrativeDelivery })}
        />
      </Group>

      <Group title={t('groupPlot')}>
        <OptionRow
          name="pacing"
          options={PLOT_PACINGS}
          value={style?.pacing ?? 'natural'}
          onSelect={(value) => set({ pacing: value as PlotPacing })}
        />
        <OptionRow
          name="difficulty"
          options={PLOT_DIFFICULTIES}
          value={style?.difficulty ?? 'normal'}
          onSelect={(value) => set({ difficulty: value as PlotDifficulty })}
        />
      </Group>

      <Group title={t('groupGenre')}>
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-fg">{t('moods')}</span>
          <div className="flex flex-wrap gap-1.5">
            {PLOT_MOODS.map((mood) => (
              <Chip
                key={mood}
                name="moods"
                value={mood}
                label={t(`moodOptions.${mood}`)}
                selected={moods.includes(mood)}
                onSelect={() => toggleMood(mood)}
              />
            ))}
          </div>
          <span className="block text-xs text-muted/80">
            {t('moodsHint', { max: MAX_PLOT_MOODS })}
          </span>
        </div>
        <OptionRow
          name="storytelling"
          options={[UNSET, ...STORYTELLING_STYLES]}
          value={style?.storytelling ?? UNSET}
          onSelect={(value) => set({ storytelling: (value as StorytellingStyle) || undefined })}
        />
      </Group>

      <Group title={t('groupExtras')}>
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-fg">{t('statusWindow')}</span>
          <Checkbox
            label={t('statusWindowLabel')}
            checked={style?.statusWindow ?? false}
            onChange={(checked) => set({ statusWindow: checked })}
          />
          <span className="block text-xs text-muted/80">{t('statusWindowHint')}</span>
          <span className="block text-xs text-muted/80">{t('statusWindowIntroHint')}</span>
        </div>
        <OptionRow
          name="choices"
          options={CHOICES_MODES}
          value={style?.choices ?? 'off'}
          onSelect={(value) => set({ choices: value as ChoicesMode })}
        />
      </Group>
    </div>
  );
}
