'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RealmImportForm } from '@/components/CardImport';
import { CreatorTabs } from '@/components/CreatorTabs';
import { Button, ErrorText, Field, Spinner, TextArea, TextInput } from '@/components/ui';
import { Link, useRouter } from '@/i18n/navigation';
import { apiGet, apiSend, apiUpload } from '@/lib/api';
import { checkCardSize, downloadRealmCard } from '@/lib/realm';
import {
  MAX_PREMISE_LENGTH,
  type Plot,
  type PlotDetail,
  type PlotDraft,
  type PlotMember,
} from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useErrorMessage } from '@/lib/useErrorMessage';

/**
 * The plots the reader owns — the shelf the creator area opens on. A card
 * file dropped here becomes a whole work: the import wraps it in a plot and
 * makes the card its first member, so both doors lead to the same editor.
 */
export default function PlotsPage() {
  const t = useTranslations('plots');
  const cardImport = useTranslations('cardImport');
  const common = useTranslations('common');
  const format = useFormatter();
  const toMessage = useErrorMessage();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  useDocumentTitle(t('title'));

  const [plots, setPlots] = useState<Plot[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  /** The AI draft panel, and the one line it is written from. */
  const [drafting, setDrafting] = useState(false);
  const [premise, setPremise] = useState('');
  /** The RisuRealm panel: a card page's address instead of a file. */
  const [realmOpen, setRealmOpen] = useState(false);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<'create' | 'draft' | 'import' | 'realm' | null>(null);
  const busy = operation !== null;

  const load = useCallback(async () => {
    try {
      setPlots(await apiGet<Plot[]>('/api/plots'));
    } catch (caught) {
      setError(toMessage(caught));
    }
  }, [toMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    if (!name.trim() || busy) return;
    setOperation('create');
    setError('');
    try {
      const created = await apiSend<Plot>('POST', '/api/plots', { name: name.trim() });
      router.push(`/plots/${created.id}`);
    } catch (caught) {
      setError(toMessage(caught));
      setOperation(null);
    }
  }

  /**
   * A first version, written from one premise. The draft itself is stored
   * nowhere — the server hands back the fields a create takes — so this creates
   * the plot through the ordinary POST and lands in the editor with them
   * already in it. The editor is the review surface: a draft the creator does
   * not like is a plot they delete, not a dialog they argue with.
   */
  async function draft(): Promise<void> {
    if (!premise.trim() || busy) return;
    setOperation('draft');
    setError('');
    try {
      const drafted = await apiSend<PlotDraft>('POST', '/api/plots/draft', {
        premise: premise.trim(),
      });
      const created = await apiSend<Plot>('POST', '/api/plots', {
        name: drafted.name,
        intro: drafted.intro,
        description: drafted.description,
        intros: drafted.intros,
        tags: drafted.tags,
      });
      // The roster is its own endpoint, so the cast joins the work it was
      // drafted for one member at a time, in the order it was written in.
      for (const member of drafted.characters) {
        await apiSend<PlotMember>('POST', `/api/plots/${created.id}/characters`, {
          name: member.name,
          card: { description: member.description, personality: member.personality },
        });
      }
      router.push(`/plots/${created.id}`);
    } catch (caught) {
      setError(toMessage(caught));
      setOperation(null);
    }
  }

  async function importCard(file: File): Promise<void> {
    if (busy) return;
    setOperation('import');
    setError('');
    try {
      const created = await apiUpload<PlotDetail>('/api/plots/import', checkCardSize(file));
      router.push(`/plots/${created.id}`);
    } catch (caught) {
      setError(toMessage(caught));
      setOperation(null);
    }
  }

  /**
   * The same import, from a RisuRealm page: this browser downloads the card
   * (`downloadRealmCard`) and uploads it like a picked file, naming the page it
   * came from. The new plot is private, so nothing is asked of the owner yet.
   */
  async function importFromRealm(url: string): Promise<boolean> {
    if (busy) return false;
    setOperation('realm');
    setError('');
    try {
      const { file, sourceUrl } = await downloadRealmCard(url);
      const created = await apiUpload<PlotDetail>('/api/plots/import', file, { sourceUrl });
      router.push(`/plots/${created.id}`);
      return true;
    } catch (caught) {
      setError(toMessage(caught));
      setOperation(null);
      return false;
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-10">
      <CreatorTabs />

      <fieldset disabled={busy} aria-busy={busy || undefined} className="min-w-0">
        <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="title2 sm:title1">{t('title')}</h1>
            <p className="mt-1 text-sm text-muted">{t('subtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              data-testid="plot-import-input"
              type="file"
              accept=".png,.json,.charx,.jpg,.jpeg"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importCard(file);
              }}
            />
            <Button busy={operation === 'import'} onClick={() => fileInput.current?.click()} title={t('importHint')}>
              {t('import')}
            </Button>
            <Button
              data-testid="plot-realm-open"
              onClick={() => {
                setRealmOpen((open) => !open);
                setDrafting(false);
                setCreating(false);
              }}
            >
              {cardImport('realmOpen')}
            </Button>
            {/* Beside 새 플롯 rather than instead of it: this drafts a first
                version, and the creator edits it like any other. */}
            <Button
              data-testid="plot-draft-open"
              title={t('draftHint')}
              onClick={() => {
                setDrafting((open) => !open);
                setCreating(false);
                setRealmOpen(false);
              }}
            >
              {t('draft')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setCreating((open) => !open);
                setDrafting(false);
                setRealmOpen(false);
              }}
            >
              {t('new')}
            </Button>
          </div>
        </div>

        {realmOpen ? (
          <div
            data-testid="plot-realm-panel"
            className="mt-5 space-y-3 rounded-xl border border-line bg-surface/60 p-3"
          >
            <h2 className="heading3 text-fg">{cardImport('realmTitle')}</h2>
            <RealmImportForm busy={operation === 'realm'} onSubmit={importFromRealm} />
          </div>
        ) : null}

        {drafting ? (
          <div
            data-testid="plot-draft-panel"
            className="mt-5 space-y-3 rounded-xl border border-line bg-surface/60 p-3"
          >
            <h2 className="heading3 text-fg">{t('draftTitle')}</h2>
            <Field label={t('draftPremise')} hint={t('draftHint')}>
              <TextArea
                autoFocus
                rows={3}
                value={premise}
                maxLength={MAX_PREMISE_LENGTH}
                placeholder={t('draftPremisePlaceholder')}
                onChange={(event) => setPremise(event.target.value)}
              />
            </Field>
            <div className="flex justify-end">
              <Button
                variant="primary"
                busy={operation === 'draft'}
                disabled={!premise.trim()}
                onClick={() => void draft()}
              >
                {t('draftCreate')}
              </Button>
            </div>
          </div>
        ) : null}

        {creating ? (
          <div className="mt-5 flex gap-2 rounded-xl border border-line bg-surface/60 p-3">
            <TextInput
              autoFocus
              value={name}
              aria-label={t('name')}
              placeholder={t('namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create();
              }}
            />
            <Button variant="primary" busy={operation === 'create'} disabled={!name.trim()} onClick={() => void create()}>
              {t('create')}
            </Button>
          </div>
        ) : null}
      </fieldset>

      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      {plots === null ? (
        <div className="flex justify-center py-20">
          <Spinner label={common('loading')} />
        </div>
      ) : plots.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-line bg-surface py-20 text-center">
          <p className="text-sm text-fg">{t('empty')}</p>
          <p className="mt-1 text-sm text-muted">{t('emptyHint')}</p>
        </div>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plots.map((plot) => (
            <li key={plot.id}>
              <Link
                href={`/plots/${plot.id}`}
                data-testid="plot-row"
                className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface transition-shadow hover:border-fg hover:shadow-card"
              >
                {plot.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={plot.coverUrl}
                    alt=""
                    loading="lazy"
                    className="aspect-[16/10] w-full bg-raised/60 object-cover"
                  />
                ) : (
                  <div className="brand-dots flex aspect-[16/10] w-full items-center justify-center bg-mint-soft/60"><span className="line-clamp-2 px-6 text-center heading1">{plot.name}</span></div>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-2 p-5">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                      {plot.name}
                    </p>
                    <span className="shrink-0 text-xs text-muted">
                      {plot.visibility === 'public' ? t('public') : t('private')}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted">
                    {plot.intro || plot.description || t('noDescription')}
                  </p>
                  <p className="mt-auto pt-1 text-xs text-muted">
                    {t('updatedAt', {
                      date: format.dateTime(new Date(plot.updatedAt), { dateStyle: 'medium' }),
                    })}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
