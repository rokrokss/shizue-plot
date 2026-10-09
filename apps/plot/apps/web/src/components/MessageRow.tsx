'use client';

import { extractChoices } from '@shizue/core/choices';
import { isNarration, narrationBody } from '@shizue/core/narration';
import { extractStatusBlock } from '@shizue/core/status-block';
import { useFormatter, useTranslations } from 'next-intl';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ComponentContext } from '@/lib/componentCalls';
import type { DisplayContext } from '@/lib/displayScripts';
import type { ChatAttachment, MessageRole, PublicMember } from '@/lib/types';
import { Avatar } from './Avatar';
import { MessageAttachments } from './MessageAttachments';
import { MessageBody } from './MessageBody';
import { StatusCard } from './StatusCard';
import { Button, TextArea, cx } from './ui';

/**
 * The row's own affordances: there for the hover and for the keyboard, invisible
 * until then. Nothing on a message may draw attention away from what it says.
 */
const QUIET_ACTION =
  'text-xs text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100';

/** The standard ring. These are plain buttons, so each one wears it itself. */
const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** Nothing to attribute the reply to, so the row speaks for it. */
const NO_ROSTER: readonly PublicMember[] = [];

/**
 * How long the reply has been waited for, counted from when the row began to
 * wait. The time is all there is to show: a reasoning model's thoughts can
 * paraphrase the creator's hidden prompt, so they are never asked for. Its own
 * component, so the tick re-renders this line and not the row around it.
 */
function ThinkingClock() {
  const t = useTranslations('chat');
  const [start] = useState(() => Date.now());
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [start]);
  return <span className="text-sm text-muted tabular-nums">{t('thinking', { seconds })}</span>;
}

/**
 * Memoized on its props, which is what keeps a streaming turn from re-rendering
 * the whole branch behind it. The page hands every row a stable identity for the
 * duration of a generation — the handlers, the footer and the branch navigation
 * are all withheld while `mode` is set — so a token that only moves the last row
 * only re-renders the last row.
 */
