'use client';

import { useTranslations } from 'next-intl';
import type { ModelPreset } from '@/lib/types';
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
  value,
  presets,
  current,
  defaultLabel,
  disabled,
  className,
  onChange,
}: {
  /** The chat's main pick; null follows the default. */
  value: string | null;
  presets: readonly ModelPreset[];
  /** The preset the chat runs on now, which the pill is named for. */
  current: ModelPreset | undefined;
  defaultLabel: string;
  disabled: boolean;
  className?: string;
  onChange: (presetId: string | null) => void;
}) {
  const t = useTranslations('chat');
  const label = current?.name ?? value ?? defaultLabel;

  return (
    <span
      data-testid="model-pill"
      className={cx(
        'relative inline-flex h-7 max-w-32 shrink-0 items-center gap-0.5 rounded-xl bg-raised pr-2.5 pl-3 text-xs text-fg transition-colors',
        'has-[select:enabled]:hover:bg-line has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-offset-2 has-[select:focus-visible]:outline-focus',
        disabled && 'opacity-45',
        className,
      )}
    >
      {/* What is chosen is the select's to say; this is only its face. */}
      <span aria-hidden="true" className="truncate">
        {label}
      </span>
      <Icon name="chevron" className="size-3 shrink-0 text-muted" />
      <select
        value={value ?? ''}
        disabled={disabled}
        aria-label={t('modelPill')}
        {...(disabled ? { title: t('lockedWhileGenerating') } : {})}
        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
        onChange={(event) => onChange(event.target.value || null)}
      >
        <ModelOptions presets={presets} value={value} defaultLabel={defaultLabel} />
      </select>
    </span>
  );
}
