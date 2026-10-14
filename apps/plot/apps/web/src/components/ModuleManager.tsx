'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { apiSend, apiUpload } from '@/lib/api';
import { checkCardSize } from '@/lib/realm';
import type { PlotDetail, PlotModuleSummary } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Badge, Button, ErrorText } from './ui';

/**
 * The RisuAI modules brought into a work — the creator's side of RisuAI's module
 * list. A module is the work's, every member's, and runs after the cards' own;
 * the server keeps it apart from the custom UI the editors here save, so an
 * import or a removal lands at once, outside the Save, and answers with the
 * plot's owner view (`onChange`).
 */
export function ModuleManager({
  plotId,
  modules,
  disabled = false,
  onChange,
}: {
  plotId: string;
  modules: readonly PlotModuleSummary[];
  disabled?: boolean;
  onChange: (detail: PlotDetail) => void;
}) {
  const t = useTranslations('plot');
  const toMessage = useErrorMessage();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'import' | string | null>(null);
  const [error, setError] = useState('');

  async function importFile(file: File): Promise<void> {
    if (busy) return;
    setBusy('import');
    setError('');
    try {
      onChange(await apiUpload<PlotDetail>(`/api/plots/${plotId}/modules`, checkCardSize(file)));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove(module: PlotModuleSummary): Promise<void> {
    if (busy || !window.confirm(t('moduleRemoveConfirm', { name: module.name }))) return;
    setBusy(module.id);
    setError('');
    try {
      onChange(await apiSend<PlotDetail>('DELETE', `/api/plots/${plotId}/modules/${module.id}`));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3" data-testid="modules">
      <h3 className="text-xs font-medium text-muted">{t('modules')}</h3>
      <p className="text-xs text-muted">{t('modulesHint')}</p>
      {modules.length === 0 ? (
        <p className="text-xs text-muted">{t('modulesEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {modules.map((module) => (
            <li key={module.id} data-testid="module" className="space-y-2 rounded-xl border border-line bg-raised/50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium break-keep [overflow-wrap:anywhere]">{module.name}</p>
                  {module.description.trim() ? (
                    <p className="line-clamp-2 text-xs text-muted break-keep">{module.description}</p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  busy={busy === module.id}
                  disabled={disabled || busy !== null}
                  onClick={() => void remove(module)}
                >
                  {t('moduleRemove')}
                </Button>
              </div>
              <p className="text-xs text-muted tabular-nums">
                {t('moduleContents', {
                  lore: module.loreCount,
                  regex: module.regexCount,
                  triggers: module.triggerCount,
                  assets: module.assetCount,
                })}
              </p>
              {module.background || module.lowLevelAccess ? (
                <div className="flex flex-wrap gap-1.5">
                  {module.background ? <Badge>{t('moduleBackground')}</Badge> : null}
                  {module.lowLevelAccess ? <Badge>{t('moduleLowLevelAccess')}</Badge> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".risum,.json,application/json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="module-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
        }}
      />
      <div className="space-y-1">
        <Button
          size="sm"
          busy={busy === 'import'}
          disabled={disabled || busy !== null}
          onClick={() => fileInput.current?.click()}
        >
          {t('moduleImport')}
        </Button>
        <p className="text-xs text-muted">{t('moduleImportHint')}</p>
      </div>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </div>
  );
}
