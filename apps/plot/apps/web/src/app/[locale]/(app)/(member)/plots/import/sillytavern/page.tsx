'use client';

import type { StManifest } from '@shizue/core/sillytavern';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CreatorTabs } from '@/components/CreatorTabs';
import {
  ReviewPanel,
  RunPanel,
  ScanProgress,
  SourcePicker,
  type ScanStage,
} from '@/components/SillyTavernImport';
import { ErrorText, cx } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { apiGet } from '@/lib/api';
import {
  DEFAULT_OPTIONS,
  defaultSelection,
  fingerprint,
  initialResults,
  lookupImports,
  planImport,
  reviewImport,
  runImport,
  type ImportOptions,
  type ImportStep,
  type Results,
  type Review,
  type Selection,
} from '@/lib/sillytavern/import';
import { IMPORT_DEPS, scanLibrary, type LibrarySource } from '@/lib/sillytavern/scan';
import type { Persona } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useErrorMessage } from '@/lib/useErrorMessage';

type Phase = 'choose' | 'scanning' | 'review' | 'run';

const STEPS = ['choose', 'review', 'run'] as const;

/**
 * Moving a SillyTavern library over (`/plots/import/sillytavern`): pick the
 * backup or the folder, let the browser read it, check what comes over, run it.
 * The backup is read here and never uploaded whole — the run sends only the
 * chosen cards, their lorebooks and the converted chats (`lib/sillytavern`).
 */
export default function SillyTavernImportPage() {
  const t = useTranslations('stImport');
  const toMessage = useErrorMessage();
  useDocumentTitle(t('title'));

  const [phase, setPhase] = useState<Phase>('choose');
  const [error, setError] = useState('');
  const [scan, setScan] = useState<{ stage: ScanStage; done: number; total: number }>({
    stage: 'reading',
    done: 0,
    total: 0,
  });
  const [manifest, setManifest] = useState<StManifest | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [options, setOptions] = useState<ImportOptions>(DEFAULT_OPTIONS);
  const [steps, setSteps] = useState<ImportStep[]>([]);
  const [results, setResults] = useState<Results>({});
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // Leaving mid-run stops it where it stands; the browser asks first.
  useEffect(() => {
    if (!running) return;
    const hold = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', hold);
    return () => window.removeEventListener('beforeunload', hold);
  }, [running]);

  // Stops whatever is in flight when the page goes.
  useEffect(() => () => abort.current?.abort(), []);

  const planned = useMemo(
    () => (review && selection ? planImport(review, selection, options) : []),
    [review, selection, options],
  );

  function restart(): void {
    abort.current?.abort();
    setPhase('choose');
    setManifest(null);
    setReview(null);
    setSelection(null);
    setSteps([]);
    setResults({});
  }

  /**
   * The scan: the core lists and reads the library, every card and chat is
   * hashed, and the account is asked which of them an earlier run brought in.
   */
  async function pick(source: LibrarySource): Promise<void> {
    const controller = new AbortController();
    abort.current = controller;
    const { signal } = controller;
    setError('');
    setPhase('scanning');
    setScan({ stage: 'reading', done: 0, total: 0 });
    try {
      // The scanner itself cannot be stopped, so a cancelled one is let finish and
      // dropped here — after which a newer pick may already be on screen.
      const scanned = await scanLibrary(source);
      signal.throwIfAborted();
      const { hashes, unreadable } = await fingerprint(scanned, {
        signal,
        onProgress: (done, total) => setScan({ stage: 'hashing', done, total }),
      });
      setScan((current) => ({ ...current, stage: 'checking' }));
      const [lookup, personas] = await Promise.all([
        lookupImports(IMPORT_DEPS.fetch, hashes.values(), signal),
        apiGet<Persona[]>('/api/personas', signal),
      ]);
      signal.throwIfAborted();
      const reviewed = reviewImport(
        scanned,
        hashes,
        lookup,
        personas.map((persona) => persona.name),
        unreadable,
      );
      setManifest(scanned);
      setReview(reviewed);
      setSelection(defaultSelection(reviewed));
      setOptions(DEFAULT_OPTIONS);
      setPhase('review');
    } catch (caught) {
      if (signal.aborted) return;
      setError(toMessage(caught));
      setPhase('choose');
    }
  }

  async function run(plan: ImportStep[], previous: Results): Promise<void> {
    if (!manifest || !review) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    const cardHashes = review.characters.map((item) => item.sha256);
    const finished = await runImport({ manifest, steps: plan, options, cardHashes }, previous, IMPORT_DEPS, {
      signal: controller.signal,
      onUpdate: setResults,
    });
    setResults(finished);
    setRunning(false);
  }

  function start(): void {
    const plan = planned;
    const initial = initialResults(plan);
    setSteps(plan);
    setResults(initial);
    setPhase('run');
    void run(plan, initial);
  }

  const current = phase === 'scanning' ? 'choose' : phase;

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-10">
      <CreatorTabs />

      <div className="mt-6">
        <Link href="/plots" className="text-xs text-link underline underline-offset-2">
          {t('back')}
        </Link>
        <h1 className="mt-2 title2 sm:title1">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('subtitle')}</p>
      </div>

      <ol className="mt-6 flex flex-wrap gap-2" aria-label={t('stepsLabel')}>
        {STEPS.map((step, index) => (
          <li
            key={step}
            aria-current={step === current ? 'step' : undefined}
            className={cx(
              'rounded-full border px-3 py-1 text-xs',
              step === current ? 'border-fg bg-mint-soft font-medium text-fg' : 'border-line text-muted',
            )}
          >
            {index + 1}. {t(`steps.${step}`)}
          </li>
        ))}
      </ol>

      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      <div className="mt-4">
        {phase === 'choose' ? <SourcePicker onPick={(source) => void pick(source)} /> : null}
        {phase === 'scanning' ? (
          <ScanProgress
            {...scan}
            onCancel={() => {
              abort.current?.abort();
              setPhase('choose');
            }}
          />
        ) : null}
        {phase === 'review' && manifest && review && selection ? (
          <ReviewPanel
            manifest={manifest}
            review={review}
            selection={selection}
            onSelection={setSelection}
            options={options}
            onOptions={setOptions}
            steps={planned.length}
            onStart={start}
            onRestart={restart}
          />
        ) : null}
        {phase === 'run' ? (
          <RunPanel
            steps={steps}
            results={results}
            running={running}
            onCancel={() => abort.current?.abort()}
            onRetry={() => void run(steps, results)}
          />
        ) : null}
      </div>
    </div>
  );
}
