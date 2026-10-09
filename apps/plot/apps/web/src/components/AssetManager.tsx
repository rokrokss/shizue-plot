'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { apiDelete, apiGet, apiSend, apiUpload } from '@/lib/api';
import {
  foldSlug,
  MAX_ASSETS,
  measureImage,
  normalizeSlug,
  slugFromFileName,
  type PlotAsset,
} from '@/lib/assets';
import {
  ASSET_UNLOCK_KINDS,
  MAX_UNLOCK_KEYWORD_LENGTH,
  MAX_UNLOCK_KEYWORDS,
  MAX_UNLOCK_RELATIONSHIP,
  MAX_UNLOCK_TURNS,
  UNLOCK_AXES,
  type AssetUnlock,
  type AssetUnlockKind,
  type UnlockAxis,
} from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Button, ErrorText, Field, Section, Select, TextInput } from './ui';

/** Which of the four the editor is on; `none` is the null column. */
type UnlockChoice = 'none' | AssetUnlockKind;

/** The label each choice is offered under, in the order the select lists them. */
const UNLOCK_LABEL: Record<UnlockChoice, string> = {
  none: 'unlockNone',
  keyword: 'unlockKeyword',
  turns: 'unlockTurns',
  relationship: 'unlockRelationship',
};

/**
 * The images a message can pull in with `{{img::slug}}`. The slug is proposed
 * from the file name but stays editable: the card refers to the slug, not to the
 * file, and re-uploading a slug replaces the image behind it.
 */
