'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import { assetHref, type Illustration } from '@/lib/assets';
import { withNarratorField } from '@/lib/narrator';
import { relationshipRows } from '@/lib/relationship';
import {
  MEMORY_CONTEXT_BUDGETS,
  MEMORY_RETRIEVAL_COUNTS,
  MEMORY_SUMMARY_THRESHOLDS,
  type ChatMemory,
  type ChatMemorySettings,
  type ChatRelationship,
  type NarratorConfig,
  type NarratorPov,
  type PublicMember,
  type UserNote,
} from '@/lib/types';
import { Avatar } from './Avatar';
import { Lightbox } from './Lightbox';
import { Button, Checkbox, Field, Select, TextArea } from './ui';

/** What the server falls back to for a key the chat has not set. */
const DEFAULTS = { contextBudget: 16000, summaryThreshold: 0.6, retrievalCount: 5 };

/**
 * What this conversation has opened of the plot's images, and what it has not.
 *
 * The open ones are the reward, so they are shown the way the chat shows any
 * image: a thumb that opens into the same lightbox a message's does. The locked
 * ones are shown too — a silhouette is what makes them worth reaching — with the
 * one thing a reader may be told, which kind of condition each is waiting on.
 */
function IllustrationGallery({ illustrations }: { illustrations: readonly Illustration[] }) {
  const t = useTranslations('chat');
  const [opened, setOpened] = useState<number | null>(null);

  // Nothing here is a reward on a plot whose pictures are simply drawn where
  // the message asks for them, so the section is not there at all.
  if (!illustrations.some((illustration) => illustration.kind !== null)) return null;
  const open = illustrations.filter((illustration) => illustration.src !== null);
  const images = open.map((illustration) => ({ src: illustration.src!, alt: illustration.slug }));

  return (
    <section data-testid="chat-illustrations" className="space-y-3 border-b border-line pb-5">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">
        {t('illustrations')}
      </h2>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {illustrations.map((illustration) => (
          <li key={illustration.slug}>
            {illustration.src === null ? (
              <span
                data-testid="illustration-locked"
                className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line bg-raised/40 px-1 text-center"
              >
                <span aria-hidden="true" className="text-sm leading-none">
                  🔒
                </span>
                {illustration.kind ? (
                  <span className="text-[10px] leading-tight text-muted">
                    {t(`lockedHints.${illustration.kind}`)}
                  </span>
                ) : null}
              </span>
            ) : (
              <button
                type="button"
                data-testid="illustration-open"
                aria-label={illustration.slug}
                onClick={() => setOpened(open.indexOf(illustration))}
                className="block w-full cursor-zoom-in overflow-hidden rounded-lg border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={assetHref(illustration.src)}
                  alt=""
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted/80">{t('illustrationsHint')}</p>
      {opened !== null ? (
        <Lightbox images={images} index={opened} onClose={() => setOpened(null)} />
      ) : null}
    </section>
  );
}

/** The panel's fields that are edited as a draft and saved on a button. */
type Saveable = 'note' | 'memory' | 'narrator';

/**
 * Chat-scoped notes: the author's note that goes into every prompt, the reusable
 * notes attached to this chat, the memory knobs, the rolling summary the memory
 * layer keeps, and the relationship the background job extracts. Saving is the
 * page's job — it owns the chat state the endpoints answer with.
 */
export function ChatPanel({
  members,
  note,
  notes,
  noteIds,
  memory,
  memorySettings,
  relationship,
  relationshipEnabled,
  narrator,
  illustrations,
  customUi,
  allowComponentTurns,
  statusWindow,
  statusWindowEnabled,
  choices,
  choicesEnabled,
  disabled,
  onSaveNote,
  onToggleNote,
  onSaveMemory,
  onSaveMemorySettings,
  onToggleRelationship,
  onSaveNarrator,
  onToggleCustomUi,
  onToggleComponentTurns,
  onToggleStatusWindow,
  onToggleChoices,
}: {
  /** Everyone the plot's replies may be written in the voice of, in its order. */
  members: readonly PublicMember[];
  note: string;
  /** Every reusable note of the account, in creation order. */
  notes: UserNote[];
  /** Ids of the notes attached to this chat. */
  noteIds: string[];
  memory: ChatMemory | null;
  memorySettings: ChatMemorySettings | null;
  relationship: ChatRelationship | null;
  relationshipEnabled: boolean;
  /** This chat's narrator; null means the character's own is in force. */
  narrator: NarratorConfig | null;
  /**
   * The plot's images as this chat sees them. The section only appears where at
   * least one of them is unlockable — for a work whose pictures are simply shown,
   * a gallery of them is not a reward, it is the message list again.
   */
  illustrations: readonly Illustration[];
  /** Viewer protection, stored per browser rather than on the chat. */
  customUi: boolean;
  /** Consent for components to send turns, granted from the chat and revoked here. */
  allowComponentTurns: boolean;
  /**
   * Whether the plot asks for each of its two derived features. A reader's
   * toggle for a feature the plot never turned on would be a switch with nothing
   * on the other end, so where it is off there is no row at all.
   */
  statusWindow: boolean;
  choices: boolean;
  /** The reader's own answer for each, which only means anything above. */
  statusWindowEnabled: boolean;
  choicesEnabled: boolean;
  /** True while a reply streams or another setting is being saved. */
  disabled: boolean;
  onSaveNote: (note: string) => Promise<void>;
  onToggleNote: (noteId: string, attached: boolean) => Promise<void>;
  onSaveMemory: (summary: string) => Promise<void>;
  onSaveMemorySettings: (settings: ChatMemorySettings) => Promise<void>;
  onToggleRelationship: (enabled: boolean) => Promise<void>;
  /** null clears the override, which is how the character's narrator comes back. */
  onSaveNarrator: (narrator: NarratorConfig | null) => Promise<void>;
  onToggleCustomUi: (enabled: boolean) => void;
  onToggleComponentTurns: (allowed: boolean) => Promise<void>;
  onToggleStatusWindow: (enabled: boolean) => Promise<void>;
  onToggleChoices: (enabled: boolean) => Promise<void>;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const format = useFormatter();

  const [noteDraft, setNoteDraft] = useState(note);
  const [summaryDraft, setSummaryDraft] = useState(memory?.summary ?? '');
  const [voiceDraft, setVoiceDraft] = useState(narrator?.voice ?? '');
  const [saving, setSaving] = useState<Saveable | null>(null);

  // Adopt whatever the server holds. Only a real change re-runs these, so text
  // typed while a reply streams is not thrown away by the state refresh.
  const summary = memory?.summary ?? '';
  const voice = narrator?.voice ?? '';
  useEffect(() => setNoteDraft(note), [note]);
  useEffect(() => setSummaryDraft(summary), [summary]);
  useEffect(() => setVoiceDraft(voice), [voice]);

  async function save(kind: Saveable): Promise<void> {
    if (disabled || saving !== null) return;
    setSaving(kind);
    try {
      if (kind === 'note') await onSaveNote(noteDraft);
      else if (kind === 'memory') await onSaveMemory(summaryDraft);
      else await onSaveNarrator(withNarratorField(narrator, { voice: voiceDraft }));
    } finally {
      setSaving(null);
    }
  }

  /**
   * The point of view saves on the spot — a select has nowhere to hold a draft —
   * and carries whatever is in the voice field with it, so choosing one does not
   * throw away text the reader has typed but not saved yet.
   */
  async function saveNarratorPov(pov: NarratorPov | ''): Promise<void> {
    if (disabled || saving !== null) return;
    setSaving('narrator');
    try {
      await onSaveNarrator(withNarratorField(narrator, { voice: voiceDraft, pov: pov || undefined }));
    } finally {
      setSaving(null);
    }
  }

  const busy = disabled || saving !== null;
  const rows = relationshipRows(relationship);
  // The selects always show a concrete value: what the chat set, or the default
  // the server would apply for a key it has not set.
  const settings = { ...DEFAULTS, ...memorySettings };
  const saveButton = (kind: Saveable): ReactNode => (
    <div className="flex justify-end">
      <Button
        size="sm"
        variant="primary"
        busy={saving === kind}
        disabled={busy}
        onClick={() => void save(kind)}
      >
        {common('save')}
      </Button>
    </div>
  );

  return (
    <div data-testid="chat-panel" className="space-y-5 rounded-xl border border-line bg-surface/60 p-5">
      {/* Who is in the room. A reply names its speaker line by line, so the roster
          is what those names are read against — and it is the first thing the
          panel can answer about a chat that holds more than one voice. */}
      {members.length > 0 ? (
        <section data-testid="chat-members" className="space-y-3 border-b border-line pb-5">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">{t('members')}</h2>
          <ul className="flex flex-wrap gap-x-4 gap-y-2">
            {members.map((member) => (
              <li key={member.id} className="flex min-w-0 items-center gap-2">
                <Avatar src={member.avatarUrl} name={member.name} className="size-7 text-xs" />
                <span className="truncate text-sm text-fg">{member.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <IllustrationGallery illustrations={illustrations} />

      <section data-testid="author-note" className="space-y-3">
        <Field label={t('authorNote')} hint={t('authorNoteHint')}>
          <TextArea
            rows={4}
            value={noteDraft}
            disabled={busy}
            placeholder={t('authorNotePlaceholder')}
            onChange={(event) => setNoteDraft(event.target.value)}
          />
        </Field>
        {saveButton('note')}
      </section>

      <section data-testid="chat-notes" className="space-y-3 border-t border-line pt-5">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">{t('attachedNotes')}</h2>
        {notes.length === 0 ? (
          <p className="text-sm text-muted">{t('attachedNotesEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {notes.map((item) => (
              <li key={item.id}>
                <Checkbox
                  label={item.title.trim() || t('untitledNote')}
                  checked={noteIds.includes(item.id)}
                  disabled={busy}
                  onChange={(attached) => void onToggleNote(item.id, attached)}
                />
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted/80">{t('attachedNotesHint')}</p>
      </section>

      <section data-testid="chat-memory" className="space-y-3 border-t border-line pt-5">
        {memory ? (
          <>
            <Field label={t('memory')} hint={t('memoryHint')}>
              <TextArea
                rows={6}
                value={summaryDraft}
                disabled={busy}
                onChange={(event) => setSummaryDraft(event.target.value)}
              />
            </Field>
            {saveButton('memory')}
          </>
        ) : (
          <>
            <h2 className="text-xs font-medium tracking-wide text-muted uppercase">{t('memory')}</h2>
            <p className="text-sm text-muted">{t('memoryEmpty')}</p>
          </>
        )}
      </section>

      <section data-testid="memory-settings" className="space-y-3 border-t border-line pt-5">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">{t('memorySettings')}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('contextBudget')}>
            <Select
              value={String(settings.contextBudget)}
              disabled={busy}
              className="h-9 py-0 text-xs"
              onChange={(event) =>
                void onSaveMemorySettings({ ...settings, contextBudget: Number(event.target.value) })
              }
            >
              {MEMORY_CONTEXT_BUDGETS.map((budget) => (
                <option key={budget} value={budget}>
                  {t('contextBudgetValue', { tokens: format.number(budget) })}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('summaryThreshold')}>
            <Select
              value={String(settings.summaryThreshold)}
              disabled={busy}
              className="h-9 py-0 text-xs"
              onChange={(event) =>
                void onSaveMemorySettings({ ...settings, summaryThreshold: Number(event.target.value) })
              }
            >
              {MEMORY_SUMMARY_THRESHOLDS.map((threshold) => (
                <option key={threshold} value={threshold}>
                  {t('summaryThresholdValue', { percent: String(Math.round(threshold * 100)) })}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('retrievalCount')}>
            <Select
              value={String(settings.retrievalCount)}
              disabled={busy}
              className="h-9 py-0 text-xs"
              onChange={(event) =>
                void onSaveMemorySettings({ ...settings, retrievalCount: Number(event.target.value) })
              }
            >
              {/* The API takes 0-10; these are the steps the UI offers. */}
              {MEMORY_RETRIEVAL_COUNTS.map((count) => (
                <option key={count} value={count}>
                  {count === 0 ? t('retrievalOff') : t('retrievalCountValue', { count: String(count) })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="text-xs text-muted/80">{t('memorySettingsHint')}</p>
      </section>

      <section data-testid="chat-narrator" className="space-y-3 border-t border-line pt-5">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">{t('narrator')}</h2>
        <Field label={t('narratorVoice')}>
          <TextArea
            rows={3}
            value={voiceDraft}
            disabled={busy}
            placeholder={t('narratorVoicePlaceholder')}
            onChange={(event) => setVoiceDraft(event.target.value)}
          />
        </Field>
        <Field label={t('narratorPov')}>
          <Select
            value={narrator?.pov ?? ''}
            disabled={busy}
            className="h-9 py-0 text-xs"
            onChange={(event) => void saveNarratorPov(event.target.value as NarratorPov | '')}
          >
            <option value="">{t('narratorPovUnset')}</option>
            <option value="first">{t('narratorPovFirst')}</option>
            <option value="third">{t('narratorPovThird')}</option>
            <option value="omniscient">{t('narratorPovOmniscient')}</option>
          </Select>
        </Field>
        {saveButton('narrator')}
        <p className="text-xs text-muted/80">{t('narratorHint')}</p>
      </section>

      {/* What the plot asked for on top of the prose. Both rows are the reader's
          half of a creator's setting, so neither is offered where the plot left
          the feature off — there would be nothing on the other end of it. */}
      {statusWindow || choices ? (
        <section data-testid="chat-plot-features" className="space-y-3 border-t border-line pt-5">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">
            {t('plotFeatures')}
          </h2>
          {statusWindow ? (
            <>
              <Checkbox
                label={t('statusWindowEnabled')}
                checked={statusWindowEnabled}
                disabled={busy}
                onChange={(enabled) => void onToggleStatusWindow(enabled)}
              />
              <p className="text-xs text-muted/80">{t('statusWindowHint')}</p>
            </>
          ) : null}
          {choices ? (
            <>
              <Checkbox
                label={t('choicesEnabled')}
                checked={choicesEnabled}
                disabled={busy}
                onChange={(enabled) => void onToggleChoices(enabled)}
              />
              <p className="text-xs text-muted/80">{t('choicesHint')}</p>
            </>
          ) : null}
        </section>
      ) : null}

      <section data-testid="chat-display" className="space-y-3 border-t border-line pt-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">{t('display')}</h2>
          <Checkbox
            label={t('customUi')}
            checked={customUi}
            onChange={onToggleCustomUi}
          />
        </div>
        <p className="text-xs text-muted/80">{t('customUiHint')}</p>

        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">
            {t('componentTurns')}
          </h2>
          <Checkbox
            label={t('componentTurnsAllowed')}
            checked={allowComponentTurns}
            disabled={busy}
            onChange={(allowed) => void onToggleComponentTurns(allowed)}
          />
        </div>
        <p className="text-xs text-muted/80">{t('componentTurnsHint')}</p>
      </section>

      <section data-testid="chat-relationship" className="space-y-3 border-t border-line pt-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">{t('relationship')}</h2>
          <Checkbox
            label={t('relationshipEnabled')}
            checked={relationshipEnabled}
            disabled={busy}
            onChange={(enabled) => void onToggleRelationship(enabled)}
          />
        </div>

        {rows.length > 0 ? (
          <>
            <ul className="space-y-2">
              {rows.map((row) => (
                <li key={row.axis} className="flex items-center gap-3">
                  <span className="w-14 shrink-0 text-xs text-muted">{t(`axes.${row.axis}`)}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${row.value}%` }}
                    />
                  </span>
                  <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted">
                    {row.value}
                  </span>
                </li>
              ))}
            </ul>
            {relationship?.note ? <p className="text-sm text-fg">{relationship.note}</p> : null}
            <p className="text-xs text-muted/80">{t('relationshipHint')}</p>
          </>
        ) : (
          <p className="text-sm text-muted">{t('relationshipEmpty')}</p>
        )}
      </section>

    </div>
  );
}
