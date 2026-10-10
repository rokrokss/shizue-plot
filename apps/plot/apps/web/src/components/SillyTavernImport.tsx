'use client';

/**
 * The SillyTavern move's four screens — the pick, the scan, the review and the
 * run — as the wizard page arranges them. Everything here draws what the page
 * holds; deciding what to import and doing it is `lib/sillytavern/import.ts`.
 */
import type { StFile, StManifest } from '@shizue/core/sillytavern';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import {
  hasWork,
  type CharacterItem,
  type ImportOptions,
  type ImportStep,
  type Results,
  type Review,
  type Selection,
  type StepResult,
} from '@/lib/sillytavern/import';
import type { LibrarySource } from '@/lib/sillytavern/scan';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Avatar } from './Avatar';
import { Badge, Button, buttonClass, Checkbox, cx, Spinner } from './ui';

const PANEL = 'rounded-2xl border border-line bg-surface p-5 sm:p-6';

// ── pick ────────────────────────────────────────────────────────────────────

/**
 * The two ways in: the backup zip (dropped or picked) or the user-data folder.
 * Nothing is read until the scan; the picked files are handles.
 */
export function SourcePicker({ onPick }: { onPick: (source: LibrarySource) => void }) {
  const t = useTranslations('stImport.choose');
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div className="space-y-4">
      <section
        data-testid="st-zip-drop"
        className={cx(PANEL, 'space-y-3', over && 'border-fg bg-mint-soft/40')}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const file = event.dataTransfer.files[0];
          if (file) onPick({ kind: 'zip', file });
        }}
      >
        <h2 className="heading3 text-fg">{t('zipTitle')}</h2>
        <p className="text-sm text-muted">{t('zipHint')}</p>
        <input
          ref={zipInput}
          data-testid="st-zip-input"
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onPick({ kind: 'zip', file });
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => zipInput.current?.click()}>
            {t('zipPick')}
          </Button>
          <span className="text-xs text-muted">{t('zipDrop')}</span>
        </div>
      </section>

      <section className={cx(PANEL, 'space-y-3')}>
        <h2 className="heading3 text-fg">{t('folderTitle')}</h2>
        <p className="text-sm text-muted">{t('folderHint')}</p>
        <input
          // `webkitdirectory` is not in React's attribute list; set as written.
          ref={(node) => {
            folderInput.current = node;
            node?.setAttribute('webkitdirectory', '');
          }}
          data-testid="st-folder-input"
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            if (files.length > 0) onPick({ kind: 'folder', files });
          }}
        />
        <Button onClick={() => folderInput.current?.click()}>{t('folderPick')}</Button>
      </section>

      <p className="rounded-xl border border-line bg-raised/50 px-4 py-3 text-xs leading-relaxed text-muted">
        {t('privacy')}
      </p>
    </div>
  );
}

// ── scan ────────────────────────────────────────────────────────────────────

export type ScanStage = 'reading' | 'hashing' | 'checking';

export function ScanProgress({
  stage,
  done,
  total,
  onCancel,
}: {
  stage: ScanStage;
  done: number;
  total: number;
  onCancel: () => void;
}) {
  const t = useTranslations('stImport.scan');
  return (
    <div className={cx(PANEL, 'flex flex-wrap items-center gap-3')} data-testid="st-scanning">
      <Spinner />
      <p role="status" className="min-w-0 flex-1 text-sm text-fg">
        {stage === 'hashing' ? t('hashing', { done, total }) : t(stage)}
      </p>
      <Button size="sm" onClick={onCancel}>
        {t('cancel')}
      </Button>
    </div>
  );
}

// ── review ──────────────────────────────────────────────────────────────────

/** Bigger than the 40px it is drawn at, for a sharp face on a dense screen. */
const THUMB_PX = 80;

/**
 * A card's face, cut down to a thumbnail: the PNG is read when its row first
 * comes near the screen, drawn small, and let go, so a list of hundreds of cards
 * holds a few kilobytes each rather than the cards themselves.
 */
