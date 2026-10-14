'use client';

import {
  readReaderPresetFile,
  READER_PRESET_NAME_MAX,
  READER_PRESET_TEXT_MAX,
  ReaderPresetImportError,
  type ReaderPresetImport,
  type ReaderPresetPart,
} from '@shizue/core/reader-preset';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { apiSend } from '@/lib/api';
import type { ReaderPreset } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { BottomSheet } from './BottomSheet';
import { Button, ErrorText, Field, Select, TextArea, TextInput } from './ui';

/** What the editor holds: a preset being written, new (`id` null) or one being changed. */
interface Draft {
  id: string | null;
  name: string;
  main: string;
  globalNote: string;
  /** What the file it came from held, when it came from one — for the notice. */
  imported?: ReaderPresetImport;
}

/**
 * "내 프리셋": the reader's own presets on top of the chat's (§11) — pick one for
 * this chat, and behind one quiet button, make, change, delete and import them.
 *
 * Stacked (the settings sheet), the picker and its manager stand in the column.
 * Compact (the wide header), there is room for one small button only, and it
 * opens the same stacked field in a sheet.
 */
export function ReaderPresetField({
  presets,
  selectedId,
  disabled,
  stacked,
  onSelect,
  onPresetsChange,
}: {
  /** The reader's presets, in creation order. */
  presets: ReaderPreset[];
  /** This chat's pick; an id that is no longer in `presets` reads as none. */
  selectedId: string | null;
  /** The chat's settings are locked (a reply streams, a save is in flight). */
  disabled: boolean;
  stacked?: boolean;
  onSelect: (id: string | null) => void;
  onPresetsChange: (presets: ReaderPreset[]) => void;
}) {
  const t = useTranslations('chat.readerPresets');
  const [sheetOpen, setSheetOpen] = useState(false);
  const selected = presets.find((preset) => preset.id === selectedId);

  if (!stacked) {
    return (
      <>
        <Button
          size="sm"
          variant={selected ? 'secondary' : 'ghost'}
          aria-haspopup="dialog"
          className="max-w-48"
          onClick={() => setSheetOpen(true)}
        >
          <span className="min-w-0 truncate">{selected ? t('activeNamed', { name: selected.name }) : t('label')}</span>
        </Button>
        {sheetOpen ? (
          <BottomSheet title={t('label')} onClose={() => setSheetOpen(false)}>
            <ReaderPresetField
              stacked
              presets={presets}
              selectedId={selectedId}
              disabled={disabled}
              onSelect={onSelect}
              onPresetsChange={onPresetsChange}
            />
          </BottomSheet>
        ) : null}
      </>
    );
  }
  return (
    <StackedField
      presets={presets}
      selected={selected}
      disabled={disabled}
      onSelect={onSelect}
      onPresetsChange={onPresetsChange}
    />
  );
}

function StackedField({
  presets,
  selected,
  disabled,
  onSelect,
  onPresetsChange,
}: {
  presets: ReaderPreset[];
  selected: ReaderPreset | undefined;
  disabled: boolean;
  onSelect: (id: string | null) => void;
  onPresetsChange: (presets: ReaderPreset[]) => void;
}) {
  const t = useTranslations('chat.readerPresets');
  const id = useId();
  const [managing, setManaging] = useState(false);

  return (
    <div data-testid="reader-presets" className="space-y-1.5">
      {presets.length > 0 ? (
        <>
          <label htmlFor={`${id}-pick`} className="block text-xs font-medium text-muted">
            {t('label')}
          </label>
          <Select
            id={`${id}-pick`}
            value={selected?.id ?? ''}
            disabled={disabled}
            onChange={(event) => onSelect(event.target.value || null)}
          >
            <option value="">{t('none')}</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted">{t('hint')}</p>
        </>
      ) : (
        <>
          <p className="text-xs font-medium text-muted">{t('label')}</p>
          <p className="text-xs text-muted">{t('empty')}</p>
        </>
      )}
      <button
        type="button"
        aria-expanded={managing}
        className="rounded text-xs font-medium text-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        onClick={() => setManaging((open) => !open)}
      >
        {managing ? t('closeManager') : t('manage')}
      </button>
      {managing ? <ReaderPresetManager presets={presets} onPresetsChange={onPresetsChange} /> : null}
    </div>
  );
}

