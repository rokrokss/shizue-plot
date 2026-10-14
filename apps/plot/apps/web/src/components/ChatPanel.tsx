'use client';

import {
  AUTHOR_NOTE_DEFAULTS,
  AUTHOR_NOTE_ROLES,
  DEFAULT_CONTEXT_BUDGET,
  HYPA_V3_DEFAULTS,
  HYPA_V3_SUMMARIZATION_PROMPT,
  type AuthorNoteRole,
  type AuthorNoteSettings,
} from '@shizue/core';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { assetHref, type Illustration } from '@/lib/assets';
import { EMBEDDING_MODELS, embeddingModels, readEmbeddingModel, writeEmbeddingModel } from '@/lib/scripts/embeddingModels';
import { withNarratorField } from '@/lib/narrator';
import { relationshipRows } from '@/lib/relationship';
import {
  MEMORY_CONTEXT_BUDGETS,
  type ChatMemorySettings,
  type ChatRelationship,
  type NarratorConfig,
  type NarratorPov,
  type PublicMember,
  type UserNote,
} from '@/lib/types';
import { Avatar } from './Avatar';
import { Lightbox } from './Lightbox';
import { MemorySummaries } from './MemorySummaries';
import { PromptInspector } from './PromptInspector';
import { Button, Checkbox, Field, Select, TextArea, cx } from './ui';

/**
 * The steps the memory settings offer (the API takes any value in range; a
 * chat holding another keeps it as one more option). RisuAI's sliders run in
 * hundredths; a select of the useful ones is this panel's way.
 */
const MEMORY_STEPS = {
  memoryTokensRatio: [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5],
  extraSummarizationRatio: [0, 0.05, 0.1, 0.2, 0.3],
  maxChatsPerSummary: [2, 4, 6, 8, 10, 15, 20],
  queryChatCount: [1, 2, 3, 4, 5, 8, 10],
  share: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
} as const;

/** The author's note's steps; SillyTavern takes 0–9999, and a chat holding another keeps it as one more option. */
const NOTE_STEPS = {
  depth: [0, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20],
  frequency: [0, 1, 2, 3, 4, 5, 10],
} as const;

/** The steps, and the chat's own value among them where it is not one. */
const withValue = (steps: readonly number[], value: number): number[] =>
  [...new Set([...steps, value])].sort((a, b) => a - b);

