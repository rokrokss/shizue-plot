'use client';

import { useTranslations } from 'next-intl';
import type { NarratorPov, PlotStyle } from '@/lib/types';
import { Badge } from './ui';

/**
 * What the style is willing to say to a reader deciding whether to open the work:
 * the moods it aims for, a difficulty or a pace that is not the ordinary one, and
 * whose eyes it is told through. Enum values only — the directives themselves are
 * the creator's writing and never leave the plot editor.
 *
 * An option at its default says nothing here for the same reason it says nothing
 * to the model: a chip reading "보통 난이도" is a chip a reader has to read to
 * learn that there was nothing to learn.
 */
export function PlotStyleBadges({
  style,
  pov,
}: {
  style: PlotStyle | null | undefined;
  /** From the plot's narrator, where the read carries one. */
  pov?: NarratorPov | undefined;
}) {
  const t = useTranslations('style');

  const badges = [
    ...(style?.moods ?? []).map((mood) => ({ key: mood, label: t(`moodOptions.${mood}`) })),
    ...(style?.difficulty && style.difficulty !== 'normal'
      ? [{ key: style.difficulty, label: t(`badges.${style.difficulty}`) }]
      : []),
    ...(style?.pacing && style.pacing !== 'natural'
      ? [{ key: style.pacing, label: t(`badges.${style.pacing}`) }]
      : []),
    ...(pov ? [{ key: pov, label: t(`badges.${pov}`) }] : []),
  ];

  if (badges.length === 0) return null;

  return (
    <ul data-testid="plot-style-badges" className="flex flex-wrap gap-1.5">
      {badges.map((badge) => (
        <li key={badge.key}>
          <Badge>{badge.label}</Badge>
        </li>
      ))}
    </ul>
  );
}