async function thumbnail(file: StFile): Promise<string> {
  const bytes = (await file.read()) as Uint8Array<ArrayBuffer>;
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_PX;
  canvas.height = THUMB_PX;
  const scale = Math.max(THUMB_PX / bitmap.width, THUMB_PX / bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  canvas.getContext('2d')?.drawImage(bitmap, (THUMB_PX - width) / 2, (THUMB_PX - height) / 2, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
  if (!blob) throw new Error('No thumbnail');
  return URL.createObjectURL(blob);
}

function StThumb({ file, name }: { file: StFile; name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let url: string | null = null;
    let gone = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        thumbnail(file).then(
          (made) => {
            if (gone) URL.revokeObjectURL(made);
            else {
              url = made;
              setSrc(made);
            }
          },
          // A card with no picture keeps its initial.
          () => undefined,
        );
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => {
      gone = true;
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);

  return (
    <span ref={ref} className="shrink-0">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="size-10 rounded-full bg-raised object-cover" />
      ) : (
        <Avatar src={null} name={name} className="size-10 text-sm" />
      )}
    </span>
  );
}

/** One checkable line of the review: a box, a face or not, a name and what it carries. */
function ReviewRow({
  testId,
  checked,
  disabled,
  onChange,
  face,
  name,
  imported,
  children,
}: {
  testId: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  face?: ReactNode;
  name: string;
  imported: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations('stImport.review');
  return (
    <li data-testid={testId} data-name={name} data-imported={imported || undefined}>
      <label
        className={cx(
          'flex items-start gap-3 rounded-xl px-3 py-2.5',
          disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:bg-raised/50',
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-3 size-4 shrink-0 accent-accent"
        />
        {face}
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-fg">{name}</span>
            {imported ? <Badge>{t('imported')}</Badge> : null}
          </span>
          {children}
        </span>
      </label>
    </li>
  );
}

function ChatSummary({ item }: { item: { plotId: string | null; chats: CharacterItem['chats'] } }) {
  const t = useTranslations('stImport.review');
  const fresh = item.chats.filter((chat) => chat.state === 'new').length;
  const incomplete = item.chats.filter((chat) => chat.state === 'incomplete').length;
  const parts = [t('chats', { count: item.chats.length })];
  // Only worth saying where an earlier run brought some of them in.
  if (item.chats.length > 0 && fresh + incomplete < item.chats.length && fresh > 0) {
    parts.push(t('chatsNew', { count: fresh }));
  }
  if (incomplete > 0) parts.push(t('chatsIncomplete', { count: incomplete }));
  return <>{parts.join(' · ')}</>;
}

/** Ticks or clears every row of a list that still has something to bring over. */
function toggled(current: Set<string>, keys: string[], on: boolean): Set<string> {
  const next = new Set(current);
  for (const key of keys) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

export function ReviewPanel({
  manifest,
  review,
  selection,
  onSelection,
  options,
  onOptions,
  steps,
  onStart,
  onRestart,
}: {
  manifest: StManifest;
  review: Review;
  selection: Selection;
  onSelection: (selection: Selection) => void;
  options: ImportOptions;
  onOptions: (options: ImportOptions) => void;
  /** How many steps the run would take with these choices. */
  steps: number;
  onStart: () => void;
  onRestart: () => void;
}) {
  const t = useTranslations('stImport.review');
  const reasons = useTranslations('stImport.skipReasons');
  const chatCount =
    review.characters.reduce((sum, item) => sum + item.chats.length, 0) +
    review.groups.reduce((sum, item) => sum + item.chats.length, 0);
  const selectable = review.characters.filter(hasWork).map((item) => item.key);
  const skippedFiles = [
    ...manifest.skipped.map((entry) => ({ path: entry.path, reason: reasons(entry.reason) })),
    ...review.unreadable.map((path) => ({ path, reason: reasons('unreadable') })),
  ];
  const set = (patch: Partial<ImportOptions>): void => onOptions({ ...options, ...patch });

  return (
    <div className="space-y-4" data-testid="st-review">
      <p className="text-sm text-fg" data-testid="st-summary">
        {t('summary', {
          characters: review.characters.length,
          groups: review.groups.length,
          personas: review.personas.length,
          chats: chatCount,
        })}
      </p>

      {review.characters.length > 0 ? (
        <section className={PANEL}>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="heading3 text-fg">{t('characters')}</h2>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onSelection({ ...selection, characters: toggled(selection.characters, selectable, true) })
                }
              >
                {t('selectAll')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onSelection({ ...selection, characters: toggled(selection.characters, selectable, false) })
                }
              >
                {t('selectNone')}
              </Button>
            </div>
          </div>
          <p className="mb-3 text-xs text-muted">{t('charactersHint')}</p>
          <ul className="-mx-3 max-h-[32rem] overflow-y-auto">
            {review.characters.map((item) => {
              const { character } = item;
              return (
                <ReviewRow
                  key={item.key}
                  testId="st-character"
                  name={character.name}
                  imported={item.plotId !== null}
                  checked={selection.characters.has(item.key)}
                  disabled={!hasWork(item)}
                  onChange={(on) =>
                    onSelection({ ...selection, characters: toggled(selection.characters, [item.key], on) })
                  }
                  face={<StThumb file={character.file} name={character.name} />}
                >
                  <span className="block text-xs text-muted">
                    <ChatSummary item={item} />
                    {character.worldName && !item.worldMissing
                      ? ` · ${t('world', { name: character.worldName })}`
                      : ''}
                    {character.extraWorlds.length > 0
                      ? ` · ${t('extraWorlds', { count: character.extraWorlds.length })}`
                      : ''}
                  </span>
                  {item.worldMissing && character.worldName ? (
                    <span className="block text-xs text-danger">
                      {t('worldMissing', { name: character.worldName })}
                    </span>
                  ) : null}
                  {item.unspeakable ? (
                    <span className="block text-xs text-danger" data-testid="st-unspeakable">
                      {t('unspeakable')}
                    </span>
                  ) : null}
                </ReviewRow>
              );
            })}
          </ul>
        </section>
      ) : null}

      {review.groups.length > 0 ? (
        <section className={PANEL}>
          <h2 className="heading3 mb-1 text-fg">{t('groups')}</h2>
          <p className="mb-3 text-xs text-muted">{t('groupsHint')}</p>
          <ul className="-mx-3">
            {review.groups.map((item) => (
              <ReviewRow
                key={item.key}
                testId="st-group"
                name={item.group.name}
                imported={item.plotId !== null}
                checked={selection.groups.has(item.key)}
                disabled={item.members.length === 0 || !hasWork(item)}
                onChange={(on) => onSelection({ ...selection, groups: toggled(selection.groups, [item.key], on) })}
              >
                <span className="block text-xs text-muted">
                  {item.members.length > 0
                    ? t('members', { names: item.members.map((member) => member.character.name).join(', ') })
                    : t('noMembers')}
                  {' · '}
                  <ChatSummary item={item} />
                </span>
                {item.overflow.length > 0 ? (
                  <span className="block text-xs text-danger" data-testid="st-group-overflow">
                    {t('overflow', { names: item.overflow.join(', ') })}
                  </span>
                ) : null}
                {item.missing.length > 0 ? (
                  <span className="block text-xs text-danger">
                    {t('missing', { names: item.missing.join(', ') })}
                  </span>
                ) : null}
              </ReviewRow>
            ))}
          </ul>
        </section>
      ) : null}

      {review.personas.length > 0 ? (
        <section className={PANEL}>
          <h2 className="heading3 mb-3 text-fg">{t('personas')}</h2>
          <ul className="-mx-3">
            {review.personas.map((item) => (
              <ReviewRow
                key={item.key}
                testId="st-persona"
                name={item.persona.name}
                imported={item.exists}
                checked={selection.personas.has(item.key)}
                disabled={item.exists}
                onChange={(on) =>
                  onSelection({ ...selection, personas: toggled(selection.personas, [item.key], on) })
                }
              >
                <span className="line-clamp-2 text-xs text-muted">
                  {item.exists ? t('personaExists') : item.persona.description}
                </span>
              </ReviewRow>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={cx(PANEL, 'space-y-3')}>
        <h2 className="heading3 text-fg">{t('options')}</h2>
        <Checkbox label={t('optionChats')} checked={options.chats} onChange={(chats) => set({ chats })} />
        <div className="space-y-1">
          <Checkbox
            label={t('optionMemoryBackfill')}
            checked={options.memoryBackfill}
            disabled={!options.chats}
            onChange={(memoryBackfill) => set({ memoryBackfill })}
          />
          <p className="pl-6 text-xs text-muted">{t('memoryNotice')}</p>
        </div>
        <Checkbox
          label={t('optionExtraLorebooks')}
          checked={options.extraLorebooks}
          onChange={(extraLorebooks) => set({ extraLorebooks })}
        />
        {manifest.globalWorlds.length > 0 ? (
          <Checkbox
            label={t('optionGlobalLorebooks', { names: manifest.globalWorlds.join(', ') })}
            checked={options.globalLorebooks}
            onChange={(globalLorebooks) => set({ globalLorebooks })}
          />
        ) : null}
        {manifest.globalRegex.length > 0 ? (
          <Checkbox
            label={t('optionGlobalRegex', { count: manifest.globalRegex.length })}
            checked={options.globalRegex}
            onChange={(globalRegex) => set({ globalRegex })}
          />
        ) : null}
        <p className="text-xs text-muted">{t('privateNotice')}</p>
      </section>

      <details className={cx(PANEL, 'text-sm')} data-testid="st-not-imported">
        <summary className="cursor-pointer heading3 text-fg">{t('notImported')}</summary>
        <p className="mt-3 text-xs leading-relaxed text-muted">{t('notImportedList')}</p>
        {skippedFiles.length > 0 ? (
          <>
            <p className="mt-3 text-xs font-medium text-fg">{t('skippedFiles', { count: skippedFiles.length })}</p>
            <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-xs text-muted">
              {skippedFiles.map((entry) => (
                <li key={`${entry.path}:${entry.reason}`} className="break-all">
                  {entry.path} — {entry.reason}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </details>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {steps === 0 ? <p className="mr-auto text-xs text-muted">{t('nothing')}</p> : null}
        <Button onClick={onRestart}>{t('restart')}</Button>
        <Button variant="primary" data-testid="st-start" disabled={steps === 0} onClick={onStart}>
          {t('start', { count: steps })}
        </Button>
      </div>
    </div>
  );
}

// ── run ─────────────────────────────────────────────────────────────────────

const stepName = (step: ImportStep): string => {
  switch (step.kind) {
    case 'persona':
      return step.item.persona.name;
    case 'character':
      return step.item.character.name;
    case 'group':
      return step.item.group.name;
    case 'chat':
      return step.item.chat.name;
  }
};

const STATUS_TONE: Record<StepResult['status'], string> = {
  pending: 'text-muted',
  running: 'text-fg',
  done: 'text-link',
  skipped: 'text-muted',
  failed: 'text-danger',
  cancelled: 'text-muted',
};

function StepRow({ step, result }: { step: ImportStep; result: StepResult }) {
  const t = useTranslations('stImport.run');
  const toMessage = useErrorMessage();
  const dropped = result.dropped;
  const droppedParts = dropped
    ? (['hidden', 'empty', 'malformed', 'overLimit', 'swipes', 'swipesOverRows'] as const)
        .filter((key) => dropped[key] > 0)
        .map((key) => t(`dropped.${key}`, { count: dropped[key] }))
    : [];

  return (
    <li
      data-testid="st-step"
      data-kind={step.kind}
      data-name={stepName(step)}
      data-status={result.status}
      className={cx('space-y-0.5 py-2', step.kind === 'chat' && 'pl-6')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs text-muted">{t(`kinds.${step.kind}`)}</span>
        <span className="min-w-0 truncate text-sm text-fg">{stepName(step)}</span>
        <span className={cx('text-xs font-medium', STATUS_TONE[result.status])}>
          {t(`status.${result.status}`)}
        </span>
        {result.status === 'running' ? <Spinner /> : null}
        {result.plotId && step.kind !== 'chat' && (result.status === 'done' || result.status === 'skipped') ? (
          <Link href={`/plots/${result.plotId}`} className="ml-auto text-xs text-link underline underline-offset-2">
            {t('openPlot')}
          </Link>
        ) : null}
        {result.chatId && (result.status === 'done' || result.status === 'skipped') ? (
          <Link href={`/chats/${result.chatId}`} className="ml-auto text-xs text-link underline underline-offset-2">
            {t('openChat')}
          </Link>
        ) : null}
      </div>
      {result.reason ? <p className="text-xs text-muted">{t(`reasons.${result.reason}`)}</p> : null}
      {result.error ? <p className="text-xs text-danger">{toMessage(result.error)}</p> : null}
      {result.memoryBackfill && result.memoryBackfill !== 'not_needed' ? (
        <p className="text-xs text-muted">{t(`memory.${result.memoryBackfill}`)}</p>
      ) : null}
      {droppedParts.length > 0 ? (
        <p className="text-xs text-muted">{t('dropped.label', { list: droppedParts.join(' · ') })}</p>
      ) : null}
      {dropped && dropped.unknownSpeaker > 0 ? (
        <p className="text-xs text-muted">{t('unknownSpeaker', { count: dropped.unknownSpeaker })}</p>
      ) : null}
      {(result.warnings ?? []).map((warning, index) => (
        <p key={index} className="text-xs text-danger">
          {t(`warnings.${warning.code}`, {
            name: warning.name ?? '',
            message: warning.error ? toMessage(warning.error) : '',
          })}
        </p>
      ))}
    </li>
  );
}

export function RunPanel({
  steps,
  results,
  running,
  onCancel,
  onRetry,
}: {
  steps: ImportStep[];
  results: Results;
  running: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const t = useTranslations('stImport.run');
  const status = (step: ImportStep): StepResult => results[step.id] ?? { status: 'pending' };
  const finished = steps.filter((step) => !['pending', 'running'].includes(status(step).status)).length;
  const count = (wanted: StepResult['status']): number =>
    steps.filter((step) => status(step).status === wanted).length;
  const failed = count('failed');
  const cancelled = count('cancelled');
  const current = steps.find((step) => status(step).status === 'running');
  const percent = steps.length === 0 ? 100 : Math.round((finished / steps.length) * 100);
  // The run stops sending chats once the API says there is no model to put them
  // on; the cards still came over, and the way on is to connect one and retry.
  const noModel = steps.some((step) => status(step).error?.code === 'model_unavailable');

  return (
    <div className="space-y-4" data-testid="st-run" data-running={running || undefined}>
      <section className={cx(PANEL, 'space-y-3')}>
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="min-w-0 flex-1 text-sm text-fg">
            {running
              ? current
                ? t('current', { name: stepName(current) })
                : t('starting')
              : t('summary', { done: count('done'), skipped: count('skipped'), failed, cancelled })}
          </p>
          <span className="text-xs text-muted">{t('progress', { done: finished, total: steps.length })}</span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('progressLabel')}
          className="h-2 overflow-hidden rounded-full bg-raised"
        >
          <div className="h-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {running ? (
            <Button onClick={onCancel}>{t('cancel')}</Button>
          ) : (
            <>
              {failed + cancelled > 0 ? (
                <Button data-testid="st-retry" onClick={onRetry}>
                  {t('retry')}
                </Button>
              ) : null}
              <Link href="/plots" className={buttonClass('primary')}>
                {t('toPlots')}
              </Link>
            </>
          )}
        </div>
        {!running && cancelled > 0 ? <p className="text-xs text-muted">{t('cancelledNotice')}</p> : null}
        {noModel ? (
          <p className="text-xs text-danger" data-testid="st-no-model">
            {t.rich('modelUnavailable', {
              link: (chunks) => (
                <Link href="/settings" className="text-link underline underline-offset-2">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        ) : null}
      </section>

      <section className={PANEL}>
        <ul className="divide-y divide-line">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} result={status(step)} />
          ))}
        </ul>
      </section>
    </div>
  );
}
