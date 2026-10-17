'use client';

import { extractChoices } from '@shizue/core/choices';
import { isNarration, narrationBody } from '@shizue/core/narration';
import { readerRuns, type ReaderRun } from '@shizue/core/speech';
import { extractStatusBlock } from '@shizue/core/status-block';
import { applyTranslationScripts } from '@shizue/core/translation';
import type { TranslationScript } from '@shizue/core/triggers';
import { useFormatter, useTranslations } from 'next-intl';
import { memo, useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import type { AssetResolver } from '@/lib/assets';
import { renderProse } from '@/lib/cbs';
import type { ComponentContext } from '@/lib/componentCalls';
import type { DisplayContext } from '@/lib/displayScripts';
import {
  useLinesTranslation,
  useRowTranslation,
  type BodyTranslation,
  type ChatTranslator,
  type RowTranslation,
} from '@/lib/translation';
import type { ChatAttachment, MessageRole, PublicMember } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { Avatar } from './Avatar';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';
import { MessageAttachments } from './MessageAttachments';
import { MessageBody } from './MessageBody';
import { StatusCard } from './StatusCard';
import { Button, ErrorText, TextArea, cx } from './ui';

/**
 * The row's own affordances: there for the hover and for the keyboard, invisible
 * until then. Nothing on a message may draw attention away from what it says.
 */
const QUIET_ACTION =
  'text-xs text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100';

/**
 * Where the actions go when there is no name for them to stand beside — a
 * narration, a continued turn: over the gap above the row, so they take no
 * room until they are shown.
 */
const ACTIONS_ABOVE = 'absolute bottom-full flex h-5 items-center gap-2';

/** The standard ring. These are plain buttons, so each one wears it itself. */
const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

type RowPairs = RowTranslation['pairs'];

/**
 * The offer, under the reply that made it, in the reader's language where the
 * row is translated. Taking one hands the page the choice as the model wrote
 * it: what is sent is the work's language, as the rest of the chat is, and an
 * input translation, where the reader has one on, leaves it as it is.
 */
function ChoiceOffer({
  choices,
  onChoice,
  translation,
  className,
}: {
  choices: readonly string[];
  onChoice: (choice: string) => void;
  translation: BodyTranslation | undefined;
  className?: string | undefined;
}) {
  const { lines, ref } = useLinesTranslation(choices, translation);
  return (
    <div ref={ref} data-testid="message-choices" className={cx('mt-2 flex flex-col items-start gap-1.5', className)}>
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
          {lines[index] ?? choice}
        </button>
      ))}
    </div>
  );
}

/**
 * A message hidden from the AI: still there to read, a step back from the rest.
 * Only what the message says is dimmed — never the controls under the last row.
 */
const HIDDEN_DIM = 'opacity-[0.58]';

/** Nothing to attribute the reply to, so the row speaks for it. */
const NO_ROSTER: readonly PublicMember[] = [];

/**
 * The reader's bubble, a reply's mirrored: the square corner by their face,
 * mint where Zeta's is purple (`bubble-user`, deep in dark and bright in light),
 * content-sized, at most the width a reply's bubble may take.
 */
const USER_BUBBLE =
  'user-bubble w-fit max-w-[min(100%_-_4rem,612px)] min-w-0 rounded-l-xl rounded-br-xl bg-bubble-user px-3 py-2 text-bubble-user-ink';

/**
 * The reply being waited for, drawn as Zeta draws it (2026-10-17 owner
 * decision): three dots breathing in turn, one chat line high, and words only
 * for a screen reader. A reasoning model's thoughts can paraphrase the
 * creator's hidden prompt, so they are never asked for — there is nothing
 * else to show.
 *
 * Drawn where the reply will be — in a bubble, and beside the face the reply
 * will carry where the row knows it (`face`): the one member of a work of one,
 * or, in a round of a work of several, the member it waits on (`typing`), whose
 * name the words then say. A narration has no bubble to wait in (`plain`).
 */
