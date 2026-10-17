'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { apiDelete, apiGet, apiUpload } from '@/lib/api';
import {
  foldSlug,
  isFontAsset,
  isImageAsset,
  MAX_ASSETS,
  measureImage,
  normalizeSlug,
  slugFromFileName,
  type PlotAsset,
} from '@/lib/assets';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Button, ErrorText, Field, Section, TextInput } from './ui';

/**
 * The images a message can pull in with `{{img::slug}}`. The slug is proposed
 * from the file name but stays editable: the card refers to the slug, not to the
 * file, and re-uploading a slug replaces the image behind it. The music an
 * imported card brought is listed among them, as a player; only a card brings
 * music — the upload here takes pictures.
 */
export function AssetManager({
  plotId,
  revision = 0,
}: {
  plotId: string;
  /** Bumped by whatever else adds or takes pictures (a module's import or removal), to read the list again. */
  revision?: number;
}) {
  const t = useTranslations('plot');
  const common = useTranslations('common');
  const toMessage = useErrorMessage();
  const fileInput = useRef<HTMLInputElement>(null);

  const [assets, setAssets] = useState<PlotAsset[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [slug, setSlug] = useState('');
  const [operation, setOperation] = useState<'upload' | 'delete' | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  /** Bumped on every upload so a replaced image is not served from the cache. */
  const [version, setVersion] = useState(0);

  useEffect(() => {
    apiGet<PlotAsset[]>(`/api/plots/${plotId}/assets`).then(setAssets, (caught: unknown) =>
      setError(toMessage(caught)),
    );
  }, [plotId, revision, toMessage]);

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
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setOperation(null);
    }
  }

  const tiles = assets.filter((asset) => !isFontAsset(asset));
  const fonts = assets.length - tiles.length;

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
      <p className="text-xs text-muted">{t('assetsHint')}</p>

      {/* A web font's slices — hundreds for a Korean family — are the stylesheet's,
          not pictures to place: counted here rather than tiled. */}
      {fonts > 0 ? (
        <p data-testid="plot-asset-fonts" className="text-xs text-muted">
          {t('assetFonts', { count: fonts })}
        </p>
      ) : null}

      {tiles.length > 0 ? (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {tiles.map((asset) => (
            <li
              key={asset.slug}
              data-testid="plot-asset"
              className="relative overflow-hidden rounded-lg border border-line bg-raised/50"
            >
              {isImageAsset(asset) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${asset.url}?v=${version}`}
                  alt={asset.slug}
                  loading="lazy"
                  className="aspect-[2/3] w-full object-contain"
                />
              ) : asset.mime.startsWith('video/') ? (
                // A card's video (`{{video::…}}`): its player in the picture's
                // place, nothing loaded until it is played.
                <video
                  data-testid="plot-asset-video"
                  controls
                  preload="none"
                  playsInline
                  src={asset.url}
                  className="aspect-[2/3] w-full object-contain"
                />
              ) : (
                // A card's music (`{{audio::…}}`, `{{bgm::…}}`): its player in the
                // picture's place, nothing loaded until it is played.
                <div className="flex aspect-[2/3] w-full flex-col items-center justify-center gap-2 px-1">
                  <span aria-hidden="true" className="text-2xl text-muted">
                    ♪
                  </span>
                  <audio data-testid="plot-asset-audio" controls preload="none" src={asset.url} className="w-full" />
                </div>
              )}
              <p
                className="truncate px-2 py-1 text-xs text-muted"
                title={
                  isImageAsset(asset)
                    ? `{{img::${asset.slug}}}`
                    : asset.mime.startsWith('video/')
                      ? `{{video::${asset.slug}}}`
                      : `{{audio::${asset.slug}}}`
                }
              >
                {asset.slug}
              </p>
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
