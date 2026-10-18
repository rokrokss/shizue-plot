'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ImportProgressLine, RealmImportForm } from '@/components/CardImport';
import { CreatorTabs } from '@/components/CreatorTabs';
import { DraftGuide } from '@/components/DraftGuide';
import { ModelOptions } from '@/components/ModelOptions';
import { PlotShelf } from '@/components/PlotShelf';
import { Button, buttonClass, ErrorText, Field, Select, Spinner, TextArea, TextInput } from '@/components/ui';
import { Link, useRouter } from '@/i18n/navigation';
import { apiGet, apiSend } from '@/lib/api';
import { readDraftModel, writeDraftModel } from '@/lib/draftPrefs';
import { effectivePreset, OPEN_BINDING } from '@/lib/modelBinding';
import { importFile, type ImportProgress } from '@/lib/fileImport';
import { keepImportWarnings } from '@/lib/importWarnings';
import { checkCardSize, downloadRealmCard } from '@/lib/realm';
import {
  MAX_PREMISE_LENGTH,
  type ModelBinding,
  type ModelPreset,
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
  const chat = useTranslations('chat');
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
  /** The presets a draft can run on, and the one it will: the last pick, else the default's sub model (''). */
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [modelDefaults, setModelDefaults] = useState<ModelBinding>(OPEN_BINDING);
  const [draftModel, setDraftModel] = useState('');
  /** The RisuRealm panel: a card page's address instead of a file. */
  const [realmOpen, setRealmOpen] = useState(false);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<'create' | 'draft' | 'import' | 'realm' | null>(null);
  /** Where a card import is, said under the buttons while it runs. */
  const [progress, setProgress] = useState<ImportProgress | null>(null);
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

  // Presets that do not load leave the draft without a select, and the server
  // drafts on the default sub model — so their failure is not this page's error.
  useEffect(() => {
    apiGet<ModelPreset[]>('/api/model-presets').then((list) => {
      setPresets(list);
      setDraftModel(readDraftModel(list));
    }, () => undefined);
    apiGet<ModelBinding>('/api/model-binding').then(setModelDefaults, () => undefined);
  }, []);
  const draftDefault = effectivePreset(presets, OPEN_BINDING, modelDefaults, 'sub');

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
        ...(draftModel ? { model: draftModel } : {}),
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
      const created = await importFile<PlotDetail & { importWarnings?: unknown }>('plot', checkCardSize(file), {}, {
        onProgress: setProgress,
      });
      // What the import left behind, for the studio it moves on to to say.
      keepImportWarnings(created.id, created.importWarnings);
      router.push(`/plots/${created.id}`);
    } catch (caught) {
      setError(toMessage(caught));
      setOperation(null);
      setProgress(null);
    }
  }

  /**
   * The same import, from a RisuRealm page: this browser downloads the card
   * (`downloadRealmCard`) and uploads it like a picked file, naming the page it
   * came from.
   */
  async function importFromRealm(url: string): Promise<boolean> {
    if (busy) return false;
    setOperation('realm');
    setError('');
    try {
      const { file, sourceUrl } = await downloadRealmCard(url);
      const created = await importFile<PlotDetail & { importWarnings?: unknown }>('plot', file, { sourceUrl }, {
        onProgress: setProgress,
      });
      keepImportWarnings(created.id, created.importWarnings);
      router.push(`/plots/${created.id}`);
      return true;
    } catch (caught) {
      setError(toMessage(caught));
      setOperation(null);
      setProgress(null);
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
            {/* A page of its own rather than a panel: a whole library is reviewed
                before anything comes over. */}
            <Link
              href="/plots/import/sillytavern"
              data-testid="plot-st-import"
              title={t('stImportHint')}
              aria-disabled={busy || undefined}
              className={buttonClass('secondary', 'md', busy ? 'pointer-events-none opacity-45' : undefined)}
            >
              {t('stImport')}
            </Link>
            {/* Field by field from another platform's editor, so a page of its own too. */}
            <Link
              href="/plots/import/paste"
              data-testid="plot-paste-import"
              title={t('pasteImportHint')}
              aria-disabled={busy || undefined}
              className={buttonClass('secondary', 'md', busy ? 'pointer-events-none opacity-45' : undefined)}
            >
              {t('pasteImport')}
            </Link>
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
            <div className="flex flex-wrap items-end justify-end gap-2">
              {presets.length > 0 ? (
                <div className="min-w-0 flex-1 sm:max-w-xs">
                  <Field label={t('draftModel')}>
                    <Select
                      data-testid="draft-model"
                      value={draftModel}
                      onChange={(event) => {
                        setDraftModel(event.target.value);
                        writeDraftModel(event.target.value);
                      }}
                    >
                      <ModelOptions
                        presets={presets}
                        value={draftModel || null}
                        defaultLabel={draftDefault ? t('draftModelDefault', { model: draftDefault.name }) : chat('modelDefault')}
                      />
                    </Select>
                  </Field>
                </div>
              ) : null}
              <Button
                variant="primary"
                busy={operation === 'draft'}
                disabled={!premise.trim()}
                onClick={() => void draft()}
              >
                {t('draftCreate')}
              </Button>
            </div>
            <DraftGuide />
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
        <ImportProgressLine progress={progress} />
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
        <div className="mt-6">
          <PlotShelf plots={plots} href={(plot) => `/plots/${plot.id}`} />
        </div>
      )}
    </div>
  );
}
