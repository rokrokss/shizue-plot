'use client';

import { useTranslations } from 'next-intl';
import type { ModelInfo } from '@/lib/types';
import { Icon } from './Icon';
import { ModelOptions } from './ModelOptions';
import { cx } from './ui';

/**
 * The chat's main model in the header, as Zeta's "zeta ⌄": its name and a
 * chevron in a small pill. Under it lies a native select of the same list the
 * settings offer (`ModelOptions`), so a tap opens the platform's own picker and
 * a pick saves as the settings' does. The main model only — the auxiliary model
 * stays in the settings. Held while a reply or a round is written.
 */
export function ModelPill({
  model,
  models,
  disabled,
  className,
  onChange,
}: {
  model: string;
  models: ModelInfo[];
  disabled: boolean;
  className?: string;
  onChange: (model: string) => void;
}) {
  const t = useTranslations('chat');
  const label = models.find((entry) => entry.id === model)?.label ?? model;

  return (
    <span
      data-testid="model-pill"
      className={cx(
        'relative inline-flex h-7 max-w-32 shrink-0 items-center gap-0.5 rounded-full border border-line bg-surface pr-1.5 pl-2.5 text-xs text-fg transition-colors',
        'has-[select:enabled]:hover:border-fg has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-offset-2 has-[select:focus-visible]:outline-focus',
        disabled && 'opacity-45',
        className,
      )}
    >
      {/* What is chosen is the select's to say; this is only its face. */}
      <span aria-hidden="true" className="truncate">
        {label}
      </span>
      <Icon name="chevron" className="size-3.5 shrink-0 text-muted" />
      <select
        value={model}
        disabled={disabled}
        aria-label={t('modelPill')}
        {...(disabled ? { title: t('lockedWhileGenerating') } : {})}
        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
        onChange={(event) => onChange(event.target.value)}
      >
        <ModelOptions model={model} models={models} />
      </select>
    </span>
  );
}
