'use client';

import { extractChoices } from '@shizue/core/choices';
import { isNarration, narrationBody } from '@shizue/core/narration';
import { readerRuns, type ReaderRun } from '@shizue/core/speech';
import { extractStatusBlock } from '@shizue/core/status-block';
import { useFormatter, useTranslations } from 'next-intl';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AssetResolver } from '@/lib/assets';
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
 *
 * In a round of a work of several members the row knows who it is waiting on
 * (`typing`), and says so with their face — the face their reply will carry.
 */
function ThinkingClock({ typing }: { typing?: { name: string; avatarUrl: string | null } | undefined }) {
  const t = useTranslations('chat');
  const [start] = useState(() => Date.now());
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [start]);
  if (!typing) return <span className="text-sm text-muted tabular-nums">{t('thinking', { seconds })}</span>;
  return (
    <span data-testid="typing" data-speaker={typing.name} className="flex items-center gap-3">
      {/* The line says the name; the face is the same name drawn. */}
      <span aria-hidden="true">
        <Avatar src={typing.avatarUrl} name={typing.name} className="size-9 text-sm" />
      </span>
      <span className="text-sm text-muted tabular-nums">{t('typing', { name: typing.name, seconds })}</span>
    </span>
  );
}

/** The roster as a reader's `@이름:` lines are read against: every name a member goes by. */
function readersOf(roster: readonly PublicMember[]): { id: string; names: string[] }[] {
  return roster.map((member) => {
    const nickname = member.nickname?.trim();
    return { id: member.id, names: [member.name, ...(nickname ? [nickname] : []), ...(member.aliases ?? [])] };
  });
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
  shown,
  name,
  avatar,
  userImage,
  assets,
  resolveAsset,
  attachments,
  display,
  components,
  componentNames,
  roster = NO_ROSTER,
  speaker,
  typing,
  previousSameRole,
  chatIndex,
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
  /**
   * What the reader sees, where it is not what is stored: a greeting with its
   * conditions decided. Editing and copying still work on `content`.
   */
  shown?: string;
  name: string;
  avatar: string | null;
  /** The reader's persona picture, for RisuAI's `{{source::user}}` in the message's markup. */
  userImage?: string | null;
  /** Character images by slug, for the `{{img::slug}}` references in the message. */
  assets: ReadonlyMap<string, string>;
  /** The same references by an imported card's own image names; slugs only without it. */
  resolveAsset?: AssetResolver;
  /** Images the reader sent this turn with; drawn above its text. */
  attachments?: ChatAttachment[];
  /** Display scripts and their bindings; omitted when custom UI is off. */
  display?: DisplayContext;
  /** Component code and its bindings; omitted when custom UI is off. */
  components?: ComponentContext;
  /** The declared components, even when custom UI is off, so their call codes show as text. */
  componentNames?: readonly string[];
  /**
   * The plot's members. A reply names its speakers line by line, so with a roster
   * in hand the faces and the names belong to the runs inside the message and the
   * row keeps none of its own. Empty until the plot read lands — and for a plot
   * with no members at all — where the row is the speaker as it always was.
   */
  roster?: readonly PublicMember[];
  /**
   * The member who says this message's lines that name no one: the one a card's
   * script wrote it as (`source` `script`, which RisuAI draws as the character's
   * own message), or the speaker a group reply is stored under
   * (`speakerMemberId`) — the reply is that member's whole.
   */
  speaker?: string;
  /**
   * Whom the row is waiting on while `thinking`, in a round of several members:
   * drawn as their face and "{이름} 입력 중…".
   */
  typing?: { name: string; avatarUrl: string | null };
  /** Raw text of the previous message with the same role, for `repeat_back`. */
  previousSameRole?: string;
  /** This message's place on the branch, RisuAI's way, for `{{chat_index}}`. */
  chatIndex?: number;
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
    const withoutChoices = extractChoices(shown ?? content);
    const withoutStatus = extractStatusBlock(withoutChoices.body);
    return { body: withoutStatus.body, status: withoutStatus.status, choices: withoutChoices.choices };
  }, [content, shown]);
  /**
   * Whether the message names its own speakers. Only a reply does — one turn of
   * the reader's is one voice — and only against a roster to name them from.
   */
  const attributed = !isUser && !narration && roster.length > 0;
  /**
   * Who owns the lines that name no one. A reply with one owner is that
   * character's whole, so its unprefixed lines are the character's own 지문 and
   * are drawn inside its block, not as a narrator: the member the page names, or
   * the one member of a one-member plot — its greeting included, as a card's
   * first message is the character's own. A message with several speakers and
   * no owner (a scene written before group turns) keeps those lines the
   * scene's. The narrator is the narration rows alone.
   */
  const owner = speaker ?? (roster.length === 1 ? roster[0]!.name : undefined);
  /**
   * A reader's turn with lines they wrote as someone else (Zeta's `@이름: …`, and
   * `@내레이터: …` or `@: …`), cut into who each stretch is by (`readerRuns`).
   * Null for every turn that is the reader's voice alone — which is drawn as it
   * always was — and for a whole-turn `@:`, which is the narration row above.
   */
  const written = useMemo<ReaderRun[] | null>(() => {
    if (!isUser || narration || roster.length === 0) return null;
    const runs = readerRuns(body, readersOf(roster));
    return runs.some((run) => run.kind !== 'user') ? runs : null;
  }, [isUser, narration, roster, body]);

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
      className={cx('group flex gap-3', isUser && !narration && !written && 'justify-end')}
    >
      {!isUser && !narration && !attributed ? (
        grouped ? (
          // The avatar's own space, so a continued turn stays in the column.
          <div aria-hidden="true" className="size-9 shrink-0" />
        ) : (
          <Avatar src={avatar} name={name} className="mt-0.5 size-9 text-sm" />
        )
      ) : null}

      <div className={cx('min-w-0', isUser && !narration && !written ? 'max-w-[85%]' : 'flex-1')}>
        <div className={cx('flex items-center gap-2', isUser && !narration && 'justify-end')}>
          {/* A continued turn is the same speaker moments later: the name was
              already said, and saying it again is what makes a run look like a list.
              A narration names no one and needs no label: its line and its
              italics say what it is, as Zeta and RisuAI draw scene text. */}
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
        ) : written ? (
          // Each stretch as who wrote it: the reader's own in their bubble, a
          // member's as that member's speech, the narrator's as narration — the
          // same components a reply is drawn with, one per stretch.
          <div data-testid="reader-runs" className="mt-1 space-y-3">
            {attachments?.length ? <MessageAttachments attachments={attachments} /> : null}
            {written.map((run, index) => {
              const runBody = (
                <MessageBody
                  content={run.text}
                  assets={assets}
                  {...(resolveAsset ? { resolveAsset } : {})}
                  {...(display ? { display } : {})}
                  {...(components ? { components } : {})}
                  {...(componentNames ? { componentNames } : {})}
                  {...(run.kind === 'member'
                    ? { roster, speaker: roster.find((member) => member.id === run.memberId)?.name ?? '' }
                    : {})}
                  previousSameRole={previousSameRole ?? ''}
                  {...(chatIndex !== undefined ? { chatIndex } : {})}
                  streaming={streaming}
                  {...(userImage ? { userImage } : {})}
                />
              );
              return run.kind === 'user' ? (
                <div key={index} className="flex justify-end">
                  <div className="max-w-[85%] min-w-0 rounded-2xl rounded-tr-sm border border-accent/30 bg-mint-soft/50 px-4 py-3">
                    {runBody}
                  </div>
                </div>
              ) : run.kind === 'narration' ? (
                // As a narration row is drawn: a line down the side, in italics.
                <div key={index} data-testid="reader-narration" className="border-l-2 border-line pl-3 italic text-muted">
                  {runBody}
                </div>
              ) : (
                <div key={index} data-testid="reader-member">
                  {runBody}
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className={cx(
              'mt-1',
              isUser &&
                !narration &&
                'rounded-2xl rounded-tr-sm border border-accent/30 bg-mint-soft/50 px-4 py-3',
              // No bubble, no face and no label: a line down the side and
              // muted italics mark it, as Zeta marks its narrator and RisuAI
              // draws its *scene text*.
              narration && 'border-l-2 border-line pl-3 italic text-muted',
            )}
          >
            {/* Above the text, in the same bubble: the picture is part of the
                turn, and the words are usually about it. */}
            {attachments?.length ? <MessageAttachments attachments={attachments} /> : null}
            <MessageBody
              content={narration ? narrationBody(body) : body}
              assets={assets}
              {...(resolveAsset ? { resolveAsset } : {})}
              {...(display ? { display } : {})}
              {...(components ? { components } : {})}
              {...(componentNames ? { componentNames } : {})}
              {...(attributed ? { roster } : {})}
              {...(attributed && owner ? { speaker: owner } : {})}
              previousSameRole={previousSameRole ?? ''}
              {...(chatIndex !== undefined ? { chatIndex } : {})}
              streaming={streaming}
              {...(userImage ? { userImage } : {})}
            />
            {thinking ? <ThinkingClock typing={typing} /> : null}
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
