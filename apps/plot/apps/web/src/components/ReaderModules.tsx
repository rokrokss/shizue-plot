'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { ApiError, apiSend, apiUpload } from '@/lib/api';
import { readImportWarnings, type ImportWarning } from '@/lib/importWarnings';
import { checkCardSize } from '@/lib/realm';
import type { ReaderModuleSummary } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { ImportWarnings } from './CardImport';
import { Badge, Button, Checkbox, ErrorText } from './ui';

/**
 * The reader's own RisuAI modules, in the chat's settings — RisuAI's module
 * list and its chat menu in one quiet section. The library is the reader's
 * account's (`/api/reader-modules`); a module is on in this chat when the chat
 * lists it (`chatIds`, RisuAI's chat `modules`) or everywhere (RisuAI's
 * `enabledModules`), which greys the chat's own switch as RisuAI greys it. A
 * module never changes the work: it runs after the work's own, in the order it
 * was imported. One that asks for low-level access comes in only after the
 * reader says yes to RisuAI's warning.
 */
export function ReaderModules({
  library,
  chatIds,
  disabled = false,
  onChatIds,
  onChange,
}: {
  library: readonly ReaderModuleSummary[];
  /** The modules this chat's own list turns on. */
  chatIds: readonly string[];
  disabled?: boolean;
  /** Saves this chat's own list. */
  onChatIds: (ids: string[]) => Promise<void>;
  /** The library changed: an import, a removal, a module turned on everywhere. */
  onChange: () => Promise<void>;
}) {
  const t = useTranslations('chat');
  const toMessage = useErrorMessage();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<ImportWarning[]>([]);

  async function act(key: string, work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(key);
    setError('');
    try {
      await work();
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function importFile(file: File): Promise<void> {
    setWarnings([]);
    await act('import', async () => {
      const sized = checkCardSize(file);
      let created: { importWarnings?: unknown };
      try {
        created = await apiUpload('/api/reader-modules', sized);
      } catch (caught) {
        // RisuAI's `lowLevelAccessConfirm`: the module's scripts may reach the model and other hosts.
        if (!(caught instanceof ApiError && caught.code === 'low_level_access_unconfirmed')) throw caught;
        if (!window.confirm(t('readerModuleLowLevelConfirm'))) return;
        created = await apiUpload('/api/reader-modules', sized, { confirmLowLevelAccess: 'true' });
      }
      setWarnings(readImportWarnings(created.importWarnings));
      await onChange();
    });
    if (fileInput.current) fileInput.current.value = '';
  }

  const setHere = (module: ReaderModuleSummary, on: boolean) =>
    act(module.id, () => onChatIds(on ? [...chatIds.filter((id) => id !== module.id), module.id] : chatIds.filter((id) => id !== module.id)));

  const setEverywhere = (module: ReaderModuleSummary, enabledGlobally: boolean) =>
    act(module.id, async () => {
      await apiSend('PATCH', `/api/reader-modules/${module.id}`, { enabledGlobally });
      await onChange();
    });

  const remove = (module: ReaderModuleSummary) => {
    if (!window.confirm(t('readerModuleRemoveConfirm', { name: module.name }))) return;
    void act(module.id, async () => {
      await apiSend('DELETE', `/api/reader-modules/${module.id}`);
      await onChange();
    });
  };

  return (
    <section data-testid="reader-modules" className="space-y-3 border-t border-line pt-5">
      <h2 className="text-xs font-medium text-muted">{t('readerModules')}</h2>
      <p className="text-xs text-muted">{t('readerModulesHint')}</p>
      {library.length === 0 ? (
        <p className="text-xs text-muted">{t('readerModulesEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {library.map((module) => {
            const here = module.enabledGlobally || chatIds.includes(module.id);
            const locked = disabled || busy !== null;
            return (
              <li key={module.id} data-testid="reader-module" className="space-y-2 rounded-xl border border-line bg-raised/50 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium break-keep [overflow-wrap:anywhere]">{module.name}</p>
                    {module.description.trim() ? (
                      <p className="line-clamp-2 text-xs text-muted break-keep">{module.description}</p>
                    ) : null}
                  </div>
                  <Button size="sm" variant="ghost" busy={busy === module.id} disabled={locked} onClick={() => remove(module)}>
                    {t('readerModuleRemove')}
                  </Button>
                </div>
                <p className="text-xs text-muted tabular-nums">
                  {t('readerModuleContents', {
                    lore: module.loreCount,
                    regex: module.regexCount,
                    triggers: module.triggerCount,
                    assets: module.assetCount,
                  })}
                </p>
                {module.lowLevelAccess || module.toggles || module.background ? (
                  <div className="flex flex-wrap gap-1.5">
                    {module.toggles ? <Badge>{t('toggles')}</Badge> : null}
                    {module.background ? <Badge>{t('readerModuleBackground')}</Badge> : null}
                    {module.lowLevelAccess ? <Badge>{t('readerModuleLowLevelAccess')}</Badge> : null}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {/* On everywhere, the chat's own switch has nothing to say, as RisuAI greys it. */}
                  <Checkbox
                    label={t('readerModuleHere')}
                    checked={here}
                    disabled={locked || module.enabledGlobally}
                    onChange={(on) => void setHere(module, on)}
                  />
                  <Checkbox
                    label={t('readerModuleEverywhere')}
                    checked={module.enabledGlobally}
                    disabled={locked}
                    onChange={(on) => void setEverywhere(module, on)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".charx,.risum,.json,.lorebook,application/json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="reader-module-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
        }}
      />
      <div className="space-y-1">
        <Button size="sm" busy={busy === 'import'} disabled={disabled || busy !== null} onClick={() => fileInput.current?.click()}>
          {t('readerModuleImport')}
        </Button>
        <p className="text-xs text-muted">{t('readerModuleImportHint')}</p>
      </div>
      <ImportWarnings warnings={warnings} />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </section>
  );
}