export const MessageRow = memo(function MessageRow({
  role,
  content,
  name,
  avatar,
  assets,
  attachments,
  display,
  components,
  roster = NO_ROSTER,
  previousSameRole,
  streaming,
  thinking = false,
  disabled = false,
  createdAt,
  grouped,
  statusCollapsed,
  onToggleStatus,
  onChoice,
  onSave,
  onEditScene,
  onDelete,
  branches,
  footer,
}: {
  role: MessageRole;
  content: string;
  name: string;
  avatar: string | null;
  /** Character images by slug, for the `{{img::slug}}` references in the message. */
  assets: ReadonlyMap<string, string>;
  /** Images the reader sent this turn with; drawn above its text. */
  attachments?: ChatAttachment[];
  /** Display scripts and their bindings; omitted when custom UI is off. */
  display?: DisplayContext;
  /** Component code and its bindings; omitted when custom UI is off. */
  components?: ComponentContext;
  /**
   * The plot's members. A reply names its speakers line by line, so with a roster
   * in hand the faces and the names belong to the runs inside the message and the
   * row keeps none of its own. Empty until the plot read lands — and for a plot
   * with no members at all — where the row is the speaker as it always was.
   */
  roster?: readonly PublicMember[];
  /** Raw text of the previous message with the same role, for `repeat_back`. */
  previousSameRole?: string;
  streaming: boolean;
  /** The request is open and none of the reply has arrived yet. */
  thinking?: boolean;
  disabled?: boolean;
  /** When the turn was stored, revealed on hover. Absent while it is optimistic. */
  createdAt?: string;
  /**
   * Continues the row above it — same speaker, moments apart. The avatar and the
   * name are what a group says once, so a continued row simply keeps the column.
   */
  grouped?: boolean;
  /** Whether this chat's status cards are folded away; one answer for all of them. */
  statusCollapsed?: boolean | undefined;
  onToggleStatus?: (() => void) | undefined;
  /**
   * What a choice does when it is taken. Omitted wherever the offer no longer
   * stands — every turn but the last, and all of them while one is generating —
   * and the buttons are then not drawn at all: the lines were an offer, not
   * content, and an old one is not there to be taken.
   */
  onChoice?: (choice: string) => void;
  /** Omitted for messages that are not persisted yet. */
  onSave?: (content: string) => Promise<void>;
  /**
   * Hands the edit to the page instead of the inline editor: a turn that is part
   * of a scene is edited with the whole scene, not on its own.
   */
  onEditScene?: () => void;
  /** Deletes this turn and everything under it; the page owns the confirmation. */
  onDelete?: () => void;
  /**
   * Where this message sits among its siblings, when it has any. A fork can land
   * anywhere on the branch — a scene edit makes one mid-path — so the way back to
   * the other version is on the message itself, not only under the last one.
   */
  branches?: {
    index: number;
    total: number;
    /** null at either end of the sibling group. */
    onPrev: (() => void) | null;
    onNext: (() => void) | null;
  };
  footer?: ReactNode;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const format = useFormatter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(content);
  }, [content, editing]);

  // Says so for a moment and then goes quiet again.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const isUser = role === 'user';
  /* The scene moving rather than anyone speaking: no speaker, no bubble. The role
     does not decide — the reader writes narration, and so does the narrate action. */
  const narration = isNarration(content);
  /** The message as it was written; the prefix is markup, not part of the text. */
  const sourceText = narration ? narrationBody(content) : content;
  /**
   * The two conventions that are not prose, taken off the message before anything
   * else reads it. The order is the order they are written in: the status block
   * only counts where the turn ends on it, and the model is taught to put its
   * choices after it — so the choices come off first or the block is never the
   * last thing there. Both parsers are tolerant of a half-arrived message, which
   * is what leaves a fence still being written on screen as the text it is.
   */
  const { body, status, choices } = useMemo(() => {
    const withoutChoices = extractChoices(content);
    const withoutStatus = extractStatusBlock(withoutChoices.body);
    return { body: withoutStatus.body, status: withoutStatus.status, choices: withoutChoices.choices };
  }, [content]);
  /**
   * Whether the message names its own speakers. Only a reply does — one turn of
   * the reader's is one voice — and only against a roster to name them from.
   */
  const attributed = !isUser && !narration && roster.length > 0;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(sourceText);
      setCopied(true);
    } catch {
      // No clipboard (insecure origin, or permission refused): silence beats a
      // row that claims to have copied something.
    }
  }

  /**
   * The edit, from either the button or the keyboard. It closes on success and
   * stays open on failure — the page says what went wrong, and the text the
   * reader typed is still here to try again with.
   */
  async function saveEdit(): Promise<void> {
    if (!onSave || busy || disabled) return;
    setBusy(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch {
      // The page presents the error; keep this draft available for another try.
    } finally {
      setBusy(false);
    }
  }

  const showActions = !streaming && !editing;

  return (
    <div
      data-testid={narration ? 'message-narration' : `message-${role}`}
      className={cx('group flex gap-3', isUser && !narration && 'justify-end')}
    >
      {!isUser && !narration && !attributed ? (
        grouped ? (
          // The avatar's own space, so a continued turn stays in the column.
          <div aria-hidden="true" className="size-9 shrink-0" />
        ) : (
          <Avatar src={avatar} name={name} className="mt-0.5 size-9 text-sm" />
        )
      ) : null}

      <div className={cx('min-w-0', isUser && !narration ? 'max-w-[85%]' : 'flex-1')}>
        <div className={cx('flex items-center gap-2', isUser && 'justify-end')}>
          {/* A continued turn is the same speaker moments later: the name was
              already said, and saying it again is what makes a run look like a list. */}
          {narration || grouped || attributed ? null : (
            <span className="text-xs font-medium text-muted">{name}</span>
          )}
          {(onSave || onEditScene) && showActions ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => (onEditScene ? onEditScene() : setEditing(true))}
              title={onEditScene ? t('sceneHint') : isUser ? t('editUserHint') : undefined}
              className={cx(QUIET_ACTION, FOCUS_RING, 'hover:text-link')}
            >
              {t('edit')}
            </button>
          ) : null}
          {showActions ? (
            <button
              type="button"
              onClick={() => void copy()}
              title={t('copyMessage')}
              className={cx(QUIET_ACTION, FOCUS_RING, 'hover:text-link', copied && 'opacity-100')}
            >
              {copied ? t('copied') : t('copyMessage')}
            </button>
          ) : null}
          {onDelete && showActions ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onDelete}
              title={t('deleteMessage')}
              className={cx(QUIET_ACTION, FOCUS_RING, 'hover:text-danger')}
            >
              {t('deleteMessage')}
            </button>
          ) : null}
          {/* Quiet like the edit affordance: a branched turn says so on hover, and
              to the keyboard as soon as one of its buttons takes focus. */}
          {branches && showActions ? (
            <div className="flex items-center gap-1 text-xs text-muted opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                disabled={disabled || !branches.onPrev}
                title={t('swipePrev')}
                aria-label={t('swipePrev')}
                onClick={() => branches.onPrev?.()}
                className={cx('px-1 hover:text-fg focus-visible:text-fg disabled:opacity-30', FOCUS_RING)}
              >
                <span aria-hidden="true">◀</span>
              </button>
              <span className="tabular-nums">
                {branches.index + 1}/{branches.total}
              </span>
              <button
                type="button"
                disabled={disabled || !branches.onNext}
                title={t('swipeNext')}
                aria-label={t('swipeNext')}
                onClick={() => branches.onNext?.()}
                className={cx('px-1 hover:text-fg focus-visible:text-fg disabled:opacity-30', FOCUS_RING)}
              >
                <span aria-hidden="true">▶</span>
              </button>
            </div>
          ) : null}
          {/* The clock is context, not chrome: it is there when the row is asked
              about, and the full date is one hover further in. */}
          {createdAt ? (
            <time
              dateTime={createdAt}
              title={format.dateTime(new Date(createdAt), { dateStyle: 'long', timeStyle: 'short' })}
              className={cx(QUIET_ACTION, 'tabular-nums')}
            >
              {format.dateTime(new Date(createdAt), { timeStyle: 'short' })}
            </time>
          ) : null}
        </div>

        {editing && onSave ? (
          <fieldset disabled={busy || disabled} aria-busy={busy || undefined} className="mt-1.5 min-w-0 space-y-2">
            <TextArea
              autoFocus
              aria-label={t('editMessage')}
              rows={Math.min(16, Math.max(3, draft.split('\n').length + 1))}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              // Enter belongs to the text being written, so the two ways out are
              // the ones a field like this always has: Escape leaves it as it was,
              // Cmd/Ctrl+Enter saves. Never mid-composition — that Escape is the
              // IME's, and taking it would drop the reader out of the editor.
              onKeyDown={(event) => {
                if (busy || disabled || event.nativeEvent.isComposing) return;
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditing(false);
                  return;
                }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void saveEdit();
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {common('cancel')}
              </Button>
              <Button size="sm" variant="primary" busy={busy} onClick={() => void saveEdit()}>
                {common('save')}
              </Button>
            </div>
          </fieldset>
        ) : (
          <div
            className={cx(
              'mt-1',
              isUser &&
                !narration &&
                'rounded-2xl rounded-tr-sm border border-accent/30 bg-mint-soft/50 px-4 py-3',
              narration && 'text-muted italic',
            )}
          >
            {/* Above the text, in the same bubble: the picture is part of the
                turn, and the words are usually about it. */}
            {attachments?.length ? <MessageAttachments attachments={attachments} /> : null}
            <MessageBody
              content={narration ? narrationBody(body) : body}
              assets={assets}
              {...(display ? { display } : {})}
              {...(components ? { components } : {})}
              {...(attributed ? { roster } : {})}
              previousSameRole={previousSameRole ?? ''}
              streaming={streaming}
            />
            {thinking ? <ThinkingClock /> : null}
            {streaming ? (
              <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-accent" />
            ) : null}
            {/* At the end of the message, where the turn left the scene. */}
            {status !== null ? (
              <StatusCard status={status} collapsed={statusCollapsed} onToggle={onToggleStatus} />
            ) : null}
          </div>
        )}

        {/* The offer, under the reply that made it. Taking one writes it into the
            composer and stops there — sending is the reader's, as it is for a
            display script's button. */}
        {onChoice && !streaming && choices.length > 0 ? (
          <div data-testid="message-choices" className="mt-2 flex flex-col items-start gap-1.5">
            {choices.map((choice, index) => (
              <button
                key={index}
                type="button"
                onClick={() => onChoice(choice)}
                className={cx(
                  'max-w-full rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-left text-sm text-muted',
                  'transition-colors hover:border-muted/60 hover:text-fg',
                  FOCUS_RING,
                )}
              >
                {choice}
              </button>
            ))}
          </div>
        ) : null}

        {footer}
      </div>
    </div>
  );
});