export function AssetManager({ plotId }: { plotId: string }) {
  const t = useTranslations('plot');
  const common = useTranslations('common');
  const toMessage = useErrorMessage();
  const fileInput = useRef<HTMLInputElement>(null);

  const [assets, setAssets] = useState<PlotAsset[]>([]);
  /** The asset whose unlock condition is being edited; one at a time. */
  const [editing, setEditing] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [slug, setSlug] = useState('');
  const [operation, setOperation] = useState<'upload' | 'delete' | 'unlock' | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  /** Bumped on every upload so a replaced image is not served from the cache. */
  const [version, setVersion] = useState(0);

  useEffect(() => {
    apiGet<PlotAsset[]>(`/api/plots/${plotId}/assets`).then(setAssets, (caught: unknown) =>
      setError(toMessage(caught)),
    );
  }, [plotId, toMessage]);

  async function upload(): Promise<void> {
    const stored = normalizeSlug(slug);
    if (!file || !stored || busy) return;
    setOperation('upload');
    setError('');
    try {
      // Measured here rather than on the server: the browser has already decoded
      // the file to show it, and the API never has to grow an image decoder.
      const preview = await measureImage(file);
      const created = await apiUpload<PlotAsset>(
        `/api/plots/${plotId}/assets`,
        file,
        {
          slug: stored,
          ...(preview
            ? {
                width: String(preview.width),
                height: String(preview.height),
                thumbhash: preview.thumbhash,
              }
            : {}),
        },
      );
      setAssets((current) => [...current.filter((item) => item.slug !== created.slug), created]);
      setVersion((current) => current + 1);
      setFile(null);
      setSlug('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setOperation(null);
    }
  }

  async function remove(target: string): Promise<void> {
    if (busy || !window.confirm(common('confirmDelete'))) return;
    setOperation('delete');
    setError('');
    try {
      await apiDelete(`/api/plots/${plotId}/assets/${target}`);
      setAssets((current) => current.filter((item) => item.slug !== target));
      setEditing((current) => (current === target ? null : current));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setOperation(null);
    }
  }

  /** The asset the editor below the grid belongs to, if any is open. */
  const edited = assets.find((asset) => asset.slug === editing) ?? null;

  return (
    <Section
      title={t('assets')}
      busy={busy}
      action={
        <span className="text-xs text-muted tabular-nums">
          {t('assetCount', { count: assets.length, max: MAX_ASSETS })}
        </span>
      }
    >
      <p className="text-xs text-muted/80">{t('assetsHint')}</p>

      {assets.length > 0 ? (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {assets.map((asset) => (
            <li
              key={asset.slug}
              data-testid="plot-asset"
              className="relative overflow-hidden rounded-lg border border-line bg-raised/50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${asset.url}?v=${version}`}
                alt={asset.slug}
                loading="lazy"
                className="aspect-square w-full object-cover"
              />
              <p className="truncate px-2 pt-1 text-xs text-muted" title={`{{img::${asset.slug}}}`}>
                {asset.slug}
              </p>
              {/* What this image waits for, and the way to change it. One editor
                  at a time, under the grid: a tile is too narrow to write a
                  condition in, and only one is ever being written. */}
              <button
                type="button"
                data-testid="asset-unlock-open"
                aria-label={t('assetUnlockEdit', { slug: asset.slug })}
                aria-expanded={editing === asset.slug}
                onClick={() => setEditing((current) => (current === asset.slug ? null : asset.slug))}
                className="block w-full truncate px-2 pb-1 text-left text-xs text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {asset.unlock ? '🔒 ' : ''}
                {t(UNLOCK_LABEL[asset.unlock?.kind ?? 'none'])}
              </button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={common('removeItem', { item: asset.slug })}
                className="absolute top-1 right-1 bg-canvas/70 backdrop-blur"
                onClick={() => void remove(asset.slug)}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t('assetsEmpty')}</p>
      )}

      {edited ? (
        <UnlockEditor
          // Keyed on the slug, so switching tiles builds the draft again from
          // the condition that asset actually carries.
          key={edited.slug}
          plotId={plotId}
          asset={edited}
          onBusyChange={(pending) => setOperation(pending ? 'unlock' : null)}
          onSaved={(updated) =>
            setAssets((current) =>
              current.map((item) => (item.slug === updated.slug ? updated : item)),
            )
          }
          onClose={() => setEditing(null)}
        />
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <input
          ref={fileInput}
          data-testid="asset-file-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null;
            setFile(picked);
            if (picked) setSlug(slugFromFileName(picked.name));
          }}
        />
        {/* The button keeps its label — and so its width — whatever is picked;
            the file name lives beside it and truncates instead. */}
        <div className="flex min-w-0 items-center gap-2">
          <Button disabled={assets.length >= MAX_ASSETS} onClick={() => fileInput.current?.click()}>
            {t('assetPick')}
          </Button>
          {file ? (
            <span
              data-testid="asset-file-name"
              className="min-w-0 truncate text-xs text-muted"
              title={file.name}
            >
              {file.name}
            </span>
          ) : null}
        </div>
        <div className="min-w-40 flex-1">
          <Field label={t('assetSlug')}>
            <TextInput
              value={slug}
              placeholder={t('assetSlugPlaceholder')}
              // A slug is a reference, not prose: nothing to correct and nothing
              // an autofill entry could sensibly stand in for.
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setSlug(foldSlug(event.target.value))}
            />
          </Field>
        </div>
        <Button
          variant="primary"
          busy={operation === 'upload'}
          disabled={!file || !normalizeSlug(slug)}
          onClick={() => void upload()}
        >
          {t('assetUpload')}
        </Button>
      </div>

      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

/** The keywords as the field holds them, and as the API takes them. */
const splitKeywords = (raw: string): string[] =>
  raw
    .split(',')
    .map((word) => word.trim().slice(0, MAX_UNLOCK_KEYWORD_LENGTH))
    .filter((word) => word.length > 0)
    .slice(0, MAX_UNLOCK_KEYWORDS);

/** Whatever the field says, inside the bounds the API would coerce it to anyway. */
const bounded = (value: number, max: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 1), max) : 1;

/**
 * One image's unlock condition. It saves on its own rather than riding the
 * plot's Save: it is a request of its own (`PATCH .../assets/:slug`), and what
 * it answers with is the asset row the grid above is drawing.
 *
 * Every kind keeps its own draft while the editor is open, so trying 턴 수 and
 * going back to 키워드 does not cost the keywords that were already typed.
 */
function UnlockEditor({
  plotId,
  asset,
  onSaved,
  onClose,
  onBusyChange,
}: {
  plotId: string;
  asset: PlotAsset;
  onSaved: (asset: PlotAsset) => void;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useTranslations('plot');
  const common = useTranslations('common');
  const toMessage = useErrorMessage();

  const unlock = asset.unlock ?? null;
  const [choice, setChoice] = useState<UnlockChoice>(unlock?.kind ?? 'none');
  const [keywords, setKeywords] = useState(
    unlock?.kind === 'keyword' ? unlock.keywords.join(', ') : '',
  );
  const [count, setCount] = useState(unlock?.kind === 'turns' ? String(unlock.count) : '10');
  const [axis, setAxis] = useState<UnlockAxis>(
    unlock?.kind === 'relationship' ? unlock.axis : 'affection',
  );
  const [min, setMin] = useState(unlock?.kind === 'relationship' ? String(unlock.min) : '50');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /** Null clears the condition, which is what 없음 means. */
  function draft(): AssetUnlock | null {
    if (choice === 'keyword') return { kind: 'keyword', keywords: splitKeywords(keywords) };
    if (choice === 'turns') return { kind: 'turns', count: bounded(Number(count), MAX_UNLOCK_TURNS) };
    if (choice === 'relationship') {
      return { kind: 'relationship', axis, min: bounded(Number(min), MAX_UNLOCK_RELATIONSHIP) };
    }
    return null;
  }

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      onSaved(
        await apiSend<PlotAsset>('PATCH', `/api/plots/${plotId}/assets/${asset.slug}`, {
          unlock: draft(),
        }),
      );
      onClose();
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <div
      data-testid="asset-unlock-editor"
      className="space-y-3 rounded-lg border border-line bg-canvas/60 p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate text-xs font-medium text-muted">
          {t('assetUnlockOf', { slug: asset.slug })}
        </h3>
        <Button size="sm" variant="ghost" aria-label={common('close')} onClick={onClose}>
          ✕
        </Button>
      </div>
      <p className="text-xs text-muted/80">{t('assetUnlockHint')}</p>

      <Field label={t('assetUnlock')}>
        <Select
          data-testid="asset-unlock-kind"
          value={choice}
          className="h-9 py-0 text-xs"
          onChange={(event) => setChoice(event.target.value as UnlockChoice)}
        >
          <option value="none">{t('unlockNone')}</option>
          {ASSET_UNLOCK_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(UNLOCK_LABEL[kind])}
            </option>
          ))}
        </Select>
      </Field>

      {choice === 'keyword' ? (
        <Field
          label={t('unlockKeywords', { max: MAX_UNLOCK_KEYWORDS })}
          hint={t('unlockKeywordsHint')}
        >
          <TextInput
            data-testid="asset-unlock-keywords"
            value={keywords}
            onChange={(event) => setKeywords(event.target.value)}
          />
        </Field>
      ) : null}

      {choice === 'turns' ? (
        <Field label={t('unlockTurnCount')} hint={t('unlockTurnCountHint')}>
          <TextInput
            type="number"
            min={1}
            max={MAX_UNLOCK_TURNS}
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </Field>
      ) : null}

      {choice === 'relationship' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('unlockAxis')}>
            <Select
              value={axis}
              className="h-9 py-0 text-xs"
              onChange={(event) => setAxis(event.target.value as UnlockAxis)}
            >
              {UNLOCK_AXES.map((value) => (
                <option key={value} value={value}>
                  {t(`unlockAxes.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('unlockMin')} hint={t('unlockMinHint')}>
            <TextInput
              type="number"
              min={1}
              max={MAX_UNLOCK_RELATIONSHIP}
              value={min}
              onChange={(event) => setMin(event.target.value)}
            />
          </Field>
        </div>
      ) : null}

      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end">
        {/* A keyword condition with no keywords would be an image nothing can
            open, so it is not offered — 없음 is how a condition is taken off. */}
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          disabled={choice === 'keyword' && splitKeywords(keywords).length === 0}
          onClick={() => void save()}
        >
          {common('save')}
        </Button>
      </div>
    </div>
  );
}
