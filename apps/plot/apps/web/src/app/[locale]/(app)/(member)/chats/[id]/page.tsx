'use client';

import { Icon } from '@/components/Icon';
import { assetResolver, type CbsMessage } from '@shizue/core/cbs';
import { componentNames } from '@shizue/core/component';
import { displayScriptsFor, orderedWithModules } from '@shizue/core/display-script';
import { NARRATOR_SPEAKER } from '@shizue/core/group';
import { fnv1a } from '@shizue/core/macro';
import { isNarration, NARRATION_PREFIX } from '@shizue/core/narration';
import { isNarrationTurn } from '@shizue/core/speech';
import { isSceneMessage, sceneSpanAt } from '@shizue/core/scene';
import { manualTriggerNames, type MemberOverlay, type TranslationScript } from '@shizue/core/triggers';
import { computeVariables, DEFAULT_USER_NAME, type FoldOptions, type Variables } from '@shizue/core/variables';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Fragment, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { AiBadge, AiNotice } from '@/components/AiNotice';
import { AttachmentChips } from '@/components/AttachmentChips';
import { Avatar } from '@/components/Avatar';
import { BgmMute } from '@/components/BgmMute';
import { BottomSheet } from '@/components/BottomSheet';
import { ChatBackground } from '@/components/ChatBackground';
import { ChatPanel } from '@/components/ChatPanel';
import { ModuleToggles } from '@/components/ModuleToggles';
import { ReaderModules } from '@/components/ReaderModules';
import { ChatSettings } from '@/components/ChatSettings';
import { EmotionScreen } from '@/components/EmotionScreen';
import { FocusPicker } from '@/components/FocusPicker';
import { MessageRow } from '@/components/MessageRow';
import { ModelPill } from '@/components/ModelPill';
import { MoreActions } from '@/components/MoreActions';
import { ScriptDialog, type ScriptPrompt } from '@/components/ScriptDialog';
import { SceneDraft } from '@/components/SceneDraft';
import { SceneEditor, type SceneBlock } from '@/components/SceneEditor';
import { Button, CenteredMessage, Spinner, TextArea, cx } from '@/components/ui';
import { WriteAsPicker } from '@/components/WriteAsPicker';
import { Link } from '@/i18n/navigation';
import { apiDelete, apiGet, apiSend, apiUpload } from '@/lib/api';
import {
  assetSrc,
  illustrations,
  isLocalizedAsset,
  lockedSrc,
  measureImage,
  openAssetLocks,
  type PlotAsset,
} from '@/lib/assets';
import { autoGrow } from '@/lib/autoGrow';
import {
  acceptFiles,
  isUploading,
  markFailed,
  markRetrying,
  markUploaded,
  removeChip,
  uploadedIds,
  type AttachmentChip,
} from '@/lib/attachments';
import {
  foldBase,
  headAnchor,
  mergeRefetched,
  prependWindow,
  type VariableAnchor,
} from '@/lib/chatHistory';
import { finishMarked, markFinish, unmarkFinish } from '@/lib/scripts/finishMark';
import { chatRowMeta, relativeDay } from '@/lib/chatRows';
import { COMPOSER_MODES, composeTurn, type ComposerMode } from '@/lib/composerMode';
import type { CbsContext } from '@/lib/cbs';
import type { ComponentContext } from '@/lib/componentCalls';
import { toggleDirectionMarkup } from '@/lib/directionMarkup';
import { awaitingEmotion, emotionResolver, emotionSlots, withEmotions } from '@/lib/emotion';
import { streamsNarration } from '@/lib/narrator';
import {
  displayContextAt,
  readCustomUiEnabled,
  sameVariables,
  writeCustomUiEnabled,
  type DisplayContext,
} from '@/lib/displayScripts';
import { greetingText, isGreeting, opensOnFirstGreeting } from '@/lib/greeting';
import {
  cueOf,
  isGroupWork,
  openRound,
  pickSpeakers,
  redoOf,
  roundRequest,
  roundStart,
  stepRound,
  type Round,
  type RoundCue,
  type RoundRequest,
} from '@/lib/groupRound';
import { reconcileSend } from '@/lib/reconcile';
import { sanitizeCustomHtml } from '@/lib/sanitizeHtml';
import { streamGeneration } from '@/lib/sse';
import { loadWholeBranch } from '@/lib/scripts/branch';
import { readEmbeddingModel } from '@/lib/scripts/embeddingModels';
import { createLuaEngine, luaFunctionNames, luaScriptsOf } from '@/lib/scripts/lua/engine';
import { createLuaSandbox, type LuaRequestAnswer } from '@/lib/scripts/lua/sandbox';
import { readerLuaSandbox } from '@/lib/scripts/lua/readerSandbox';
import { useSession } from '@/lib/authClient';
import { groupDisplayEdits, prepareGroupSend, runtimeOf, type ScriptCast } from '@/lib/scripts/group';
import {
  activeLore,
  createScriptRuntime,
  sharedScripts,
  type CommandOutcome,
  type PreparedGeneration,
  type PrepareOptions,
  type ScriptBundle,
  type ScriptRuntime,
  type ScriptTurn,
  type ScriptUi,
  type ScriptView,
} from '@/lib/scripts/runtime';
import { DEFAULT_CONTEXT_BUDGET } from '@/lib/loreBudget';
import { readStatusCollapsed, writeStatusCollapsed } from '@/lib/statusCard';
import { useChatTranslator } from '@/lib/translation';
import {
  isTranslationLanguage,
  recommendsTranslateMode,
  resolveTranslation,
  translatesMessage,
  type ChatTranslationSettings,
} from '@shizue/core/translation';
import type { AuthorNoteSettings, DisplaySide, EmotionProcessor } from '@shizue/core';
import { presetDefaultVariables } from '@shizue/core/reader-preset';
import type {
  ChatAttachment,
  ChatMemorySettings,
  ChatMessage,
  ChatModulesView,
  ChatState,
  DisplayScript,
  MessageRole,
  MessageSource,
  ModelInfo,
  NarratorConfig,
  Persona,
  PresetInfo,
  ReaderPreset,
  PublicMember,
  PublicPlotDetail,
  StreamMode,
  SuggestionsResult,
  UserNote,
} from '@/lib/types';
import { useCardOverlays } from '@/lib/useCardOverlays';
import { useBackgroundMusic } from '@/lib/useBackgroundMusic';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { ApiError } from '@/lib/api';
import { useErrorMessage } from '@/lib/useErrorMessage';
import { useSmoothStream } from '@/lib/useSmoothStream';

/** What a send may carry besides its text: who wrote it, and how it was judged. */
interface SendOptions {
  source?: MessageSource;
  directions?: string;
  /** Uploads to bind to the turn; the server checks they are this chat's own. */
  attachmentIds?: string[];
}

/**
 * A turn taken once the one in hand has fully ended: the reply a card's script
 * asked for (`next`, RisuAI's `sendAIprompt`), what a `/multisend` left
 * (`ScriptTurn`), or the reader's own line, sent as text because the slash
 * commands in it answered `false` (`own`).
 */
type QueuedTurn = { kind: 'next' } | ScriptTurn | { kind: 'own'; content: string; options?: SendOptions };

/**
 * How often to ask whether a reply the server is finishing on its own is done —
 * one whose stream dropped, or one a page that has since gone asked for (§7.2).
 */
const SERVER_POLL_MS = 2_000;
/**
 * How long a turn whose stream dropped holds the composer waiting for that reply.
 * Past it the turn lets go and the page goes on waiting quietly (`chat.generating`).
 */
const SERVER_WAIT_MS = 10 * 60_000;

/**
 * How close to the top of the list the reader has to come before the window
 * before this one is fetched. Far enough that on an ordinary flick the older
 * messages are already in place by the time the top is reached.
 */
const LOAD_EARLIER_PX = 400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a finished reply's emotion picture is waited for. The server chooses
 * it after the turn (its auxiliary model has 20 seconds), so the page asks about
 * that one reply on a short beat and gives up a little after the server would.
 */
const EMOTION_POLL_TRIES = 15;
const EMOTION_POLL_MS = 1500;

/**
 * Replies a card's scripts may ask for in a row (`sendAIprompt`) before the
 * reader has to act again. RisuAI sets no limit; a card that asks every time
 * would spend the reader's model turns without end.
 */
const MAX_SCRIPT_FOLLOW_UPS = 3;

/**
 * One request of a round, in a work of several members (`lib/groupRound`): who it
 * asks and where the reply goes — or, on a send, how to pick the round once the
 * turn's text is known, which is after the input scripts rewrote it.
 */
interface GroupStep {
  request?: RoundRequest;
  pick?: (text: string) => RoundRequest | null;
  /**
   * The branch as the round left it. The request after a reply runs before the
   * page has rendered that reply, so this render's `state` does not have it yet.
   */
  base: ChatState | null;
}

/** What became of one generation, for a round to go on from. */
interface RunOutcome {
  /** `done`: a reply landed. `failed`: it may be asked again. `over`: nothing more comes of it. */
  kind: 'done' | 'failed' | 'over';
  /** The round the reply was stored in, where it was a group reply. */
  groupTurnId: string | null;
  /** The card's output scripts asked for another reply (`sendAIprompt`). */
  followUp: boolean;
  /** The branch as it now stands, its reply finished; null when it could not be read. */
  state: ChatState | null;
}

/**
 * The member whose start triggers a generation runs, in a work of several: the
 * one its round asks, the head's for a continue (the server goes on as that
 * speaker), and none — the lead's scripts — for a narration, a carry-on of the
 * scene, or a send no round was picked for.
 */
function speakerOf(mode: StreamMode, step: GroupStep | undefined, current: ChatState): string | null {
  if (step?.request) return step.request.speakerId;
  const head = current.path.at(-1);
  return mode === 'continue' && head?.role === 'assistant' ? (head.speakerMemberId ?? null) : null;
}

/** How a round in a work of several members begins (`playRound`). */
type RoundStart =
  | { opening: 'send'; content: string; options?: SendOptions; prepareOptions?: PrepareOptions }
  | { opening: 'regenerate' }
  /** A round of its own after the head: 이어가기 rolls one, 지금 말하기 names its speaker. */
  | { opening: 'reply'; speakers?: string[] };

/**
 * Whether a generation left anything behind. Continue appends to the head in
 * place and leaves its id alone, so there what the head says is the question.
 * Every other mode ends in a fresh assistant row — and the head moving is not
 * enough to prove one landed, because a send moves it to the persisted user
 * turn before the reply exists. Only an assistant tail the branch did not have
 * before settles it.
 */
function generationLanded(
  mode: StreamMode,
  before: { id: string | null; content: string },
  next: ChatState,
): boolean {
  const tail = next.path[next.path.length - 1];
  if (mode === 'continue') return (tail?.content ?? '') !== before.content;
  return tail !== undefined && tail.role === 'assistant' && tail.id !== before.id;
}

/**
 * Holds on to the previous map while the new one says the same thing. A fold
 * produces a fresh object every time it runs, and every streamed token runs it;
 * without this the identity change alone would invalidate every memoized message
 * body in the chat, sixty times a second.
 */
function useStableVariables(next: Variables): Variables {
  const held = useRef(next);
  if (!sameVariables(held.current, next)) held.current = next;
  return held.current;
}

interface ViewMessage {
  key: string;
  /** null for the optimistic user bubble and the streaming reply. */
  id: string | null;
  role: MessageRole;
  content: string;
  /**
   * A greeting with its conditions decided (`lib/greeting`), or the text
   * SillyTavern showed in the message's place, where that differs from what is stored.
   */
  shown?: string;
  /** What SillyTavern kept beside a message it brought in: the reasoning, and the reader's bias. */
  reasoning?: string;
  bias?: string;
  /** Images sent with the turn — already uploaded ones on the optimistic bubble. */
  attachments: ChatAttachment[];
  /** null for the same two: nothing is stored, so nothing has a time yet. */
  createdAt: string | null;
  streaming: boolean;
  /**
   * The member whose lines are the ones naming no one: a group reply's speaker
   * (`speakerMemberId`), whose whole message it is, or `scriptSpeaker` on a
   * character message a card's script wrote (`source` `script`).
   */
  speaker?: string;
  /**
   * In a work of several members, whose message it is for its custom UI: the
   * speaker, else the work's first member.
   */
  member?: string;
  /**
   * Whether `member` spoke it: then its buttons run that member's scripts, and
   * otherwise the lead's (`runtimeOf`).
   */
  spoken?: boolean;
  /** The chat's opening, whose `#` lines are scene titles. */
  intro?: boolean;
  /** The model a stored reply was written with, by name — the chat's where the reply names none. */
  model?: string;
  /** Hidden from the AI: drawn dimmed, and numbered no depth for the display scripts. */
  hidden?: boolean;
}

/** Nothing attached, shared so a row without images keeps a stable prop. */
const NO_ATTACHMENTS: ChatAttachment[] = [];

/** Held until the plot read lands, so a row's roster prop never changes for nothing. */
const NO_MEMBERS: readonly PublicMember[] = [];

/** A work whose scripts name no manual trigger: its `{{button}}`s fill the composer. */
const NO_TRIGGERS: ReadonlySet<string> = new Set();

/** One runtime per scripted member, the lead's among them, given back together. */
interface ScriptRuntimes {
  byMember: ReadonlyMap<string, ScriptRuntime>;
  lead: ScriptRuntime;
  dispose(): void;
}

/** The background's key among the messages the card's display scripts draw — an id no message has. */
const BACKGROUND_ITEM = 'background';

/** How long a manual run's `risu-id` stays readable after it, as RisuAI keeps `{{trigger_id}}`. */
const TRIGGER_ID_MS = 100;

/** A work none of whose members carries an `edittrans` script. */
const NO_TRANSLATION_SCRIPTS: ReadonlyMap<string, TranslationScript[]> = new Map();

