'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { apiSend, apiUpload } from '@/lib/api';
import { readImportWarnings, type ImportWarning } from '@/lib/importWarnings';
import { checkCardSize } from '@/lib/realm';
import type { PlotDetail, PlotModuleSummary } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { ImportWarnings, RightsConfirmation } from './CardImport';
import { ModuleInertNotice } from './ReaderModules';
import { Badge, Button, ErrorText } from './ui';

/**
 * The RisuAI modules brought into a work — the creator's side of RisuAI's module
 * list. A module is the work's, every member's, and runs after the cards' own;
 * the server keeps it apart from the custom UI the editors here save, so an
 * import or a removal lands at once, outside the Save, and answers with the
 * plot's owner view (`onChange`). Into a published work a module is someone
 * else's work shown to readers the moment it lands, so it asks the owner's
 * word as an imported member does (`rightsConfirmed`), and what the import left
 * behind is said as a card import's is.
 */
export function ModuleManager({
  plotId,
  modules,
  published = false,
  disabled = false,
  onChange,
}: {
  plotId: string;
  modules: readonly PlotModuleSummary[];
  published?: boolean;
  disabled?: boolean;
  onChange: (detail: PlotDetail) => void;
}) {
  const t = useTranslations('plot');
  const rights = useTranslations('rights');
  const toMessage = useErrorMessage();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'import' | string | null>(null);
  const [error, setError] = useState('');
  const [importRights, setImportRights] = useState(false);
  const [warnings, setWarnings] = useState<ImportWarning[]>([]);

  async function importFile(file: File): Promise<void> {
    if (busy) return;
    setBusy('import');
    setError('');
    setWarnings([]);
    try {
      const detail = await apiUpload<PlotDetail & { importWarnings?: unknown }>(
        `/api/plots/${plotId}/modules`,
        checkCardSize(file),
        published && importRights ? { rightsConfirmed: 'true' } : {},
      );
      setWarnings(readImportWarnings(detail.importWarnings));
      setImportRights(false);
      onChange(detail);
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
              {module.background || module.lowLevelAccess || module.hideIcon ? (
                <div className="flex flex-wrap gap-1.5">
                  {module.background ? <Badge>{t('moduleBackground')}</Badge> : null}
                  {module.hideIcon ? <Badge>{t('moduleHideIcon')}</Badge> : null}
                  {module.lowLevelAccess ? <Badge>{t('moduleLowLevelAccess')}</Badge> : null}
                </div>
              ) : null}
              <ModuleInertNotice inert={module.inert} />
            </li>
          ))}
        </ul>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".charx,.risum,.json,.lorebook,application/json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="module-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
        }}
      />
      {published ? (
        <RightsConfirmation
          notice={rights('moduleImportPublicNotice')}
          label={rights('confirmModuleImport')}
          checked={importRights}
          onChange={setImportRights}
        />
      ) : null}
      <div className="space-y-1">
        <Button
          size="sm"
          busy={busy === 'import'}
          disabled={disabled || busy !== null || (published && !importRights)}
          onClick={() => fileInput.current?.click()}
        >
          {t('moduleImport')}
        </Button>
        <p className="text-xs text-muted">{t('moduleImportHint')}</p>
      </div>
      <ImportWarnings warnings={warnings} />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </div>
  );
}
