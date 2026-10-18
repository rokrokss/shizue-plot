'use client';

import { MAX_FACT_LENGTH } from '@shizue/core';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiSend } from '@/lib/api';
import type { MemoryFact, MemorySummary } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Button, ErrorText, Spinner, TextArea, cx } from './ui';

/** Summaries of the current branch shown at a time, newest first; the rest one press away. */
const PAGE = 20;
/** When the list is read again after a change, for the summary the background writes after a turn. */
const BACKGROUND_DELAY_MS = 6000;

/**
 * Where the plot's embedding model stands on the server: until it is ready,
 * memory picks no summary by meaning and takes no facts.
 */
type MemoryModelState = 'ready' | 'downloading' | 'missing' | 'off';

const ACTION =
  'rounded-md px-1.5 py-0.5 text-xs transition-colors disabled:opacity-50 focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-focus';

/**
 * The chat's memory, as RisuAI's HypaV3 shows it: every summary with the
 * messages it covers, and for each a pin (important — selected before any
 * other), an edit, a regenerate that offers a new text to keep or throw away,
 * and a delete. The summaries the current branch holds come first, newest at
 * the top; ones written on another branch wait folded below.
 *
 * Below them, the facts of the summaries on the branch (`facts.ts` in the API):
 * the durable ones taken from what each summary covers, each to edit or delete;
 * the ones a later summary ended wait folded below them, struck, to restore.
 *
 * The list is the panel's own to fetch: it is read again whenever `version`
 * moves — the branch's head (a turn, a swipe) or the chat's memory revision (an
 * edit, a hide, a delete) — since any of them can change which summaries apply,
 * and once more a little later, by when the background has usually written
 * the summary the change was due.
 */