function WaitingDots({
  face,
  typing = false,
  plain = false,
}: {
  face?: { name: string; avatarUrl: string | null } | undefined;
  typing?: boolean;
  plain?: boolean;
}) {
  const t = useTranslations('chat');
  const line = (
    <span className="waiting-dots text-muted">
      <span className="sr-only">{typing && face ? t('typing', { name: face.name }) : t('thinking')}</span>
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </span>
  );
  if (plain) return line;
  const bubble = (
    <span className="chat-bubble w-fit rounded-r-xl rounded-bl-xl bg-bubble px-3 py-2">{line}</span>
  );
  if (!face) return <span className="flex">{bubble}</span>;
  return (
    <span
      {...(typing ? { 'data-testid': 'typing', 'data-speaker': face.name } : {})}
      className="flex items-start gap-1.5"
    >
      {/* The line says the name; the face is the same name drawn. */}
      <span aria-hidden="true" className="chat-face">
        <Avatar src={face.avatarUrl} name={face.name} className="size-8 text-xs" />
      </span>
      {bubble}
    </span>
  );
}

/** How long a finger holds a row before its menu opens. */
const LONG_PRESS_MS = 500;
/** A finger that moves this far is scrolling, not pressing. */
const PRESS_SLOP_PX = 10;
/** What takes a press of its own, which a long press on it is left to. */
const OWN_PRESS = 'a, button, input, textarea, select, summary, label, [contenteditable]';

/**
 * A finger held on a row opens its menu, as Zeta's long press does (2026-10-17
 * owner decision): a touch screen has no hover for the row's quiet actions to
 * come out on. A mouse and a pen are left to those, and a finger that moves —
 * a scroll — or that holds something with a press of its own is left alone.
 * The click a long press ends with is swallowed, so it does not also press
 * what was under the finger, and so is the browser's own menu. Null leaves
 * the row as it is.
 */
