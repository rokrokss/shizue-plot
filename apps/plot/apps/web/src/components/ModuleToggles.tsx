'use client';

import {
  groupToggles,
  isToggleGroup,
  parseToggleSyntax,
  toggleVariable,
  type ToggleEntry,
} from '@shizue/core/toggles';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Checkbox, Select, TextArea, TextInput } from './ui';

/**
 * RisuAI's custom toggles (`Toggles.svelte`) for one chat: what the reader's
 * preset, the modules on it and the members' cards declare (`text`, RisuAI's
 * syntax, read by `parseToggleSyntax`), drawn as RisuAI draws them — a
 * checkbox, a select, a text field or box, a caption, a divider, a group folded
 * under its title. A value is the reader's global variable `toggle_<key>` on
 * the work (`values`, as the chat reads them): a checkbox `'1'`/`'0'`, a select
 * the chosen option's index, a field its text; unset reads as nothing. A field
 * is saved when it is left, as RisuAI saves it on change. Under them, RisuAI's
 * "Local Toggles" switch (`local`): while on, what is set here stays this
 * chat's. Nothing is drawn where nothing is declared.
 */
export function ModuleToggles({
  text,
  values,
  onSet,
  local = false,
  disabled = false,
  onLocal,
}: {
  text: string;
  values: Readonly<Record<string, string>> | undefined;
  onSet: (variable: string, value: string) => Promise<void>;
  /** RisuAI's `useLocallySetGlobalVariables` for this chat. */
  local?: boolean;
  disabled?: boolean;
  onLocal?: (local: boolean) => Promise<void> | void;
}) {
  const t = useTranslations('chat');
  const entries = useMemo(() => groupToggles(parseToggleSyntax(text)), [text]);
  if (entries.length === 0) return null;

  /** RisuAI's `getGlobalChatVarNH`: an unset value reads as nothing. */
  const valueOf = (key: string): string => {
    const value = values?.[toggleVariable(key)];
    return value === undefined || value === 'null' ? '' : value;
  };

  const checkbox = (entry: ToggleEntry, index: number): ReactNode => (
    <div key={`${entry.key}-${index}`}>
      <Checkbox
        label={entry.value}
        checked={valueOf(entry.key) === '1'}
        onChange={() => void onSet(toggleVariable(entry.key), valueOf(entry.key) === '1' ? '0' : '1')}
      />
    </div>
  );

  const draw = (list: readonly ToggleEntry[]): ReactNode =>
    list.map((entry, index) => {
      if (isToggleGroup(entry)) {
        // A group nothing went into is a checkbox in RisuAI's sidebar.
        if (entry.children.length === 0) return checkbox(entry, index);
        return (
          <details key={`${entry.key}-${index}`} className="rounded-xl border border-line px-3 py-2">
            <summary className="cursor-pointer text-sm text-fg">{entry.value}</summary>
            <div className="mt-2 space-y-2">{draw(entry.children)}</div>
          </details>
        );
      }
      const key = `${entry.key}-${index}`;
      switch (entry.type) {
        case 'caption':
          return (
            <p key={key} className="text-xs text-muted">
              {entry.value}
            </p>
          );
        case 'divider':
          return (
            <div key={key} role="separator" className="flex items-center gap-2">
              {entry.value ? <span className="shrink-0 text-xs text-muted">{entry.value}</span> : null}
              <hr className="grow border-line" />
            </div>
          );
        case 'select':
          return (
            <label key={key} className="flex items-center justify-between gap-3 text-sm text-muted">
              <span className="min-w-0 break-keep">{entry.value}</span>
              <Select
                className="h-8 w-40 shrink-0 py-0 text-xs"
                value={valueOf(entry.key)}
                onChange={(event) => void onSet(toggleVariable(entry.key), event.target.value)}
              >
                {(entry.options ?? []).map((option, at) => (
                  <option key={at} value={String(at)}>
                    {option}
                  </option>
                ))}
              </Select>
            </label>
          );
        case 'text':
        case 'textarea':
          return (
            <ToggleField
              key={key}
              label={entry.value}
              multiline={entry.type === 'textarea'}
              value={valueOf(entry.key)}
              onSave={(value) => onSet(toggleVariable(entry.key), value)}
            />
          );
        default:
          return checkbox(entry, index);
      }
    });

  return (
    <section data-testid="chat-toggles" className="space-y-3 border-t border-line pt-5">
      <h2 className="text-xs font-medium text-muted">{t('toggles')}</h2>
      <div className="space-y-2">{draw(entries)}</div>
      <p className="text-xs text-muted">{t('togglesHint')}</p>
      {onLocal ? (
        <div data-testid="local-toggles" className="space-y-1">
          <Checkbox label={t('localToggles')} checked={local} disabled={disabled} onChange={(on) => void onLocal(on)} />
          <p className="text-xs text-muted">{t('localTogglesHint')}</p>
        </div>
      ) : null}
    </section>
  );
}

/** A text toggle: typed freely, saved when it is left and only if it changed. */
function ToggleField({
  label,
  multiline,
  value,
  onSave,
}: {
  label: string;
  multiline: boolean;
  value: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = (): void => {
    if (draft !== value) void onSave(draft);
  };
  return (
    <label className="block space-y-1 text-sm text-muted">
      <span className="break-keep">{label}</span>
      {multiline ? (
        <TextArea rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={save} />
      ) : (
        <TextInput value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={save} />
      )}
    </label>
  );
}