/** A fold's values as one number, the same for the same values in whatever order they were set. */
function foldKey(values: Variables | undefined): number {
  if (!values) return 0;
  return fnv1a(
    Object.keys(values)
      .sort()
      .map((key) => `${key}\u0000${values[key]}`)
      .join('\u0001'),
  );
}

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const localeNames = useTranslations('locales');
  const format = useFormatter();
  const toMessage = useErrorMessage();

  const [state, setState] = useState<ChatState | null>(null);
  /**
   * Where the variable fold starts. Every read of the head window replaces it,
   * and paging older messages in leaves it alone — those messages are already in
   * the fold the server sent with it.
   */
  const [anchor, setAnchor] = useState<VariableAnchor | null>(null);
  const [plot, setPlot] = useState<PublicPlotDetail | null>(null);
  /** The plot's read has come back, either way. */
  const [plotRead, setPlotRead] = useState(false);
  const [assets, setAssets] = useState<PlotAsset[]>([]);
  /**
   * The reader's own modules on this chat and their library (`GET /:id/modules`):
   * null until read. Read again whenever the reader changes which are on.
   */
  const [chatModules, setChatModules] = useState<ChatModulesView | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [readerPresets, setReaderPresets] = useState<ReaderPreset[]>([]);
  const [notes, setNotes] = useState<UserNote[]>([]);
  const [missing, setMissing] = useState(false);

  /**
   * The cards' scripts (`lib/scripts`), one bundle per member that carries any,
   * in roster order: undefined while the read is out, null for a plot that
   * carries none. Read once per chat — what they rewrite of the work afterwards,
   * the runtimes keep track of themselves. The first is the lead's
   * (`scriptBundle`), the scripted member a work of one has.
   */
  const [scriptBundles, setScriptBundles] = useState<readonly ScriptBundle[] | null | undefined>(undefined);
  /**
   * Each member's `edittrans` scripts, which its messages' translations run
   * through before they are shown (RisuAI's `applyEdittransRegex`), by member id.
   */
  const [translationScripts, setTranslationScripts] = useState<ReadonlyMap<string, TranslationScript[]>>(NO_TRANSLATION_SCRIPTS);
  /**
   * Bumped when the reader turns a module of theirs on or off here: the bundles
   * carry the modules' triggers, regex and lore, so they are read again.
   */
  const [scriptsVersion, setScriptsVersion] = useState(0);
  const reloadScripts = useCallback(() => setScriptsVersion((version) => version + 1), []);
  useEffect(() => {
    /**
     * Set once a later read has taken this one's place — another chat, the bundles
     * read again, React's development double run. Its answer is dropped: new
     * bundles build the runtimes anew, and the set they replace lets go of the Lua
     * calls it had started (`readerLuaSandbox`).
     */
    let superseded = false;
    setScriptBundles(undefined);
    setTranslationScripts(NO_TRANSLATION_SCRIPTS);
    apiGet<{
      scripts: ScriptBundle | null;
      members?: ScriptBundle[];
      translation?: { memberId: string; scripts: TranslationScript[] }[];
    }>(`/api/chats/${id}/scripts`).then(
      (answer) => {
        if (superseded) return;
        setScriptBundles(answer?.members?.length ? answer.members : answer?.scripts ? [answer.scripts] : null);
        if (answer?.translation?.length) {
          setTranslationScripts(new Map(answer.translation.map(({ memberId, scripts }) => [memberId, scripts])));
        }
      },
      // A plot that cannot be read runs nothing, and a pending reply is kept as written.
      () => {
        if (!superseded) setScriptBundles(null);
      },
    );
    return () => {
      superseded = true;
    };
  }, [id, scriptsVersion]);
  const scriptBundle = scriptBundles === undefined ? undefined : (scriptBundles?.[0] ?? null);
  /**
   * What the cards' scripts rewrote of their members for this reader on the plot —
   * in this chat or another of theirs (`MemberOverlay`), by member id:
   * the bundles' on load, then the runtimes' each time the server took a run's
   * rewrite. The screen draws a member's name from it, and the first greeting and
   * the background from the lead's, as RisuAI draws them from its character.
   */
  const [scriptOverlays, setScriptOverlays] = useState<Readonly<Record<string, MemberOverlay>>>({});
  useEffect(
    () =>
      setScriptOverlays(
        Object.fromEntries((scriptBundles ?? []).flatMap((bundle) => (bundle.overlay.member ? [[bundle.memberId, bundle.overlay.member]] : []))),
      ),
    [scriptBundles],
  );
  /** The lead's: the scripted member a work of one has. */
  const scriptOverlay = scriptBundle ? (scriptOverlays[scriptBundle.memberId] ?? null) : null;

  const [input, setInput] = useState('');
  /** How the composer's text is meant: a line, a description, or the narrator's. */
  const [composerMode, setComposerMode] = useState<ComposerMode>('dialogue');
  /** The member the reader writes the turn as (Zeta's `@이름:`); null is their own voice. */
  const [writeAs, setWriteAs] = useState<string | null>(null);
  /**
   * Who speaks in the next round of a work of several members (다음 차례), exactly
   * and in roster order. One round's worth: cleared once its first reply lands.
   */
  const [focus, setFocus] = useState<string[]>([]);
  const [mode, setMode] = useState<StreamMode | null>(null);
  /**
   * The round in hand in a work of several members (`lib/groupRound`): who is
   * still to speak, and — once a request failed — what the retry asks again.
   * Null in a work of one, and between rounds.
   */
  const [round, setRound] = useState<Round | null>(null);
  /** The reader stopped the round: the speakers still queued are not asked. */
  const roundStopped = useRef(false);
  /** How many replies at the branch's end the running regenerate replaces, which the screen hides. */
  const [replacing, setReplacing] = useState(0);
  /**
   * The mode whose optimistic row is still on screen after its stream failed.
   * Nothing of that reply was stored, so what arrived exists only here.
   */
  const [held, setHeld] = useState<StreamMode | null>(null);
  /** A turn whose stream dropped is waiting for the server to finish its reply (`awaitServerReply`). */
  const [waitingOnServer, setWaitingOnServer] = useState(false);
  // Tokens arrive in whatever rhythm the model has; this is what turns that into
  // a steady line of prose, and it is the only thing that renders per frame.
  const { visibleText: streamText, append, finish, reset } = useSmoothStream();
  const [pendingUser, setPendingUser] = useState('');
  /** Three things the reader could say next, asked for and dismissed by them. */
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  /** Why the last ask came back empty-handed; said quietly, beside the chips. */
  const [suggestError, setSuggestError] = useState('');
  const [error, setError] = useState('');
  /** The reader's turn is being translated into the work's language before it is sent. */
  const [translatingInput, setTranslatingInput] = useState(false);
  const [retryable, setRetryable] = useState(false);
  /** The send may or may not have landed — the reconcile refetch failed. */
  const [ambiguous, setAmbiguous] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [mutating, setMutating] = useState(false);
  const mutationRef = useRef(false);
  const [panelOpen, setPanelOpen] = useState(false);
  /** The settings sheet, which is where the header's controls go below `lg`. */
  const [sheetOpen, setSheetOpen] = useState(false);
  /** Message the scene editor was opened on; its whole scene is what it edits. */
  const [sceneEdit, setSceneEdit] = useState<string | null>(null);
  /** A scene is being drawn. One round trip, so there is nothing to stream. */
  const [drawing, setDrawing] = useState(false);
  /** The last draw came back empty-handed, and its row is still offering a retry. */
  const [drawFailed, setDrawFailed] = useState(false);
  /** Per-browser viewer protection; read after mount so SSR and client agree. */
  const [customUi, setCustomUi] = useState(true);
  useEffect(() => setCustomUi(readCustomUiEnabled()), []);
  /** Whether this chat's status cards are folded; the same answer for all of them. */
  const [statusCollapsed, setStatusCollapsed] = useState(false);
  useEffect(() => setStatusCollapsed(readStatusCollapsed(id)), [id]);
  const toggleStatus = useCallback(() => {
    const next = !statusCollapsed;
    setStatusCollapsed(next);
    writeStatusCollapsed(id, next);
  }, [id, statusCollapsed]);

  const abortRef = useRef<AbortController | null>(null);
  /**
   * The stop the reader asked the server for, which the turn's ending waits on:
   * closing the stream no longer stops a reply (§7.2), and the server answers it
   * once the stopped reply is stored. An earlier turn's is long settled, so
   * waiting on it costs nothing.
   */
  const stopping = useRef<Promise<void> | null>(null);
  // The message list scrolls, not the document: the reader's own scroll is what
  // decides whether new text follows them down, and the library gives that up the
  // moment they move away from the bottom.
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    initial: 'instant',
  });
  /** A component turn that was accepted and has not finished yet. */
  const componentTurnRef = useRef(false);

  /** Older messages on their way in, which the list says a word about. */
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** One page-back at a time: the scroll fires far more often than it finishes. */
  const loadingEarlierRef = useRef(false);
  /** A cursor whose window could not be read, so it is not asked for again. */
  const failedCursor = useRef<string | null>(null);
  /** The list's height just before something went in above the reader. */
  const heightBeforeGrowth = useRef<number | null>(null);

  // Everything that arrives at the top arrives above the reader, so the scroll
  // has to move down by exactly as much as the content grew — otherwise the line
  // they were reading slides off the bottom of the screen. It runs for the row
  // that says older messages are coming as well as for the messages themselves:
  // both go in above, and a jump is a jump whichever put it there. Before paint,
  // in the commit that did it.
  useLayoutEffect(() => {
    const before = heightBeforeGrowth.current;
    if (before === null) return;
    heightBeforeGrowth.current = null;
    const list = scrollRef.current;
    if (!list) return;
    list.scrollTop += list.scrollHeight - before;
  }, [state, loadingEarlier, scrollRef]);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Where the caret belongs once React has written the text the button produced. */
  const composerSelection = useRef<[number, number] | null>(null);

  /** Images picked for the turn being written, each on its way to the server. */
  const [chips, setChips] = useState<AttachmentChip[]>([]);
  /** Why the last pick was not taken whole — a cap, or a file that was too big. */
  const [attachError, setAttachError] = useState('');
  /** A file is over the window; the overlay says so and the drop takes it. */
  const [dropping, setDropping] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  /**
   * Chips taken out while their upload was still in flight. The request cannot
   * be recalled, so what lands is deleted instead — a removed thumbnail must not
   * leave the reader's picture on the server.
   */
  const abandoned = useRef(new Set<string>());
  /** Already stored, so the optimistic bubble can draw them while the reply streams. */
  const pendingAttachments = useMemo(
    () => chips.flatMap((chip) => (chip.attachment ? [chip.attachment] : [])),
    [chips],
  );

  /** Wraps the composer's selection in the `*지문*` marks, or unwraps it. */
  const toggleDirection = useCallback((): void => {
    const field = composerRef.current;
    if (!field) return;
    const next = toggleDirectionMarkup(field.value, field.selectionStart, field.selectionEnd);
    composerSelection.current = [next.selStart, next.selEnd];
    setInput(next.value);
  }, []);

  // Moving the caret has to wait for the commit: setting it before React writes
  // the value would only have it overwritten.
  useLayoutEffect(() => {
    const range = composerSelection.current;
    if (!range) return;
    composerSelection.current = null;
    composerRef.current?.focus();
    composerRef.current?.setSelectionRange(range[0], range[1]);
  }, [input]);

  // The composer is as tall as what is written in it, up to `max-h-48`. Height
  // only: nothing here touches the value, so a composition in progress is left
  // exactly as it is and the field simply grows under it.
  useLayoutEffect(() => {
    const field = composerRef.current;
    if (field) autoGrow(field);
  }, [input]);

  /**
   * Sends one picked file. Measured first, in the browser, so the size and the
   * blurred placeholder ride along with the bytes and the bubble can reserve the
   * image's box before it has loaded — the same trip a character asset makes.
   */
  const uploadChip = useCallback(
    async (chip: AttachmentChip): Promise<void> => {
      /** Never told to the reader: the chip it belongs to is already gone. */
      const discard = (attachmentId: string): void => {
        abandoned.current.delete(chip.key);
        void apiDelete(`/api/chats/${id}/attachments/${attachmentId}`).catch(() => undefined);
      };
      try {
        const measured = await measureImage(chip.file);
        const attachment = await apiUpload<ChatAttachment>(
          `/api/chats/${id}/attachments`,
          chip.file,
          measured
            ? {
                width: String(measured.width),
                height: String(measured.height),
                thumbhash: measured.thumbhash,
              }
            : {},
        );
        if (abandoned.current.has(chip.key)) discard(attachment.id);
        else setChips((current) => markUploaded(current, chip.key, attachment));
      } catch {
        // The chip stays, with the retry on it: the file is still in hand, and
        // the reader decides whether to try again or drop it.
        abandoned.current.delete(chip.key);
        setChips((current) => markFailed(current, chip.key));
      }
    },
    [id],
  );

  /** Files from the button, a paste or a drop — one door for all three. */
  const addFiles = useCallback(
    (files: File[]): void => {
      if (files.length === 0 || mode) return;
      const { chips: next, refusal } = acceptFiles(chips, files, () => crypto.randomUUID());
      setAttachError(refusal ? t(refusal.key, { max: refusal.max }) : '');
      setChips(next);
      for (const chip of next.slice(chips.length)) void uploadChip(chip);
    },
    [chips, mode, t, uploadChip],
  );

  /** Taking one back out. A stored upload is deleted rather than left behind. */
  const dropChip = useCallback(
    (key: string): void => {
      const chip = chips.find((entry) => entry.key === key);
      if (!chip) return;
      setChips(removeChip(chips, key));
      URL.revokeObjectURL(chip.preview);
      if (chip.status === 'uploading') abandoned.current.add(key);
      if (chip.attachment) {
        // Nothing to tell the reader if this fails: the chip is already gone, and
        // an unclaimed upload is deleted with the chat in any case.
        void apiDelete(`/api/chats/${id}/attachments/${chip.attachment.id}`).catch(() => undefined);
      }
    },
    [chips, id],
  );

  const retryChip = useCallback(
    (key: string): void => {
      const chip = chips.find((entry) => entry.key === key);
      if (!chip) return;
      setChips(markRetrying(chips, key));
      void uploadChip(chip);
    },
    [chips, uploadChip],
  );

  /** Sent, so the strip is empty again and the object URLs are given back. */
  const clearChips = useCallback((): void => {
    setChips((current) => {
      for (const chip of current) URL.revokeObjectURL(chip.preview);
      return [];
    });
    setAttachError('');
  }, []);

  /**
   * A file dragged anywhere over the window, not only onto the composer: the drop
   * target is the whole page, so the overlay is what says where it will land.
   * `dragenter`/`dragleave` are counted rather than paired — they fire for every
   * element the pointer crosses — so the overlay only closes when the drag has
   * really left the window.
   */
  useEffect(() => {
    let depth = 0;
    const carriesFiles = (event: DragEvent): boolean =>
      event.dataTransfer?.types.includes('Files') ?? false;

    function onDragEnter(event: DragEvent): void {
      if (!carriesFiles(event)) return;
      depth += 1;
      setDropping(true);
    }
    function onDragOver(event: DragEvent): void {
      // Without this the browser navigates to the file instead of dropping it.
      if (carriesFiles(event)) event.preventDefault();
    }
    function onDragLeave(event: DragEvent): void {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDropping(false);
    }
    function onDrop(event: DragEvent): void {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDropping(false);
      addFiles([...(event.dataTransfer?.files ?? [])]);
    }

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [addFiles]);

  /** Refetches without touching the error state, so callers decide what it means. */
  const refetch = useCallback(async (): Promise<{ state: ChatState | null; error: string }> => {
    try {
      return { state: await apiGet<ChatState>(`/api/chats/${id}`), error: '' };
    } catch (caught) {
      return { state: null, error: toMessage(caught) };
    }
  }, [id, toMessage]);

  /** A whole state from the server, and the anchor its first message establishes. */
  const applyState = useCallback((next: ChatState): void => {
    setAnchor(headAnchor(next));
    setState(next);
  }, []);

  /** The same, folded onto whatever the reader has already paged in. */
  const mergeState = useCallback((next: ChatState): void => {
    setAnchor(headAnchor(next));
    setState((current) => mergeRefetched(current, next));
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const { state: next, error: message } = await refetch();
    if (next) mergeState(next);
    else setError(message);
  }, [refetch, mergeState]);

  /**
   * The window before the one on screen. The cursor is the first message the
   * reader has, which is exactly what the API pages backwards from; a window
   * that cannot be read is left alone rather than announced — the reader is in
   * the middle of the conversation, not looking for it — and its cursor is not
   * asked for a second time, so a stale branch cannot be retried on every pixel
   * of scroll.
   */
  const loadEarlier = useCallback(async (): Promise<void> => {
    const cursor = state?.path[0]?.id;
    if (!state?.hasMore || !cursor) return;
    if (loadingEarlierRef.current || failedCursor.current === cursor) return;
    loadingEarlierRef.current = true;
    heightBeforeGrowth.current = scrollRef.current?.scrollHeight ?? null;
    setLoadingEarlier(true);
    try {
      const older = await apiGet<ChatState>(`/api/chats/${id}?before=${cursor}`);
      setState((current) => (current ? prependWindow(current, older) : older));
    } catch {
      failedCursor.current = cursor;
    } finally {
      // Both updates land in one commit, and this is the height they change
      // from: the row that said it was loading goes, and — where the window was
      // read — the older messages take its place.
      heightBeforeGrowth.current = scrollRef.current?.scrollHeight ?? null;
      loadingEarlierRef.current = false;
      setLoadingEarlier(false);
    }
  }, [id, state, scrollRef]);

  useEffect(() => {
    apiGet<ChatState>(`/api/chats/${id}`).then(applyState, () => setMissing(true));
    apiGet<ModelInfo[]>('/api/models').then(setModels, () => undefined);
    apiGet<PresetInfo[]>('/api/presets').then(setPresets, () => undefined);
    apiGet<Persona[]>('/api/personas').then(setPersonas, () => undefined);
    apiGet<ReaderPreset[]>('/api/reader-presets').then(setReaderPresets, () => undefined);
    apiGet<UserNote[]>('/api/notes').then(setNotes, () => undefined);
  }, [id]);
  /** Reads the chat's modules again — on load, and after the reader changes which are on. */
  const loadChatModules = useCallback(
    () => apiGet<ChatModulesView>(`/api/chats/${id}/modules`).then(setChatModules, () => undefined),
    [id],
  );
  useEffect(() => {
    void loadChatModules();
  }, [loadChatModules]);
  /**
   * The reader's presets after one was made, changed or deleted: the chat's own
   * may have brought other toggles or, by its module integration, other modules.
   */
  const changeReaderPresets = useCallback(
    (next: ReaderPreset[]) => {
      setReaderPresets(next);
      void loadChatModules();
      reloadScripts();
    },
    [loadChatModules, reloadScripts],
  );
  /** The library modules on this chat, in the order they run after the work's own. */
  const readerModules = useMemo(() => chatModules?.active ?? [], [chatModules]);
  /**
   * Their pictures, as assets after the work's — RisuAI's `getModuleAssets` after
   * the character's, so a name the work has is the work's. Never locked, and never
   * in the work's gallery or `{{assetlist}}`.
   */
  const readerAssets = useMemo<PlotAsset[]>(
    () =>
      readerModules.flatMap((module) =>
        module.assets.map((asset) => ({
          slug: `m-${asset.id}`,
          name: asset.name,
          url: asset.url,
          mime: asset.mime,
          width: null,
          height: null,
          thumbhash: null,
          createdAt: '',
        })),
      ),
    [readerModules],
  );

  const plotId = state?.chat.plotId ?? null;
  useEffect(() => {
    if (!plotId) return;
    apiGet<PublicPlotDetail>(`/api/plots/${plotId}/public`)
      .then(setPlot, () => undefined)
      .finally(() => setPlotRead(true));
    // Images the messages may reference. Readable by anyone who may read the
    // plot, so this works for someone else's public plot too.
    apiGet<PlotAsset[]>(`/api/plots/${plotId}/assets`).then(setAssets, () => undefined);
  }, [plotId]);

  /** What this chat may show of the plot's images; empty until the read lands. */
  const locks = state?.assetLocks;
  /** The ones it may not, with the kind of condition each is waiting on. */
  const lockedKinds = useMemo(
    () =>
      new Map(
        (locks ?? [])
          .filter((lock) => lock.locked && lock.kind !== null)
          .map((lock) => [lock.slug, lock.kind!]),
      ),
    [locks],
  );

  // assetSrc carries the measured size and placeholder in the URL fragment, so
  // the chat's images can reserve their boxes; every other consumer of the map
  // still sees a plain usable URL.
  //
  // A locked slug is simply not in it: a display script or a component naming
  // one gets what an unknown slug gets, which is nothing.
  const assetUrls = useMemo(
    () =>
      new Map(
        [...assets, ...readerAssets]
          .filter((asset) => !lockedKinds.has(asset.slug))
          .map((asset) => [asset.slug, assetSrc(asset)]),
      ),
    [assets, readerAssets, lockedKinds],
  );

  /**
   * The same map for the message bodies, where a locked reference is worth more
   * than nothing: it resolves to the marker `MessageBody` draws the locked card
   * from, so the reader can see there is something to reach for.
   */
  const messageAssets = useMemo(() => {
    if (lockedKinds.size === 0) return assetUrls;
    const map = new Map(assetUrls);
    for (const [slug, kind] of lockedKinds) map.set(slug, lockedSrc(kind));
    return map;
  }, [assetUrls, lockedKinds]);

  /**
   * What a reference names, for both maps: a slug, or the name an imported card
   * wrote it under (`{{img::profile.png}}`), which no slug can stand in for.
   */
  const resolveAsset = useMemo(() => assetResolver([...assets, ...readerAssets]), [assets, readerAssets]);
  /** The same names as data, for the display worker to build the resolver again (`CbsContext.namedAssets`). */
  const namedAssets = useMemo(
    () => [...assets, ...readerAssets].map((asset) => ({ slug: asset.slug, name: asset.name })),
    [assets, readerAssets],
  );

  /** The gallery's rows: every image of the work, open or not. */
  const gallery = useMemo(() => illustrations(assets, locks ?? []), [assets, locks]);

  const messages = state?.path ?? [];
  const last = messages[messages.length - 1];
  /** Which turn a row was drawn from, without a scan per row. */
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  /**
   * The mode the optimistic row belongs to: the one that is running, or — once a
   * stream failed with text already on screen — the one that was. `mode` alone
   * still says whether anything is live, and so whether the composer is locked.
   */
  const active = mode ?? held;

  // Display scripts and their seed variables are presentation, so the public
  // view of a plot carries them — otherwise a creator's status window would
  // only ever render for the creator.
  // The reader's own modules' after the work's, sorted with them by RisuAI's
  // `<order N>` (`orderedWithModules`), as RisuAI runs a character's regex and
  // every module's on the chat as one list.
  const scripts: DisplayScript[] = useMemo(
    () =>
      readerModules.length > 0
        ? orderedWithModules(plot?.displayScripts ?? [], readerModules.map((module) => module.displayScripts))
        : (plot?.displayScripts ?? []),
    [plot, readerModules],
  );
  const creatorCss = [plot?.css ?? '', ...readerModules.map((module) => module.css)].filter((css) => css.trim()).join('\n\n');
  /**
   * The plot's stylesheet, scoped and filtered exactly as a `<style>` in a
   * script's output is — but once for the whole chat, not once per message. It
   * styles nothing but the islands, so it goes when custom UI does.
   */
  const creatorSheet = useMemo(
    () => (customUi && creatorCss ? sanitizeCustomHtml(`<style>${creatorCss}</style>`) : ''),
    [customUi, creatorCss],
  );
  /**
   * What a variable nothing set reads: the work's defaults, then the chat's
   * reader preset's (RisuAI's `templateDefaultVariables`) — what the server folds
   * the branch over too (`chatDefaultVariables`).
   */
  const presetVariables = readerPresets.find((preset) => preset.id === state?.chat.readerPresetId)?.defaultVariables;
  const defaultVariables = useMemo(
    () => presetDefaultVariables(plot?.defaultVariables, presetVariables) ?? {},
    [plot, presetVariables],
  );
  const componentCode = plot?.componentCode ?? '';
  /** Only these tags are call codes, so a plot without components never mounts a frame. */
  const declaredComponents = useMemo(() => componentNames(componentCode), [componentCode]);
  /**
   * Gate one of three: a capability the plot never declared is not granted, and
   * the frame is not even given a handler for it.
   */
  const maySendTurn = (plot?.componentCapabilities ?? []).includes('sendTurn');

  // Only the loaded window is folded here, onto the state the server folded for
  // everything in front of it — the messages paged in above the window are
  // already counted in it (see `foldBase`).
  const fold = useMemo(
    () => foldBase(messages, anchor, defaultVariables),
    [messages, anchor, defaultVariables],
  );
  // `{{user}}` and `{{char}}` in a value fold to the names the server folds with
  // (`foldOptionsOf` in the API) — the persona's, else the default, and the
  // plot's — so a value built from them reads the same here and in the prompt.
  const foldPersonaName = personas.find((persona) => persona.id === state?.chat.personaId)?.name;
  const foldPlotName = plot?.name ?? state?.chat.title ?? '';
  const foldNames = useMemo<FoldOptions>(
    () => ({ user: foldPersonaName ?? DEFAULT_USER_NAME, char: foldPlotName }),
    [foldPersonaName, foldPlotName],
  );

  // The fold of the persisted branch, and of the branch without its head — the
  // two bases every mode builds on. Both depend only on server state, so a
  // streamed token never re-folds the history. The messages go in whole, not
  // their text: what the card's scripts left on each one is folded with it, as
  // the server folds it for the prompt.
  const persistedVariables = useMemo(
    () => computeVariables(fold.messages, fold.defaults, foldNames),
    [fold, foldNames],
  );
  // A regenerate replaces the head, or in a work of several members the round it
  // ends (`replacing`).
  const variablesBeforeHead = useMemo(
    () => computeVariables(fold.messages.slice(0, -Math.max(1, replacing)), fold.defaults, foldNames),
    [fold, foldNames, replacing],
  );

  // The branch as it currently reads. `computeVariables` folds onto whatever it
  // is given as defaults, so the streaming text is folded onto the right base
  // rather than replayed over the whole path: per token this is one small scan.
  // Regenerate is why there are two bases — its head is being replaced, and a
  // fold cannot be run backwards.
  const liveVariables = useMemo(() => {
    if (active === null) return persistedVariables;
    const base = active === 'regenerate' && replacing > 0 ? variablesBeforeHead : persistedVariables;
    const pending = mode === 'send' ? [pendingUser, streamText] : [streamText];
    return computeVariables(pending, base, foldNames);
  }, [active, mode, replacing, persistedVariables, variablesBeforeHead, pendingUser, streamText, foldNames]);

  // …and the same values keep the same object, so the memoized message bodies do
  // not re-run their regexes, their template and two DOMPurify passes for a token
  // that moved nothing.
  const variables = useStableVariables(liveVariables);

  /**
   * The plot's cast, which is what a reply's `이름:` lines are read against — a
   * scripted member under the name its scripts gave it for this reader
   * (`setName`), its lines under the old name still its own (`aliases`).
   */
  const scriptedId = scriptBundle?.memberId;
  const renamed = scriptOverlay?.name;
  const cast = plot?.characters ?? NO_MEMBERS;
  const members = useMemo(() => {
    const renamedTo = (member: PublicMember): string | undefined => {
      const name = scriptOverlays[member.id]?.name;
      return name !== undefined && name !== member.name ? name : undefined;
    };
    return cast.some((member) => renamedTo(member) !== undefined)
      ? cast.map((member) => {
          const name = renamedTo(member);
          return name === undefined ? member : { ...member, name, aliases: [member.name] };
        })
      : cast;
  }, [cast, scriptOverlays]);
  const absentIds = state?.chat.absentCharacterIds;
  /** Who is on the stage — the members a round's speakers are picked from. */
  const stage = useMemo(
    () => members.filter((member) => !(absentIds ?? []).includes(member.id)),
    [members, absentIds],
  );
  /**
   * A work of two or more members answers one reply per speaker, each its own
   * message, in rounds the page drives (`playRound`); a work of one answers as it
   * always has and never names a speaker.
   */
  const group = isGroupWork(members);
  /**
   * Who says a character message a card's script wrote (`source` `script`), which
   * names no speaker, stored as the script wrote it: the member whose scripts run,
   * under the name it goes by here — or a plot's one member, should its scripts be
   * gone. RisuAI draws such a message as that character's own.
   */
  const scriptSpeaker = useMemo(
    () => (members.find((member) => member.id === scriptedId) ?? (members.length === 1 ? members[0] : undefined))?.name,
    [members, scriptedId],
  );
  // A plot of one member is that character: renamed by its scripts, the chat is with
  // the new name, and `{{char}}` in the work's text is it too (the prompt's `PromptPlot.char`).
  const soleRenamed = renamed !== undefined && cast.length === 1 && cast[0]!.id === scriptedId ? cast[0]! : null;
  const characterName = soleRenamed ? renamed! : (plot?.name ?? state?.chat.title ?? '');
  /** `{{char}}` in the work's own text on screen: the plot's name, or the renamed character's, nickname first. */
  const charMacro = soleRenamed ? soleRenamed.nickname?.trim() || renamed! : characterName;
  // Who the conversation is with, once either read has said so.
  useDocumentTitle(characterName);
  // A card's `{{bgm::…}}`, wherever on the page its markup drew it.
  useBackgroundMusic();

  /**
   * The conversation's area, which a card's `fixed` overlay floats over and never
   * past (`.chat-stage`), and the way out of one while it is open: "close card
   * screen" in the header, or Esc (`useCardOverlays`).
   */
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const cardOverlays = useCardOverlays(stageElement, customUi);
  const closeCardOverlays = cardOverlays.close;
  useEffect(() => {
    if (!cardOverlays.open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A dialog or a sheet of ours that is open takes its own Esc.
      if ((event.target as Element | null)?.closest?.('[role="dialog"], dialog')) return;
      event.preventDefault();
      closeCardOverlays();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cardOverlays.open, closeCardOverlays]);

  /**
   * RisuAI's emotion screen: the picture each panel member shows on the branch
   * on screen (`emotionSlots`) — nothing at all for a work whose cards show none.
   */
  const emotionScreen = useMemo(() => emotionSlots(messages, members, assetUrls), [messages, members, assetUrls]);
  /** What `{{emotion::name}}` in a member's reply is drawn from: its own pictures first (`emotionResolver`). */
  const emotionResolvers = useMemo(
    () =>
      new Map(
        members.flatMap((member) =>
          member.emotion ? [[member.id, emotionResolver(member.emotion.images, resolveAsset)] as const] : [],
        ),
      ),
    [members, resolveAsset],
  );
  /**
   * Replies this page saw finish. Their pictures are chosen after the turn, so
   * the ones still without one are asked about until they have it.
   */
  const [freshReplies, setFreshReplies] = useState<ReadonlySet<string>>(() => new Set());
  const waitingEmotion = awaitingEmotion(messages, members, freshReplies).join(',');
  useEffect(() => {
    if (!waitingEmotion) return;
    const ids = waitingEmotion.split(',');
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < EMOTION_POLL_TRIES; attempt += 1) {
        await sleep(EMOTION_POLL_MS);
        if (cancelled) return;
        const answers = await Promise.all(
          ids.map((messageId) =>
            apiGet<{ emotion: string | null }>(`/api/chats/${id}/messages/${messageId}/emotion`).then(
              (answer) => answer.emotion,
              () => null,
            ),
          ),
        );
        if (cancelled) return;
        const chosen = new Map(ids.flatMap((messageId, index) => (answers[index] ? [[messageId, answers[index]!] as const] : [])));
        // The rest, if any, are asked about by the run this change starts.
        if (chosen.size > 0) {
          setState((current) => (current ? withEmotions(current, chosen) : current));
          return;
        }
      }
      // None came: a choice that failed is not waited for again.
      setFreshReplies((current) => new Set([...current].filter((messageId) => !ids.includes(messageId))));
    })();
    return () => {
      cancelled = true;
    };
  }, [waitingEmotion, id]);
  const chatPersona = personas.find((persona) => persona.id === state?.chat.personaId);
  const personaName = chatPersona?.name;
  /** The persona's picture, for RisuAI's `{{source::user}}` on screen. */
  const personaAvatarUrl = chatPersona?.avatarUrl ?? null;
  const youLabel = t('you');
  /** User turns taken on this branch, for `{{turn}}`. */
  const turn = messages.filter((message) => message.role === 'user').length + (mode === 'send' ? 1 : 0);
  const axes = state?.chat.relationship?.axes ?? null;

  /**
   * Where RisuAI would number the branch from. Its greeting sits outside the
   * message list at -1, so a branch that opens on one starts there; with earlier
   * messages not read yet, the loaded stretch is counted from 0, which keeps the
   * comparisons cards make between two indices right.
   */
  const indexBase = !state?.hasMore && messages[0] && isGreeting(messages[0]) ? -1 : 0;
  const lastMessageId = indexBase + messages.length - 1;
  /**
   * The names a card asks for its images by — its own where it had them — open
   * ones only, and none the import fetched from another host for its markup.
   */
  const assetNames = useMemo(
    () =>
      assets
        .filter((asset) => !lockedKinds.has(asset.slug) && !isLocalizedAsset(asset))
        .map((asset) => asset.name ?? asset.slug),
    [assets, lockedKinds],
  );
  /**
   * The work's modules for `{{moduleenabled}}` and `{{moduleassetlist}}`, naming
   * the open pictures only, as `assetNames` does. Unset until the plot is read.
   */
  const cbsModules = useMemo(() => {
    if (!plot) return undefined;
    const open = new Set(assetNames);
    return [
      ...(plot.modules ?? []).map((module) => ({
        namespace: module.namespace,
        assets: module.assets.filter((name) => open.has(name)),
      })),
      // The reader's own modules on the chat, with their pictures by their names.
      ...readerModules.flatMap((module) =>
        module.namespace ? [{ namespace: module.namespace, assets: module.assets.map((asset) => asset.name) }] : [],
      ),
    ];
  }, [plot, assetNames, readerModules]);
  /**
   * The loaded messages after the greeting, as RisuAI's chat functions read them
   * and numbered as `chatIndex` numbers them. Stored messages only: a reply still
   * streaming is not on the branch yet, and gets no display scripts anyway.
   */
  const branchMessages = useMemo(
    () =>
      messages.slice(indexBase === -1 ? 1 : 0).map(
        (message): CbsMessage => ({
          role: message.role === 'user' ? 'user' : 'char',
          data: message.content,
          time: Date.parse(message.createdAt),
        }),
      ),
    [messages, indexBase],
  );
  /** Nothing before the loaded stretch was left unread, so the chat functions may answer. */
  const wholeBranch = !state?.hasMore;
  const globalVariables = state?.globalVariables;
  const chatId = state?.chat.id ?? '';
  /**
   * What a redraw is, for the draws of `{{random}}` and its kin
   * (`CbsContext.drawKey`): the chat and its stored variables, chat and global,
   * by value. RisuAI draws them again when a script moves the variables and not
   * when a message merely arrives, so the stored fold is the key — not the live
   * one a streamed `{{setvar}}` moves before anything is committed.
   */
  const drawKey = useMemo(
    () => `${chatId}\u0000${foldKey(persistedVariables)}\u0000${foldKey(globalVariables)}`,
    [chatId, persistedVariables, globalVariables],
  );
  /**
   * The `risu-id` of the button whose manual run is under way or has just ended,
   * for a display pass's `{{trigger_id}}`. RisuAI sets it as the run starts and
   * clears it 100ms after (`TRIGGER_ID_MS`), so the redraw the run caused reads it
   * and the ones after it do not. Read when the display bindings are next made,
   * and no reason to make them: RisuAI's clearing redraws nothing either.
   */
  const shownTriggerId = useRef<string | null>(null);
  const locale = useLocale();
  /**
   * The chat's language mode (§11 언어 모드): decided by the work's language
   * against the one this page is read in until the reader picks. Nothing is
   * translated before the plot read says what language the work is in.
   */
  const languageMode =
    plot && isTranslationLanguage(plot.language)
      ? resolveTranslation(state?.chat.translation, plot.language, isTranslationLanguage(locale) ? locale : null)
      : null;
  const translator = useChatTranslator(
    chatId,
    languageMode && languageMode.mode !== 'off' ? languageMode.language : null,
  );
  /** Whether the work's scripts read the model's words, which recommends the translation mode. */
  const translateRecommended = useMemo(
    () =>
      recommendsTranslateMode({
        displayScripts: scripts,
        scripts: (scriptBundles ?? []).map(({ triggers, editScripts }) => ({ triggers, editScripts })),
      }),
    [scripts, scriptBundles],
  );

  /**
   * The manual triggers a `{{button}}` may name, which then runs one rather than
   * filling the composer — each scripted member's own, and the lead's.
   */
  const triggerNamesByMember = useMemo(
    () =>
      new Map(
        (scriptBundles ?? []).map((bundle) => [
          bundle.memberId,
          new Set([
            ...manualTriggerNames(bundle.triggers),
            // A manual run calls the Lua global of its name, so a button may name one.
            ...luaFunctionNames(luaScriptsOf(bundle.triggers)),
          ]),
        ]),
      ),
    [scriptBundles],
  );
  const triggerNames = scriptBundle ? triggerNamesByMember.get(scriptBundle.memberId) : undefined;
  /**
   * The work's first member, whose display scripts and stylesheet dress the
   * messages no member speaks — their scripts are the lead's (`lib/scripts/group`).
   */
  const firstMemberId = cast[0]?.id ?? null;

  /**
   * What the messages are drawn with: the display scripts and the bindings their
   * CBS reads. A work without scripts has one too, with none in it — RisuAI reads
   * every message it shows as CBS (`risuChatParser`), so a `{{getvar}}` the model
   * wrote is answered with or without a script to dress it.
   */
  const display = useMemo<DisplayContext | undefined>(() => {
    if (!customUi) return undefined;
    return {
      scripts,
      variables,
      assets: assetUrls,
      resolveAsset,
      namedAssets,
      relationship: axes,
      turn,
      char: charMacro,
      user: personaName ?? youLabel,
      ...(personaAvatarUrl ? { userImage: personaAvatarUrl } : {}),
      lastMessageId,
      assetNames,
      ...(cbsModules ? { modules: cbsModules } : {}),
      messages: branchMessages,
      wholeBranch,
      chatId,
      locale,
      drawKey,
      ...(shownTriggerId.current !== null ? { triggerId: shownTriggerId.current } : {}),
      ...(globalVariables ? { globalVariables } : {}),
      ...(triggerNames ? { triggerNames } : {}),
    };
  }, [
    customUi,
    scripts,
    variables,
    assetUrls,
    resolveAsset,
    namedAssets,
    axes,
    turn,
    charMacro,
    personaName,
    personaAvatarUrl,
    youLabel,
    lastMessageId,
    assetNames,
    cbsModules,
    branchMessages,
    wholeBranch,
    chatId,
    locale,
    drawKey,
    globalVariables,
    triggerNames,
  ]);

  /**
   * Each member's display scripts in a work of several (`displayScriptsFor`):
   * the untagged ones and its own. The same array for a member as long as the
   * plot's scripts are the same — the planner tells a fresh plan by it — and,
   * while no script is tagged, nobody's but the plot's own.
   */
  const scriptsByMember = useMemo(() => {
    const lists = new Map<string, DisplayScript[]>();
    if (!group || !scripts.some((script) => script.memberId !== undefined)) return lists;
    for (const member of cast) lists.set(member.id, displayScriptsFor(scripts, member.id));
    return lists;
  }, [group, scripts, cast]);
  /**
   * What a member's messages are drawn with, in a work of several: its display
   * scripts, and the buttons its own triggers answer — none for a member with no
   * scripts, the first no differently (`runtimeOf`). A member none of the plot's
   * scripts apply to has an empty list, so its messages' own CBS is still read.
   * The messages no member speaks (`sceneDisplay`)
   * take the first member's display scripts and the lead's buttons, as they run
   * the lead's scripts.
   */
  const { byMember: displayByMember, scene: sceneDisplay } = useMemo(() => {
    const byMember = new Map<string, DisplayContext>();
    let scene: DisplayContext | undefined;
    if (!display || !group) return { byMember, scene };
    const { triggerNames: _lead, ...rest } = display;
    const contextOf = (list: DisplayScript[], names: ReadonlySet<string> | undefined): DisplayContext =>
      list === scripts && names === triggerNames ? display : { ...rest, scripts: list, ...(names ? { triggerNames: names } : {}) };
    for (const member of cast) {
      const list = scriptsByMember.get(member.id) ?? scripts;
      const own = triggerNamesByMember.get(member.id);
      byMember.set(member.id, contextOf(list, own));
      if (member.id === firstMemberId) scene = contextOf(list, triggerNames);
    }
    return { byMember, scene };
  }, [display, group, cast, scripts, scriptsByMember, triggerNamesByMember, firstMemberId, triggerNames]);
  /**
   * The display context of a row: in a work of several, its speaker's, or the
   * scene's for a message no member speaks; else the plot's.
   */
  const displayOf = (row: Pick<ViewMessage, 'member' | 'spoken'>): DisplayContext | undefined =>
    row.member !== undefined && group ? (row.spoken ? displayByMember.get(row.member) : sceneDisplay) : display;
  /**
   * Which of SillyTavern's placements a row's display scripts keep to
   * (`DisplaySide`): a narration — the 나레이션 button's, or a turn the reader
   * wrote wholly as the narrator (`isNarrationTurn`) — is its narrator's
   * (`SLASH_COMMAND`). Read once per text, as the roster reads it.
   */
  const narrationTurns = useMemo(() => {
    const readers = members.map((member) => ({
      id: member.id,
      names: [member.name, ...(member.nickname?.trim() ? [member.nickname.trim()] : []), ...(member.aliases ?? [])],
    }));
    const seen = new Map<string, boolean>();
    return (content: string): boolean => {
      let narration = seen.get(content);
      if (narration === undefined) {
        narration = isNarrationTurn(content, readers);
        seen.set(content, narration);
      }
      return narration;
    };
  }, [members]);
  const sideOf = (row: Pick<ViewMessage, 'role' | 'content'>): DisplaySide =>
    (row.role === 'user' ? narrationTurns(row.content) : isNarration(row.content)) ? 'narration' : row.role;
  /**
   * The manual triggers a row's own `{{button}}`s run, as a template's do: in a
   * work of several, its speaker's, the lead's for a message no member speaks.
   * Custom UI, so none with it off — the macro then reads as written.
   */
  const buttonsOf = (row: Pick<ViewMessage, 'member' | 'spoken'>): ReadonlySet<string> | undefined =>
    customUi
      ? ((group && row.member !== undefined && row.spoken ? triggerNamesByMember.get(row.member) : triggerNames) ??
        NO_TRIGGERS)
      : undefined;
  /** The background is the work's, drawn with the first member's display scripts — the untagged ones in a work of one. */
  const backgroundScripts = (firstMemberId !== null && scriptsByMember.get(firstMemberId)) || scripts;
  /**
   * Each member's own stylesheet in a work of several (`PlotCustomUi.memberCss`),
   * scoped to the rows of that member's messages (`data-shizue-member`), and gone
   * with the rest of the custom UI.
   */
  const memberSheets = useMemo(
    () =>
      customUi && group
        ? Object.entries(plot?.memberCss ?? {}).flatMap(([memberId, css]) => {
            const sheet = css ? sanitizeCustomHtml(`<style>${css}</style>`, { member: memberId }) : '';
            return sheet ? [{ memberId, sheet }] : [];
          })
        : [],
    [customUi, group, plot],
  );

  /**
   * Whether the branch opens on the plot's first opening, where the first message
   * the scripts set stands in for the stored greeting (RisuAI's `fmIndex` -1).
   */
  const firstGreeting = useMemo(() => opensOnFirstGreeting(messages, state?.siblings ?? {}), [messages, state?.siblings]);
  const firstMessage = scriptOverlay?.firstMessage;
  /**
   * The greetings on the branch as the reader sees them — the prompt's pass over
   * the conditions a greeting kept, with the same variables (`lib/greeting`).
   * Keyed on the stored messages rather than the view, so a streamed token does
   * not re-evaluate the opening; only a variable that moved does.
   */
  const shownGreetings = useMemo(() => {
    const shown = new Map<string, string>();
    for (const message of messages) {
      if (!isGreeting(message)) continue;
      // On the first opening, the first message the scripts set stands in for the
      // stored one (`setCharacterFirstMessage`), as RisuAI draws its greeting from
      // the character there — evaluated the way the stored one was when the chat opened.
      const source = firstGreeting && firstMessage !== undefined ? firstMessage : message.content;
      const text = greetingText(source, message.id, {
        variables,
        char: charMacro,
        user: personaName ?? youLabel,
        seed: chatId,
        seedLength: lastMessageId + 1,
        drawKey,
      });
      if (text !== message.content) shown.set(message.id, text);
    }
    return shown;
  }, [messages, firstGreeting, firstMessage, variables, charMacro, personaName, youLabel, chatId, lastMessageId, drawKey]);

  /** Fills the composer; the reader still decides to send. */
  const suggestInput = useCallback((text: string) => setInput(text), []);

  /**
   * Stable identity over a handler that changes every render: the context below
   * is memoized on the platform state, and re-creating it on every keystroke
   * would re-init every mounted frame.
   */
  const sendTurnRef = useRef<(text: string, directions?: string) => void>(() => undefined);
  const sendTurn = useCallback((text: string, directions?: string) => {
    sendTurnRef.current(text, directions);
  }, []);

  const components = useMemo<ComponentContext | undefined>(() => {
    if (!customUi || !componentCode || declaredComponents.length === 0) return undefined;
    return {
      code: componentCode,
      names: declaredComponents,
      // The same bindings the templates get, as one prop: the model may re-state
      // every value in the call code (the Elyn way) or emit only `{{setvar}}`
      // deltas and read them back off `platform` (ours).
      platform: {
        variables,
        relationship: axes,
        turn,
        char: charMacro,
        user: personaName ?? youLabel,
        assets: Object.fromEntries(assetUrls),
      },
      onSuggestInput: suggestInput,
      ...(maySendTurn ? { onSendTurn: sendTurn } : {}),
    };
  }, [
    customUi,
    componentCode,
    declaredComponents,
    variables,
    axes,
    turn,
    charMacro,
    personaName,
    youLabel,
    assetUrls,
    suggestInput,
    maySendTurn,
    sendTurn,
  ]);

  /**
   * The HTML behind the conversation (`ChatBackground`): what the lead's scripts
   * set for this reader (`setBackgroundEmbedding`), else the work's own
   * (`PlotCustomUi.backgroundHtml`, or the card's past its stylesheet on a plot
   * from before it) — one for the whole work, as a RisuAI group has; a
   * companion's card background is drawn nowhere. It is custom UI, so it goes
   * when custom UI does, as the stylesheet does.
   */
  const backgroundHtml = customUi
    ? [scriptOverlay?.backgroundHtml ?? plot?.backgroundHtml ?? '', ...readerModules.map((module) => module.backgroundHtml)]
        .filter((html) => html.trim())
        .join('\n')
    : '';
  /** What its CBS reads: the screen's own, as a display script's template reads it. */
  const backgroundContext = useMemo<CbsContext | null>(
    () =>
      backgroundHtml
        ? {
            variables,
            assets: assetUrls,
            resolveAsset,
            namedAssets,
            relationship: axes,
            turn,
            char: charMacro,
            user: personaName ?? youLabel,
            ...(personaAvatarUrl ? { userImage: personaAvatarUrl } : {}),
            lastMessageId,
            assetNames,
            ...(cbsModules ? { modules: cbsModules } : {}),
            messages: branchMessages,
            wholeBranch,
            chatId,
            locale,
            drawKey,
            ...(shownTriggerId.current !== null ? { triggerId: shownTriggerId.current } : {}),
            ...(globalVariables ? { globalVariables } : {}),
          }
        : null,
    [
      backgroundHtml,
      variables,
      assetUrls,
      resolveAsset,
      namedAssets,
      axes,
      turn,
      charMacro,
      personaName,
      personaAvatarUrl,
      youLabel,
      lastMessageId,
      assetNames,
      cbsModules,
      branchMessages,
      wholeBranch,
      chatId,
      locale,
      drawKey,
      globalVariables,
    ],
  );

  /* --------------------------------------------------------- card scripts */

  /** What a script is asking the reader, while the run waits on it. */
  const [scriptPrompt, setScriptPrompt] = useState<ScriptPrompt | null>(null);
  /** A word from the scripts that is not an error: a send they held back. */
  const [scriptNotice, setScriptNotice] = useState('');
  /** Turns waiting for the one in hand to end (`QueuedTurn`), taken one at a time. */
  const [queuedTurns, setQueuedTurns] = useState<readonly QueuedTurn[]>([]);
  /** A queued turn is being taken; the next waits for it. */
  const [takingTurn, setTakingTurn] = useState(false);
  /** Replies asked for in a row that way; the reader's own action starts the count again. */
  const followUpChain = useRef(0);
  /** Pending heads already tried, by id and revision, so a failure is not retried in a loop. */
  const finishTried = useRef(new Set<string>());

  const scriptUi = useMemo<ScriptUi>(
    () => ({
      alert: (text, error) => new Promise<void>((resolve) => setScriptPrompt({ kind: 'alert', text, error, resolve })),
      input: (text) => new Promise<string>((resolve) => setScriptPrompt({ kind: 'input', text, resolve })),
      select: (options, display) =>
        new Promise<string>((resolve) => setScriptPrompt({ kind: 'select', text: display ?? '', options, resolve })),
      confirm: (text) => new Promise<boolean>((resolve) => setScriptPrompt({ kind: 'confirm', text, resolve })),
      // The first render's `t` is the page's: another language mounts the page anew.
      help: () =>
        new Promise<void>((resolve) =>
          setScriptPrompt({ kind: 'alert', text: t('scriptCommandHelp'), error: false, resolve }),
        ),
    }),
    [],
  );
  /** Whose Lua sandbox the scripts run in: the reader's, kept across their chats (`readerLuaSandbox`). */
  const reader = useSession().data?.user.id ?? '';
  /**
   * One runtime per member that carries scripts (`lib/scripts`), the lead's
   * first. They share the reader's Lua sandbox — each member's Lua in states of
   * its own, which outlive this page for the reader's next chat with the member,
   * as RisuAI's outlive a chat — the persona and the chat's lore their scripts
   * rewrite, and in a work of several members every request names its member
   * (`group`).
   *
   * Built once what they are built from has all arrived — the scripts, and the
   * plot read that says whether the work has several members — so the first load
   * never builds a set only to replace it a moment later, letting a Lua start or
   * `editDisplay` in flight go. Built in an effect rather than
   * during the render, so the set disposed is always the set that was used; and
   * given back a tick after its effect is cleaned up (`lingering`), so a remount
   * from the same inputs — React's strict mode runs every effect's cleanup and
   * the effect again — takes the same set back instead of starting another.
   */
  const [runtimes, setRuntimes] = useState<ScriptRuntimes | null>(null);
  const lingering = useRef<{ made: ScriptRuntimes; from: readonly unknown[]; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  useEffect(() => {
    if (!scriptBundles?.length || !plotRead) {
      setRuntimes(null);
      return;
    }
    const from = [id, scriptBundles, scriptUi, group, reader] as const;
    /** The cleanup that gives a set back, a tick late. */
    const release = (made: ScriptRuntimes) => (): void => {
      setRuntimes((current) => (current === made ? null : current));
      const timer = setTimeout(() => {
        if (lingering.current?.made === made) lingering.current = null;
        // The lease on the sandbox goes with the runtimes that took it.
        made.dispose();
      }, 0);
      lingering.current = { made, from, timer };
    };
    const kept = lingering.current;
    if (kept && kept.from.every((input, at) => input === from[at])) {
      clearTimeout(kept.timer);
      lingering.current = null;
      setRuntimes(kept.made);
      return release(kept.made);
    }
    const log = (entry: { kind: string; effect?: string; message: string }): void =>
      console.warn('[scripts]', entry.kind, entry.effect ?? '', entry.message);
    // The embedding search of `checkSimilarity` and Lua's `similarity`, one for both:
    // its worker and the model are fetched on the first search, never before. The
    // first one on a model waits on its load, the first time on its download, so the
    // reader is told why. The model is the reader's pick as it stands at each search.
    const similarity = async (source: string, texts: readonly string[]): Promise<string[]> => {
      const model = readEmbeddingModel();
      const { searchSimilar, embedderReady } = await import('@/lib/scripts/embedding');
      if (embedderReady(model)) return searchSimilar(model, source, texts);
      const notice = t('scriptSimilarityPreparing');
      setScriptNotice(notice);
      try {
        return await searchSimilar(model, source, texts);
      } finally {
        setScriptNotice((current) => (current === notice ? '' : current));
      }
    };
    // A plot that carries Lua leases the reader's sandbox; wasmoon is fetched on its
    // first call, never before. Given back with the runtimes rather than by each engine.
    const sandbox = scriptBundles.some((bundle) => luaScriptsOf(bundle.triggers).length > 0)
      ? readerLuaSandbox(reader, () =>
          createLuaSandbox({
            loadAssets: () => import('@/lib/scripts/lua/assets').then((assets) => assets.loadLuaAssets()),
            onIdleKill: (reason) => log({ kind: 'limit', effect: 'triggerlua', message: `a Lua script still running between calls was stopped (${reason})` }),
          }),
        )
      : null;
    const shared = sharedScripts(scriptBundles[0]!);
    const byMember = new Map(
      scriptBundles.map((bundle) => {
        /** In a work of several members, the member a call is made for. */
        const tag = group ? { memberId: bundle.memberId } : {};
        const engines = sandbox && luaScriptsOf(bundle.triggers).length
          ? [
              createLuaEngine({
                triggers: bundle.triggers,
                lowLevelAccess: bundle.lowLevelAccess,
                // Its states are its card's code's (`luaCodeKey`): the sandbox outlives the page.
                sandbox: { call: (...args) => sandbox.call(...args), dispose: () => undefined },
                ui: scriptUi,
                // Each names the trigger whose code asked: the server holds the call to that trigger's access.
                llm: async (messages, model, trigger) =>
                  (await apiSend<{ result: string }>('POST', `/api/chats/${id}/script-llm`, { messages, model, trigger, ...tag }))
                    .result,
                similarity,
                // Our server makes the GET, under RisuAI's limits, and answers as RisuAI does.
                request: (url, trigger) =>
                  apiSend<LuaRequestAnswer>('POST', `/api/chats/${id}/script-fetch`, { url, trigger, ...tag }),
                // `loadLoreBooks`: activated as `/test_lorebook` is, against RisuAI's
                // `maxContext`, which is the chat's context budget here.
                lore: async (history, lorebook) => ({
                  actives: (await activeLore(lorebook, history, bundle.character.loreSettings)).actives.map(
                    (active) => ({ prompt: active.prompt, role: active.role }),
                  ),
                  maxContext: stateRef.current?.chat.memorySettings?.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
                }),
                avatarUrl: bundle.character.avatarUrl ?? null,
                // The persona the chat is on when the call starts — the reader may switch it.
                personaAvatarUrl: () =>
                  personasRef.current.find((persona) => persona.id === stateRef.current?.chat.personaId)?.avatarUrl ??
                  null,
                log,
              }),
            ]
          : [];
        const runtime = createScriptRuntime({
          chatId: id,
          bundle,
          api: { send: apiSend },
          ui: scriptUi,
          engines,
          similarity,
          log,
          onGlobalVariables: (globals) =>
            setState((current) => (current ? { ...current, globalVariables: globals } : current)),
          onOverlay: (member, memberId) => setScriptOverlays((current) => ({ ...current, [memberId]: member })),
          shared,
          ...(group ? { group: true } : {}),
        });
        return [bundle.memberId, runtime] as const;
      }),
    );
    const made: ScriptRuntimes = {
      byMember,
      lead: byMember.get(scriptBundles[0]!.memberId)!,
      dispose: () => {
        for (const runtime of byMember.values()) runtime.dispose();
        sandbox?.dispose();
      },
    };
    setRuntimes(made);
    return release(made);
  }, [id, scriptBundles, scriptUi, group, reader, plotRead]);
  /** Where each moment's scripts run (`runtimeOf`). */
  const scriptCast = useMemo<ScriptCast | null>(
    () => (runtimes ? { byMember: runtimes.byMember, lead: runtimes.lead } : null),
    [runtimes],
  );
  /** The lead's runtime: a work of one's only one. */
  const runtime = runtimes?.lead ?? null;
  const anyRuntime = (has: (runtime: ScriptRuntime) => boolean): boolean =>
    runtimes ? [...runtimes.byMember.values()].some(has) : false;
  /** Whether any member's scripts rewrite what messages show — its display triggers, its Lua's `editDisplay` — or listen to the request. */
  const rewritesDisplay = anyRuntime((one) => one.rewritesDisplay);
  const editsDisplay = anyRuntime((one) => one.editsDisplay);
  const rewritesOnServer = anyRuntime((one) => one.rewritesOnServer);
  /**
   * Whose scripts a stored message is drawn through (`lib/scripts/group`): in a
   * work of several members, a reply's speaker; null — the lead's — for a message
   * no member speaks, and in a work of one.
   */
  const memberOfMessage = useCallback(
    (message: ChatMessage): string | null =>
      group && message.role === 'assistant' && message.speakerMemberId && cast.some((member) => member.id === message.speakerMemberId)
        ? message.speakerMemberId
        : null,
    [group, cast],
  );
  /**
   * The scripts fold the branch as the server does, from the plot's defaults, so
   * nothing runs before both reads are in: a turn sent in the meantime would be
   * measured against the wrong starting state. Nor before the runtimes that
   * run them are built, a render after the reads (`runtimes`).
   */
  const scriptsPending =
    scriptBundle === undefined || (scriptBundle !== null && (plot === null || runtimes === null));

  /** The page's latest state, for the steps of a turn that outlive the render they began in. */
  const stateRef = useRef<ChatState | null>(null);
  stateRef.current = state;
  /** The reader's personas as they stand, for a script call made after this render. */
  const personasRef = useRef(personas);
  personasRef.current = personas;

  /** What RisuAI's functions may read in a script, from the reader's side. */
  const scriptData = useCallback(
    (afterGreeting: number): ScriptView['data'] => {
      const zone = Intl.DateTimeFormat().resolvedOptions();
      return {
        clock: { now: new Date(), timeZone: zone.timeZone, locale: zone.locale },
        seed: { key: chatId, length: afterGreeting },
        meta: { language: locale },
        assets: { names: assetNames, display: assetNames },
        ...(cbsModules ? { modules: cbsModules } : {}),
      };
    },
    [chatId, locale, assetNames, cbsModules],
  );

  /**
   * The branch as a script reads it: all of it — the windows not paged in yet
   * are read first, and the page keeps them — with the fold's starting point and
   * the reader's side of things.
   */
  const scriptViewOf = useCallback(
    async (current: ChatState): Promise<ScriptView> => {
      let whole = current;
      if (current.hasMore) {
        whole = await loadWholeBranch(current, (cursor, limit) =>
          apiGet<ChatState>(`/api/chats/${id}?before=${cursor}&limit=${limit}`),
        );
        stateRef.current = whole;
        setState((latest) => (latest && latest.chat.headMessageId === whole.chat.headMessageId ? whole : latest));
      }
      const persona = personas.find((entry) => entry.id === whole.chat.personaId);
      const afterGreeting = whole.path.length - (whole.path[0] && isGreeting(whole.path[0]) ? 1 : 0);
      return {
        messages: whole.path,
        defaults: defaultVariables,
        names: foldNames,
        note: whole.chat.note,
        persona: persona?.description ?? '',
        firstGreeting: opensOnFirstGreeting(whole.path, whole.siblings),
        ...(whole.globalVariables ? { globalVariables: whole.globalVariables } : {}),
        data: scriptData(afterGreeting),
      };
    },
    [id, personas, defaultVariables, foldNames, scriptData],
  );

  /**
   * Finishes the reply the server holds `pending`: the `editoutput` scripts and
   * the output triggers, committed in place. A plot with no scripts left, or an
   * attempt that took the tab down last time (`finishMark`), keeps the reply as
   * the model wrote it. A head that moved or changed under the commit is read
   * again and tried once more; one someone else finished is simply taken.
   */
  async function finishPending(
    current: ChatState,
    retried = false,
  ): Promise<{ state: ChatState; followUp: boolean } | null> {
    const head = current.path[current.path.length - 1];
    if (!head || head.scriptState !== 'pending') return null;
    const rev = head.scriptRev ?? 0;
    finishTried.current.add(`${head.id}:${rev}`);
    // The speaker's output pass: a reply is its speaker's to finish.
    const runtime = scriptCast ? runtimeOf(scriptCast, head.speakerMemberId ?? null) : null;
    try {
      if (!runtime || finishMarked(head.id, rev)) {
        unmarkFinish(head.id, rev);
        const kept = await apiSend<ChatState>('POST', `/api/chats/${id}/script-commit`, {
          messageId: head.id,
          scriptRev: rev,
          clearPending: true,
        });
        return { state: kept, followUp: false };
      }
      const view = await scriptViewOf(current);
      // Marked only around the scripts themselves: a tab closed while the older
      // windows were still loading did not hang on them.
      markFinish(head.id, rev);
      try {
        return await runtime.finish(view);
      } finally {
        unmarkFinish(head.id, rev);
      }
    } catch (caught) {
      if (!(caught instanceof ApiError) || caught.status !== 409) throw caught;
      const { state: fresh } = await refetch();
      if (!fresh) throw caught;
      if (retried || caught.code === 'not_pending') return { state: fresh, followUp: false };
      return finishPending(mergeRefetched(stateRef.current, fresh), true);
    }
  }

  /**
   * `finishPending`, its answer applied and a follow-up queued. Answers with the
   * branch as it now stands — `current` when there was nothing to finish or the
   * finish failed, which it says on the banner.
   *
   * Inside a round (`round`), a follow-up is the round's to take — the same
   * speaker again — so it is noted there rather than queued as a turn.
   */
  async function settlePending(current: ChatState, round?: { followUp: boolean }): Promise<ChatState> {
    try {
      const done = await finishPending(current);
      if (!done) return current;
      mergeState(done.state);
      // RisuAI's `sendAIprompt` asks for the next reply at once. A few in a row at
      // most: a card that asks every time would otherwise never stop.
      if (done.followUp && round) {
        round.followUp = true;
      } else if (done.followUp && followUpChain.current < MAX_SCRIPT_FOLLOW_UPS) {
        setQueuedTurns((turns) => [...turns, { kind: 'next' }]);
      }
      return mergeRefetched(current, done.state);
    } catch {
      setError(t('scriptFinishFailed'));
      return current;
    }
  }

  // A reply the server is finishing for a page that has gone — this tab before a
  // reload, another device, a turn that stopped waiting (`awaitServerReply`) — is
  // read when it lands: the page asks again until the chat's slot is free. A reply
  // that lands owing its output scripts is finished by the effect below.
  const serverGenerating = Boolean(state?.chat.generating);
  useEffect(() => {
    if (!serverGenerating || mode || drawing || mutating) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void refetch().then((answer) => {
        if (!cancelled && answer.state) mergeState(answer.state);
      });
    }, SERVER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [serverGenerating, mode, drawing, mutating, refetch, mergeState]);

  // A pending head that is not this tab's doing — a reload after the tab closed
  // mid-reply, a swipe onto a pending sibling — is finished as soon as it is seen.
  useEffect(() => {
    if (!state || mode || mutating || drawing || scriptsPending || state.chat.importing) return;
    const head = state.path[state.path.length - 1];
    if (!head || head.scriptState !== 'pending') return;
    if (finishTried.current.has(`${head.id}:${head.scriptRev ?? 0}`)) return;
    if (!beginMutation()) return;
    void settlePending(state).finally(endMutation);
    // `settlePending` and the mutation pair are this render's; the effect only
    // has to run again when one of these moves.
  }, [state, mode, mutating, drawing, scriptsPending]);

  // The queued turns, each once the turn before it has fully ended. A reply the
  // card takes for the reader — one a script asked for, `/multisend`'s — waits on
  // the same consent a component's turn does, and declining it drops the rest.
  useEffect(() => {
    const turn = queuedTurns[0];
    if (!turn || takingTurn || mode || mutating || drawing || !state) return;
    setQueuedTurns((turns) => turns.slice(1));
    setTakingTurn(true);
    void (async () => {
      try {
        if (turn.kind === 'own') {
          await generate('send', turn.content, turn.options);
          return;
        }
        if (turn.kind === 'append') {
          if (!runtime || !beginMutation()) return;
          try {
            const next = await runtime.append(turn.items, await scriptViewOf(stateRef.current ?? state));
            if (next) mergeState(next);
          } catch (caught) {
            setError(toMessage(caught));
          } finally {
            endMutation();
          }
          return;
        }
        if (!(await allowScriptTurns(turn.kind === 'next' ? 'scriptFollowUpConsent' : 'scriptMultisendConsent', state))) {
          setQueuedTurns([]);
          return;
        }
        if (turn.kind === 'next') {
          followUpChain.current += 1;
          // RisuAI generates on whatever its chat now ends with: a reader's turn the
          // output triggers added is answered, anything else is carried on from —
          // in a work of several members, by the member who just spoke.
          const head = state.path.at(-1);
          if (head?.role === 'user') await generate('regenerate', undefined, undefined, true);
          else if (group && head?.speakerMemberId && stage.some((member) => member.id === head.speakerMemberId)) {
            await playRound({ opening: 'reply', speakers: [head.speakerMemberId] }, true);
          } else await generate('auto', undefined, undefined, true);
        } else {
          // `/multisend`'s message, pushed as it is and answered.
          await generate('send', turn.content, undefined, true, { raw: true, clear: turn.clear });
        }
      } finally {
        setTakingTurn(false);
      }
    })();
  }, [queuedTurns, takingTurn, mode, mutating, drawing, state]);

  /**
   * A `risu-trigger` or `{{button}}` click: the manual triggers of that name of
   * the member whose message holds the button (`member`, the lead's without
   * one), committed on the head.
   */
  async function runManualTrigger(name: string, triggerId: string | null, member: string | null): Promise<void> {
    const current = stateRef.current;
    const runtime = scriptCast ? runtimeOf(scriptCast, member) : null;
    if (!runtime || !current || scriptsPending || !beginMutation()) return;
    shownTriggerId.current = triggerId;
    try {
      const next = await runtime.manual(name, triggerId, await scriptViewOf(current));
      if (next) mergeState(next);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      endMutation();
      if (triggerId !== null) {
        setTimeout(() => {
          if (shownTriggerId.current === triggerId) shownTriggerId.current = null;
        }, TRIGGER_ID_MS);
      }
    }
  }

  /**
   * RisuAI's composer: a line starting with `/`, in a chat whose plot carries
   * RisuAI scripts, is a line of slash commands (`processMultiCommand`). What
   * they did is committed on the head and the composer stays empty — unless the
   * line answered `false` (a command RisuAI does not run), and then the text
   * goes as an ordinary message all the same, or a command threw, and then it
   * goes back into the composer. `content` is the text as a send would carry it.
   */
  async function runCommand(text: string, content: string, options: SendOptions | undefined): Promise<void> {
    let current = stateRef.current;
    if (!runtime || !current || scriptsPending || !beginMutation()) {
      setInput((typed) => (typed.trim() ? `${text}\n${typed}` : text));
      return;
    }
    followUpChain.current = 0;
    setError('');
    setScriptNotice('');
    let outcome: CommandOutcome | null = null;
    try {
      // A reply still owed its output scripts is finished before the commands read the chat.
      const owed = current.path[current.path.length - 1];
      if (owed?.scriptState === 'pending' && !finishTried.current.has(`${owed.id}:${owed.scriptRev ?? 0}`)) {
        current = await settlePending(current);
      }
      outcome = await runtime.command(text, await scriptViewOf(current));
      if (outcome.state) mergeState(outcome.state);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      endMutation();
    }
    if (!outcome || outcome.error !== undefined) {
      // What threw is in the console, with the scripts' other notes.
      if (outcome) setError(t('scriptCommandFailed'));
      setInput((typed) => (typed.trim() ? `${text}\n${typed}` : text));
      return;
    }
    const turns: QueuedTurn[] = [...outcome.turns];
    if (outcome.send) turns.push({ kind: 'own', content, ...(options ? { options } : {}) });
    if (turns.length > 0) setQueuedTurns((queued) => [...queued, ...turns]);
  }

  /**
   * A `risu-btn` click: the card's Lua `onButtonClick` — the card of the member
   * whose message holds the button — and what it did committed on the head, as a
   * manual trigger's is.
   */
  async function runLuaButton(data: string, member: string | null): Promise<void> {
    const current = stateRef.current;
    const runtime = scriptCast ? runtimeOf(scriptCast, member) : null;
    if (!runtime || !current || scriptsPending || !beginMutation()) return;
    try {
      const next = await runtime.button(data, await scriptViewOf(current));
      if (next) mergeState(next);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      endMutation();
    }
  }

  /**
   * The messages as the Lua `editDisplay` listeners draw them, by id — the
   * screen's alone, and asked for whenever the branch or its fold moves. A
   * message keeps the last answer it had until the next one arrives, so a
   * redraw does not flash the text the listeners hide; the first time, it shows
   * as it stands until they answer. The background is drawn through them too,
   * under `BACKGROUND_ITEM` and at no message's index (-1), as RisuAI's
   * `BackgroundDom` runs its display pass.
   */
  const [luaShown, setLuaShown] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    if (!scriptCast || !editsDisplay || !customUi || !state) return;
    let current = true;
    const persona = personas.find((entry) => entry.id === state.chat.personaId);
    const view: ScriptView = {
      messages,
      defaults: defaultVariables,
      names: foldNames,
      note: state.chat.note,
      persona: persona?.description ?? '',
      firstGreeting,
      ...(globalVariables ? { globalVariables } : {}),
      data: scriptData(lastMessageId + 1),
      ...(shownTriggerId.current !== null ? { triggerId: shownTriggerId.current } : {}),
    };
    // Each message to the listeners of the member it is (`runtimeOf`), the background to the lead's.
    const items = messages.map((message) => ({
      id: message.id,
      text: shownGreetings.get(message.id) ?? message.content,
      memberId: memberOfMessage(message),
    }));
    if (backgroundHtml) items.push({ id: BACKGROUND_ITEM, text: backgroundHtml, memberId: null });
    groupDisplayEdits(scriptCast, items, (owner, list) => owner.displayEdits(list, view, persistedVariables)).then(
      (shown) => {
        if (current) setLuaShown(shown);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [
    scriptCast,
    editsDisplay,
    memberOfMessage,
    customUi,
    state,
    personas,
    messages,
    defaultVariables,
    foldNames,
    globalVariables,
    scriptData,
    lastMessageId,
    firstGreeting,
    shownGreetings,
    persistedVariables,
    backgroundHtml,
  ]);

  /**
   * The messages as the display triggers draw them, where the plot has any —
   * text for the screen alone, never stored — over what the Lua display
   * listeners made of them, as RisuAI runs the two. Over the stored branch and
   * its fold, so a streamed token redraws none of it. The background too, under
   * `BACKGROUND_ITEM`: RisuAI's display pass over it runs the triggers as well.
   */
  const scriptShown = useMemo(() => {
    const shown = new Map<string, string>();
    if (!scriptCast || !customUi || !state) return shown;
    if (!rewritesDisplay) return editsDisplay ? new Map(luaShown) : shown;
    const persona = personas.find((entry) => entry.id === state.chat.personaId);
    const view: ScriptView = {
      messages,
      defaults: defaultVariables,
      names: foldNames,
      note: state.chat.note,
      persona: persona?.description ?? '',
      firstGreeting,
      ...(globalVariables ? { globalVariables } : {}),
      data: scriptData(lastMessageId + 1),
      ...(shownTriggerId.current !== null ? { triggerId: shownTriggerId.current } : {}),
    };
    // Each message through the display triggers of the member it is (`runtimeOf`).
    for (const message of messages) {
      const text = shownGreetings.get(message.id) ?? message.content;
      const listened = luaShown.get(message.id) ?? text;
      const drawn = runtimeOf(scriptCast, memberOfMessage(message))?.display(listened, view, persistedVariables) ?? listened;
      if (drawn !== text) shown.set(message.id, drawn);
    }
    if (backgroundHtml) {
      const drawn = scriptCast.lead.display(luaShown.get(BACKGROUND_ITEM) ?? backgroundHtml, view, persistedVariables);
      if (drawn !== backgroundHtml) shown.set(BACKGROUND_ITEM, drawn);
    }
    return shown;
  }, [
    scriptCast,
    rewritesDisplay,
    editsDisplay,
    memberOfMessage,
    customUi,
    state,
    personas,
    messages,
    defaultVariables,
    foldNames,
    globalVariables,
    scriptData,
    lastMessageId,
    firstGreeting,
    shownGreetings,
    persistedVariables,
    luaShown,
    backgroundHtml,
  ]);
  /** The background as the card's scripts draw it; their display scripts come after, in `ChatBackground`. */
  const shownBackground = scriptShown.get(BACKGROUND_ITEM) ?? backgroundHtml;

  /**
   * The reply a dropped stream left with the server, waited for: the server goes
   * on with it and stores it (§7.2), so this reads the chat until its slot is free,
   * or the reader's stop has been answered, and answers with that read. A phone
   * that slept through it reads it on waking. Past SERVER_WAIT_MS it answers with
   * the chat still generating, and the page waits on its own (`chat.generating`).
   */
  async function awaitServerReply(): Promise<{ state: ChatState | null; error: string }> {
    setWaitingOnServer(true);
    const deadline = Date.now() + SERVER_WAIT_MS;
    let last = await refetch();
    /** The newest read that answered: one lost to the network says nothing about the reply. */
    let known = last;
    while ((known.state === null || known.state.chat.generating) && Date.now() < deadline) {
      await sleep(SERVER_POLL_MS);
      if (stopping.current) await stopping.current;
      last = await refetch();
      if (last.state) known = last;
    }
    setWaitingOnServer(false);
    return known.state ? known : last;
  }

  async function run(
    next: StreamMode,
    content?: string,
    turnOptions?: SendOptions,
    /** A reply a script asked for, rather than one the reader did. */
    scripted = false,
    /** How the scripts take a send that is not the reader's typing (`/multisend`'s). */
    prepareOptions?: PrepareOptions,
    /**
     * One request of a round, in a work of several members. The round drives the
     * next one once this resolves, so the composer stays held (`mode`) between them.
     */
    step?: GroupStep,
  ): Promise<RunOutcome> {
    const nothing: RunOutcome = { kind: 'over', groupTurnId: null, followUp: false, state: null };
    // A drawn scene holds the same per-chat slot a generation does, so asking for
    // one while the picture is on its way would only come back a 429. A round's
    // later speakers are asked from the render that began it, before any `mode`.
    if (mode || drawing || mutationRef.current || scriptsPending) return nothing;
    if (!scripted) followUpChain.current = 0;
    const start = step?.base ?? stateRef.current ?? state;
    const headBefore = start?.chat.headMessageId ?? null;
    /** What the branch looked like before, for reading whether the turn landed. */
    const before = { id: headBefore, content: start?.path.at(-1)?.content ?? '' };
    const controller = new AbortController();
    abortRef.current = controller;
    setMode(next);
    // A regenerate hides what it replaces: the head, or the round it ends.
    setReplacing(
      next !== 'regenerate' ? 0 : (step?.request?.replaces ?? (start?.path.at(-1)?.role === 'assistant' ? 1 : 0)),
    );
    // A generation outside a round leaves behind whatever round failed before it.
    if (!step) setRound(null);
    // Whatever the last attempt left on screen belongs to the last attempt.
    setHeld(null);
    // Suggestions answer the turn as it stood; a new one is being taken, so
    // they are gone whether the reader used one of them or wrote their own.
    setSuggestions([]);
    setSuggestError('');
    reset();
    setPendingUser(content ?? '');
    setError('');
    setRetryable(false);
    setAmbiguous(false);
    setScriptNotice('');

    /** What the reader wrote: what goes back into the composer if the turn never lands. */
    const typed = content;
    // The card's scripts go first — the input and start triggers and the input
    // scripts — and what they decide rides on the request (`lib/scripts`).
    let scriptBody: Record<string, unknown> = {};
    let prepared: PreparedGeneration | null = null;
    /** A send's round, picked between its members' input passes and the speaker's start (`prepareGroupSend`). */
    const pickedRound: { request?: RoundRequest | null } = {};
    if (scriptCast && start) {
      try {
        let current = start;
        // A reply still owed its output scripts is finished before anything builds
        // on it — unless this tab already tried and failed, which the request then
        // says it gives up on (below). A regenerate replaces it, so it waits.
        const owed = current.path[current.path.length - 1];
        if (
          next !== 'regenerate' &&
          owed?.scriptState === 'pending' &&
          !finishTried.current.has(`${owed.id}:${owed.scriptRev ?? 0}`)
        ) {
          current = await settlePending(current);
        }
        const view = await scriptViewOf(current);
        const replaces = step?.request?.replaces;
        const options = replaces ? { ...prepareOptions, replaces } : prepareOptions;
        const pick = step?.pick;
        if (group && next === 'send' && pick) {
          // Every member on the stage takes its input pass, the round is picked off
          // the turn they left, and the speaker's start triggers run.
          prepared = (
            await prepareGroupSend(scriptCast, view, content ?? '', options, {
              stage: stage.map((member) => member.id),
              pick: (text) => {
                pickedRound.request = pick(text);
                return pickedRound.request?.speakerId ?? null;
              },
            })
          ).prepared;
        } else {
          // Any other moment is one member's: the speaker's — the head's for a
          // continue — or the lead's where no member speaks. A speaker with no
          // scripts runs none, and the request only says what it was built on.
          const runner = group ? runtimeOf(scriptCast, speakerOf(next, step, current)) : scriptCast.lead;
          prepared = runner
            ? await runner.prepare(next, view, content, options)
            : { body: { baseHeadId: current.chat.headMessageId }, stop: false, accept: () => undefined };
        }
        if (prepared.state) mergeState(prepared.state);
        // A head still pending here is one this tab could not finish: the turn
        // goes on without its output scripts rather than being refused for them.
        const head = view.messages[view.messages.length - 1];
        scriptBody = { ...prepared.body, ...(head?.scriptState === 'pending' ? { abandonPending: true } : {}) };
      } catch (caught) {
        prepared = null;
        setError(toMessage(caught));
      }
      // A stopped send still goes, as a turn with nothing generated for it (below);
      // anything else that did not go is over here.
      if (!prepared || (prepared.stop && next !== 'send')) {
        // Nothing was sent. A send's text goes back where it was written.
        if (next === 'send') setInput((current) => (current.trim() ? `${typed ?? ''}\n${current}` : (typed ?? '')));
        if (prepared?.stop) setScriptNotice(t('scriptStopped'));
        abortRef.current = null;
        reset();
        setMode(null);
        setPendingUser('');
        return nothing;
      }
      if (prepared.content !== undefined && next === 'send') {
        content = prepared.content;
        setPendingUser(content);
      }
    }

    let rejection: unknown = null;
    let streamError: string | null = null;
    let aborted = false;
    /** The stream ended without a word: the server is finishing the reply on its own. */
    let dropped = false;
    /** How much of a reply arrived, which decides whether there is any to keep. */
    let received = 0;
    /** The round the reply was stored in, for the round to go on in. */
    let groupTurnId: string | null = null;
    let landed = false;
    /**
     * RisuAI pushes the turn before its start triggers run, so their `stop` leaves
     * it in the chat with no reply, and the composer empty: the turn is stored as
     * any send stores it, and nothing is generated. Everything below — the
     * refetch, a rejection's reconcile, the images — goes as it does for a send.
     */
    const stoppedTurn = next === 'send' && prepared?.stop === true;
    // Who this request asks, in a round: known up front, or — on a send — picked
    // now, off the turn as its input scripts left it. A stopped turn asks no one.
    const request = stoppedTurn
      ? null
      : 'request' in pickedRound
        ? (pickedRound.request ?? null)
        : step?.pick
          ? step.pick(content ?? '')
          : (step?.request ?? null);
    const speakerBody = request
      ? {
          speakerId: request.speakerId,
          finalSpeaker: request.finalSpeaker,
          ...(request.mode === 'reply' && request.groupTurnId !== null ? { groupTurnId: request.groupTurnId } : {}),
        }
      : undefined;
    try {
      if (stoppedTurn) {
        await apiSend<ChatState>('POST', `/api/chats/${id}/messages`, {
          content,
          ...turnOptions,
          ...scriptBody,
          stopped: true,
        });
        setScriptNotice(t('scriptStopped'));
      } else {
        const result = await streamGeneration(
          next === 'send' ? `/api/chats/${id}/messages` : `/api/chats/${id}/${next}`,
          next === 'send'
            ? { content, ...turnOptions, ...speakerBody, ...scriptBody }
            : speakerBody || Object.keys(scriptBody).length > 0
              ? { ...speakerBody, ...scriptBody }
              : undefined,
          (text) => {
            received += text.length;
            append(text);
          },
          controller.signal,
        );
        if (result.kind === 'error') streamError = result.code ? toMessage(new ApiError(0, result.code, result.message, result.params)) : result.message;
        aborted = result.kind === 'aborted';
        dropped = result.kind === 'dropped';
        landed = result.kind === 'done';
        if (result.kind === 'done') groupTurnId = result.groupTurnId ?? null;
        // Its emotion picture, where its member shows one, comes after it (`awaitingEmotion`).
        if (result.kind === 'done' && result.messageId) {
          const reply = result.messageId;
          setFreshReplies((current) => new Set(current).add(reply));
        }
        // What the turn opened, celebrated on the spot: the refetch below carries
        // the same answer, and a reveal that waits for it arrives a beat late.
        if (result.kind === 'done' && result.unlockedAssetIds.length > 0) {
          const opened = result.unlockedAssetIds;
          setState((current) =>
            current ? { ...current, assetLocks: openAssetLocks(current.assetLocks, opened) } : current,
          );
        }
      }
    } catch (caught) {
      rejection = caught;
    }
    // The server took the turn, so it kept what the scripts rewrote of the work.
    if (rejection === null) prepared?.accept();
    // RisuAI's `editRequest` listener rewrites the live character and the chat's
    // lore; here the server ran it with the reply, so the page asks what it left
    // before the output scripts read them.
    if (rejection === null && !stoppedTurn && runtimes && rewritesOnServer) {
      await apiGet<{ scripts: ScriptBundle | null; members?: ScriptBundle[] }>(`/api/chats/${id}/scripts`).then(
        (answer) => {
          const bundles = answer?.members?.length ? answer.members : answer?.scripts ? [answer.scripts] : [];
          for (const bundle of bundles) runtimes.byMember.get(bundle.memberId)?.adopt(bundle);
        },
        () => undefined,
      );
    }
    abortRef.current = null;
    // However it ended, it ended: the pacing gives up whatever it was still
    // holding back before anything decides what the ending meant.
    finish();

    // A stopped reply is stored by the time the server answers the stop, so the
    // read below waits for that answer rather than racing the write.
    if (aborted && stopping.current) await stopping.current;
    // Refresh before clearing the streamed text so the persisted message
    // replaces it in a single render — no flash of a duplicated reply. A dropped
    // stream's reply is still the server's to finish, so that read waits for it.
    const refreshed = dropped ? await awaitServerReply() : await refetch();
    if (
      dropped &&
      refreshed.state &&
      !refreshed.state.chat.generating &&
      !generationLanded(next, before, refreshed.state)
    ) {
      // The server's attempt failed after the page lost it: nothing was stored.
      streamError = toMessage(new ApiError(0, 'stream_interrupted', ''));
    }
    // Merged rather than assigned: the refetch answers with the newest window,
    // and on a long chat that is less than what the reader has paged in.
    const settled = refreshed.state;
    if (settled) mergeState(settled);
    // A reply the scripts still owe their output pass is finished before the turn
    // ends, with the composer still held: until then it is not the reply. In a
    // round, the next speaker's request waits on it too — and reads the branch
    // from here, before this render has it.
    const roundNote = { followUp: false };
    let latest = settled ? mergeRefetched(step?.base ?? stateRef.current, settled) : null;
    if (latest && scriptBundle !== undefined) latest = await settlePending(latest, step ? roundNote : undefined);
    if (latest && step) stateRef.current = latest;

    /** Whether the turn was written — and so whether its images went with it. */
    let delivered = next === 'send';
    /** Whether asking again may still answer it — the retry beside the banner. */
    let mayRetry = false;
    if (streamError !== null) {
      // The stream was open, so the user turn is stored: regenerate retries it.
      setError(streamError);
      mayRetry = true;
    } else if (rejection !== null) {
      setError(toMessage(rejection));
      if (next !== 'send') {
        mayRetry = true;
      } else {
        // A rejected send proves only that no stream was read. Whether the turn
        // was stored is decided by the head, never assumed.
        const recovery = reconcileSend(headBefore, refreshed.state);
        mayRetry = recovery.kind === 'delivered' && recovery.retry;
        // The unsent text goes back into the composer — above whatever was
        // typed while it was on its way, never over it.
        if (recovery.kind !== 'delivered') {
          setInput((current) => (current.trim() ? `${typed ?? ''}\n${current}` : (typed ?? '')));
        }
        setAmbiguous(recovery.kind === 'unknown');
        delivered = recovery.kind === 'delivered';
      }
    } else if (!refreshed.state) {
      setError(refreshed.error);
    }
    setRetryable(mayRetry);
    // The images belong to the turn that carried them. A send that never landed
    // leaves them in the composer with the text, still uploaded, ready to go
    // again; one that did has handed them over to the message.
    if (delivered) clearChips();

    // A failed stream is the one ending whose text the server did not store, so
    // the partial stays on screen — under the banner, with the retry beside it —
    // rather than vanishing. Unless it *was* stored: a transport drop reads as
    // an error here while the server's abort path persists what it had, and
    // holding the optimistic row next to that persisted row would show the
    // reply twice. Every other ending has just been replaced by the branch the
    // refetch brought back.
    const keepPartial =
      streamError !== null &&
      received > 0 &&
      !(refreshed.state !== null && generationLanded(next, before, refreshed.state));
    setHeld(keepPartial ? next : null);
    if (!keepPartial) reset();

    // A round holds the composer through all its speakers, the next one's row
    // already up; it lets go once the round is over (`playRound`).
    setMode(step ? 'reply' : null);
    setPendingUser('');
    return {
      kind: landed && latest ? 'done' : mayRetry ? 'failed' : 'over',
      groupTurnId,
      followUp: roundNote.followUp,
      state: latest,
    };
  }

  /**
   * The next turn, the way the work answers it. In a work of several members a
   * send, a regenerate and a carry-on (`auto`, 이어가기) are rounds (`playRound`);
   * continuing and narrating stay the one request they are, which the server
   * gives to the head's speaker or to the narrator. A work of one is `run`.
   */
  async function generate(
    next: StreamMode,
    content?: string,
    options?: SendOptions,
    scripted = false,
    prepareOptions?: PrepareOptions,
  ): Promise<void> {
    if (group && next === 'send') {
      await playRound(
        {
          opening: 'send',
          content: content ?? '',
          ...(options ? { options } : {}),
          ...(prepareOptions ? { prepareOptions } : {}),
        },
        scripted,
      );
    } else if (group && next === 'regenerate') await playRound({ opening: 'regenerate' }, scripted);
    else if (group && next === 'auto') await playRound({ opening: 'reply' }, scripted);
    else await run(next, content, options, scripted, prepareOptions);
  }

  /**
   * The reader's one-off consent, for this chat, to the replies a card's scripts
   * take for them (`allowComponentTurns`): asked where it was not given yet, and
   * stored. False when they declined, or it could not be stored.
   */
  async function allowScriptTurns(
    consent: 'scriptFollowUpConsent' | 'scriptMultisendConsent',
    current: ChatState,
  ): Promise<boolean> {
    if (current.chat.allowComponentTurns) return true;
    if (!window.confirm(t(consent, { name: characterName }))) return false;
    try {
      applyState(await apiSend<ChatState>('PATCH', `/api/chats/${id}`, { allowComponentTurns: true }));
      return true;
    } catch (caught) {
      setSettingsError(toMessage(caught));
      return false;
    }
  }

  /**
   * A round in a work of several members: one reply per speaker, each its own
   * message. The speakers are picked here (`lib/groupRound`) — on a send once the
   * input scripts have left the turn's text — and asked one at a time, each after
   * the last reply is stored and finished. The 다음 차례 picks are this round's.
   * With nobody on the stage there is no one to pick, and the work answers as the
   * scene, as it did before group turns.
   */
  async function playRound(begin: RoundStart, scripted = false): Promise<void> {
    const current = stateRef.current ?? state;
    if (!current || mode || drawing || mutationRef.current || scriptsPending) return;
    roundStopped.current = false;
    // A round that failed before is given up by starting another.
    setRound(null);
    const picks = focus;
    const pick = (cue: RoundCue): string[] =>
      pickSpeakers({ stage, picks, cue, settings: plot?.groupSettings, random: Math.random });

    if (begin.opening === 'send') {
      const opened: { round: Round | null } = { round: null };
      const outcome = await run('send', begin.content, begin.options, scripted, begin.prepareOptions, {
        base: current,
        pick: (text) => {
          // What the turn answers is the turn as stored: after its input scripts.
          opened.round = openRound('send', pick({ text, lastSpeakerId: null }));
          setRound(opened.round);
          return roundRequest(opened.round);
        },
      });
      await carryRound(opened.round, outcome, picks);
      return;
    }

    let round: Round | null;
    if (begin.opening === 'regenerate') {
      // The whole round again, rolled afresh — a reroll, and whoever spoke before
      // may since have left the stage. A round the narration button opened is
      // the narrator's to redo; a narration that only ended a round is not redone.
      const redo = redoOf(current.path);
      round = openRound('regenerate', redo.narrator ? [NARRATOR_SPEAKER] : pick(redo.cue), redo.replaces);
    } else {
      round = openRound('reply', begin.speakers ?? pick(cueOf(current.path.at(-1))));
    }
    if (!round) {
      await run(begin.opening === 'regenerate' ? 'regenerate' : 'auto', undefined, undefined, scripted);
      return;
    }
    setRound(round);
    const request = roundRequest(round)!;
    await carryRound(round, await run(request.mode, undefined, undefined, scripted, undefined, { base: current, request }), picks);
  }

  /**
   * Takes a round on from what its last request came to, speaker by speaker,
   * until it is over, the reader stopped it, or a request failed — which leaves
   * the round in `round` for the retry to ask that speaker again and go on. The
   * composer is held throughout and let go here.
   */
  async function carryRound(begun: Round | null, outcome: RunOutcome, picks: readonly string[]): Promise<void> {
    let round = begun;
    let result = outcome;
    let latest = result.state;
    try {
      while (round) {
        if (result.kind === 'done') {
          // The picks were for this round; any made while it ran are the next one's.
          if (round.groupTurnId === null) setFocus((now) => (now === picks ? [] : now));
          // RisuAI's `sendAIprompt`: the same speaker again, a few times a round at most.
          const followUp =
            result.followUp && latest !== null && (await allowScriptTurns('scriptFollowUpConsent', latest));
          round = stepRound(round, {
            type: 'landed',
            groupTurnId: result.groupTurnId,
            ...(followUp ? { followUp: { cap: MAX_SCRIPT_FOLLOW_UPS } } : {}),
          });
        } else {
          round = stepRound(round, { type: result.kind === 'failed' ? 'failed' : 'ended' });
        }
        if (!round || round.failed || roundStopped.current) break;
        setRound(round);
        const request = roundRequest(round)!;
        result = await run(request.mode, undefined, undefined, true, undefined, { base: latest, request });
        latest = result.state ?? latest;
      }
    } finally {
      setRound(round?.failed ? round : null);
      setMode(null);
    }
  }

  /** The retry beside a failed round: the speaker it failed on, in the same round, and on from there. */
  async function retryRound(): Promise<void> {
    if (!round?.failed || mode || drawing || mutationRef.current || scriptsPending) return;
    const again = stepRound(round, { type: 'retry' })!;
    roundStopped.current = false;
    setRound(again);
    const request = roundRequest(again)!;
    const outcome = await run(request.mode, undefined, undefined, false, undefined, {
      base: stateRef.current ?? state,
      request,
    });
    await carryRound(again, outcome, focus);
  }

  /**
   * A component asking to take the turn for the reader.
   *
   * Gate one decided whether this handler is reachable at all — a card that does
   * not declare `sendTurn` never gets it passed down. The other two are here: the
   * reader's one-off consent for this chat, and one component turn per model turn.
   */
  async function sendComponentTurn(text: string, directions?: string): Promise<void> {
    const content = text.trim();
    // Gate three. `mode` covers the streaming half; the flag covers the consent
    // prompt, where nothing is streaming yet and a second call would sail past.
    if (!content || mode || drawing || mutationRef.current || componentTurnRef.current) return;
    componentTurnRef.current = true;
    try {
      // Gate two: granted once per chat, and taken back from the notes panel.
      if (!state?.chat.allowComponentTurns) {
        if (!window.confirm(t('componentTurnConsent', { name: characterName }))) return;
        try {
          applyState(
            await apiSend<ChatState>('PATCH', `/api/chats/${id}`, { allowComponentTurns: true }),
          );
        } catch (caught) {
          setSettingsError(toMessage(caught));
          return;
        }
      }
      await generate('send', content, {
        source: 'component',
        ...(directions ? { directions } : {}),
      });
    } finally {
      componentTurnRef.current = false;
    }
  }
  // The frames hold the stable `sendTurn`, so the handler they reach through it
  // is always this render's — with this render's `mode` and consent state.
  sendTurnRef.current = (text, directions) => void sendComponentTurn(text, directions);

  /**
   * Three things the reader could say next. Reader-initiated and reader-owned —
   * unlike the creator's 선택지, which the plot's own characters offer inside a
   * reply — and nothing is stored, so a failure is worth a line beside the
   * button rather than the banner a lost turn gets.
   */
  async function suggest(): Promise<void> {
    if (mode || drawing || mutationRef.current || suggesting) return;
    setSuggesting(true);
    setSuggestError('');
    try {
      const answer = await apiSend<SuggestionsResult>('POST', `/api/chats/${id}/suggest`);
      setSuggestions(answer.suggestions);
      if (answer.suggestions.length === 0) setSuggestError(t('suggestEmpty'));
    } catch (caught) {
      setSuggestions([]);
      setSuggestError(toMessage(caught));
    } finally {
      setSuggesting(false);
    }
  }

  async function editMessage(message: ChatMessage, content: string): Promise<void> {
    if (!beginMutation()) return;
    try {
      await apiSend<{ messageId: string }>('PATCH', `/api/messages/${message.id}`, { content });
      await reload();
    } catch (caught) {
      setError(toMessage(caught));
      throw caught;
    } finally {
      endMutation();
    }
  }

  /**
   * Deleting a turn takes everything grown from it — the server prunes the whole
   * subtree — so it asks first. Other versions of the same turn are left alone.
   */
  async function deleteMessage(messageId: string): Promise<void> {
    if (!window.confirm(t('deleteConfirm'))) return;
    if (!beginMutation()) return;
    try {
      applyState(await apiSend<ChatState>('DELETE', `/api/chats/${id}/messages/${messageId}`));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      endMutation();
    }
  }

  /**
   * Hides a message from the AI or shows it to the AI again (SillyTavern's
   * /hide): it stays on screen either way. The server answers with the chat, as
   * a delete does — the memory may have dropped a summary that covered it.
   */
  async function toggleHidden(message: ChatMessage): Promise<void> {
    if (!beginMutation()) return;
    try {
      applyState(
        await apiSend<ChatState>('PUT', `/api/chats/${id}/messages/${message.id}/hidden`, {
          hidden: !message.hiddenFromPrompt,
        }),
      );
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      endMutation();
    }
  }

  /** Today and yesterday by name; anything further back by its date. */
  function dayLabel(iso: string): string {
    const named = relativeDay(iso, new Date());
    return named ? t(named) : format.dateTime(new Date(iso), { dateStyle: 'long' });
  }

  /**
   * The scene as the reader rewrote it. Every block the scene came with carries
   * its message id, touched or not: the server works out where the rewrite
   * diverged and forks there.
   */
  async function saveScene(messageIds: string[], blocks: SceneBlock[]): Promise<void> {
    if (!beginMutation()) return;
    try {
      await apiSend<ChatState>('POST', `/api/chats/${id}/edit-scene`, { messageIds, blocks });
      setSceneEdit(null);
      await reload();
    } catch (caught) {
      setError(toMessage(caught));
      throw caught;
    } finally {
      endMutation();
    }
  }

  async function moveHead(messageId: string): Promise<void> {
    if (!beginMutation()) return;
    try {
      applyState(await apiSend<ChatState>('POST', `/api/chats/${id}/head`, { messageId }));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      endMutation();
    }
  }

  /**
   * Draws the scene as it stands. The server answers with the whole state — the
   * narration turn and its picture already on the branch — so the placeholder row
   * is replaced by the real one in a single render. A failure stored nothing, so
   * the placeholder stays with the retry on it instead.
   */
  async function drawScene(): Promise<void> {
    if (mode || drawing || mutationRef.current) return;
    setDrawing(true);
    setDrawFailed(false);
    setError('');
    try {
      applyState(await apiSend<ChatState>('POST', `/api/chats/${id}/draw-scene`));
    } catch (caught) {
      setDrawFailed(true);
      setError(toMessage(caught));
    } finally {
      setDrawing(false);
    }
  }

  // These endpoints return an entire chat state. Keep their writes exclusive so
  // a late response cannot replace a newer branch or unlock another request.
  function beginMutation(): boolean {
    if (mutationRef.current || abortRef.current || mode || drawing) return false;
    mutationRef.current = true;
    setMutating(true);
    return true;
  }

  function endMutation(): void {
    mutationRef.current = false;
    setMutating(false);
  }

  /** Every chat setting goes through PATCH, which answers with the whole state. */
  async function updateSettings(patch: {
    model?: string;
    /** null hands the side work back to the first model in the catalog. */
    subModel?: string | null;
    /** null sends no effort, leaving the model's own default. */
    reasoningEffort?: string | null;
    personaId?: string | null;
    note?: string;
    preset?: string;
    /** The reader's own preset on top of `preset`; null picks none. */
    readerPresetId?: string | null;
    relationshipEnabled?: boolean;
    /** How a reply's emotion picture is chosen. */
    emotionProcessor?: EmotionProcessor;
    memorySettings?: ChatMemorySettings;
    allowComponentTurns?: boolean;
    /** The reader's half of the plot's two style features. */
    statusWindowEnabled?: boolean;
    choicesEnabled?: boolean;
    /** null clears the override and hands the chat back to the character's narrator. */
    narrator?: NarratorConfig | null;
    /** Members sent off the stage; an empty list is the whole roster on. */
    absentCharacterIds?: string[];
    /** The author's note's depth, frequency and role. */
    noteSettings?: Required<AuthorNoteSettings>;
    /** The language mode as the reader picked it, whole. */
    translation?: ChatTranslationSettings;
    /** Whether earlier messages are searched by meaning and brought back. */
    retrieval?: { enabled: boolean };
    /** The reader's library modules this chat's own list turns on. */
    modules?: string[];
    /** RisuAI's "Local Toggles": the toggles set here keep their values to this chat. */
    localToggles?: boolean;
  }): Promise<void> {
    if (!beginMutation()) return;
    setSettingsError('');
    try {
      applyState(await apiSend<ChatState>('PATCH', `/api/chats/${id}`, patch));
      // The reader preset brings its toggles and, by its module integration, modules.
      if ('readerPresetId' in patch) {
        void loadChatModules();
        reloadScripts();
      }
    } catch (caught) {
      setSettingsError(toMessage(caught));
    } finally {
      endMutation();
    }
  }

  /**
   * Sends a member off the stage or brings them back. Ids no member has any more
   * are dropped on the way: the server only takes the plot's own members.
   */
  async function toggleAbsent(memberId: string, absent: boolean): Promise<void> {
    const kept = (state?.chat.absentCharacterIds ?? []).filter(
      (other) => other !== memberId && members.some((member) => member.id === other),
    );
    await updateSettings({ absentCharacterIds: absent ? [...kept, memberId] : kept });
  }

  /**
   * One of the reader's global variables on the work — a toggle's value
   * (`toggle_<key>`) — written at once, as RisuAI writes it (`setGlobalChatVar`:
   * to this chat alone while its "Local Toggles" is on), and the page's copy
   * taken from the answer, which the scripts and the next prompt read.
   */
  async function setGlobalVariable(name: string, value: string): Promise<void> {
    setSettingsError('');
    try {
      const answer = await apiSend<{ variables: Variables }>('PATCH', `/api/chats/${id}/global-variables`, {
        variables: { [name]: value },
        toggles: true,
      });
      setState((current) => (current ? { ...current, globalVariables: answer.variables } : current));
    } catch (caught) {
      setSettingsError(toMessage(caught));
    }
  }

  /** Attaching a reusable note, which answers with the whole state as well. */
  async function toggleNote(noteId: string, attached: boolean): Promise<void> {
    if (!beginMutation()) return;
    setSettingsError('');
    try {
      applyState(
        await apiSend<ChatState>(attached ? 'POST' : 'DELETE', `/api/chats/${id}/notes/${noteId}`),
      );
    } catch (caught) {
      setSettingsError(toMessage(caught));
    } finally {
      endMutation();
    }
  }

  /** Adjacent sibling of the given message, or null at either end. */
  function siblingTarget(message: ChatMessage, direction: -1 | 1): string | null {
    const info = state?.siblings[message.id];
    return info?.ids[info.index + direction] ?? null;
  }

  /**
   * Branch navigation for a message that has more than one version. A scene edit
   * forks mid-path, so this is what makes the version it replaced reachable; the
   * head follows the sibling's deepest leaf, which brings its downstream back with
   * it. Undefined for a message that was never forked.
   */
  function branchNav(message: ChatMessage): {
    index: number;
    total: number;
    onPrev: (() => void) | null;
    onNext: (() => void) | null;
  } | undefined {
    const info = state?.siblings[message.id];
    if (!info || info.total < 2) return undefined;
    const prev = siblingTarget(message, -1);
    const next = siblingTarget(message, 1);
    return {
      index: info.index,
      total: info.total,
      onPrev: prev ? () => void moveHead(prev) : null,
      onNext: next ? () => void moveHead(next) : null,
    };
  }

  if (missing) return <CenteredMessage>{t('notFound')}</CenteredMessage>;
  // The plot's display scripts come with its read, which can only start once the
  // chat's has said which plot it is. Drawn before them, every status block shows
  // as the text it was written as and then rearranges, so a chat that may draw
  // custom UI waits for that one read too.
  if (!state || (customUi && !plotRead)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={common('loading')} />
      </div>
    );
  }

  /** A member by id, for the replies that name their speaker by it. */
  const memberById = new Map(members.map((member) => [member.id, member]));
  /** A model as the settings name it; an id the catalog no longer lists, as it is. */
  const modelName = (id: string): string => models.find((entry) => entry.id === id)?.label ?? id;
  const view: ViewMessage[] = messages.map((message) => {
    const continued = active === 'continue' && message.id === last?.id;
    const tagged = message.role === 'assistant' && message.speakerMemberId ? memberById.get(message.speakerMemberId) : undefined;
    const opening = isGreeting(message);
    // A reply the model wrote — not the opening, nor a turn a card's script wrote.
    const written = message.role === 'assistant' && !opening && message.source !== 'script';
    return {
      key: message.id,
      id: message.id,
      role: message.role,
      content: continued ? message.content + streamText : message.content,
      // What the display triggers draw, else what SillyTavern showed in the
      // message's place (`extra.display_text || mes`), else the greeting as its
      // conditions decide it.
      ...(!continued && scriptShown.has(message.id)
        ? { shown: scriptShown.get(message.id)! }
        : !continued && message.displayText
          ? { shown: message.displayText }
          : shownGreetings.has(message.id)
            ? { shown: shownGreetings.get(message.id)! }
            : {}),
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      ...(message.bias ? { bias: message.bias } : {}),
      attachments: message.attachments,
      createdAt: message.createdAt,
      streaming: continued && mode !== null,
      // A group reply is wholly its speaker's; a character message a card's script
      // wrote is the scripted member's.
      ...(tagged
        ? { speaker: tagged.name }
        : message.role === 'assistant' && message.source === 'script' && scriptSpeaker
          ? { speaker: scriptSpeaker }
          : {}),
      ...(group && (tagged?.id ?? firstMemberId) ? { member: tagged?.id ?? firstMemberId! } : {}),
      ...(group && tagged ? { spoken: true } : {}),
      ...(opening ? { intro: true } : {}),
      ...(written ? { model: modelName(message.model ?? state.chat.model) } : {}),
      ...(message.hiddenFromPrompt ? { hidden: true } : {}),
    };
  });

  if (active === 'regenerate' && replacing > 0) view.splice(view.length - replacing, replacing);
  /**
   * Who the round in hand asks now — and, after a failure, whose partial reply is
   * still held on screen: a member's id, or the narrator's.
   */
  const roundSpeaker = active !== null ? round?.queue[0] : undefined;
  const streamMember = roundSpeaker ? memberById.get(roundSpeaker) : undefined;
  if (mode === 'send') {
    view.push({
      key: 'pending-user',
      id: null,
      role: 'user',
      content: pendingUser,
      attachments: pendingAttachments,
      createdAt: null,
      streaming: false,
      ...(group && firstMemberId ? { member: firstMemberId } : {}),
    });
  }
  // Auto-continue appends a new reply, so unlike regenerate it keeps the head
  // bubble and streams below it. When what is being generated is a narration, the
  // prefix the server will store goes on the optimistic text — which is all
  // MessageRow needs to draw it as one while it streams, rather than flipping it
  // when the turn lands.
  // A round's next speaker streams below the last reply the same way, under
  // their own face from the first moment.
  if (active === 'send' || active === 'regenerate' || active === 'auto' || active === 'narrate' || active === 'reply') {
    const narrates = roundSpeaker !== undefined ? roundSpeaker === NARRATOR_SPEAKER : streamsNarration(active, last);
    view.push({
      key: 'streaming',
      id: null,
      role: 'assistant',
      content: narrates ? `${NARRATION_PREFIX} ${streamText}` : streamText,
      attachments: NO_ATTACHMENTS,
      createdAt: null,
      streaming: mode !== null,
      ...(streamMember ? { speaker: streamMember.name } : {}),
      // Dressed as its speaker's from the first token, as it will be once stored.
      ...(group && streamMember ? { member: streamMember.id, spoken: true } : {}),
    });
  }

  /**
   * What each row needs from the rows around it — the previous turn of the same
   * role for `repeat_back`, where a new day begins, and which turns continue the
   * one above them. One pass rather than a scan per row: every streamed frame
   * rebuilds this, and a scan made that quadratic in the length of the branch.
   */
  // A greeting is read as it is shown, so `repeat_back` carries over what the reader saw.
  const rowMeta = chatRowMeta(
    shownGreetings.size === 0
      ? view
      : view.map((row) => (row.shown === undefined ? row : { ...row, content: row.shown })),
  );

  // The scene being edited, if any. It is grouped from the branch as it stands, so
  // a message that is no longer on it simply leaves nothing to draw.
  const sceneIndex = sceneEdit ? messages.findIndex((message) => message.id === sceneEdit) : -1;
  const sceneSpan = sceneIndex < 0 ? null : sceneSpanAt(messages, sceneIndex);
  const scene = sceneSpan ? messages.slice(sceneSpan.start, sceneSpan.end) : [];
  const sceneIds = new Set(scene.map((message) => message.id));

  /**
   * The one send, whichever way it was asked for. An image still on its way up
   * holds it: the turn names its uploads by id, so sending before they exist
   * would send the turn without them.
   */
  const attaching = isUploading(chips);
  /**
   * An import is still writing this chat's history, and until it finishes the API
   * refuses every other write (`chat_importing`). The chat reads as it stands so
   * far, and everything that would write is held — the composer included.
   */
  const importing = state.chat.importing === true;
  /**
   * The member the composer writes as, while still on the stage — or null for
   * the reader's own voice. Only in a work of several members.
   */
  const writer = group && writeAs ? (stage.find((member) => member.id === writeAs) ?? null) : null;
  /**
   * Whether a send would know how the work answers. A work's cast comes with the
   * plot's read, and a send before it would answer a work of several as one.
   */
  const castPending = !plotRead;
  /** RisuAI's input translation: the reader writes in their language, the turn goes out in the work's. */
  const translateInput = languageMode?.input === true;
  function submit(): void {
    if (!input.trim() || mode || drawing || serverGenerating || mutationRef.current || attaching || importing || scriptsPending || castPending || translatingInput) return;
    // The chip is a way of typing: what is stored is the plain convention, the
    // same one the reader could have written the marks of by hand — a member's
    // line included (`@이름: …`).
    const content = composeTurn(input, composerMode, writer?.name ?? null);
    const attachmentIds = uploadedIds(chips);
    const options = attachmentIds.length > 0 ? { attachmentIds } : undefined;
    // Slash commands only where RisuAI's scripts run; anywhere else `/…` is just text.
    if (runtime && input.startsWith('/')) {
      setInput('');
      void runCommand(input, content, options);
      return;
    }
    if (!translateInput) {
      setInput('');
      void generate('send', content, options);
      return;
    }
    // Translated first, as RisuAI's input box holds the translation before the
    // send: the stored turn, the scripts and the model all read the work's
    // language. The reader's words stay in the box until it has arrived, and a
    // translation that fails sends nothing.
    setTranslatingInput(true);
    setError('');
    void apiSend<{ text: string }>('POST', `/api/chats/${id}/translate-input`, { text: content })
      .then(({ text }) => {
        setInput('');
        void generate('send', text, options);
      }, (caught: unknown) => setError(toMessage(caught)))
      .finally(() => setTranslatingInput(false));
  }
  const languageView =
    plot && isTranslationLanguage(plot.language)
      ? {
          settings: state.chat.translation ?? {},
          plotLanguage: plot.language,
          locale: isTranslationLanguage(locale) ? locale : plot.language,
          recommended: translateRecommended,
        }
      : undefined;

  /**
   * The reply the footer's swipe moves: in a work of several members the first of
   * the round the branch ends on, whose siblings are the round's other takes —
   * moving to one brings its whole round back. The head itself otherwise.
   */
  const roundHead = group && last?.role === 'assistant' ? messages[roundStart(messages)] : last;
  const info = roundHead ? state.siblings[roundHead.id] : undefined;
  // A drawn scene takes the same per-chat slot a generation does, so while one is
  // in flight the row of actions is withheld exactly as it is while text streams.
  const showActions = !mode && !drawing && !mutating && !importing && !scriptsPending && !castPending && Boolean(last);
  /**
   * The two features the plot turns on and the reader may turn back off. The
   * panel offers a toggle only where the plot asked for the feature at all — a
   * switch for something that was never going to happen is noise — while the
   * choice buttons follow the reader's own answer, so a chat that has them off
   * is not offered the lines an older turn still carries.
   */
  const plotStatusWindow = plot?.style?.statusWindow === true;
  const plotChoices = (plot?.style?.choices ?? 'off') !== 'off';
  const choicesOffered = state.chat.choicesEnabled;
  const settingsLocked = Boolean(mode) || drawing || mutating || importing;
  const prevTarget = roundHead && !mode ? siblingTarget(roundHead, -1) : null;
  const nextTarget = roundHead && !mode ? siblingTarget(roundHead, 1) : null;
  /** The speakers a running round has still to ask after the one it asks now. */
  const upNext =
    mode !== null && round
      ? round.queue.slice(1).map((speaker) => memberById.get(speaker)?.name ?? t('narrator'))
      : [];

  return (
    // A column exactly as tall as what is left under the header, so the list
    // below is the only thing that scrolls and the composer never moves.
    <div className="chat-workspace flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="shrink-0 border-b border-line bg-surface">
        {/* One row on a phone, where the title is what gives way — after everything
            that can step aside has: the music's mute goes into the settings sheet,
            the settings into an icon, and the model pill gives its place to the
            card screen's way out while that is open. The wide row wraps its controls. */}
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-5 py-2.5 lg:flex-wrap lg:gap-3">
          <Link
            // The work's own page, which is the same one for creator and reader.
            href={`/p/${state.chat.plotId}`}
            className="flex min-w-0 items-center gap-2.5"
            title={t('backToPlot')}
          >
            <Avatar src={plot?.coverUrl ?? null} name={characterName} className="size-8 shrink-0 text-sm" />
            <span className="truncate text-sm font-medium">{characterName}</span>
          </Link>
          <AiBadge />
          {/* While the page has music; on a phone, in the settings sheet. */}
          <span className="hidden lg:contents">
            <BgmMute />
          </span>
          {/* While a card's floating screen is open: the quiet way out of it. On a
              phone the row has room for its mark alone, so the title still shows. */}
          {cardOverlays.open ? (
            <button
              type="button"
              data-testid="close-card-screen"
              aria-label={t('closeCardScreen')}
              title={t('closeCardScreen')}
              onClick={closeCardOverlays}
              className="ml-auto inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-full border border-line px-2 text-xs text-muted transition-colors hover:border-muted/60 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:px-2.5"
            >
              <span aria-hidden="true">✕</span>
              <span aria-hidden="true" className="hidden sm:inline">
                {t('closeCardScreen')}
              </span>
            </button>
          ) : null}

          {/* Wide enough for the controls, and they stand in the header. Narrower
              than that, one button opens them in a sheet from the bottom edge. */}
          <div className={cx('hidden items-center gap-2 lg:flex', !cardOverlays.open && 'ml-auto')}>
            <ChatSettings
              model={state.chat.model}
              subModel={state.chat.subModel}
              reasoningEffort={state.chat.reasoningEffort}
              preset={state.chat.preset}
              personaId={state.chat.personaId}
              models={models}
              presets={presets}
              personas={personas}
              readerPresetId={state.chat.readerPresetId}
              readerPresets={readerPresets}
              onReaderPresetsChange={changeReaderPresets}
              disabled={settingsLocked}
              retrieval={state.chat.retrieval?.enabled ?? false}
              onChange={(patch) => void updateSettings(patch)}
              {...(languageView ? { language: languageView } : {})}
            />
            <Button
              size="sm"
              variant={panelOpen ? 'secondary' : 'ghost'}
              aria-expanded={panelOpen}
              onClick={() => setPanelOpen((open) => !open)}
            >
              {t('notes')}
            </Button>
          </div>
          {/* Zeta's "zeta ⌄": the main model, where the row has no room for the controls
              above — and not while a card's screen is open, whose way out takes its
              place; the sheet still has it. */}
          {cardOverlays.open ? null : (
            <ModelPill
              model={state.chat.model}
              models={models}
              disabled={settingsLocked}
              className="ml-auto max-w-24! lg:hidden"
              onChange={(model) => void updateSettings({ model })}
            />
          )}
          <Button
            size="sm"
            variant={sheetOpen ? 'secondary' : 'ghost'}
            aria-expanded={sheetOpen}
            aria-label={t('settings')}
            title={t('settings')}
            className="shrink-0 rounded-full! px-2! lg:hidden"
            onClick={() => setSheetOpen(true)}
          >
            <Icon name="sliders" className="size-4" />
          </Button>
        </div>

        {settingsError ? (
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 pb-2.5">
            <p className="min-w-0 flex-1 text-xs text-danger">{settingsError}</p>
            <button
              type="button"
              onClick={() => setSettingsError('')}
              aria-label={common('close')}
              className="text-xs text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              ✕
            </button>
          </div>
        ) : null}
      </div>

      {/* Settings stay above the list rather than inside it: opening the panel
          should not push the conversation off the bottom of its own container. */}
      {panelOpen ? (
        <div className="max-h-[35dvh] shrink-0 overflow-y-auto border-b border-line">
          <div className="mx-auto w-full max-w-3xl px-5 py-5">
            <ChatPanel
              chatId={id}
              headMessageId={state.chat.headMessageId}
              memoryRevision={state.chat.memoryRevision}
              members={members}
              note={state.chat.note}
              noteSettings={state.chat.noteSettings}
              onSaveNoteSettings={(noteSettings) => updateSettings({ noteSettings })}
              notes={notes}
              noteIds={state.chat.noteIds}
              memorySettings={state.chat.memorySettings}
              relationship={state.chat.relationship}
              relationshipEnabled={state.chat.relationshipEnabled}
              emotionProcessor={state.chat.emotionProcessor ?? 'submodel'}
              onSaveEmotionProcessor={(emotionProcessor) => updateSettings({ emotionProcessor })}
              narrator={state.chat.narrator}
              onSaveNarrator={(narrator) => updateSettings({ narrator })}
              illustrations={gallery}
              disabled={settingsLocked}
              onSaveNote={(note) => updateSettings({ note })}
              onToggleNote={toggleNote}
              onSaveMemorySettings={(memorySettings) => updateSettings({ memorySettings })}
              onToggleRelationship={(relationshipEnabled) => updateSettings({ relationshipEnabled })}
              allowComponentTurns={state.chat.allowComponentTurns}
              onToggleComponentTurns={(allowComponentTurns) => updateSettings({ allowComponentTurns })}
              statusWindow={plotStatusWindow}
              statusWindowEnabled={state.chat.statusWindowEnabled}
              onToggleStatusWindow={(statusWindowEnabled) => updateSettings({ statusWindowEnabled })}
              choices={plotChoices}
              choicesEnabled={state.chat.choicesEnabled}
              onToggleChoices={(choicesEnabled) => updateSettings({ choicesEnabled })}
              absentCharacterIds={state.chat.absentCharacterIds}
              onToggleAbsent={toggleAbsent}
              {...(group
                ? { onSpeakNow: (memberId: string) => void playRound({ opening: 'reply', speakers: [memberId] }) }
                : {})}
              {...(state.isPlotOwner ? { inspectChatId: state.chat.id } : {})}
              customUi={customUi}
              onToggleCustomUi={(enabled) => {
                writeCustomUiEnabled(enabled);
                setCustomUi(enabled);
              }}
              scriptSimilarity={scriptBundle?.lowLevelAccess ?? false}
              modules={
                <>
                  <ModuleToggles
                    text={chatModules?.toggles ?? ''}
                    values={state.globalVariables}
                    onSet={setGlobalVariable}
                    local={state.chat.localToggles ?? false}
                    disabled={settingsLocked}
                    onLocal={(localToggles) => updateSettings({ localToggles })}
                  />
                  {chatModules ? (
                    <ReaderModules
                      library={chatModules.library}
                      plotId={state.chat.plotId}
                      chatIds={state.chat.modules ?? []}
                      disabled={settingsLocked}
                      onChatIds={async (modules) => {
                        await updateSettings({ modules });
                        await loadChatModules();
                        reloadScripts();
                      }}
                      onChange={async () => {
                        await loadChatModules();
                        reloadScripts();
                      }}
                    />
                  ) : null}
                </>
              }
            />
          </div>
        </div>
      ) : null}

      {/* The chat area: the emotion screen, where the work's cards show one, and
          the column of the conversation and the composer. The screen is a band
          above the column on a narrow screen and a column beside it on a wide one. */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {emotionScreen.length > 0 ? <EmotionScreen chatId={state.chat.id} slots={emotionScreen} /> : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The conversation's area. What a card draws behind the chat stands still
              in it while the list scrolls over it, as RisuAI's background does, and
              what a card floats (`position: fixed`) floats over it and no further. */}
          <div ref={setStageElement} data-testid="chat-stage" className="chat-stage relative flex min-h-0 flex-1 flex-col">
            {backgroundContext ? (
              <ChatBackground html={shownBackground} context={backgroundContext} scripts={backgroundScripts} />
            ) : null}
            <div
              ref={scrollRef}
              // Positioned only over a background, which it has to paint above —
              // and what stands on it with no bubble of its own gets a veil there.
              className={cx('min-h-0 flex-1 overflow-y-auto overscroll-contain', backgroundContext && 'chat-backdrop relative')}
              // What a message measures "near the screen" against (`lib/translation`).
              data-message-list=""
              // RisuAI's `HideIconStore`: a module or the card hides every sender's picture and name.
              {...(chatModules?.hideIcons ? { 'data-hide-icons': '' } : {})}
              // Reading upwards into a long chat: near the top, the window before this
              // one is fetched and put in above without moving what is on screen.
              onScroll={(event) => {
                if (event.currentTarget.scrollTop < LOAD_EARLIER_PX) void loadEarlier();
              }}
            >
              <div
                ref={contentRef}
                // The bottom padding is for the jump-to-latest pill, which floats over
                // the last line of the conversation when it is showing.
                className="mx-auto w-full max-w-3xl space-y-7 px-5 pt-7 pb-12"
                // What a button in a message can do: run one of the card's manual
                // triggers (`risu-trigger`, `{{button}}` naming one) or hand a Lua button
                // its data (`risu-btn`), or put its text in the composer — sending that
                // stays the reader's decision.
                onClick={(event) => {
                  const target = event.target as HTMLElement;
                  const scripted = target.closest?.('[data-shizue-trigger], [data-shizue-btn]');
                  if (scripted) {
                    // The scripts of the member who spoke the message holding the button;
                    // the lead's in a message no member speaks.
                    const row = scripted.closest('[data-shizue-member]');
                    const member = row?.hasAttribute('data-shizue-spoken') ? row.getAttribute('data-shizue-member') : null;
                    const name = scripted.getAttribute('data-shizue-trigger');
                    if (name !== null) void runManualTrigger(name, scripted.getAttribute('data-shizue-trigger-id'), member);
                    else void runLuaButton(scripted.getAttribute('data-shizue-btn') ?? '', member);
                    return;
                  }
                  const button = target.closest?.('[data-shizue-fill]');
                  if (button) setInput(button.getAttribute('data-shizue-fill') ?? '');
                }}
              >
                <AiNotice />

                {creatorSheet ? (
                  <div
                    hidden
                    data-testid="creator-css"
                    // Sanitized by lib/sanitizeHtml — the only place markup is trusted.
                    dangerouslySetInnerHTML={{ __html: creatorSheet }}
                  />
                ) : null}
                {memberSheets.map(({ memberId, sheet }) => (
                  <div
                    key={memberId}
                    hidden
                    data-testid="member-css"
                    // Sanitized by lib/sanitizeHtml, scoped to this member's rows.
                    dangerouslySetInnerHTML={{ __html: sheet }}
                  />
                ))}

                {loadingEarlier ? (
                  <p className="text-center text-xs text-muted" role="status">
                    {t('loadingEarlier')}
                  </p>
                ) : null}

                {view.length === 0 ? <p className="py-16 text-center text-sm text-muted">{t('empty')}</p> : null}

                {view.map((message, index) => {
                  const meta = rowMeta[index]!;
                  const source = message.id ? messageById.get(message.id) : undefined;
                  const isLast = index === view.length - 1;
                  // Every forked message carries its own way back, except the last assistant
                  // one — the footer's swipe already sits under that — and, in a work of
                  // several members, the first reply of the last round, whose takes the
                  // footer moves between.
                  const branches =
                    source &&
                    !mode &&
                    !(isLast && last?.role === 'assistant') &&
                    !(group && last?.role === 'assistant' && source.id === roundHead?.id)
                      ? branchNav(source)
                      : undefined;
                  // Where the conversation crossed midnight. It belongs to the row it
                  // stands above, so the scene editor gets it as readily as a message.
                  const divider = meta.dayStart ? (
                    <div className="flex items-center gap-3">
                      <span className="h-px flex-1 bg-line" />
                      <span className="chat-meta text-xs text-muted">{dayLabel(meta.dayStart)}</span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  ) : null;
                  // The scene's rows give way to one editor, drawn where the first of them was.
                  if (message.id && sceneIds.has(message.id)) {
                    return (
                      <Fragment key={message.key}>
                        {divider}
                        {message.id === scene[0]?.id ? (
                          <SceneEditor
                            scene={scene}
                            characterName={characterName}
                            youName={t('you')}
                            disabled={settingsLocked}
                            onCancel={() => setSceneEdit(null)}
                            onSave={(blocks) => saveScene(scene.map((item) => item.id), blocks)}
                          />
                        ) : null}
                      </Fragment>
                    );
                  }
                  return (
                    <Fragment key={message.key}>
                      {divider}
                      <MessageRow
                        role={message.role}
                        content={message.content}
                        {...(message.shown !== undefined ? { shown: message.shown } : {})}
                        {...(message.reasoning ? { reasoning: message.reasoning } : {})}
                        {...(message.bias ? { bias: message.bias } : {})}
                        name={message.role === 'user' ? (personaName ?? t('you')) : characterName}
                        avatar={plot?.coverUrl ?? null}
                        userImage={personaAvatarUrl}
                        roster={members}
                        {...(message.speaker ? { speaker: message.speaker } : {})}
                        {...(message.member ? { member: message.member, ...(message.spoken ? { spoken: true } : {}) } : {})}
                        assets={messageAssets}
                        resolveAsset={
                          emotionResolvers.get(
                            (message.spoken ? message.member : members.length === 1 ? members[0]!.id : undefined) ?? '',
                          ) ?? resolveAsset
                        }
                        attachments={message.attachments}
                        {...(displayContextAt(displayOf(message), meta.depth, sideOf(message))
                          ? { display: displayContextAt(displayOf(message), meta.depth, sideOf(message))! }
                          : {})}
                        {...(buttonsOf(message) ? { buttons: buttonsOf(message)! } : {})}
                        {...(components ? { components } : {})}
                        componentNames={declaredComponents}
                        previousSameRole={meta.previousSameRole}
                        chatIndex={indexBase + index}
                        streaming={message.streaming}
                        // Nothing of the reply on screen yet: the time it has been
                        // waited for, which is all of the model's thinking that is shown.
                        thinking={message.streaming && streamText === ''}
                        // In a round, whom the row waits on: the face its reply will carry.
                        {...(message.id === null && message.role === 'assistant' && streamMember
                          ? { typing: { name: streamMember.name, avatarUrl: streamMember.avatarUrl } }
                          : {})}
                        disabled={settingsLocked}
                        {...(message.createdAt ? { createdAt: message.createdAt } : {})}
                        grouped={meta.grouped}
                        {...(message.intro ? { intro: true } : {})}
                        // Translated once it is stored and its output scripts have run: every
                        // message in the translation mode, and where the model is asked to write
                        // in the reader's language, what the card wrote: its openings and the
                        // messages its scripts wrote.
                        {...(translator &&
                        languageMode &&
                        source &&
                        source.scriptState !== 'pending' &&
                        translatesMessage(languageMode.mode, { intro: message.intro === true, scripted: source.source === 'script' })
                          ? {
                              translator,
                              translationId: source.id,
                              // The edittrans scripts of the member the message is, as RisuAI runs its character's.
                              translationScripts: translationScripts.get(message.member ?? members[0]?.id ?? ''),
                            }
                          : {})}
                        {...(message.model ? { model: message.model } : {})}
                        statusCollapsed={statusCollapsed}
                        onToggleStatus={toggleStatus}
                        // The offer stands under the newest reply and nowhere else, and
                        // only while nothing is being generated over it.
                        {...(isLast && showActions && message.role === 'assistant' && choicesOffered
                          ? { onChoice: suggestInput }
                          : {})}
                        {...(source && !mode && !isSceneMessage(source)
                          ? { onSave: (content: string) => editMessage(source, content) }
                          : {})}
                        // A turn the scene is made of is edited with the whole scene.
                        {...(source && !mode && isSceneMessage(source)
                          ? { onEditScene: () => setSceneEdit(source.id) }
                          : {})}
                        {...(source && !mode ? { onDelete: () => void deleteMessage(source.id) } : {})}
                        {...(message.hidden ? { hidden: true } : {})}
                        {...(source && !mode ? { onToggleHidden: () => void toggleHidden(source) } : {})}
                        {...(branches ? { branches } : {})}
                        footer={
                          isLast && showActions ? (
                            <div
                              className={cx(
                                'chat-veil mt-2 flex w-fit items-center gap-1',
                                message.role === 'user' && 'justify-end',
                              )}
                            >
                              {last?.role === 'assistant' && info && info.total > 1 ? (
                                <div className="mr-1 flex items-center gap-1 text-xs text-muted">
                                  <button
                                    type="button"
                                    disabled={!prevTarget}
                                    title={t('swipePrev')}
                                    aria-label={t('swipePrev')}
                                    onClick={() => prevTarget && void moveHead(prevTarget)}
                                    className="px-1 hover:text-fg disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                                  >
                                    <span aria-hidden="true">◀</span>
                                  </button>
                                  <span className="tabular-nums">
                                    {info.index + 1}/{info.total}
                                  </span>
                                  <button
                                    type="button"
                                    disabled={!nextTarget}
                                    title={t('swipeNext')}
                                    aria-label={t('swipeNext')}
                                    onClick={() => nextTarget && void moveHead(nextTarget)}
                                    className="px-1 hover:text-fg disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                                  >
                                    <span aria-hidden="true">▶</span>
                                  </button>
                                </div>
                              ) : null}
                              {/* In a work of several members: the whole round again, and
                                  a round of its own after the last reply. */}
                              <Button
                                size="sm"
                                variant="ghost"
                                {...(group ? { title: t('regenerateRoundHint') } : {})}
                                onClick={() => void generate('regenerate')}
                              >
                                {t('regenerate')}
                              </Button>
                              {/* A narration answers a user turn as readily as it follows a
                                  reply, so unlike continue/auto it is offered under both. */}
                              <Button
                                size="sm"
                                variant="ghost"
                                title={t('narrateHint')}
                                onClick={() => void generate('narrate')}
                              >
                                {t('narrate')}
                              </Button>
                              {last?.role === 'assistant' ? (
                                <>
                                  {/* Continue and auto are the two the row can do
                                      without on a phone: the least reached for, and the
                                      easiest to describe in a menu. */}
                                  <div className="hidden items-center gap-1 sm:flex">
                                    {/* A reply hidden from the AI is not continued: its
                                        text would go out as the reply being resumed. */}
                                    {!last.hiddenFromPrompt ? (
                                      <Button size="sm" variant="ghost" onClick={() => void generate('continue')}>
                                        {t('continue')}
                                      </Button>
                                    ) : null}
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      {...(group ? { title: t('autoRoundHint') } : {})}
                                      onClick={() => void generate('auto')}
                                    >
                                      {t('auto')}
                                    </Button>
                                  </div>
                                  <MoreActions
                                    label={t('moreActions')}
                                    className="sm:hidden"
                                    actions={[
                                      ...(!last.hiddenFromPrompt
                                        ? [
                                            {
                                              key: 'continue',
                                              label: t('continue'),
                                              onSelect: () => void generate('continue'),
                                            },
                                          ]
                                        : []),
                                      { key: 'auto', label: t('auto'), onSelect: () => void generate('auto') },
                                    ]}
                                  />
                                </>
                              ) : null}
                              {/* Only where the deployment has an image provider: the
                                  server decides, and says so on every chat read. */}
                              {state.capabilities?.drawScene ? (
                                <Button size="sm" variant="ghost" onClick={() => void drawScene()}>
                                  {t('drawScene')}
                                </Button>
                              ) : null}
                            </div>
                          ) : null
                        }
                      />
                    </Fragment>
                  );
                })}

                {/* Where the drawn scene will land: a box of its own aspect while the
                    provider works, and the same box with the retry in it if it never
                    came. The message the refetch brings back replaces this outright. */}
                {drawing || drawFailed ? (
                  <SceneDraft
                    status={drawing ? 'drawing' : 'failed'}
                    onRetry={() => void drawScene()}
                  />
                ) : null}

                {/* Directly under the row it belongs to, which is the streaming one when
                    a stream failed part-way: its text is still up there, unstored. */}
                {error ? (
                  <div
                    role="alert"
                    className="flex items-center gap-3 rounded-lg border border-danger/40 bg-danger/5 px-3.5 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-danger">{error}</p>
                      {ambiguous ? <p className="mt-1 text-xs text-muted">{t('sendMaybeDelivered')}</p> : null}
                      {held ? <p className="mt-1 text-xs text-muted">{t('streamError')}</p> : null}
                    </div>
                    {retryable && !mode ? (
                      <Button
                        size="sm"
                        variant="danger"
                        // A round that failed asks the same speaker again and goes on.
                        onClick={() => void (round?.failed ? retryRound() : generate('regenerate'))}
                      >
                        {common('retry')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="relative shrink-0 border-t border-line bg-surface">
            {/* Only while the reader has scrolled away: new text never drags them
                back down, so this is how they choose to follow it again. Round, at
                the column's bottom-right, as Zeta has it. */}
            {isAtBottom ? null : (
              <div className="pointer-events-none absolute inset-x-0 -top-14 px-5">
                <div className="mx-auto flex max-w-3xl justify-end">
                  <button
                    type="button"
                    aria-label={t('jumpToLatest')}
                    title={t('jumpToLatest')}
                    onClick={() => void scrollToBottom()}
                    className="pointer-events-auto flex size-10 items-center justify-center rounded-full border border-line bg-surface text-fg shadow-lg transition-colors hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <Icon name="arrow" className="size-5 rotate-90" />
                  </button>
                </div>
              </div>
            )}
            {importing ? (
              <div
                role="status"
                data-testid="chat-importing"
                className="mx-auto flex max-w-3xl items-center gap-3 px-5 pt-3"
              >
                <p className="min-w-0 flex-1 rounded-xl border border-line bg-raised/60 px-4 py-2.5 text-xs text-muted">
                  {t('importing')}
                </p>
                <Button size="sm" onClick={() => void reload()}>
                  {t('importingReload')}
                </Button>
              </div>
            ) : null}
            <div className="mx-auto w-full max-w-3xl">
              <AttachmentChips chips={chips} onRemove={dropChip} onRetry={retryChip} />
              {attachError ? (
                <p className="px-5 pt-2 text-xs text-danger" role="status">
                  {attachError}
                </p>
              ) : null}
            </div>
            {/* What the reader could say next, for the turns where nothing comes to
                mind. A chip fills the composer and stops there — sending stays the
                reader's own act, exactly as it is for a display script's button. */}
            {suggestions.length > 0 ? (
              <ul
                data-testid="reply-suggestions"
                className="mx-auto flex max-w-3xl flex-wrap gap-2 px-5 pt-3"
              >
                {suggestions.map((suggestion, index) => (
                  <li key={index} className="min-w-0">
                    <button
                      type="button"
                      data-testid="reply-suggestion"
                      aria-label={t('suggestionLabel', { text: suggestion })}
                      onClick={() => {
                        setInput(suggestion);
                        composerRef.current?.focus();
                      }}
                      className="max-w-full rounded-lg border border-line px-3 py-1.5 text-left text-xs text-muted transition-colors hover:border-muted/60 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      <span className="line-clamp-2 block">{suggestion}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {suggestError ? (
              <p className="mx-auto max-w-3xl px-5 pt-2 text-xs text-muted" role="status">
                {suggestError}
              </p>
            ) : null}
            {scriptNotice ? (
              <p data-testid="script-notice" className="mx-auto max-w-3xl px-5 pt-2 text-xs text-muted" role="status">
                {scriptNotice}
              </p>
            ) : null}
            {/* A reply the server is finishing without a stream to this page: the
                connection dropped, or the page came back to one already going. */}
            {waitingOnServer || (serverGenerating && !mode && !drawing) ? (
              <p data-testid="server-generating" className="mx-auto max-w-3xl px-5 pt-2 text-xs text-muted" role="status">
                {t('serverGenerating')}
              </p>
            ) : null}
            {/* Who the round in hand still has to ask, quietly: the row above the
                composer already shows whom it is waiting on now. */}
            {upNext.length > 0 ? (
              <div className="mx-auto max-w-3xl px-5 pt-3" role="status">
                <span
                  data-testid="round-next"
                  className="inline-flex max-w-full rounded-full border border-line px-3 py-1 text-xs text-muted"
                >
                  <span className="truncate">{t('roundNext', { names: upNext.join(', ') })}</span>
                </span>
              </div>
            ) : null}

            {/* What the reader is about to write: their own line, their 상황묘사, or
                the narrator's — and in a work of several members, whose line it is.
                It marks the text on its way out and nothing more — the message is
                stored in the same notation either way. */}
            <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 px-5 pt-3">
              <div
                role="group"
                aria-label={t('composerMode')}
                className="flex gap-1 rounded-lg border border-line bg-surface/60 p-1"
              >
                {COMPOSER_MODES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={composerMode === value}
                    title={t(`composerModes.${value}Hint`)}
                    onClick={() => {
                      setComposerMode(value);
                      // The narrator is no member: a narration is nobody's line.
                      if (value === 'narration') setWriteAs(null);
                    }}
                    className={cx(
                      'rounded-md px-3 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                      composerMode === value ? 'bg-mint-soft font-medium text-fg' : 'text-muted hover:text-fg',
                    )}
                  >
                    {t(`composerModes.${value}`)}
                  </button>
                ))}
              </div>
              {group && stage.length > 0 ? (
                <WriteAsPicker
                  members={stage}
                  selected={writer?.id ?? null}
                  onChange={(memberId) => {
                    setWriteAs(memberId);
                    if (memberId !== null && composerMode === 'narration') setComposerMode('dialogue');
                  }}
                />
              ) : null}
              {/* Beside the chips, because it is about the same thing they are: what
                  the reader is about to write. Withheld while a reply streams — what
                  it would suggest is an answer to a turn that has not arrived. */}
              <Button
                size="sm"
                variant="ghost"
                data-testid="suggest-button"
                title={t('suggestHint')}
                busy={suggesting}
                disabled={Boolean(mode) || drawing || importing}
                onClick={() => void suggest()}
              >
                <span aria-hidden="true">✦</span>
                {t('suggest')}
              </Button>
              {/* Only where there is a choice to make: a lone member on the stage is
                  who every reply is about anyway. */}
              {stage.length > 1 ? <FocusPicker members={stage} selected={focus} onChange={setFocus} /> : null}
            </div>
            {/* Zeta's composer: the picture button, the field with its `*` inside,
                and the round send. */}
            <div className="mx-auto flex max-w-3xl items-end gap-2 px-5 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              {/* The picker is the button's doing; the input itself is never seen. */}
              <input
                ref={filePicker}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  addFiles([...(event.target.files ?? [])]);
                  // Cleared so picking the same file again still counts as a change.
                  event.target.value = '';
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('attach')}
                title={t('attach')}
                disabled={Boolean(mode) || importing}
                className="mb-1 shrink-0 rounded-full! px-2.5!"
                onClick={() => filePicker.current?.click()}
              >
                <Icon name="attach" className="size-4" />
              </Button>
              <div className="relative min-w-0 flex-1">
                <TextArea
                  ref={composerRef}
                  rows={1}
                  value={input}
                  // Unlike a streaming reply, an import has no end the reader is waiting
                  // on in the composer, so the field itself is held with the rest.
                  disabled={importing}
                  aria-label={t('placeholder')}
                  placeholder={
                    translateInput && plot
                      ? t('placeholderTranslated', { work: localeNames(plot.language) })
                      : t('placeholder')
                  }
                  // Typing goes on while the reply streams — only sending waits for it
                  // (`submit` checks `mode`). Locking the field would also throw the
                  // keyboard user's focus away mid-turn.
                  onChange={(event) => setInput(event.target.value)}
                  // An image on the clipboard is an image to attach; text pastes into
                  // the field as it always did, because nothing here touches it.
                  onPaste={(event) => {
                    const files = [...event.clipboardData.files];
                    if (files.length === 0) return;
                    event.preventDefault();
                    addFiles(files);
                  }}
                  onKeyDown={(event) => {
                    // Exactly Cmd/Ctrl+I: with shift or alt it is the browser's own
                    // shortcut (devtools), and taking that would be worse than useful.
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      !event.shiftKey &&
                      !event.altKey &&
                      event.key.toLowerCase() === 'i'
                    ) {
                      event.preventDefault();
                      toggleDirection();
                      return;
                    }
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  // Its height is written by `autoGrow`, so the drag handle would only
                  // be overruled on the next keystroke; past `max-h-48` it scrolls.
                  // The right padding is the `*` button's, which sits inside the field.
                  className="block max-h-48 min-h-11 resize-none! overflow-y-auto rounded-3xl border-focus/50 bg-surface py-2.5 pr-11 pl-4"
                />
                <button
                  type="button"
                  aria-label={t('direction')}
                  title={t('directionHint')}
                  disabled={Boolean(mode) || importing}
                  onClick={toggleDirection}
                  className="absolute right-1.5 bottom-1.5 flex size-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {/* The asterisk sits high in its em box, so what is centred is the box
                      and not the glyph. The nudge centres the glyph. */}
                  <span aria-hidden="true" className="translate-y-[0.18em] text-base leading-none">*</span>
                </button>
              </div>
              {/* Icon-only, so the label is the name: the same word the button said.
                  Round, so the button's own radius and padding give way (`!`). */}
              {mode ? (
                <Button
                  className="size-11 shrink-0 rounded-full! px-0!"
                  variant="secondary"
                  aria-label={t('stop')}
                  title={t('stop')}
                  onClick={() => {
                    // A round's speakers still to come are not asked; what is stored stays.
                    roundStopped.current = true;
                    abortRef.current?.abort();
                    // Closing the stream leaves the reply going on the server (§7.2),
                    // so the stop is said there; the turn's ending waits on its answer.
                    stopping.current = apiSend<void>('POST', `/api/chats/${id}/stop`).catch(() => undefined);
                  }}
                >
                  <span aria-hidden="true" className="size-3 rounded-[3px] bg-current" />
                </Button>
              ) : (
                <Button
                  className="size-11 shrink-0 rounded-full! px-0!"
                  variant="primary"
                  aria-label={t('send')}
                  title={t('send')}
                  busy={translatingInput}
                  disabled={!input.trim() || attaching || drawing || serverGenerating || mutating || importing || scriptsPending || castPending || translatingInput}
                  onClick={submit}
                >
                  <Icon name="arrow" className="size-5 -rotate-90" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* What the header holds on a wide screen, on a narrow one. The notes panel
          has a whole section of the page to open into, so the sheet only opens it
          and gets out of the way. */}
      {sheetOpen ? (
        <BottomSheet title={t('settings')} onClose={() => setSheetOpen(false)}>
          {/* The music's mute, which the phone's header has no room for. */}
          <BgmMute row className="mb-5" />
          <ChatSettings
            stacked
            model={state.chat.model}
            subModel={state.chat.subModel}
            reasoningEffort={state.chat.reasoningEffort}
            preset={state.chat.preset}
            personaId={state.chat.personaId}
            models={models}
            presets={presets}
            personas={personas}
            readerPresetId={state.chat.readerPresetId}
            readerPresets={readerPresets}
            onReaderPresetsChange={changeReaderPresets}
            disabled={settingsLocked}
            retrieval={state.chat.retrieval?.enabled ?? false}
            onChange={(patch) => void updateSettings(patch)}
            {...(languageView ? { language: languageView } : {})}
          />
          <Button
            className="mt-5 w-full"
            variant={panelOpen ? 'secondary' : 'ghost'}
            aria-expanded={panelOpen}
            onClick={() => {
              setPanelOpen((open) => !open);
              setSheetOpen(false);
            }}
          >
            {t('notes')}
          </Button>
        </BottomSheet>
      ) : null}

      {scriptPrompt ? (
        <ScriptDialog prompt={scriptPrompt} onDone={() => setScriptPrompt(null)} />
      ) : null}

      {/* The whole window is the drop target while a file is over it, so the
          overlay is the only thing that has to say where it will land. */}
      {dropping ? (
        <div
          data-testid="attachment-drop"
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-canvas/70 backdrop-blur-sm"
        >
          <span className="rounded-xl border border-dashed border-muted px-6 py-4 text-sm text-fg">
            {t('attach')}
          </span>
        </div>
      ) : null}
    </div>
  );
}
