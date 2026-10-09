'use client';

import { fromLorebookFile, toWorldInfo } from '@shizue/core/world-info';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Button, ErrorText } from '@/components/ui';
import type { LoreEntry } from '@/lib/types';

/**
 * A lorebook to and from a file, in the browser. Import adds the file's entries to
 * the ones being edited, so they go up with the next Save like any other edit;
 * export writes the entries as they stand now, unsaved ones included, as a
 * SillyTavern World Info file.
 */
export function LorebookFileActions({
  entries,
  fileName,
  onImport,
}: {
  entries: LoreEntry[];
  /** Without the extension. */
  fileName: string;
  onImport: (imported: LoreEntry[]) => void;
}) {
  const t = useTranslations('plot');
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load(file: File): Promise<void> {
    setError('');
    setNotice('');
    try {
      const imported = fromLorebookFile(JSON.parse(await file.text()));
      onImport(imported);
      setNotice(t('lorebookImported', { count: imported.length }));
    } catch {
      setError(t('lorebookImportFailed'));
    }
  }

  function download(): void {
    const blob = new Blob([JSON.stringify(toWorldInfo(entries), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${fileName}.json`;
    link.click();
    // After the click has handed the URL to the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          data-testid="lorebook-import-input"
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void load(file);
          }}
        />
        <Button size="sm" title={t('lorebookImportHint')} onClick={() => fileInput.current?.click()}>
          {t('lorebookImport')}
        </Button>
        <Button size="sm" disabled={entries.length === 0} onClick={download}>
          {t('lorebookExport')}
        </Button>
        {notice ? <span className="text-xs text-link">{notice}</span> : null}
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