/** A share as the selects show it. Rounded: 1 - 0.4 - 0.4 is not 0.2 in floating point. */
const percent = (share: number): string => String(Math.round(share * 100));

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
      <h2 className="text-xs font-medium text-muted">
        {t('illustrations')}
      </h2>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {illustrations.map((illustration) => (
          <li key={illustration.slug}>
            {illustration.src === null ? (
              <span
                data-testid="illustration-locked"
                className="flex aspect-[2/3] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line bg-raised/40 px-1 text-center"
              >
                <span aria-hidden="true" className="text-sm leading-none">
                  🔒
                </span>
                {illustration.kind ? (
                  <span className="caption2 text-muted">
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
                  className="aspect-[2/3] w-full object-cover"
                />
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">{t('illustrationsHint')}</p>
      {opened !== null ? (
        <Lightbox images={images} index={opened} onClose={() => setOpened(null)} />
      ) : null}
    </section>
  );
}

/** The panel's fields that are edited as a draft and saved on a button. */
type Saveable = 'note' | 'prompt' | 'narrator';

/**
 * The model the plot's scripts compare texts with, picked as RisuAI's
 * `hypaModel` is. Like the custom-UI switch it is this browser's, so it holds
 * for every chat here; the search reads it as it starts. After a write the
 * select shows what was read back, which is the default where storage refuses it.
 */
function EmbeddingModelSetting() {
  const t = useTranslations('chat');
  const [model, setModel] = useState(readEmbeddingModel);
  const id = useId();

  return (
    <section data-testid="chat-similarity" className="space-y-3 border-t border-line pt-5">
      <h2 id={id} className="text-xs font-medium text-muted">{t('similarityModel')}</h2>
      <Select
        aria-labelledby={id}
        value={model}
        className="h-9 py-0 text-xs"
        onChange={(event) => {
          writeEmbeddingModel(event.target.value as typeof model);
          setModel(readEmbeddingModel());
        }}
      >
        {embeddingModels.map((name) => (
          <option key={name} value={name}>
            {t('similarityModelOption', { name: EMBEDDING_MODELS[name].label, size: EMBEDDING_MODELS[name].megabytes })}
          </option>
        ))}
      </Select>
      <p className="text-xs text-muted">{t(`similarityModels.${model}`)}</p>
      <p className="text-xs text-muted">{t('similarityModelHint')}</p>
    </section>
  );
}

/**
 * Chat-scoped notes: the author's note that goes into every prompt, the reusable
 * notes attached to this chat, the memory's summaries and its settings, and the
 * relationship the background job extracts. Saving is the page's job — it owns
 * the chat state the endpoints answer with — but for the summaries, which are
 * a list of their own (`MemorySummaries`).
 */
export function ChatPanel({
  chatId,
  headMessageId,
  memoryRevision,
  members,
  note,
  noteSettings,
  notes,
  noteIds,
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
  onSaveNoteSettings,
  onToggleNote,
  onSaveMemorySettings,
  onToggleRelationship,
  onSaveNarrator,
  onToggleCustomUi,
  onToggleComponentTurns,
  onToggleStatusWindow,
  onToggleChoices,
  absentCharacterIds = [],
  onToggleAbsent,
  onSpeakNow,
  inspectChatId,
  scriptSimilarity = false,
}: {
  chatId: string;
  /** The branch's head and the chat's memory revision: the summaries are read again whenever either moves. */
  headMessageId: string | null;
  memoryRevision: number;
  /** Everyone the plot's replies may be written in the voice of, in its order. */
  members: readonly PublicMember[];
  note: string;
  /** Where the note goes and how often; absent, the defaults. */
  noteSettings?: AuthorNoteSettings | undefined;
  /** Every reusable note of the account, in creation order. */
  notes: UserNote[];
  /** Ids of the notes attached to this chat. */
  noteIds: string[];
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
  /** Saves the note's depth, frequency and role; without it they are not offered. */
  onSaveNoteSettings?: (settings: Required<AuthorNoteSettings>) => Promise<void>;
  onToggleNote: (noteId: string, attached: boolean) => Promise<void>;
  onSaveMemorySettings: (settings: ChatMemorySettings) => Promise<void>;
  onToggleRelationship: (enabled: boolean) => Promise<void>;
  /** null clears the override, which is how the character's narrator comes back. */
  onSaveNarrator: (narrator: NarratorConfig | null) => Promise<void>;
  onToggleCustomUi: (enabled: boolean) => void;
  onToggleComponentTurns: (allowed: boolean) => Promise<void>;
  onToggleStatusWindow: (enabled: boolean) => Promise<void>;
  onToggleChoices: (enabled: boolean) => Promise<void>;
  /** Members the reader sent off the stage. */
  absentCharacterIds?: readonly string[];
  /** Sends a member off the stage or brings them back; no toggles without it. */
  onToggleAbsent?: (memberId: string, absent: boolean) => Promise<void>;
  /**
   * A round of one, that member's (지금 말하기) — offered in a work of several
   * members, for those on the stage.
   */
  onSpeakNow?: (memberId: string) => void;
  /**
   * The chat whose assembled prompt this reader may see — set only for the
   * plot's creator. Everyone else never gets the section.
   */
  inspectChatId?: string;
  /**
   * Whether the plot's scripts may search by embedding, which RisuAI keeps
   * behind their low-level access. Only then is there a model to pick.
   */
  scriptSimilarity?: boolean;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const format = useFormatter();

  const [noteDraft, setNoteDraft] = useState(note);
  const [promptDraft, setPromptDraft] = useState(memorySettings?.summarizationPrompt ?? '');
  const [voiceDraft, setVoiceDraft] = useState(narrator?.voice ?? '');
  const [saving, setSaving] = useState<Saveable | null>(null);

  // Adopt whatever the server holds. Only a real change re-runs these, so text
  // typed while a reply streams is not thrown away by the state refresh.
  const prompt = memorySettings?.summarizationPrompt ?? '';
  const voice = narrator?.voice ?? '';
  useEffect(() => setNoteDraft(note), [note]);
  useEffect(() => setPromptDraft(prompt), [prompt]);
  useEffect(() => setVoiceDraft(voice), [voice]);

  async function save(kind: Saveable): Promise<void> {
    if (disabled || saving !== null) return;
    setSaving(kind);
    try {
      if (kind === 'note') await onSaveNote(noteDraft);
      else if (kind === 'prompt') await saveMemorySettings({ summarizationPrompt: promptDraft });
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
  const placement = { ...AUTHOR_NOTE_DEFAULTS, ...noteSettings };
  const rows = relationshipRows(relationship);
  // The selects always show a concrete value: what the chat set, or the default
  // the server would apply for a key it has not set.
  const settings = { contextBudget: DEFAULT_CONTEXT_BUDGET, ...HYPA_V3_DEFAULTS, ...memorySettings };
  const randomShare = Math.max(0, 1 - settings.recentMemoryRatio - settings.similarMemoryRatio);

  /**
   * One change on top of what the chat set — never the defaults, which a key
   * left unset already means. The two shares may not add up to more than the
   * whole: moving one past it takes the other down, as RisuAI's settings do.
   */
  function saveMemorySettings(change: ChatMemorySettings): Promise<void> {
    const next = { ...(memorySettings ?? {}), ...change };
    const recent = next.recentMemoryRatio ?? HYPA_V3_DEFAULTS.recentMemoryRatio;
    const similar = next.similarMemoryRatio ?? HYPA_V3_DEFAULTS.similarMemoryRatio;
    if (recent + similar > 1 + 1e-9) {
      if (change.recentMemoryRatio !== undefined) next.similarMemoryRatio = Math.round((1 - recent) * 100) / 100;
      else next.recentMemoryRatio = Math.round((1 - similar) * 100) / 100;
    }
    const memory = next.memoryTokensRatio ?? HYPA_V3_DEFAULTS.memoryTokensRatio;
    if ((next.extraSummarizationRatio ?? 0) > 1 - memory) next.extraSummarizationRatio = 0;
    return onSaveMemorySettings(next);
  }

  /** A select of `steps` for one numeric setting, saved on the spot. */
  const memorySelect = (
    key: 'memoryTokensRatio' | 'extraSummarizationRatio' | 'maxChatsPerSummary' | 'queryChatCount' | 'recentMemoryRatio' | 'similarMemoryRatio',
    steps: readonly number[],
    label: (value: number) => string,
  ): ReactNode => (
    <Field label={t(`memorySetting.${key}`)}>
      <Select
        value={String(settings[key])}
        disabled={busy}
        className="h-9 py-0 text-xs"
        onChange={(event) => void saveMemorySettings({ [key]: Number(event.target.value) })}
      >
        {withValue(steps, settings[key]).map((value) => (
          <option key={value} value={value}>
            {label(value)}
          </option>
        ))}
      </Select>
    </Field>
  );
  const share = (value: number): string => t('percentValue', { percent: percent(value) });
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
          <h2 className="text-xs font-medium text-muted">{t('members')}</h2>
          <ul className="flex flex-wrap gap-x-4 gap-y-2">
            {members.map((member) => {
              const away = absentCharacterIds.includes(member.id);
              return (
                <li key={member.id} className="flex min-w-0 items-center gap-2">
                  <Avatar
                    src={member.avatarUrl}
                    name={member.name}
                    className={cx('size-7 text-xs', away && 'opacity-40')}
                  />
                  <span className={cx('truncate text-sm', away ? 'text-muted line-through' : 'text-fg')}>
                    {member.name}
                  </span>
                  {onSpeakNow && !away ? (
                    <button
                      type="button"
                      data-testid="member-speak-now"
                      disabled={busy}
                      onClick={() => onSpeakNow(member.id)}
                      className="rounded-md px-1.5 py-0.5 text-xs text-link transition-colors hover:text-fg disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {t('speakNow')}
                    </button>
                  ) : null}
                  {onToggleAbsent ? (
                    <button
                      type="button"
                      data-testid="member-absent-toggle"
                      aria-pressed={away}
                      disabled={busy}
                      onClick={() => void onToggleAbsent(member.id, !away)}
                      className="rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors hover:text-fg disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {away ? t('sceneReturn') : t('sceneLeave')}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {onToggleAbsent ? <p className="text-xs text-muted">{t('sceneCastHint')}</p> : null}
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
        {/* SillyTavern's Author's Note settings, beside the note they place. Saved on the spot, as the memory's. */}
        {onSaveNoteSettings ? (
          <div data-testid="author-note-settings" className="grid grid-cols-3 gap-3">
            <Field label={t('noteDepth')}>
              <Select
                value={String(placement.depth)}
                disabled={busy}
                className="h-9 py-0 text-xs"
                onChange={(event) => void onSaveNoteSettings({ ...placement, depth: Number(event.target.value) })}
              >
                {withValue(NOTE_STEPS.depth, placement.depth).map((depth) => (
                  <option key={depth} value={depth}>
                    {t('noteDepthValue', { depth })}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('noteFrequency')}>
              <Select
                value={String(placement.frequency)}
                disabled={busy}
                className="h-9 py-0 text-xs"
                onChange={(event) => void onSaveNoteSettings({ ...placement, frequency: Number(event.target.value) })}
              >
                {withValue(NOTE_STEPS.frequency, placement.frequency).map((frequency) => (
                  <option key={frequency} value={frequency}>
                    {t('noteFrequencyValue', { frequency })}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('noteRole')}>
              <Select
                value={placement.role}
                disabled={busy}
                className="h-9 py-0 text-xs"
                onChange={(event) =>
                  void onSaveNoteSettings({ ...placement, role: event.target.value as AuthorNoteRole })
                }
              >
                {AUTHOR_NOTE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(`noteRoles.${role}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}
        {onSaveNoteSettings ? <p className="text-xs text-muted">{t('noteSettingsHint')}</p> : null}
        {saveButton('note')}
      </section>

      <section data-testid="chat-notes" className="space-y-3 border-t border-line pt-5">
        <h2 className="text-xs font-medium text-muted">{t('attachedNotes')}</h2>
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
        <p className="text-xs text-muted">{t('attachedNotesHint')}</p>
      </section>

      <MemorySummaries chatId={chatId} version={`${headMessageId}:${memoryRevision}`} disabled={busy} />

      <section data-testid="memory-settings" className="space-y-3 border-t border-line pt-5">
        <h2 className="text-xs font-medium text-muted">{t('memorySettings')}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label={t('contextBudget')}>
            <Select
              value={String(settings.contextBudget)}
              disabled={busy}
              className="h-9 py-0 text-xs"
              onChange={(event) => void saveMemorySettings({ contextBudget: Number(event.target.value) })}
            >
              {MEMORY_CONTEXT_BUDGETS.map((budget) => (
                <option key={budget} value={budget}>
                  {t('contextBudgetValue', { tokens: format.number(budget) })}
                </option>
              ))}
            </Select>
          </Field>
          {memorySelect('memoryTokensRatio', MEMORY_STEPS.memoryTokensRatio, share)}
          {memorySelect('extraSummarizationRatio', MEMORY_STEPS.extraSummarizationRatio, share)}
          {memorySelect('maxChatsPerSummary', MEMORY_STEPS.maxChatsPerSummary, (count) =>
            t('messageCountValue', { count }),
          )}
          {memorySelect('queryChatCount', MEMORY_STEPS.queryChatCount, (count) => t('messageCountValue', { count }))}
          {memorySelect('recentMemoryRatio', MEMORY_STEPS.share, share)}
          {memorySelect('similarMemoryRatio', MEMORY_STEPS.share, share)}
          <div className="space-y-1.5">
            <span className="block text-xs font-semibold text-muted">{t('memorySetting.randomMemoryRatio')}</span>
            <p data-testid="memory-random-share" className="flex h-9 items-center text-xs text-fg">
              {share(randomShare)}
            </p>
          </div>
        </div>
        <Checkbox
          label={t('memorySetting.doNotSummarizeUserMessage')}
          checked={settings.doNotSummarizeUserMessage}
          disabled={busy}
          onChange={(checked) => void saveMemorySettings({ doNotSummarizeUserMessage: checked })}
        />
        <Field label={t('memorySetting.summarizationPrompt')} hint={t('memorySetting.summarizationPromptHint')}>
          <TextArea
            rows={3}
            value={promptDraft}
            disabled={busy}
            placeholder={HYPA_V3_SUMMARIZATION_PROMPT}
            onChange={(event) => setPromptDraft(event.target.value)}
          />
        </Field>
        {saveButton('prompt')}
        <p className="text-xs text-muted">{t('memorySettingsHint')}</p>
      </section>

      <section data-testid="chat-narrator" className="space-y-3 border-t border-line pt-5">
        <h2 className="text-xs font-medium text-muted">{t('narrator')}</h2>
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
            <option value="third-limited">{t('narratorPovThirdLimited')}</option>
            <option value="omniscient">{t('narratorPovOmniscient')}</option>
          </Select>
        </Field>
        {saveButton('narrator')}
        <p className="text-xs text-muted">{t('narratorHint')}</p>
      </section>

      {/* What the plot asked for on top of the prose. Both rows are the reader's
          half of a creator's setting, so neither is offered where the plot left
          the feature off — there would be nothing on the other end of it. */}
      {statusWindow || choices ? (
        <section data-testid="chat-plot-features" className="space-y-3 border-t border-line pt-5">
          <h2 className="text-xs font-medium text-muted">
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
              <p className="text-xs text-muted">{t('statusWindowHint')}</p>
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
              <p className="text-xs text-muted">{t('choicesHint')}</p>
            </>
          ) : null}
        </section>
      ) : null}

      <section data-testid="chat-display" className="space-y-3 border-t border-line pt-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium text-muted">{t('display')}</h2>
          <Checkbox
            label={t('customUi')}
            checked={customUi}
            onChange={onToggleCustomUi}
          />
        </div>
        <p className="text-xs text-muted">{t('customUiHint')}</p>

        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium text-muted">
            {t('componentTurns')}
          </h2>
          <Checkbox
            label={t('componentTurnsAllowed')}
            checked={allowComponentTurns}
            disabled={busy}
            onChange={(allowed) => void onToggleComponentTurns(allowed)}
          />
        </div>
        <p className="text-xs text-muted">{t('componentTurnsHint')}</p>
      </section>

      {scriptSimilarity ? <EmbeddingModelSetting /> : null}

      <section data-testid="chat-relationship" className="space-y-3 border-t border-line pt-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium text-muted">{t('relationship')}</h2>
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
            <p className="text-xs text-muted">{t('relationshipHint')}</p>
          </>
        ) : (
          <p className="text-sm text-muted">{t('relationshipEmpty')}</p>
        )}
      </section>

      {inspectChatId ? <PromptInspector chatId={inspectChatId} /> : null}
    </div>
  );
}
