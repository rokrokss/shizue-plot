'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import type { ModelRegistry, ProfileStatus, RegistryProfile } from '@/lib/types';
import { Badge, Button, Select, TextInput, cx } from './ui';

/** PocketRisu's catalog display levels (`modelProfileVisibilityLevel`), current only by default. */
const VISIBILITIES = ['currentOnly', 'hideDeprecated', 'all'] as const;
type Visibility = (typeof VISIBILITIES)[number];

const STATUS_ORDER: ProfileStatus[] = ['current', 'outdated', 'deprecated'];

const visible = (status: ProfileStatus, level: Visibility): boolean =>
  level === 'all' || (level === 'hideDeprecated' ? status !== 'deprecated' : status === 'current');

/** A registry string in the page's language where the registry has it, else as written. */
export const localized = (text: string | undefined, translations: Record<string, string> | undefined, locale: string): string =>
  translations?.[locale] ?? text ?? '';

/**
 * PocketRisu's profile browser (`modelProfileBrowser.svelte`): the registry's
 * profiles this app offers on one tab, grouped by provider and searched by
 * name, id, model or provider, outdated and deprecated ones hidden until the
 * owner asks; the custom model — this app's own editor on a format, with a
 * typed model id — on the other. Picking a profile makes a preset on it, or in
 * `replace` mode puts it in place of a preset's profile.
 */
export function ModelProfileBrowser({
  registry,
  mode,
  busy,
  refreshing,
  refreshNote,
  onPick,
  onCustom,
  onRefresh,
  onClose,
}: {
  registry: ModelRegistry | null;
  mode: 'create' | 'replace';
  busy: boolean;
  refreshing: boolean;
  /** What the last refresh said, if anything. */
  refreshNote: string;
  onPick: (profile: RegistryProfile) => void;
  onCustom: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('models');
  const locale = useLocale();
  const id = useId();
  const [tab, setTab] = useState<'official' | 'custom'>('official');
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<Visibility>('currentOnly');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const searching = query.trim() !== '';

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (registry?.profiles ?? []).filter((profile) => visible(profile.status, level)).filter((profile) =>
      !needle || [
        profile.displayName,
        localized(profile.displayName, profile.displayNameI18n, locale),
        profile.id,
        profile.modelId,
        profile.description ?? '',
        localized(profile.description, profile.descriptionI18n, locale),
        profile.baseLabel,
        profile.baseId,
      ].some((text) => text.toLowerCase().includes(needle)));
    const byBase = new Map<string, { id: string; label: string; profiles: RegistryProfile[] }>();
    for (const profile of matches) {
      const group = byBase.get(profile.baseId) ?? { id: profile.baseId, label: profile.baseLabel, profiles: [] };
      group.profiles.push(profile);
      byBase.set(profile.baseId, group);
    }
    for (const group of byBase.values()) {
      group.profiles.sort((a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
        || (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
        || localized(a.displayName, a.displayNameI18n, locale).localeCompare(localized(b.displayName, b.displayNameI18n, locale)));
    }
    return [...byBase.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [registry, query, level, locale]);

  const toggle = (group: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  const date = (ms: number | undefined): string => (ms ? new Date(ms).toLocaleDateString(locale) : '');
  const source = registry
    ? registry.origin === 'remote' && registry.fetchedAt
      ? t('registrySourceRemote', { date: new Date(registry.fetchedAt).toLocaleString(locale) })
      : t('registrySourceBundled')
    : '';

  return (
    <section data-testid="model-profile-browser" aria-labelledby={`${id}-title`} className="space-y-3 rounded-xl border border-line bg-raised/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <h4 id={`${id}-title`} className="text-sm font-semibold">{mode === 'replace' ? t('browserReplaceTitle') : t('browserTitle')}</h4>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t('browserClose')}</Button>
      </div>
      {mode === 'create' ? (
        <div role="tablist" className="flex w-full overflow-hidden rounded-xl border border-line">
          {(['official', 'custom'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              className={cx('flex-1 px-3 py-2 text-sm', tab === entry ? 'bg-raised font-medium text-fg' : 'text-muted hover:text-fg')}
              onClick={() => setTab(entry)}
            >
              {entry === 'official' ? t('browserTabOfficial') : t('browserTabCustom')}
            </button>
          ))}
        </div>
      ) : null}

      {tab === 'custom' && mode === 'create' ? (
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-muted">{t('customModelDescription')}</p>
          <Button size="sm" variant="primary" disabled={busy} onClick={onCustom}>{t('customModelStart')}</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <TextInput
              type="search"
              aria-label={t('browserSearch')}
              placeholder={t('browserSearch')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Select aria-label={t('browserVisibility')} value={level} onChange={(event) => setLevel(event.target.value as Visibility)}>
              {VISIBILITIES.map((entry) => (
                <option key={entry} value={entry}>{t(`visibility.${entry}`)}</option>
              ))}
            </Select>
          </div>
          {groups.length === 0 ? <p className="py-6 text-center text-sm text-muted">{t('browserEmpty')}</p> : null}
          <div className="space-y-2">
            {groups.map((group) => {
              const expanded = searching || open.has(group.id);
              return (
                <div key={group.id} data-testid="model-profile-group">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-2 py-1 text-left text-sm text-muted hover:text-fg"
                    onClick={() => toggle(group.id)}
                  >
                    <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                    <span className="font-semibold">{group.label}</span>
                    <span className="text-xs">({group.profiles.length})</span>
                  </button>
                  {expanded ? (
                    <ul className="mt-1 space-y-1.5">
                      {group.profiles.map((profile) => {
                        const description = localized(profile.description, profile.descriptionI18n, locale);
                        return (
                          <li key={profile.id}>
                            <button
                              type="button"
                              data-testid="model-profile"
                              disabled={busy}
                              className="flex w-full flex-col gap-0.5 rounded-xl border border-line px-3 py-2.5 text-left transition-colors hover:bg-raised disabled:opacity-45"
                              onClick={() => onPick(profile)}
                            >
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">{localized(profile.displayName, profile.displayNameI18n, locale)}</span>
                                {profile.status !== 'current' ? <Badge>{t(`profileStatus.${profile.status}`)}</Badge> : null}
                              </span>
                              <span className="truncate text-xs text-muted">{profile.id}</span>
                              {profile.updatedAt ? <span className="text-xs text-muted">{t('profileUpdatedOn', { date: date(profile.updatedAt) })}</span> : null}
                              {description ? <span className="text-xs text-muted">{description}</span> : null}
                              {profile.statusReason ? <span className="text-xs text-muted">{profile.statusReason}</span> : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <p role="status" className="min-w-0 flex-1 text-xs text-muted">{refreshNote || source}</p>
            {registry?.refreshable ? (
              <Button size="sm" busy={refreshing} disabled={busy} onClick={onRefresh}>{t('registryRefresh')}</Button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
