'use client';

import {
  convertToDraft,
  draftFingerprint,
  emptyInput,
  MIGRATION_PLATFORMS_ENABLED,
  SITE_SCHEMAS,
  type MigrationPlatform,
  type MigrationResult,
  type SiteInput,
  type SiteSchema,
} from '@shizue/core/migrate';
import { sourceUrlFor } from '@shizue/core/source-url';
import { notFound } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { use, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { CreatorTabs } from '@/components/CreatorTabs';
import { SiteForm, type RowOrder } from '@/components/MigrationForm';
import { ConfirmStep, ImagesStep, PreviewStep, RunStep } from '@/components/PasteMigration';
import { Button, cx, Spinner } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import {
  BROWSER_DEPS,
  importedPlots,
  initialRun,
  planSteps,
  runMigration,
  type MigrationPlan,
  type MigrationStep,
  type RunState,
} from '@/lib/migrate/run';
import {
  browserStorage,
  clearSaved,
  confirmationItems,
  confirmationsReady,
  convertOptions,
  defaultOptions,
  fieldLabel,
  hasInput,
  preservedFile,
  readSaved,
  renumberOptions,
  sceneFields,
  WIZARD_STEPS,
  writeSaved,
  type PreviewOptions,
  type WizardImage,
  type WizardStep,
} from '@/lib/migrate/wizard';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

/**
 * A paste migration from one site (`/plots/import/paste/:platform`): confirm the
 * work is the creator's to move → paste the source editor's fields into a form
 * laid out like it → add the images → check the plot the conversion makes → make
 * it. The page holds the state; `lib/migrate` decides and sends, and this browser
 * keeps a copy of the form per site until the plot is made.
 */
export default function PasteMigrationPage({ params }: { params: Promise<{ platform: string }> }) {
  const { platform } = use(params);
  const enabled = MIGRATION_PLATFORMS_ENABLED.find((each) => each === platform);
  const schema = enabled ? SITE_SCHEMAS[enabled] : undefined;
  if (!enabled || !schema) notFound();
  return <Wizard key={enabled} platform={enabled} schema={schema} />;
}

/** Object URLs for the image thumbnails, made when the set of images changes and let go after. */
function useObjectUrls(images: WizardImage[]): ReadonlyMap<string, string> {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const latest = useRef(images);
  latest.current = images;
  const key = images.map((image) => image.id).join('\n');
  useEffect(() => {
    const made = new Map(latest.current.map((image) => [image.id, URL.createObjectURL(image.file)]));
    setUrls(made);
    return () => made.forEach((url) => URL.revokeObjectURL(url));
  }, [key]);
  return urls;
}

interface Run {
  plan: MigrationPlan;
  steps: MigrationStep[];
  state: RunState;
  /** The conversion the run was started from: its warnings and preserved text. */
  result: MigrationResult;
}

function Wizard({ platform, schema }: { platform: MigrationPlatform; schema: SiteSchema }) {
  const t = useTranslations('migrate');
  const site = t(`platforms.${platform}`);
  useDocumentTitle(t('wizardTitle', { platform: site }));

  const items = useMemo(() => confirmationItems(schema), [schema]);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<WizardStep>('confirm');
  const [confirmations, setConfirmations] = useState<Record<string, boolean>>({});
  const [sourceUrl, setSourceUrl] = useState('');
  const [input, setInput] = useState<SiteInput>(() => emptyInput(schema));
  const [options, setOptions] = useState<PreviewOptions>(() => defaultOptions());
  const [images, setImages] = useState<WizardImage[]>([]);
  /** The saved form came back with images it could not keep. */
  const [lostImages, setLostImages] = useState(false);
  const [restored, setRestored] = useState(false);
  /** This browser holds a copy of the form for this site. */
  const [savedLeft, setSavedLeft] = useState(false);
  const [existing, setExisting] = useState<string[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);
  const urls = useObjectUrls(images);

  // The saved copy is the browser's alone, so it is read after mount.
  useEffect(() => {
    const saved = readSaved(browserStorage(), platform);
    if (saved) {
      setStep(saved.step);
      setConfirmations(saved.confirmations);
      setSourceUrl(saved.sourceUrl);
      setInput(saved.input);
      setOptions(saved.options);
      setLostImages(saved.hadImages);
      setRestored(true);
      setSavedLeft(true);
    }
    setLoaded(true);
  }, [platform]);

  const touched =
    hasInput(input, schema) || sourceUrl.trim() !== '' || Object.values(confirmations).some(Boolean);

  // Every change is saved a moment later, until the run starts; a refused write
  // only means there is no copy.
  useEffect(() => {
    if (!loaded || step === 'run' || !touched) return;
    const timer = setTimeout(() => {
      const ok = writeSaved(browserStorage(), platform, {
        version: 1,
        step,
        confirmations,
        sourceUrl,
        input,
        options,
        hadImages: images.length > 0 || lostImages,
      });
      if (ok) setSavedLeft(true);
    }, 400);
    return () => clearTimeout(timer);
  }, [loaded, step, touched, platform, confirmations, sourceUrl, input, options, images.length, lostImages]);

  // Leaving mid-run would stop it between requests; the browser asks first.
  useEffect(() => {
    if (!running) return;
    const hold = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', hold);
    return () => window.removeEventListener('beforeunload', hold);
  }, [running]);

  const normalizedUrl = sourceUrl.trim() ? sourceUrlFor(platform, sourceUrl) : null;
  const sourceUrlValid = !sourceUrl.trim() || normalizedUrl !== null;
  const confirmed = confirmationsReady(items, confirmations) && sourceUrlValid;

  // The conversion, re-run on every change: the form shows its warnings under
  // the fields, the preview shows the whole draft.
  const deferredInput = useDeferredValue(input);
  const result = useMemo((): MigrationResult | null => {
    try {
      return convertToDraft(platform, deferredInput, convertOptions(options, images, platform));
    } catch {
      return null;
    }
  }, [platform, deferredInput, options, images]);

  // Whether this very draft was moved over before, asked once the preview settles.
  useEffect(() => {
    if (step !== 'preview' || !result) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      importedPlots(BROWSER_DEPS.fetch, draftFingerprint(result.draft), controller.signal).then(
        setExisting,
        () => undefined,
      );
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [step, result]);

  const scenes = useMemo(
    () => sceneFields(schema, input).map(({ path }) => ({ path, label: fieldLabel(schema, path) ?? path })),
    [schema, input],
  );

  const avatars = useMemo(() => {
    const byMember = new Map<number, string>();
    for (const image of images) {
      const url = urls.get(image.id);
      if (image.avatarOf !== null && url) byMember.set(image.avatarOf, url);
    }
    return byMember;
  }, [images, urls]);

  const canCreate = Boolean(result && result.draft.plot.name.trim() && result.draft.members.length > 0);

  function changeInput(next: SiteInput, reorder?: RowOrder): void {
    setInput(next);
    if (reorder) setOptions((current) => renumberOptions(current, reorder.sectionId, reorder.order));
  }

  function clearDraft(): void {
    clearSaved(browserStorage(), platform);
    setSavedLeft(false);
  }

  async function execute(current: Run): Promise<void> {
    setRunning(true);
    const finished = await runMigration(current.plan, current.steps, current.state, BROWSER_DEPS, (state) => {
      setRun((now) => (now ? { ...now, state } : now));
      // The plot exists now: a saved form would only make it twice.
      if (state.plotId) clearDraft();
    });
    setRun((now) => (now ? { ...now, state: finished } : now));
    setRunning(false);
  }

  function start(): void {
    if (!result || !canCreate || running) return;
    const plan: MigrationPlan = { platform, sourceUrl: normalizedUrl, draft: result.draft, images };
    const steps = planSteps(plan);
    const next: Run = { plan, steps, state: initialRun(steps), result };
    setRun(next);
    setStep('run');
    void execute(next);
  }

  const reachable = (target: WizardStep): boolean =>
    step !== 'run' && target !== 'run' && (target === 'confirm' || confirmed);

  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <Spinner label={t('loading')} />
      </div>
    );
  }

  const index = WIZARD_STEPS.indexOf(step);
  const previous = index > 0 && step !== 'run' ? WIZARD_STEPS[index - 1] : undefined;

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-10">
      <CreatorTabs />

      <div className="mt-6">
        <Link href="/plots/import/paste" className="text-xs text-link underline underline-offset-2">
          {t('backToSites')}
        </Link>
        <h1 className="mt-2 title2 sm:title1">{t('wizardTitle', { platform: site })}</h1>
        <p className="mt-1 text-sm text-muted">{t('wizardSubtitle')}</p>
      </div>

      <ol className="mt-6 flex flex-wrap gap-2" aria-label={t('stepsLabel')}>
        {WIZARD_STEPS.map((each, at) => (
          <li key={each}>
            <button
              type="button"
              data-testid={`migrate-step-${each}`}
              aria-current={each === step ? 'step' : undefined}
              disabled={each === step || !reachable(each)}
              onClick={() => setStep(each)}
              className={cx(
                'rounded-full border px-3 py-1 text-xs',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                each === step
                  ? 'border-fg bg-mint-soft font-medium text-fg'
                  : reachable(each)
                    ? 'border-line text-muted hover:text-fg'
                    : 'border-line text-muted/60',
              )}
            >
              {at + 1}. {t(`steps.${each}`)}
            </button>
          </li>
        ))}
      </ol>

      {restored && step !== 'run' ? (
        <p className="mt-4 text-xs text-muted" data-testid="migrate-restored">
          {lostImages && images.length === 0 ? t('restoredWithoutImages') : t('restored')}
        </p>
      ) : null}

      <div className="mt-4">
        {step === 'confirm' ? (
          <ConfirmStep
            platform={platform}
            items={items}
            checked={confirmations}
            onCheck={(id, value) => setConfirmations((current) => ({ ...current, [id]: value }))}
            sourceUrl={sourceUrl}
            sourceUrlValid={sourceUrlValid}
            onSourceUrl={setSourceUrl}
          />
        ) : null}

        {step === 'form' ? (
          <div className="space-y-4">
            <p className="rounded-xl border border-line bg-raised/50 px-4 py-3 text-xs leading-relaxed text-muted">
              {t('form.hint')}
            </p>
            <SiteForm schema={schema} input={input} warnings={result?.warnings ?? []} onChange={changeInput} />
          </div>
        ) : null}

        {step === 'images' ? (
          <ImagesStep
            images={images}
            urls={urls}
            memberNames={result?.draft.members.map((member) => member.name) ?? []}
            restoredWithoutImages={lostImages && images.length === 0}
            onChange={(next) => {
              setImages(next);
              if (next.length > 0) setLostImages(false);
            }}
          />
        ) : null}

        {step === 'preview' && result ? (
          <PreviewStep
            platform={platform}
            schema={schema}
            result={result}
            options={options}
            onOptions={setOptions}
            scenes={scenes}
            avatars={avatars}
            existing={existing}
          />
        ) : null}

        {step === 'run' && run ? (
          <RunStep
            platform={platform}
            schema={schema}
            steps={run.steps}
            state={run.state}
            running={running}
            result={run.result}
            preservedText={preservedFile(run.result.preserved)}
            savedLeft={savedLeft}
            onRetry={() => void execute(run)}
            onClearSaved={clearDraft}
            onBack={() => {
              setRun(null);
              setStep('preview');
            }}
          />
        ) : null}
      </div>

      {step !== 'run' ? (
        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          {step === 'preview' && !canCreate ? (
            <p className="mr-auto text-xs text-danger">{t('preview.cannotCreate')}</p>
          ) : null}
          {step === 'preview' && canCreate ? (
            <p className="mr-auto text-xs text-muted">{t('preview.createHint')}</p>
          ) : null}
          {previous ? (
            <Button data-testid="migrate-previous" onClick={() => setStep(previous)}>
              {t('previous')}
            </Button>
          ) : null}
          {step === 'preview' ? (
            <Button variant="primary" data-testid="migrate-create" disabled={!canCreate} onClick={start}>
              {t('preview.create')}
            </Button>
          ) : (
            <Button
              variant="primary"
              data-testid="migrate-next"
              disabled={!confirmed}
              onClick={() => setStep(WIZARD_STEPS[index + 1]!)}
            >
              {t('next')}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