function useLongPress(onLongPress: (() => void) | null): HTMLAttributes<HTMLDivElement> {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(() => cancel, []);
  if (!onLongPress) return {};
  return {
    onPointerDown: (event) => {
      fired.current = false;
      if (event.pointerType !== 'touch' || (event.target as Element).closest(OWN_PRESS)) return;
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      if (start.current && Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > PRESS_SLOP_PX) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event) => {
      if (fired.current || timer.current) event.preventDefault();
    },
    onClickCapture: (event) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
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
 * duration of a generation — the handlers and the footer
 * are all withheld while `mode` is set — so a token that only moves the last row
 * only re-renders the last row.
 */
export const MessageRow = memo(function MessageRow({
  role,
  content,
  shown,
  reasoning,
  bias,
  name,
  avatar,
  userImage,
  assets,
  resolveAsset,
  attachments,
  display,
  buttons,
  components,
  componentNames,
  roster = NO_ROSTER,
  speaker,
  member,
  spoken = false,
  typing,
  previousSameRole,
  chatIndex,
  streaming,
  thinking = false,
  disabled = false,
  createdAt,
  grouped,
  intro = false,
  model,
  statusCollapsed,
  onToggleStatus,
  onChoice,
  onSave,
  onEditScene,
  onDelete,
  hidden = false,
  onToggleHidden,
  footer,
  translator,
  translationId,
  translationScripts,
}: {
  role: MessageRole;
  content: string;
  /**
   * What the reader sees, where it is not what is stored: a greeting with its
   * conditions decided, or the text SillyTavern showed in a message's place.
   * Editing and copying still work on `content`.
   */
  shown?: string;
  /**
   * The model's reasoning before the reply, as SillyTavern kept it: drawn folded
   * above the text, as ST draws its reasoning block (`auto_expand` off).
   */
  reasoning?: string;
  /** The reader's `{{bias}}` on their turn, as SillyTavern kept it: drawn under the bubble (`.mes_bias`). */
  bias?: string;
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
  /**
   * The manual triggers the message's own `{{button}}`s run (`MessageBody`
   * `buttons`); omitted when custom UI is off.
   */
  buttons?: ReadonlySet<string>;
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
   * In a work of several members, whose message this is for its custom UI: that
   * member's stylesheet dresses it (`data-shizue-member`, `sanitizeCustomHtml`).
   */
  member?: string;
  /**
   * Whether `member` spoke this message (`data-shizue-spoken`): its buttons then
   * run that member's scripts, and otherwise the lead's.
   */
  spoken?: boolean;
  /**
   * Whom the row is waiting on while `thinking`, in a round of several members:
   * drawn as their face beside the dots, and "{이름} 입력 중…" to a screen reader.
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
  /** A chat's opening: its `#`/`##` lines are scene titles, as a narration's are. */
  intro?: boolean;
  /** The name of the model that wrote this reply, shown small by it once it is finished. */
  model?: string;
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
   * Hidden from the AI (SillyTavern's hide): drawn dimmed, and said so beside the
   * model's name — still on screen, never in what a model reads.
   */
  hidden?: boolean;
  /** Hides the message from the AI, or shows it to the AI again; the page owns the request. */
  onToggleHidden?: () => void;
  /**
   * What stands under the row (the last reply's bar). A function is handed the
   * row's own way into its editor, or null where the row cannot be edited.
   */
  footer?: ReactNode | ((edit: (() => void) | null) => ReactNode);
  /**
   * The chat's translator (`lib/translation`), and the stored message it
   * translates — absent where this row is not translated: another language
   * mode, a reply still being written, a turn not stored yet.
   */
  translator?: ChatTranslator | null;
  translationId?: string;
  /**
   * The card's `edittrans` scripts, which the translation runs through before it
   * is shown (RisuAI's `applyEdittransRegex`) — with the display scripts, so
   * only where the card's custom UI is on.
   */
  translationScripts?: readonly TranslationScript[] | undefined;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const format = useFormatter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** The translation through the card's edittrans scripts, a `cbs` pattern read with the message's own values. */
  const editTranslation = useMemo(
    () =>
      display && translationScripts?.length
        ? (text: string) =>
            applyTranslationScripts(text, translationScripts, { cbs: (pattern) => renderProse(pattern, display, () => {}) })
        : undefined,
    [display, translationScripts],
  );
  const translation = useRowTranslation(translator, streaming ? undefined : translationId, editTranslation);
  /**
   * The reader correcting the translation (RisuAI's 번역 수정): the texts the row
   * showed when they began, and their wording of each.
   */
  const [correcting, setCorrecting] = useState<{ pairs: RowPairs; drafts: string[] } | null>(null);
  const [correctBusy, setCorrectBusy] = useState(false);
  const [correctError, setCorrectError] = useState('');
  const toMessage = useErrorMessage();

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

  /** Keeps what the reader rewrote; a field left as it was, or emptied, keeps what it had. */
  async function saveCorrection(): Promise<void> {
    if (!correcting || correctBusy) return;
    const corrected: Record<string, string> = {};
    correcting.pairs.forEach(([text, now], index) => {
      const next = correcting.drafts[index] ?? now;
      if (next.trim() && next !== now) corrected[text] = next;
    });
    if (Object.keys(corrected).length === 0) {
      setCorrecting(null);
      return;
    }
    setCorrectBusy(true);
    setCorrectError('');
    try {
      await translation.correct(corrected);
      setCorrecting(null);
    } catch (caught) {
      setCorrectError(toMessage(caught));
    } finally {
      setCorrectBusy(false);
    }
  }

  const showActions = !streaming && !editing && !correcting;

  /**
   * The row's quiet actions. Beside the name where the row says one — the
   * reader's, a fallback reply's — and beside the first name a reply says, which
   * its body draws (`MessageBody` `header`).
   */
  const actions = (
    <>
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
      {onToggleHidden && showActions ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onToggleHidden}
          aria-label={hidden ? t('showToAi') : t('hideFromAi')}
          title={hidden ? t('showToAi') : t('hideFromAiHint')}
          className={cx(QUIET_ACTION, FOCUS_RING, 'inline-flex items-center hover:text-link')}
        >
          {/* A phone's row has no room for these words beside the others, and the
              name would be squeezed for them: the eye says it there. */}
          <Icon name={hidden ? 'eye' : 'eyeOff'} className="size-3.5 sm:hidden" />
          <span className="hidden sm:inline">{hidden ? t('showToAi') : t('hideFromAi')}</span>
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
    </>
  );
  const hasActions = showActions || Boolean(createdAt);

  /**
   * The same actions for a finger (`useLongPress`): a sheet of them, each one a
   * full-width button, the time it was said at the top.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  const press = useLongPress(showActions ? () => setMenuOpen(true) : null);
  const pressable = showActions && 'message-press';
  const act = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };
  const menu = menuOpen ? (
    <BottomSheet title={t('messageMenu')} onClose={() => setMenuOpen(false)}>
      {createdAt ? (
        <p className="-mt-2 pb-3 text-xs text-muted">
          {format.dateTime(new Date(createdAt), { dateStyle: 'long', timeStyle: 'short' })}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {onSave || onEditScene ? (
          <Button disabled={disabled} onClick={act(() => (onEditScene ? onEditScene() : setEditing(true)))}>
            {t('edit')}
          </Button>
        ) : null}
        <Button
          // Says so a moment before it closes: the row's own label is not on a phone's screen.
          onClick={() => void copy().then(() => setTimeout(() => setMenuOpen(false), 700))}
        >
          {copied ? t('copied') : t('copyMessage')}
        </Button>
        {onToggleHidden ? (
          <Button disabled={disabled} onClick={act(onToggleHidden)}>
            {hidden ? t('showToAi') : t('hideFromAi')}
          </Button>
        ) : null}
        {onDelete ? (
          <Button variant="danger" disabled={disabled} onClick={act(onDelete)}>
            {t('deleteMessage')}
          </Button>
        ) : null}
      </div>
    </BottomSheet>
  ) : null;

  const startEdit = onSave || onEditScene ? () => (onEditScene ? onEditScene() : setEditing(true)) : null;
  const shownFooter = typeof footer === 'function' ? footer(startEdit) : footer;

  const editor =
    editing && onSave ? (
      <fieldset disabled={busy || disabled} aria-busy={busy || undefined} className="mt-1.5 w-full min-w-0 space-y-2">
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
    ) : correcting ? (
      // RisuAI's 번역 수정 puts the translation in a field in place of the body.
      // The translation here is kept text by text, so each text the row shows is
      // a field of its own under its original — and the markup around them stays
      // the creator's, byte for byte.
      <fieldset
        data-testid="translation-editor"
        disabled={correctBusy}
        aria-busy={correctBusy || undefined}
        className="mt-1.5 w-full min-w-0 space-y-3"
        onKeyDown={(event) => {
          if (correctBusy || event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            setCorrecting(null);
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void saveCorrection();
          }
        }}
      >
        {correcting.pairs.map(([text], index) => (
          <label key={index} className="block space-y-1">
            <span className="line-clamp-3 block whitespace-pre-line text-xs text-muted">{text}</span>
            <TextArea
              autoFocus={index === 0}
              rows={Math.min(8, Math.max(2, (correcting.drafts[index] ?? '').split('\n').length + 1))}
              value={correcting.drafts[index] ?? ''}
              onChange={(event) => {
                const drafts = [...correcting.drafts];
                drafts[index] = event.target.value;
                setCorrecting({ ...correcting, drafts });
              }}
              className="w-full text-sm"
            />
          </label>
        ))}
        {correctError ? <ErrorText>{correctError}</ErrorText> : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setCorrecting(null)}>
            {common('cancel')}
          </Button>
          <Button size="sm" variant="primary" busy={correctBusy} onClick={() => void saveCorrection()}>
            {t('saveTranslation')}
          </Button>
        </div>
      </fieldset>
    ) : null;

  /** What the body takes however the row lays it out. */
  const bodyProps = {
    assets,
    ...(resolveAsset ? { resolveAsset } : {}),
    ...(display ? { display } : {}),
    ...(buttons ? { buttons } : {}),
    ...(components ? { components } : {}),
    ...(componentNames ? { componentNames } : {}),
    previousSameRole: previousSameRole ?? '',
    ...(chatIndex !== undefined ? { chatIndex } : {}),
    streaming,
    ...(userImage ? { userImage } : {}),
    translation: translation.body,
  };

  /**
   * The offer, under the reply that made it. Taking one writes it into the
   * composer and stops there — sending is the reader's, as it is for a display
   * script's button. In line with what it answers (`indent`): the bubbles past
   * the face, a narration's text past its ≡.
   */
  const offerAt = (indent?: string) =>
    onChoice && !streaming && choices.length > 0 ? (
      <ChoiceOffer choices={choices} onChoice={onChoice} translation={translation.body} className={indent} />
    ) : null;

  /** At the end of the message, where the turn left the scene. */
  const statusCard =
    status !== null ? (
      <StatusCard status={status} collapsed={statusCollapsed} onToggle={onToggleStatus} translation={translation.body} />
    ) : null;

  /** The model that wrote a finished reply: faint, outside its last bubble, at the corner. */
  const modelLabel =
    model && !streaming && !thinking ? (
      <span data-testid="message-model" className="chat-meta caption2 text-muted/80">
        {model}
      </span>
    ) : undefined;

  /** Says the message is hidden from the AI, in the meta line by the model's name. */
  const hiddenMark = hidden ? (
    <span data-testid="message-hidden" className="chat-meta caption2 inline-flex items-center gap-1 text-muted">
      <Icon name="eyeOff" className="size-3" />
      {t('hiddenFromAi')}
    </span>
  ) : null;
  /**
   * A translated message says so, quietly, where its meta goes: "번역 중…" while
   * the original stands in for it, then a switch between the translation and
   * the original. Not on a row that is not translated.
   */
  const translationMark =
    translation.status === 'idle' ? null : translation.status === 'pending' ? (
      <span data-testid="message-translation" data-state="pending" className="chat-meta caption2 animate-pulse text-muted">
        {t('translating')}
      </span>
    ) : translation.status === 'failed' ? (
      <button
        type="button"
        data-testid="message-translation"
        data-state="failed"
        onClick={translation.retry}
        className={cx('chat-meta caption2 text-muted hover:text-link', FOCUS_RING)}
      >
        {t('translationFailed')}
      </button>
    ) : (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          data-testid="message-translation"
          data-state={translation.original ? 'original' : 'translated'}
          aria-pressed={translation.original}
          onClick={translation.toggleOriginal}
          className={cx('chat-meta caption2 text-muted hover:text-link', FOCUS_RING)}
        >
          {translation.original ? t('showTranslation') : t('showOriginal')}
        </button>
        {/* RisuAI's two, there while the translation is what is shown. */}
        {!translation.original && !editing && !correcting ? (
          <>
            <button
              type="button"
              data-testid="message-retranslate"
              onClick={translation.retranslate}
              className={cx('chat-meta caption2 text-muted hover:text-link', FOCUS_RING)}
            >
              {t('retranslate')}
            </button>
            <button
              type="button"
              data-testid="message-correct-translation"
              onClick={() => {
                setCorrectError('');
                setCorrecting({ pairs: translation.pairs, drafts: translation.pairs.map(([, now]) => now) });
              }}
              className={cx('chat-meta caption2 text-muted hover:text-link', FOCUS_RING)}
            >
              {t('correctTranslation')}
            </button>
          </>
        ) : null}
      </span>
    );
  /** The marks a row says of itself, in the meta line. */
  const marks =
    hiddenMark && translationMark ? (
      <span className="inline-flex items-center gap-2">
        {translationMark}
        {hiddenMark}
      </span>
    ) : (hiddenMark ?? translationMark);
  /** The meta line under a reply's last bubble: the marks, then the model. */
  const meta = marks ? (
    <span className="inline-flex items-center gap-2">
      {marks}
      {modelLabel}
    </span>
  ) : modelLabel;
  /** What a hidden message's own content is drawn with; nothing while it is edited. */
  const dim = hidden && !editing ? HIDDEN_DIM : undefined;

  const memberProps = member ? { 'data-shizue-member': member, ...(spoken ? { 'data-shizue-spoken': '' } : {}) } : {};

  /** The reasoning, folded, where the reply's text starts. */
  const reasoningBlock =
    reasoning && !editing ? (
      <details
        data-testid="message-reasoning"
        className="mb-2 max-w-[min(100%,36rem)] rounded-xl border border-line bg-raised"
      >
        <summary className={cx('cursor-pointer select-none rounded-xl px-3 py-1.5 text-xs font-medium text-muted', FOCUS_RING)}>
          {t('reasoning')}
        </summary>
        <div className="whitespace-pre-wrap break-words px-3 pb-2 text-xs text-muted">{reasoning}</div>
      </details>
    ) : null;
  /**
   * The pictures and files a reply or a narration came with — only a SillyTavern
   * chat brings any — after its words, in the text's column, as ST draws a
   * message's media and files under its text.
   */
  const attachedBlock =
    attachments?.length && !editing ? (
      <div className="mt-2 max-w-[min(100%,36rem)]">
        <MessageAttachments attachments={attachments} />
      </div>
    ) : null;
  /** The bias, quietly under the reader's bubble. */
  const biasLine =
    bias && !editing ? (
      <p data-testid="message-bias" className="mt-1 max-w-[min(100%,36rem)] whitespace-pre-wrap text-right text-xs text-muted italic">
        {bias}
      </p>
    ) : null;

  // No bubble, no face and no label: the ≡ at its start and muted italics mark
  // it, as Zeta marks its narrator and RisuAI draws its *scene text*.
  if (narration) {
    return (
      <div data-testid="message-narration" {...memberProps} {...press} className={cx('group relative min-w-0', pressable)}>
        {editor ?? (
          <div className={dim}>
            {reasoningBlock}
            <MessageBody
              {...bodyProps}
              content={narrationBody(body)}
              mode="narration"
              sceneHeadings
              {...(marks ? { trailer: marks } : {})}
            />
            {attachedBlock ? <div className="pl-6">{attachedBlock}</div> : null}
            {thinking ? <WaitingDots plain /> : null}
            {statusCard}
          </div>
        )}
        {/* The ≡ and the gap after it: in line with the narration's text. */}
        {offerAt('pl-6')}
        {shownFooter}
        <div className={cx(ACTIONS_ABOVE, 'left-0')}>{actions}</div>
        {menu}
      </div>
    );
  }

  // The reader's, mirrored: their face at the far right, their name beside it,
  // and the bubble in mint under the name.
  if (isUser) {
    return (
      <div data-testid="message-user" {...memberProps} {...press} className={cx('group flex flex-row-reverse gap-1.5', pressable)}>
        {grouped ? (
          <div aria-hidden="true" className="chat-face w-8 shrink-0" />
        ) : (
          <Avatar src={userImage ?? null} name={name} className={cx('chat-face size-8 text-xs', dim)} />
        )}
        <div className="relative flex min-w-0 flex-1 flex-col items-end">
          {/* A continued turn is the same reader moments later: the name was
              already said, and the actions wait above the row. */}
          {grouped ? (
            <div className={cx(ACTIONS_ABOVE, 'right-0')}>{actions}</div>
          ) : (
            <div className="flex min-h-5 items-center justify-end gap-2">
              {actions}
              <span className={cx('chat-name text-xs text-link/70', dim)}>{name}</span>
            </div>
          )}
          {editor ?? (
            <div className={cx('flex w-full min-w-0 flex-col items-end', dim)}>
              {written ? (
                // Each stretch as who wrote it: the reader's own in their bubble, a
                // member's as that member's speech, the narrator's as narration — the
                // same components a reply is drawn with, one per stretch.
                <div data-testid="reader-runs" className="mt-1 w-full space-y-3">
                  {attachments?.length ? (
                    <div className="flex justify-end">
                      <MessageAttachments attachments={attachments} end />
                    </div>
                  ) : null}
                  {written.map((run, index) =>
                    run.kind === 'user' ? (
                      <div key={index} className="flex justify-end">
                        <div className={USER_BUBBLE}>
                          <MessageBody {...bodyProps} content={run.text} />
                        </div>
                      </div>
                    ) : run.kind === 'narration' ? (
                      <div key={index} data-testid="reader-narration">
                        <MessageBody {...bodyProps} content={run.text} mode="narration" sceneHeadings />
                      </div>
                    ) : (
                      <div key={index} data-testid="reader-member">
                        <MessageBody
                          {...bodyProps}
                          content={run.text}
                          roster={roster}
                          speaker={roster.find((entry) => entry.id === run.memberId)?.name ?? ''}
                          mode="reply"
                        />
                      </div>
                    ),
                  )}
                </div>
              ) : (
                <>
                  {/* Above the bubble, in the flow: the picture is part of the turn,
                      and the words are usually about it. */}
                  {attachments?.length ? (
                    <div className="mt-1 max-w-[min(100%,36rem)]">
                      <MessageAttachments attachments={attachments} end />
                    </div>
                  ) : null}
                  {/* A turn with no words — a SillyTavern picture sent alone, or a turn
                      that was only its bias — draws no empty bubble. */}
                  {body.trim() || !(attachments?.length || bias) ? (
                    <div className={cx(USER_BUBBLE, 'mt-1')}>
                      <MessageBody {...bodyProps} content={body} />
                    </div>
                  ) : null}
                </>
              )}
              {biasLine}
              {/* Under the bubble, at its corner, as a reply's model name is. */}
              {marks ? <div className="mt-1">{marks}</div> : null}
            </div>
          )}
          {shownFooter}
        </div>
        {menu}
      </div>
    );
  }

  // A reply with a roster draws its own speakers — each one's face, name and
  // bubble (`MessageBody`) — so the row keeps none of its own.
  if (attributed) {
    const ownMember = owner ? roster.find((entry) => entry.name === owner) : undefined;
    const waitingOn = typing ?? (owner ? { name: owner, avatarUrl: ownMember?.avatarUrl ?? null } : undefined);
    // A continue waits under the reply it goes on from, whose face is already there.
    const waiting = thinking ? (
      body.trim() ? (
        <div className="mt-3 pl-9.5">
          <WaitingDots />
        </div>
      ) : (
        <WaitingDots face={waitingOn} typing={typing !== undefined} />
      )
    ) : null;
    return (
      <div data-testid="message-assistant" {...memberProps} {...press} className={cx('group min-w-0', pressable)}>
        {editor ?? (
          <div className={dim}>
            {reasoningBlock ? <div className="pl-9.5">{reasoningBlock}</div> : null}
            <MessageBody
              {...bodyProps}
              content={body}
              roster={roster}
              {...(owner ? { speaker: owner } : {})}
              mode="reply"
              sceneHeadings={intro}
              continued={grouped ?? false}
              {...(hasActions ? { header: actions } : {})}
              {...(meta ? { trailer: meta } : {})}
            />
            {attachedBlock ? <div className="pl-9.5">{attachedBlock}</div> : null}
            {waiting}
            {statusCard ? <div className="mt-3">{statusCard}</div> : null}
          </div>
        )}
        {offerAt('pl-9.5')}
        {shownFooter}
        {menu}
      </div>
    );
  }

  // A greeting before the roster has arrived, or in a work with no members: the
  // body draws the plot's face and name as a member's (`face`), so a scene title
  // it opens on or cuts to stands outside them, at the column's width. What hangs
  // under the bubble keeps the bubble's column.
  if (intro) {
    return (
      <div data-testid="message-assistant" {...memberProps} {...press} className={cx('group min-w-0', pressable)}>
        {editor ?? (
          <div className={dim}>
            {reasoningBlock ? <div className="pl-9.5">{reasoningBlock}</div> : null}
            <MessageBody
              {...bodyProps}
              content={body}
              face={{ name, avatarUrl: avatar }}
              mode="reply"
              sceneHeadings
              continued={grouped ?? false}
              {...(hasActions ? { header: actions } : {})}
              {...(meta ? { trailer: meta } : {})}
            />
            {attachedBlock ? <div className="pl-9.5">{attachedBlock}</div> : null}
            {thinking ? (
              <div className={cx('pl-9.5', body.trim() && 'mt-3')}>
                <WaitingDots />
              </div>
            ) : null}
            {statusCard ? <div className="mt-3 pl-9.5">{statusCard}</div> : null}
          </div>
        )}
        {offerAt('pl-9.5')}
        {shownFooter ? <div className="pl-9.5">{shownFooter}</div> : null}
        {menu}
      </div>
    );
  }

  // Before the roster has arrived, or in a work with no members: the row is the
  // speaker, as it always was — the plot's face and name, then its bubble.
  return (
    <div data-testid="message-assistant" {...memberProps} {...press} className={cx('group flex gap-1.5', pressable)}>
      {grouped ? (
        // The avatar's own width, so a continued turn stays in the column.
        <div aria-hidden="true" className="chat-face w-8 shrink-0" />
      ) : (
        <Avatar src={avatar} name={name} className={cx('chat-face size-8 text-xs', dim)} />
      )}
      <div className="relative min-w-0 flex-1">
        {grouped ? (
          <div className={cx(ACTIONS_ABOVE, 'left-0')}>{actions}</div>
        ) : (
          <div className="flex min-h-5 items-center gap-2">
            {/* The chat text's letter-spacing, which a character's name line drawn by the body takes from `.message-body`. */}
            <span className={cx('chat-name text-xs tracking-[-0.01876rem] text-fg/70', dim)}>{name}</span>
            {actions}
          </div>
        )}
        {editor ?? (
          <div className={cx(!grouped && 'mt-1', dim)}>
            {reasoningBlock}
            <MessageBody
              {...bodyProps}
              content={body}
              mode="reply"
              sceneHeadings={intro}
              {...(meta ? { trailer: meta } : {})}
            />
            {attachedBlock}
            {thinking ? (
              <div className={body.trim() ? 'mt-3' : undefined}>
                <WaitingDots />
              </div>
            ) : null}
            {statusCard ? <div className="mt-3">{statusCard}</div> : null}
          </div>
        )}
        {offerAt()}
        {shownFooter}
      </div>
      {menu}
    </div>
  );
});
