'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { apiGet, timeZoneHeaders } from '@/lib/api';
import type { PromptReport } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Button } from './ui';

type Block = PromptReport['blocks'][number];

/**
 * The list as it is drawn: every block on its own, except that a run of history
 * turns folds into one row. Depth lore and the author's note still sit between
 * the runs, which is where the model reads them.
 */
type Row = { type: 'block'; block: Block } | { type: 'history'; turns: Block[] };

function rowsOf(blocks: Block[]): Row[] {
  const rows: Row[] = [];
  for (const block of blocks) {
    const last = rows[rows.length - 1];
    if (block.kind !== 'history') rows.push({ type: 'block', block });
    else if (last?.type === 'history') last.turns.push(block);
    else rows.push({ type: 'history', turns: [block] });
  }
  return rows;
}

const TEXT = 'max-h-64 overflow-y-auto rounded-lg bg-raised/50 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words text-fg';
const SUMMARY =
  'flex cursor-pointer items-center gap-2 rounded-md py-1 text-sm text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/**
 * What the creator's work sends: the prompt a regenerate of this chat would
 * assemble right now, block by block, with what the budget allowed and which
 * lore fired. Read on demand rather than with the chat — it is a debugging view,
 * and building it is a whole prompt assembly.
 */
export function PromptInspector({ chatId }: { chatId: string }) {
  const t = useTranslations('chat.inspector');
  const format = useFormatter();
  const toMessage = useErrorMessage();
  const [report, setReport] = useState<PromptReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load(): Promise<void> {
    setLoading(true);
    setError('');
    try {
      // The clock macros expand in the reader's zone, as the regenerate it previews would.
      setReport(await apiGet<PromptReport>(`/api/chats/${chatId}/inspect`, undefined, timeZoneHeaders()));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  const tokens = (count: number): string => t('tokens', { count: format.number(count) });
  const kindLabel = (block: Block): string =>
    block.kind === 'history'
      ? t(`roles.${block.label === 'user' ? 'user' : 'assistant'}`)
      : [t(`kinds.${block.kind}`), block.label].filter(Boolean).join(' · ');

  const percent = (value: number): string =>
    report && report.totals.contextBudget > 0
      ? `${Math.min(100, (value / report.totals.contextBudget) * 100)}%`
      : '0%';

  return (
    <section data-testid="prompt-inspector" className="space-y-3 border-t border-line pt-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium text-muted">{t('title')}</h2>
        <div className="flex items-center gap-1">
          {report ? (
            <Button size="sm" variant="ghost" onClick={() => setReport(null)}>
              {t('close')}
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" busy={loading} onClick={() => void load()}>
            {report ? t('refresh') : t('open')}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted/80">{t('hint')}</p>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      {report ? (
        <div className="space-y-4">
          <div className="space-y-1.5">
            {/* Used from the left, the reply's reserve from the right: what is
                between them is what the history could still have had. */}
            <div className="relative h-2 overflow-hidden rounded-full bg-raised" aria-hidden="true">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-accent"
                style={{ width: percent(report.totals.used) }}
              />
              <span
                className="absolute inset-y-0 right-0 bg-muted/40"
                style={{ width: percent(report.totals.responseReserve) }}
              />
            </div>
            <p className="text-xs text-muted tabular-nums">
              {t('budget', {
                used: format.number(report.totals.used),
                budget: format.number(report.totals.contextBudget),
                reserve: format.number(report.totals.responseReserve),
              })}
            </p>
            <p className="text-xs text-muted tabular-nums">
              {t('counts', {
                history: report.history.included,
                historyTotal: report.history.total,
                examples: report.examples.included,
                examplesTotal: report.examples.total,
              })}
            </p>
          </div>

          <ol className="space-y-1">
            {rowsOf(report.blocks).map((row, index) =>
              row.type === 'block' ? (
                <li key={index}>
                  <details>
                    <summary className={SUMMARY}>
                      <span className="min-w-0 flex-1 truncate">{kindLabel(row.block)}</span>
                      <span className="shrink-0 text-xs text-muted tabular-nums">{tokens(row.block.tokens)}</span>
                    </summary>
                    <pre className={TEXT}>{row.block.text}</pre>
                  </details>
                </li>
              ) : (
                <li key={index}>
                  <details>
                    <summary className={SUMMARY}>
                      <span className="min-w-0 flex-1 truncate">
                        {t('historyRun', { count: row.turns.length })}
                      </span>
                      <span className="shrink-0 text-xs text-muted tabular-nums">
                        {tokens(row.turns.reduce((sum, turn) => sum + turn.tokens, 0))}
                      </span>
                    </summary>
                    <div className="space-y-2">
                      {row.turns.map((turn, at) => (
                        <div key={at} className="space-y-1">
                          <p className="text-xs text-muted">
                            {kindLabel(turn)} · {tokens(turn.tokens)}
                          </p>
                          <pre className={TEXT}>{turn.text}</pre>
                        </div>
                      ))}
                    </div>
                  </details>
                </li>
              ),
            )}
          </ol>

          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted">{t('lore')}</h3>
            {report.lore.length === 0 ? (
              <p className="text-sm text-muted">{t('loreEmpty')}</p>
            ) : (
              <ul className="space-y-2">
                {report.lore.map((entry) => (
                  <li key={entry.key} className="rounded-lg border border-line px-3 py-2">
                    <p className="text-sm break-words text-fg">{entry.preview}</p>
                    <p className="mt-1 text-xs text-muted">
                      {[
                        entry.source === 'plot' ? t('sourcePlot') : entry.source,
                        entry.placement.startsWith('depth ')
                          ? t('placement.depth', { depth: entry.placement.slice('depth '.length) })
                          : t(`placement.${entry.placement as 'before_char' | 'after_char'}`),
                        t(`via.${entry.via}`),
                        entry.keys.length > 0 ? entry.keys.join(', ') : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