/** The list, the editor and the import — one of the first two at a time. */
function ReaderPresetManager({
  presets,
  onPresetsChange,
}: {
  presets: ReaderPreset[];
  onPresetsChange: (presets: ReaderPreset[]) => void;
}) {
  const t = useTranslations('chat.readerPresets');
  const common = useTranslations('common');
  const toMessage = useErrorMessage();
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function importFile(file: File): Promise<void> {
    setError('');
    try {
      const imported = await readReaderPresetFile(file.name, new Uint8Array(await file.arrayBuffer()));
      setDraft({
        id: null,
        name: imported.name || t('importedName'),
        main: imported.main,
        globalNote: imported.globalNote,
        imported,
      });
    } catch (caught) {
      setError(
        caught instanceof ReaderPresetImportError && caught.reason === 'unsupported'
          ? t('importUnsupported')
          : t('importUnreadable'),
      );
    }
  }

  async function save(): Promise<void> {
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    const body = { name: draft.name, main: draft.main, globalNote: draft.globalNote };
    try {
      if (draft.id === null) {
        const created = await apiSend<ReaderPreset>('POST', '/api/reader-presets', body);
        onPresetsChange([...presets, created]);
      } else {
        const updated = await apiSend<ReaderPreset>('PUT', `/api/reader-presets/${draft.id}`, body);
        onPresetsChange(presets.map((preset) => (preset.id === updated.id ? updated : preset)));
      }
      setDraft(null);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(preset: ReaderPreset): Promise<void> {
    if (busy || !window.confirm(common('confirmDelete'))) return;
    setBusy(true);
    setError('');
    try {
      // A chat that had it picked goes back to none on the server.
      await apiSend('DELETE', `/api/reader-presets/${preset.id}`);
      onPresetsChange(presets.filter((other) => other.id !== preset.id));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="reader-preset-manager" className="space-y-3 rounded-xl border border-line bg-surface p-3">
      {draft ? (
        <fieldset disabled={busy} className="space-y-3">
          {draft.imported ? <ImportNotice imported={draft.imported} /> : null}
          <Field label={t('name')}>
            <TextInput
              value={draft.name}
              maxLength={READER_PRESET_NAME_MAX}
              className="h-10 w-full text-sm"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <TextField
            label={t('main')}
            hint={t('mainHint')}
            value={draft.main}
            rows={5}
            onChange={(main) => setDraft({ ...draft, main })}
          />
          <TextField
            label={t('globalNote')}
            hint={t('globalNoteHint')}
            value={draft.globalNote}
            rows={4}
            onChange={(globalNote) => setDraft({ ...draft, globalNote })}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              {common('cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              busy={busy}
              disabled={!draft.name.trim()}
              onClick={() => void save()}
            >
              {common('save')}
            </Button>
          </div>
        </fieldset>
      ) : (
        <>
          {presets.length > 0 ? (
            <ul className="divide-y divide-line">
              {presets.map((preset) => (
                <li key={preset.id} className="flex items-center gap-1 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm">{preset.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t('editNamed', { name: preset.name })}
                    onClick={() => setDraft({ id: preset.id, name: preset.name, main: preset.main, globalNote: preset.globalNote })}
                  >
                    {common('edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t('deleteNamed', { name: preset.name })}
                    onClick={() => void remove(preset)}
                  >
                    {common('delete')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => setDraft({ id: null, name: '', main: '', globalNote: '' })}
            >
              {t('new')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => fileInput.current?.click()}>
              {t('import')}
            </Button>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept=".json,.risup,.risupreset,.preset"
              data-testid="reader-preset-import-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importFile(file);
              }}
            />
          </div>
          <p className="text-xs text-muted">{t('importHint')}</p>
        </>
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </div>
  );
}

/** A text of the preset, with how much of its cap it has used. */
function TextField({
  label,
  hint,
  value,
  rows,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  rows: number;
  onChange: (value: string) => void;
}) {
  const format = useFormatter();
  const over = value.length > READER_PRESET_TEXT_MAX;
  return (
    <Field label={label} hint={hint}>
      <TextArea rows={rows} value={value} className="w-full text-sm" onChange={(event) => onChange(event.target.value)} />
      <span className={`block text-right caption2 ${over ? 'text-danger' : 'text-muted'}`}>
        {format.number(value.length)} / {format.number(READER_PRESET_TEXT_MAX)}
      </span>
    </Field>
  );
}

/** What an import took and where each prompt went, and — always — what it left behind. */
function ImportNotice({ imported }: { imported: ReaderPresetImport }) {
  const t = useTranslations('chat.readerPresets');
  const source = imported.source === 'risuai' ? 'RisuAI' : 'SillyTavern';
  const names = imported.ignoredPrompts.map((name) => name || t('unnamedPrompt'));
  /** A prompt by the file's name for it, else by what RisuAI calls its field. */
  const partName = (part: ReaderPresetPart): string =>
    part.name ||
    (part.kind === 'main'
      ? t('partMain')
      : part.kind === 'globalNote'
        ? t('partGlobalNote')
        : part.kind === 'jailbreak'
          ? t('partJailbreak')
          : t('unnamedPrompt'));
  const lines = [
    ...imported.imported.map((part) => t('takenInto', { name: partName(part), field: t(part.into) })),
    names.length > 0 ? t('ignoredPrompts', { count: names.length, names: names.join(', ') }) : '',
    imported.ignoredSettings ? t('ignoredSettings') : '',
  ].filter((line) => line.length > 0);
  const nothing = !imported.main && !imported.globalNote;

  return (
    <div data-testid="reader-preset-import-notice" className="space-y-1 rounded-lg bg-raised px-3 py-2 text-xs text-muted">
      <p className="font-medium text-fg">{nothing ? t('importedNothing', { source }) : t('imported', { source })}</p>
      {lines.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {/* Two unnamed items of one kind read the same: the place keeps them apart. */}
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