export function MemorySummaries({
  chatId,
  version,
  disabled,
}: {
  chatId: string;
  /** Changes whenever the summaries may have: the head and the memory revision. */
  version: string;
  /** True while a reply streams or another setting is being saved. */
  disabled: boolean;
}) {
  const t = useTranslations('chat');
  const toMessage = useErrorMessage();
  const [summaries, setSummaries] = useState<MemorySummary[] | null>(null);
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [memoryModel, setMemoryModel] = useState<MemoryModelState>('ready');
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const answer = await apiGet<{ summaries: MemorySummary[]; facts: MemoryFact[]; memoryModel?: MemoryModelState }>(
          `/api/chats/${chatId}/memory`,
          signal,
        );
        setSummaries(answer.summaries);
        setFacts(answer.facts);
        setMemoryModel(answer.memoryModel ?? 'ready');
        setError('');
      } catch (caught) {
        if (signal?.aborted) return;
        setError(toMessage(caught));
      }
    },
    [chatId, toMessage],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const later = setTimeout(() => void load(controller.signal), BACKGROUND_DELAY_MS);
    return () => {
      clearTimeout(later);
      controller.abort();
    };
  }, [load, version]);

  const replace = (next: MemorySummary): void =>
    setSummaries((current) => current?.map((summary) => (summary.id === next.id ? next : summary)) ?? null);
  // A summary's facts go with it.
  const remove = (id: string): void => {
    setSummaries((current) => current?.filter((summary) => summary.id !== id) ?? null);
    setFacts((current) => current.filter((fact) => fact.summaryId !== id));
  };
  const onFactError = (caught: unknown): void => setError(caught === null ? '' : toMessage(caught));
  const changeFact = (next: MemoryFact): void =>
    setFacts((current) => current.map((item) => (item.id === next.id ? next : item)));
  // The facts that hold are sent; the ones a later summary ended wait folded below, to restore.
  const holding = facts.filter((fact) => !fact.invalidated);
  const ended = facts.filter((fact) => fact.invalidated);

  const applied = (summaries ?? []).filter((summary) => summary.applies).reverse();
  const elsewhere = (summaries ?? []).filter((summary) => !summary.applies);
  const card = (summary: MemorySummary) => (
    <SummaryCard
      key={summary.id}
      chatId={chatId}
      summary={summary}
      disabled={disabled}
      onChanged={replace}
      onDeleted={remove}
      onError={(caught) => setError(caught === null ? '' : toMessage(caught))}
    />
  );

  return (
    <section data-testid="chat-memory" className="space-y-3 border-t border-line pt-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium text-muted">{t('memory')}</h2>
        {applied.length > 0 ? (
          <span className="text-xs text-muted">{t('memoryCount', { count: applied.length })}</span>
        ) : null}
      </div>
      {summaries === null && !error ? <Spinner label={t('memoryLoading')} /> : null}
      {summaries !== null && applied.length === 0 ? <p className="text-sm text-muted">{t('memoryEmpty')}</p> : null}
      <p className="text-xs text-muted">{t('memoryHint')}</p>
      {memoryModel === 'downloading' || memoryModel === 'missing' ? (
        <p data-testid="memory-model" className="text-xs text-muted">
          {t(memoryModel === 'downloading' ? 'memoryModelDownloading' : 'memoryModelMissing')}
        </p>
      ) : null}
      <ErrorText>{error}</ErrorText>

      {applied.length > 0 ? <ol className="space-y-3">{applied.slice(0, shown).map(card)}</ol> : null}
      {applied.length > shown ? (
        <Button size="sm" variant="ghost" onClick={() => setShown((count) => count + PAGE)}>
          {t('memoryShowOlder', { count: applied.length - shown })}
        </Button>
      ) : null}

      {elsewhere.length > 0 ? (
        <details data-testid="memory-elsewhere" className="space-y-3">
          <summary className="cursor-pointer text-xs text-muted">
            {t('memoryElsewhere', { count: elsewhere.length })}
          </summary>
          <ol className="mt-3 space-y-3">{elsewhere.map(card)}</ol>
        </details>
      ) : null}

      <div data-testid="memory-facts" className="space-y-3 pt-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-medium text-muted">{t('memoryFacts')}</h3>
          {holding.length > 0 ? (
            <span className="text-xs text-muted">{t('memoryFactsCount', { count: holding.length })}</span>
          ) : null}
        </div>
        {summaries !== null && holding.length === 0 ? <p className="text-sm text-muted">{t('memoryFactsEmpty')}</p> : null}
        <p className="text-xs text-muted">{t('memoryFactsHint')}</p>
        {holding.length > 0 ? (
          <ul className="space-y-2">
            {holding.map((fact) => (
              <FactCard
                key={fact.id}
                chatId={chatId}
                fact={fact}
                disabled={disabled}
                onChanged={changeFact}
                onDeleted={(id) => setFacts((current) => current.filter((item) => item.id !== id))}
                onError={onFactError}
              />
            ))}
          </ul>
        ) : null}
        {ended.length > 0 ? (
          <details data-testid="memory-ended-facts">
            <summary className="cursor-pointer text-xs text-muted">{t('memoryEndedFacts', { count: ended.length })}</summary>
            <p className="mt-2 text-xs text-muted">{t('memoryEndedHint')}</p>
            <ul className="mt-2 space-y-2">
              {ended.map((fact) => (
                <EndedFactCard key={fact.id} chatId={chatId} fact={fact} disabled={disabled} onChanged={changeFact} onError={onFactError} />
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}

/** One fact, with an edit in place and a delete, as a summary has. */
function FactCard({
  chatId,
  fact,
  disabled,
  onChanged,
  onDeleted,
  onError,
}: {
  chatId: string;
  fact: MemoryFact;
  disabled: boolean;
  onChanged: (fact: MemoryFact) => void;
  onDeleted: (id: string) => void;
  onError: (error: unknown) => void;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const [draft, setDraft] = useState<string | null>(null);
  const [working, setWorking] = useState<'save' | 'delete' | null>(null);
  const base = `/api/chats/${chatId}/memory/facts/${fact.id}`;
  const busy = disabled || working !== null;

  async function run(kind: NonNullable<typeof working>, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setWorking(kind);
    onError(null);
    try {
      await action();
    } catch (caught) {
      onError(caught);
    } finally {
      setWorking(null);
    }
  }

  // A group scene's fact says who may be told it; a fact of no scene (a work of one, or older) says nothing.
  const knownTo =
    fact.knownTo === null || (!fact.knownToAll && fact.knownTo.length === 0)
      ? null
      : fact.knownToAll
        ? t('memoryFactKnownToAll')
        : t('memoryFactKnownTo', { names: fact.knownTo.map((member) => member.name).join(', ') });

  return (
    <li data-testid="memory-fact" className="space-y-2 rounded-xl border border-line bg-surface p-3">
      {draft === null ? (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="break-keep text-sm text-fg [overflow-wrap:anywhere]">{fact.content}</p>
            {knownTo !== null ? (
              <p data-testid="memory-fact-known-to" className="break-keep text-xs text-muted [overflow-wrap:anywhere]">
                {knownTo}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => setDraft(fact.content)}
              className={cx(ACTION, 'text-muted hover:text-fg')}
            >
              {common('edit')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(t('memoryFactDeleteConfirm'))) return;
                void run('delete', async () => {
                  await apiSend<void>('DELETE', base);
                  onDeleted(fact.id);
                });
              }}
              className={cx(ACTION, 'text-danger hover:bg-danger/10')}
            >
              {common('delete')}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <TextArea
            rows={2}
            value={draft}
            disabled={busy}
            maxLength={MAX_FACT_LENGTH}
            aria-label={t('memoryFactEditLabel')}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              {common('cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              busy={working === 'save'}
              disabled={busy || draft.trim() === ''}
              onClick={() =>
                void run('save', async () => {
                  const answer = await apiSend<{ fact: MemoryFact }>('PATCH', base, { content: draft });
                  onChanged(answer.fact);
                  setDraft(null);
                })
              }
            >
              {common('save')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * A fact a later summary ended: struck through, with what took its place and
 * the turn it ended at, and a restore — it holds again, and is sent again.
 */
function EndedFactCard({
  chatId,
  fact,
  disabled,
  onChanged,
  onError,
}: {
  chatId: string;
  fact: MemoryFact;
  disabled: boolean;
  onChanged: (fact: MemoryFact) => void;
  onError: (error: unknown) => void;
}) {
  const t = useTranslations('chat');
  const [working, setWorking] = useState(false);
  const busy = disabled || working;

  async function restore(): Promise<void> {
    if (busy) return;
    setWorking(true);
    onError(null);
    try {
      const answer = await apiSend<{ fact: MemoryFact }>('PATCH', `/api/chats/${chatId}/memory/facts/${fact.id}`, {
        invalidated: false,
      });
      onChanged(answer.fact);
    } catch (caught) {
      onError(caught);
    } finally {
      setWorking(false);
    }
  }

  return (
    <li data-testid="memory-ended-fact" className="space-y-1 rounded-xl border border-line bg-raised/40 p-3">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 break-keep text-sm text-muted line-through [overflow-wrap:anywhere]">{fact.content}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void restore()}
          className={cx(ACTION, 'shrink-0 text-muted hover:text-fg')}
        >
          {t('memoryFactRestore')}
        </button>
      </div>
      {fact.supersededBy ? (
        <p className="break-keep text-xs text-fg [overflow-wrap:anywhere]">
          {t('memoryReplacedBy', { content: fact.supersededBy.content })}
        </p>
      ) : null}
      {fact.invalidatedTurn !== null ? (
        <p className="text-xs text-muted">{t('memoryEndedAt', { turn: fact.invalidatedTurn })}</p>
      ) : null}
    </li>
  );
}

function SummaryCard({
  chatId,
  summary,
  disabled,
  onChanged,
  onDeleted,
  onError,
}: {
  chatId: string;
  summary: MemorySummary;
  disabled: boolean;
  onChanged: (summary: MemorySummary) => void;
  onDeleted: (id: string) => void;
  /** A failure to say, or null as an action starts and the last one is no longer news. */
  onError: (error: unknown) => void;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const [draft, setDraft] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [working, setWorking] = useState<'pin' | 'save' | 'regenerate' | 'delete' | null>(null);
  const base = `/api/chats/${chatId}/memory/${summary.id}`;
  const busy = disabled || working !== null;

  async function run(kind: NonNullable<typeof working>, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setWorking(kind);
    onError(null);
    try {
      await action();
    } catch (caught) {
      onError(caught);
    } finally {
      setWorking(null);
    }
  }

  const patch = (body: { text?: string; important?: boolean }) =>
    run(body.text === undefined ? 'pin' : 'save', async () => {
      const answer = await apiSend<{ summary: MemorySummary }>('PATCH', base, body);
      onChanged(answer.summary);
      if (body.text !== undefined) {
        setDraft(null);
        setCandidate(null);
      }
    });

  const positions = summary.messages.flatMap((message) => (message.position === null ? [] : [message.position + 1]));
  const range =
    !summary.applies || positions.length === 0
      ? t('memoryOtherBranch')
      : positions.length === 1
        ? t('memoryCoversOne', { at: positions[0]! })
        : t('memoryCovers', { from: Math.min(...positions), to: Math.max(...positions) });

  return (
    <li
      data-testid="memory-summary"
      className={cx('space-y-2 rounded-xl border bg-surface p-3', summary.important ? 'border-fg/40' : 'border-line')}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-xs text-muted">{range}</span>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            aria-pressed={summary.important}
            disabled={busy}
            onClick={() => void patch({ important: !summary.important })}
            className={cx(ACTION, summary.important ? 'font-medium text-fg' : 'text-muted hover:text-fg')}
          >
            <span aria-hidden="true">{summary.important ? '★ ' : '☆ '}</span>
            {t('memoryImportant')}
          </button>
          <button
            type="button"
            disabled={busy || draft !== null}
            onClick={() => setDraft(summary.text)}
            className={cx(ACTION, 'text-muted hover:text-fg')}
          >
            {common('edit')}
          </button>
          <button
            type="button"
            disabled={busy || summary.messages.length === 0}
            onClick={() =>
              void run('regenerate', async () => {
                const answer = await apiSend<{ text: string }>('POST', `${base}/regenerate`);
                setCandidate(answer.text);
              })
            }
            className={cx(ACTION, 'text-muted hover:text-fg')}
          >
            {working === 'regenerate' ? t('memoryRegenerating') : t('memoryRegenerate')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(t('memoryDeleteConfirm'))) return;
              void run('delete', async () => {
                await apiSend<void>('DELETE', base);
                onDeleted(summary.id);
              });
            }}
            className={cx(ACTION, 'text-danger hover:bg-danger/10')}
          >
            {common('delete')}
          </button>
        </div>
      </div>

      {draft === null ? (
        <p className="whitespace-pre-wrap break-keep text-sm text-fg [overflow-wrap:anywhere]">{summary.text}</p>
      ) : (
        <div className="space-y-2">
          <TextArea
            rows={6}
            value={draft}
            disabled={busy}
            aria-label={t('memoryEditLabel')}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              {common('cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              busy={working === 'save'}
              disabled={busy || draft.trim() === ''}
              onClick={() => void patch({ text: draft })}
            >
              {common('save')}
            </Button>
          </div>
        </div>
      )}

      {candidate !== null ? (
        <div data-testid="memory-candidate" className="space-y-2 rounded-lg border border-dashed border-line bg-raised/40 p-3">
          <p className="text-xs font-medium text-muted">{t('memoryRegenerated')}</p>
          <p className="whitespace-pre-wrap break-keep text-sm text-fg [overflow-wrap:anywhere]">{candidate}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCandidate(null)}>
              {common('cancel')}
            </Button>
            <Button size="sm" variant="primary" busy={working === 'save'} disabled={busy} onClick={() => void patch({ text: candidate })}>
              {t('memoryApply')}
            </Button>
          </div>
        </div>
      ) : null}

      <details>
        <summary className="cursor-pointer text-xs text-muted">
          {t('memoryMessages', { count: summary.messages.length })}
        </summary>
        <ul className="mt-2 space-y-1">
          {summary.messages.map((message) => (
            <li key={message.id} className="flex gap-2 text-xs">
              <span className="shrink-0 text-muted">
                {message.position === null ? '·' : `#${message.position + 1}`}{' '}
                {message.role === 'user' ? t('memoryRoleUser') : t('memoryRoleAssistant')}
              </span>
              <span className="min-w-0 break-keep text-fg [overflow-wrap:anywhere]">{message.preview}</span>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
