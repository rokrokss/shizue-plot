'use client';

import { Icon } from '@/components/Icon';
import { assetResolver, type CbsMessage } from '@shizue/core/cbs';
import { componentNames } from '@shizue/core/component';
import { NARRATION_PREFIX } from '@shizue/core/narration';
import { isSceneMessage, sceneSpanAt } from '@shizue/core/scene';
import { manualTriggerNames, type MemberOverlay } from '@shizue/core/triggers';
import { computeVariables, DEFAULT_USER_NAME, type FoldOptions, type Variables } from '@shizue/core/variables';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Fragment, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { AiBadge, AiNotice } from '@/components/AiNotice';
import { AttachmentChips } from '@/components/AttachmentChips';
import { Avatar } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { ChatBackground } from '@/components/ChatBackground';
import { ChatPanel } from '@/components/ChatPanel';
import { ChatSettings } from '@/components/ChatSettings';
import { FocusPicker } from '@/components/FocusPicker';
import { MessageRow } from '@/components/MessageRow';
import { MoreActions } from '@/components/MoreActions';
import { ScriptDialog, type ScriptPrompt } from '@/components/ScriptDialog';
import { SceneDraft } from '@/components/SceneDraft';
import { SceneEditor, type SceneBlock } from '@/components/SceneEditor';
import { Button, CenteredMessage, Spinner, TextArea, cx } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { apiDelete, apiGet, apiSend, apiUpload } from '@/lib/api';
import {
  assetSrc,
  illustrations,
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
import { streamsNarration } from '@/lib/narrator';
import {
  readCustomUiEnabled,
  sameVariables,
  writeCustomUiEnabled,
  type DisplayContext,
} from '@/lib/displayScripts';
import { greetingText, isGreeting, opensOnFirstGreeting } from '@/lib/greeting';
import { reconcileSend } from '@/lib/reconcile';
import { sanitizeCustomHtml } from '@/lib/sanitizeHtml';
import { streamGeneration } from '@/lib/sse';
import { loadWholeBranch } from '@/lib/scripts/branch';
import { readEmbeddingModel } from '@/lib/scripts/embeddingModels';
import { createLuaEngine, luaFunctionNames, luaScriptsOf } from '@/lib/scripts/lua/engine';
import { createLuaSandbox, type LuaRequestAnswer } from '@/lib/scripts/lua/sandbox';
import {
  activeLore,
  createScriptRuntime,
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
import type {
  ChatAttachment,
  ChatMemorySettings,
  ChatMessage,
  ChatState,
  DisplayScript,
  MessageRole,
  MessageSource,
  ModelInfo,
  NarratorConfig,
  Persona,
  PresetInfo,
  PublicMember,
  PublicPlotDetail,
  StreamMode,
  SuggestionsResult,
  UserNote,
} from '@/lib/types';
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
 * How hard to look for a stopped turn. The server writes the partial reply after
 * the socket is already gone, so the refetch that follows a stop routinely
 * arrives before it — and a refetch that misses it takes the text off the screen
 * for good. Four tries a quarter-second apart covers the write without leaving
 * the composer locked for long.
 */
const ABORT_POLL_TRIES = 4;
const ABORT_POLL_MS = 250;

/**
 * How close to the top of the list the reader has to come before the window
 * before this one is fetched. Far enough that on an ordinary flick the older
 * messages are already in place by the time the top is reached.
 */
const LOAD_EARLIER_PX = 400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replies a card's scripts may ask for in a row (`sendAIprompt`) before the
 * reader has to act again. RisuAI sets no limit; a card that asks every time
 * would spend the reader's model turns without end.
 */
const MAX_SCRIPT_FOLLOW_UPS = 3;

/** The modes a next-speaker pick rides on; continuing or narrating has no speaker to pick. */
const FOCUS_MODES: readonly StreamMode[] = ['send', 'regenerate', 'auto'];

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
  /** A greeting with its conditions decided (`lib/greeting`), where that differs from what is stored. */
  shown?: string;
  /** Images sent with the turn — already uploaded ones on the optimistic bubble. */
  attachments: ChatAttachment[];
  /** null for the same two: nothing is stored, so nothing has a time yet. */
  createdAt: string | null;
  streaming: boolean;
}

/** Nothing attached, shared so a row without images keeps a stable prop. */
const NO_ATTACHMENTS: ChatAttachment[] = [];

/** Held until the plot read lands, so a row's roster prop never changes for nothing. */
const NO_MEMBERS: readonly PublicMember[] = [];

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('chat');
  const common = useTranslations('common');
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
  const [assets, setAssets] = useState<PlotAsset[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [notes, setNotes] = useState<UserNote[]>([]);
  const [missing, setMissing] = useState(false);

  /**
   * The card's scripts (`lib/scripts`): undefined while the read is out, null for
   * a plot that carries none. Read once per chat — what they rewrite of the work
   * afterwards, the runtime keeps track of itself.
   */
  const [scriptBundle, setScriptBundle] = useState<ScriptBundle | null | undefined>(undefined);
  useEffect(() => {
    setScriptBundle(undefined);
    apiGet<{ scripts: ScriptBundle | null }>(`/api/chats/${id}/scripts`).then(
      (answer) => setScriptBundle(answer?.scripts ?? null),
      // A plot that cannot be read runs nothing, and a pending reply is kept as written.
      () => setScriptBundle(null),
    );
  }, [id]);
  /**
   * What the card's scripts rewrote of their member in this chat (`MemberOverlay`):
   * the bundle's on load, then the runtime's each time the server took a run's
   * rewrite. The screen draws the member's name, the first greeting and the
   * background from it, as RisuAI draws them from its character.
   */
  const [scriptOverlay, setScriptOverlay] = useState<MemberOverlay | null>(null);
  useEffect(() => setScriptOverlay(scriptBundle?.overlay.member ?? null), [scriptBundle]);

  const [input, setInput] = useState('');
  /** How the composer's text is meant: a line, a description, or the narrator's. */
  const [composerMode, setComposerMode] = useState<ComposerMode>('dialogue');
  /**
   * Members the next reply should center on. One reply's worth: it rides on the
   * next send, regenerate or auto-continue and is cleared once that lands.
   */
  const [focus, setFocus] = useState<string[]>([]);
  const [mode, setMode] = useState<StreamMode | null>(null);
  /**
   * The mode whose optimistic row is still on screen after its stream failed.
   * Nothing of that reply was stored, so what arrived exists only here.
   */
  const [held, setHeld] = useState<StreamMode | null>(null);
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
    apiGet<UserNote[]>('/api/notes').then(setNotes, () => undefined);
  }, [id]);

  const plotId = state?.chat.plotId ?? null;
  useEffect(() => {
    if (!plotId) return;
    apiGet<PublicPlotDetail>(`/api/plots/${plotId}/public`).then(setPlot, () => undefined);
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
        assets
          .filter((asset) => !lockedKinds.has(asset.slug))
          .map((asset) => [asset.slug, assetSrc(asset)]),
      ),
    [assets, lockedKinds],
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
  const resolveAsset = useMemo(() => assetResolver(assets), [assets]);

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
  const scripts: DisplayScript[] = useMemo(() => plot?.displayScripts ?? [], [plot]);
  const creatorCss = plot?.css ?? '';
  /**
   * The plot's stylesheet, scoped and filtered exactly as a `<style>` in a
   * script's output is — but once for the whole chat, not once per message. It
   * styles nothing but the islands, so it goes when custom UI does.
   */
  const creatorSheet = useMemo(
    () => (customUi && creatorCss ? sanitizeCustomHtml(`<style>${creatorCss}</style>`) : ''),
    [customUi, creatorCss],
  );
  const defaultVariables = useMemo(() => plot?.defaultVariables ?? {}, [plot]);
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
  const variablesBeforeHead = useMemo(
    () => computeVariables(fold.messages.slice(0, -1), fold.defaults, foldNames),
    [fold, foldNames],
  );

  // The branch as it currently reads. `computeVariables` folds onto whatever it
  // is given as defaults, so the streaming text is folded onto the right base
  // rather than replayed over the whole path: per token this is one small scan.
  // Regenerate is why there are two bases — its head is being replaced, and a
  // fold cannot be run backwards.
  const liveVariables = useMemo(() => {
    if (active === null) return persistedVariables;
    const base =
      active === 'regenerate' && last?.role === 'assistant'
        ? variablesBeforeHead
        : persistedVariables;
    const pending = mode === 'send' ? [pendingUser, streamText] : [streamText];
    return computeVariables(pending, base, foldNames);
  }, [active, mode, last, persistedVariables, variablesBeforeHead, pendingUser, streamText, foldNames]);

  // …and the same values keep the same object, so the memoized message bodies do
  // not re-run their regexes, their template and two DOMPurify passes for a token
  // that moved nothing.
  const variables = useStableVariables(liveVariables);

  /**
   * The plot's cast, which is what a reply's `이름:` lines are read against — the
   * scripted member under the name its scripts gave it in this chat (`setName`),
   * its lines under the old name still its own (`aliases`).
   */
  const scriptedId = scriptBundle?.memberId;
  const renamed = scriptOverlay?.name;
  const cast = plot?.characters ?? NO_MEMBERS;
  const members = useMemo(
    () =>
      renamed === undefined || !scriptedId
        ? cast
        : cast.map((member) =>
            member.id === scriptedId && member.name !== renamed
              ? { ...member, name: renamed, aliases: [member.name] }
              : member,
          ),
    [cast, scriptedId, renamed],
  );
  const absentIds = state?.chat.absentCharacterIds;
  /** Who is on the stage — the members a reply can be asked to center on. */
  const stage = useMemo(
    () => members.filter((member) => !(absentIds ?? []).includes(member.id)),
    [members, absentIds],
  );
  // A plot of one member is that character: renamed by its scripts, the chat is with
  // the new name, and `{{char}}` in the work's text is it too (the prompt's `PromptPlot.char`).
  const soleRenamed = renamed !== undefined && cast.length === 1 && cast[0]!.id === scriptedId ? cast[0]! : null;
  const characterName = soleRenamed ? renamed! : (plot?.name ?? state?.chat.title ?? '');
  /** `{{char}}` in the work's own text on screen: the plot's name, or the renamed character's, nickname first. */
  const charMacro = soleRenamed ? soleRenamed.nickname?.trim() || renamed! : characterName;
  // Who the conversation is with, once either read has said so.
  useDocumentTitle(characterName);
  const personaName = personas.find((persona) => persona.id === state?.chat.personaId)?.name;
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
  /** The names a card asks for its images by — its own where it had them — open ones only. */
  const assetNames = useMemo(
    () => assets.filter((asset) => !lockedKinds.has(asset.slug)).map((asset) => asset.name ?? asset.slug),
    [assets, lockedKinds],
  );
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
  const locale = useLocale();

  /** The manual triggers a `{{button}}` may name, which then runs one rather than filling the composer. */
  const triggerNames = useMemo(
    () =>
      scriptBundle
        ? new Set([
            ...manualTriggerNames(scriptBundle.triggers),
            // A manual run calls the Lua global of its name, so a button may name one.
            ...luaFunctionNames(luaScriptsOf(scriptBundle.triggers)),
          ])
        : undefined,
    [scriptBundle],
  );

  const display = useMemo<DisplayContext | undefined>(() => {
    if (!customUi || scripts.length === 0) return undefined;
    return {
      scripts,
      variables,
      assets: assetUrls,
      resolveAsset,
      relationship: axes,
      turn,
      char: charMacro,
      user: personaName ?? youLabel,
      lastMessageId,
      assetNames,
      messages: branchMessages,
      wholeBranch,
      chatId,
      locale,
      ...(globalVariables ? { globalVariables } : {}),
      ...(triggerNames ? { triggerNames } : {}),
    };
  }, [
    customUi,
    scripts,
    variables,
    assetUrls,
    resolveAsset,
    axes,
    turn,
    charMacro,
    personaName,
    youLabel,
    lastMessageId,
    assetNames,
    branchMessages,
    wholeBranch,
    chatId,
    locale,
    globalVariables,
    triggerNames,
  ]);

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
      });
      if (text !== message.content) shown.set(message.id, text);
    }
    return shown;
  }, [messages, firstGreeting, firstMessage, variables, charMacro, personaName, youLabel, chatId, lastMessageId]);

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
   * The HTML behind the conversation (`ChatBackground`): what the scripts set in
   * this chat (`setBackgroundEmbedding`), else the card's past its stylesheet. It
   * is custom UI, so it goes when custom UI does, as the stylesheet does.
   */
  const backgroundHtml = customUi ? (scriptOverlay?.backgroundHtml ?? plot?.backgroundHtml ?? '') : '';
  /** What its CBS reads: the screen's own, as a display script's template reads it. */
  const backgroundContext = useMemo<CbsContext | null>(
    () =>
      backgroundHtml
        ? {
            variables,
            assets: assetUrls,
            resolveAsset,
            relationship: axes,
            turn,
            char: charMacro,
            user: personaName ?? youLabel,
            lastMessageId,
            assetNames,
            messages: branchMessages,
            wholeBranch,
            chatId,
            locale,
            ...(globalVariables ? { globalVariables } : {}),
          }
        : null,
    [
      backgroundHtml,
      variables,
      assetUrls,
      resolveAsset,
      axes,
      turn,
      charMacro,
      personaName,
      youLabel,
      lastMessageId,
      assetNames,
      branchMessages,
      wholeBranch,
      chatId,
      locale,
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
  const runtime = useMemo<ScriptRuntime | null>(() => {
    if (!scriptBundle) return null;
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
    // A plot that carries Lua gets the sandbox; wasmoon is fetched on its first call, never before.
    const engines = luaScriptsOf(scriptBundle.triggers).length
      ? [
          createLuaEngine({
            triggers: scriptBundle.triggers,
            lowLevelAccess: scriptBundle.lowLevelAccess,
            sandbox: createLuaSandbox({
              loadAssets: () => import('@/lib/scripts/lua/assets').then((assets) => assets.loadLuaAssets()),
              onIdleKill: (reason) => log({ kind: 'limit', effect: 'triggerlua', message: `a Lua script still running between calls was stopped (${reason})` }),
            }),
            ui: scriptUi,
            llm: async (messages, model) =>
              (await apiSend<{ result: string }>('POST', `/api/chats/${id}/script-llm`, { messages, model })).result,
            similarity,
            // Our server makes the GET, under RisuAI's limits, and answers as RisuAI does.
            request: (url) => apiSend<LuaRequestAnswer>('POST', `/api/chats/${id}/script-fetch`, { url }),
            // `loadLoreBooks`: activated as `/test_lorebook` is, against RisuAI's
            // `maxContext`, which is the chat's context budget here.
            lore: async (history, lorebook) => ({
              actives: (await activeLore(lorebook, history, scriptBundle.character.loreSettings)).actives.map(
                (active) => ({ prompt: active.prompt, role: active.role }),
              ),
              maxContext: stateRef.current?.chat.memorySettings?.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
            }),
            avatarUrl: scriptBundle.character.avatarUrl ?? null,
            log,
          }),
        ]
      : [];
    return createScriptRuntime({
      chatId: id,
      bundle: scriptBundle,
      api: { send: apiSend },
      ui: scriptUi,
      engines,
      similarity,
      log,
      onGlobalVariables: (globals) =>
        setState((current) => (current ? { ...current, globalVariables: globals } : current)),
      onOverlay: setScriptOverlay,
    });
  }, [id, scriptBundle, scriptUi]);
  // The sandbox goes with the runtime that opened it.
  useEffect(() => () => runtime?.dispose(), [runtime]);
  /**
   * The scripts fold the branch as the server does, from the plot's defaults, so
   * nothing runs before both reads are in: a turn sent in the meantime would be
   * measured against the wrong starting state.
   */
  const scriptsPending = scriptBundle === undefined || (scriptBundle !== null && plot === null);

  /** The page's latest state, for the steps of a turn that outlive the render they began in. */
  const stateRef = useRef<ChatState | null>(null);
  stateRef.current = state;

  /** What RisuAI's functions may read in a script, from the reader's side. */
  const scriptData = useCallback(
    (afterGreeting: number): ScriptView['data'] => {
      const zone = Intl.DateTimeFormat().resolvedOptions();
      return {
        clock: { now: new Date(), timeZone: zone.timeZone, locale: zone.locale },
        seed: { key: chatId, length: afterGreeting },
        meta: { language: locale },
        assets: { names: assetNames, display: assetNames },
      };
    },
    [chatId, locale, assetNames],
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
   */
  async function settlePending(current: ChatState): Promise<ChatState> {
    try {
      const done = await finishPending(current);
      if (!done) return current;
      mergeState(done.state);
      // RisuAI's `sendAIprompt` asks for the next reply at once. A few in a row at
      // most: a card that asks every time would otherwise never stop.
      if (done.followUp && followUpChain.current < MAX_SCRIPT_FOLLOW_UPS) {
        setQueuedTurns((turns) => [...turns, { kind: 'next' }]);
      }
      return mergeRefetched(current, done.state);
    } catch {
      setError(t('scriptFinishFailed'));
      return current;
    }
  }

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
          await run('send', turn.content, turn.options);
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
        if (!state.chat.allowComponentTurns) {
          const consent = turn.kind === 'next' ? 'scriptFollowUpConsent' : 'scriptMultisendConsent';
          if (!window.confirm(t(consent, { name: characterName }))) {
            setQueuedTurns([]);
            return;
          }
          try {
            applyState(await apiSend<ChatState>('PATCH', `/api/chats/${id}`, { allowComponentTurns: true }));
          } catch (caught) {
            setSettingsError(toMessage(caught));
            setQueuedTurns([]);
            return;
          }
        }
        if (turn.kind === 'next') {
          followUpChain.current += 1;
          // RisuAI generates on whatever its chat now ends with: a reader's turn the
          // output triggers added is answered, anything else is carried on from.
          await run(state.path.at(-1)?.role === 'user' ? 'regenerate' : 'auto', undefined, undefined, true);
        } else {
          // `/multisend`'s message, pushed as it is and answered.
          await run('send', turn.content, undefined, true, { raw: true, clear: turn.clear });
        }
      } finally {
        setTakingTurn(false);
      }
    })();
  }, [queuedTurns, takingTurn, mode, mutating, drawing, state]);

  /** A `risu-trigger` or `{{button}}` click: the plot's manual triggers of that name, committed on the head. */
  async function runManualTrigger(name: string, triggerId: string | null): Promise<void> {
    const current = stateRef.current;
    if (!runtime || !current || scriptsPending || !beginMutation()) return;
    try {
      const next = await runtime.manual(name, triggerId, await scriptViewOf(current));
      if (next) mergeState(next);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      endMutation();
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
   * A `risu-btn` click: the card's Lua `onButtonClick`, and what it did
   * committed on the head, as a manual trigger's is.
   */
  async function runLuaButton(data: string): Promise<void> {
    const current = stateRef.current;
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
   * as it stands until they answer.
   */
  const [luaShown, setLuaShown] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    if (!runtime?.editsDisplay || !customUi || !state) return;
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
    };
    const items = messages.map((message) => ({ id: message.id, text: shownGreetings.get(message.id) ?? message.content }));
    runtime.displayEdits(items, view, persistedVariables).then(
      (shown) => {
        if (current) setLuaShown(shown);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [
    runtime,
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
  ]);

  /**
   * The messages as the display triggers draw them, where the plot has any —
   * text for the screen alone, never stored — over what the Lua display
   * listeners made of them, as RisuAI runs the two. Over the stored branch and
   * its fold, so a streamed token redraws none of it.
   */
  const scriptShown = useMemo(() => {
    const shown = new Map<string, string>();
    if (!runtime || !customUi || !state) return shown;
    if (!runtime.rewritesDisplay) return runtime.editsDisplay ? new Map(luaShown) : shown;
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
    };
    for (const message of messages) {
      const text = shownGreetings.get(message.id) ?? message.content;
      const drawn = runtime.display(luaShown.get(message.id) ?? text, view, persistedVariables);
      if (drawn !== text) shown.set(message.id, drawn);
    }
    return shown;
  }, [
    runtime,
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
  ]);

  async function run(
    next: StreamMode,
    content?: string,
    turnOptions?: SendOptions,
    /** A reply a script asked for, rather than one the reader did. */
    scripted = false,
    /** How the scripts take a send that is not the reader's typing (`/multisend`'s). */
    prepareOptions?: PrepareOptions,
  ): Promise<void> {
    // A drawn scene holds the same per-chat slot a generation does, so asking for
    // one while the picture is on its way would only come back a 429.
    if (mode || drawing || mutationRef.current || scriptsPending) return;
    if (!scripted) followUpChain.current = 0;
    const headBefore = state?.chat.headMessageId ?? null;
    /** What the branch looked like before, for reading whether the turn landed. */
    const before = { id: headBefore, content: last?.content ?? '' };
    const controller = new AbortController();
    abortRef.current = controller;
    setMode(next);
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
    if (runtime && state) {
      try {
        let current = stateRef.current ?? state;
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
        prepared = await runtime.prepare(next, view, content, prepareOptions);
        if (prepared.state) mergeState(prepared.state);
        // A head still pending here is one this tab could not finish: the turn
        // goes on without its output scripts rather than being refused for them.
        const head = view.messages[view.messages.length - 1];
        scriptBody = { ...prepared.body, ...(head?.scriptState === 'pending' ? { abandonPending: true } : {}) };
      } catch (caught) {
        prepared = null;
        setError(toMessage(caught));
      }
      if (!prepared || prepared.stop) {
        // Nothing was sent. A send's text goes back where it was written.
        if (next === 'send') {
          setInput((current) => (current.trim() ? `${typed ?? ''}\n${current}` : (typed ?? '')));
          if (prepared?.stop) setScriptNotice(t('scriptStopped'));
        }
        abortRef.current = null;
        reset();
        setMode(null);
        setPendingUser('');
        return;
      }
      if (prepared.content !== undefined && next === 'send') {
        content = prepared.content;
        setPendingUser(content);
      }
    }

    let rejection: unknown = null;
    let streamError: string | null = null;
    let aborted = false;
    /** How much of a reply arrived, which decides whether there is any to keep. */
    let received = 0;
    // Only the modes where someone speaks carry the pick, and only members still
    // on the stage: the server refuses anyone else.
    const focusIds = FOCUS_MODES.includes(next)
      ? focus.filter((memberId) => stage.some((member) => member.id === memberId))
      : [];
    const focusBody = focusIds.length > 0 ? { focusCharacterIds: focusIds } : undefined;
    try {
      const result = await streamGeneration(
        next === 'send' ? `/api/chats/${id}/messages` : `/api/chats/${id}/${next}`,
        next === 'send'
          ? { content, ...turnOptions, ...focusBody, ...scriptBody }
          : focusBody || Object.keys(scriptBody).length > 0
            ? { ...focusBody, ...scriptBody }
            : undefined,
        (text) => {
          received += text.length;
          append(text);
        },
        controller.signal,
      );
      if (result.kind === 'error') streamError = result.code ? toMessage(new ApiError(0, result.code, result.message)) : result.message;
      aborted = result.kind === 'aborted';
      // The pick was for this reply. A failed one keeps it, so the retry asks again.
      if (result.kind === 'done' && focusIds.length > 0) setFocus([]);
      // What the turn opened, celebrated on the spot: the refetch below carries
      // the same answer, and a reveal that waits for it arrives a beat late.
      if (result.kind === 'done' && result.unlockedAssetIds.length > 0) {
        const opened = result.unlockedAssetIds;
        setState((current) =>
          current ? { ...current, assetLocks: openAssetLocks(current.assetLocks, opened) } : current,
        );
      }
    } catch (caught) {
      rejection = caught;
    }
    // The stream opened, so the server kept what the scripts rewrote of the work.
    if (rejection === null) prepared?.accept();
    abortRef.current = null;
    // However it ended, it ended: the pacing gives up whatever it was still
    // holding back before anything decides what the ending meant.
    finish();

    // Refresh before clearing the streamed text so the persisted message
    // replaces it in a single render — no flash of a duplicated reply.
    let refreshed = await refetch();
    // A stopped turn is written after the socket closed, so the answer above may
    // simply be too early. Keep asking — the optimistic row is still up, and it
    // is the partial that the server is in the middle of storing.
    if (aborted && received > 0) {
      for (let attempt = 0; attempt < ABORT_POLL_TRIES; attempt += 1) {
        if (refreshed.state && generationLanded(next, before, refreshed.state)) break;
        await sleep(ABORT_POLL_MS);
        const again = await refetch();
        if (again.state) refreshed = again;
      }
    }
    // Merged rather than assigned: the refetch answers with the newest window,
    // and on a long chat that is less than what the reader has paged in.
    const settled = refreshed.state;
    if (settled) mergeState(settled);
    // A reply the scripts still owe their output pass is finished before the turn
    // ends, with the composer still held: until then it is not the reply.
    if (settled && scriptBundle !== undefined) await settlePending(mergeRefetched(stateRef.current, settled));

    /** Whether the turn was written — and so whether its images went with it. */
    let delivered = next === 'send';
    if (streamError !== null) {
      // The stream was open, so the user turn is stored: regenerate retries it.
      setError(streamError);
      setRetryable(true);
    } else if (rejection !== null) {
      setError(toMessage(rejection));
      if (next !== 'send') {
        setRetryable(true);
      } else {
        // A rejected send proves only that no stream was read. Whether the turn
        // was stored is decided by the head, never assumed.
        const recovery = reconcileSend(headBefore, refreshed.state);
        setRetryable(recovery.kind === 'delivered' && recovery.retry);
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

    setMode(null);
    setPendingUser('');
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
      await run('send', content, {
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
    relationshipEnabled?: boolean;
    memorySettings?: ChatMemorySettings;
    allowComponentTurns?: boolean;
    /** The reader's half of the plot's two style features. */
    statusWindowEnabled?: boolean;
    choicesEnabled?: boolean;
    /** null clears the override and hands the chat back to the character's narrator. */
    narrator?: NarratorConfig | null;
    /** Members sent off the stage; an empty list is the whole roster on. */
    absentCharacterIds?: string[];
  }): Promise<void> {
    if (!beginMutation()) return;
    setSettingsError('');
    try {
      applyState(await apiSend<ChatState>('PATCH', `/api/chats/${id}`, patch));
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

  /** The rolling summary has its own endpoint, but the same whole-state answer. */
  async function saveMemory(summary: string): Promise<void> {
    if (!beginMutation()) return;
    setSettingsError('');
    try {
      applyState(await apiSend<ChatState>('PUT', `/api/chats/${id}/memory`, { summary }));
    } catch (caught) {
      setSettingsError(toMessage(caught));
    } finally {
      endMutation();
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
  if (!state) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={common('loading')} />
      </div>
    );
  }

  const view: ViewMessage[] = messages.map((message) => {
    const continued = active === 'continue' && message.id === last?.id;
    return {
      key: message.id,
      id: message.id,
      role: message.role,
      content: continued ? message.content + streamText : message.content,
      // What the display triggers draw, else the greeting as its conditions decide it.
      ...(!continued && scriptShown.has(message.id)
        ? { shown: scriptShown.get(message.id)! }
        : shownGreetings.has(message.id)
          ? { shown: shownGreetings.get(message.id)! }
          : {}),
      attachments: message.attachments,
      createdAt: message.createdAt,
      streaming: continued && mode !== null,
    };
  });

  if (active === 'regenerate' && last?.role === 'assistant') view.pop();
  if (mode === 'send') {
    view.push({
      key: 'pending-user',
      id: null,
      role: 'user',
      content: pendingUser,
      attachments: pendingAttachments,
      createdAt: null,
      streaming: false,
    });
  }
  // Auto-continue appends a new reply, so unlike regenerate it keeps the head
  // bubble and streams below it. When what is being generated is a narration, the
  // prefix the server will store goes on the optimistic text — which is all
  // MessageRow needs to draw it as one while it streams, rather than flipping it
  // when the turn lands.
  if (active === 'send' || active === 'regenerate' || active === 'auto' || active === 'narrate') {
    view.push({
      key: 'streaming',
      id: null,
      role: 'assistant',
      content: streamsNarration(active, last) ? `${NARRATION_PREFIX} ${streamText}` : streamText,
      attachments: NO_ATTACHMENTS,
      createdAt: null,
      streaming: mode !== null,
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
  function submit(): void {
    if (!input.trim() || mode || drawing || mutationRef.current || attaching || importing || scriptsPending) return;
    // The chip is a way of typing: what is stored is the plain convention, the
    // same one the reader could have written the marks of by hand.
    const content = composeTurn(input, composerMode);
    const attachmentIds = uploadedIds(chips);
    const options = attachmentIds.length > 0 ? { attachmentIds } : undefined;
    setInput('');
    // Slash commands only where RisuAI's scripts run; anywhere else `/…` is just text.
    if (runtime && input.startsWith('/')) void runCommand(input, content, options);
    else void run('send', content, options);
  }

  const info = last ? state.siblings[last.id] : undefined;
  // A drawn scene takes the same per-chat slot a generation does, so while one is
  // in flight the row of actions is withheld exactly as it is while text streams.
  const showActions = !mode && !drawing && !mutating && !importing && !scriptsPending && Boolean(last);
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
  const prevTarget = last && !mode ? siblingTarget(last, -1) : null;
  const nextTarget = last && !mode ? siblingTarget(last, 1) : null;

  return (
    // A column exactly as tall as what is left under the header, so the list
    // below is the only thing that scrolls and the composer never moves.
    <div className="chat-workspace flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="shrink-0 border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-5 py-2.5">
          <Link
            // The work's own page, which is the same one for creator and reader.
            href={`/p/${state.chat.plotId}`}
            className="flex min-w-0 items-center gap-2.5"
            title={t('backToPlot')}
          >
            <Avatar src={plot?.coverUrl ?? null} name={characterName} className="size-8 text-sm" />
            <span className="truncate text-sm font-medium">{characterName}</span>
          </Link>
          <AiBadge />

          {/* Wide enough for the controls, and they stand in the header. Narrower
              than that, one button opens them in a sheet from the bottom edge. */}
          <div className="ml-auto hidden items-center gap-2 lg:flex">
            <ChatSettings
              model={state.chat.model}
              subModel={state.chat.subModel}
              reasoningEffort={state.chat.reasoningEffort}
              preset={state.chat.preset}
              personaId={state.chat.personaId}
              models={models}
              presets={presets}
              personas={personas}
              disabled={settingsLocked}
              onChange={(patch) => void updateSettings(patch)}
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
          <Button
            size="sm"
            variant={sheetOpen ? 'secondary' : 'ghost'}
            aria-expanded={sheetOpen}
            className="ml-auto lg:hidden"
            onClick={() => setSheetOpen(true)}
          >
            {t('settings')}
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
              members={members}
              note={state.chat.note}
              notes={notes}
              noteIds={state.chat.noteIds}
              memory={state.chat.memory}
              memorySettings={state.chat.memorySettings}
              relationship={state.chat.relationship}
              relationshipEnabled={state.chat.relationshipEnabled}
              narrator={state.chat.narrator}
              onSaveNarrator={(narrator) => updateSettings({ narrator })}
              illustrations={gallery}
              disabled={settingsLocked}
              onSaveNote={(note) => updateSettings({ note })}
              onToggleNote={toggleNote}
              onSaveMemory={saveMemory}
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
              {...(state.isPlotOwner ? { inspectChatId: state.chat.id } : {})}
              customUi={customUi}
              onToggleCustomUi={(enabled) => {
                writeCustomUiEnabled(enabled);
                setCustomUi(enabled);
              }}
              scriptSimilarity={scriptBundle?.lowLevelAccess ?? false}
            />
          </div>
        </div>
      ) : null}

      {/* The conversation's area. What a card draws behind the chat stands still
          in it while the list scrolls over it, as RisuAI's background does. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {backgroundContext ? <ChatBackground html={backgroundHtml} context={backgroundContext} /> : null}
        <div
          ref={scrollRef}
          // Positioned only over a background, which it has to paint above.
          className={cx('min-h-0 flex-1 overflow-y-auto overscroll-contain', backgroundContext && 'relative')}
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
                const name = scripted.getAttribute('data-shizue-trigger');
                if (name !== null) void runManualTrigger(name, scripted.getAttribute('data-shizue-trigger-id'));
                else void runLuaButton(scripted.getAttribute('data-shizue-btn') ?? '');
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
              // one — the footer's swipe already sits under that.
              const branches =
                source && !mode && !(isLast && last?.role === 'assistant')
                  ? branchNav(source)
                  : undefined;
              // Where the conversation crossed midnight. It belongs to the row it
              // stands above, so the scene editor gets it as readily as a message.
              const divider = meta.dayStart ? (
                <div className="flex items-center gap-3">
                  <span className="h-px flex-1 bg-line" />
                  <span className="text-xs text-muted">{dayLabel(meta.dayStart)}</span>
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
                    name={message.role === 'user' ? t('you') : characterName}
                    avatar={plot?.coverUrl ?? null}
                    roster={members}
                    assets={messageAssets}
                    resolveAsset={resolveAsset}
                    attachments={message.attachments}
                    {...(display ? { display } : {})}
                    {...(components ? { components } : {})}
                    previousSameRole={meta.previousSameRole}
                    chatIndex={indexBase + index}
                    streaming={message.streaming}
                    // Nothing of the reply on screen yet: the time it has been
                    // waited for, which is all of the model's thinking that is shown.
                    thinking={message.streaming && streamText === ''}
                    disabled={settingsLocked}
                    {...(message.createdAt ? { createdAt: message.createdAt } : {})}
                    grouped={meta.grouped}
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
                    {...(branches ? { branches } : {})}
                    footer={
                      isLast && showActions ? (
                        <div
                          className={cx(
                            'mt-2 flex items-center gap-1',
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
                          <Button size="sm" variant="ghost" onClick={() => void run('regenerate')}>
                            {t('regenerate')}
                          </Button>
                          {/* A narration answers a user turn as readily as it follows a
                              reply, so unlike continue/auto it is offered under both. */}
                          <Button
                            size="sm"
                            variant="ghost"
                            title={t('narrateHint')}
                            onClick={() => void run('narrate')}
                          >
                            {t('narrate')}
                          </Button>
                          {last?.role === 'assistant' ? (
                            <>
                              {/* Continue and auto are the two the row can do
                                  without on a phone: the least reached for, and the
                                  easiest to describe in a menu. */}
                              <div className="hidden items-center gap-1 sm:flex">
                                <Button size="sm" variant="ghost" onClick={() => void run('continue')}>
                                  {t('continue')}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => void run('auto')}>
                                  {t('auto')}
                                </Button>
                              </div>
                              <MoreActions
                                label={t('moreActions')}
                                className="sm:hidden"
                                actions={[
                                  {
                                    key: 'continue',
                                    label: t('continue'),
                                    onSelect: () => void run('continue'),
                                  },
                                  { key: 'auto', label: t('auto'), onSelect: () => void run('auto') },
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
                  <Button size="sm" variant="danger" onClick={() => void run('regenerate')}>
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
            back down, so this is how they choose to follow it again. */}
        {isAtBottom ? null : (
          <button
            type="button"
            onClick={() => void scrollToBottom()}
            className="absolute -top-11 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised/95 px-3.5 py-1.5 text-xs text-fg shadow-lg backdrop-blur transition-colors hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <span aria-hidden="true">↓</span>
            {t('jumpToLatest')}
          </button>
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

        {/* What the reader is about to write: their own line, their 상황묘사, or
            the narrator's. It marks the text on its way out and nothing more —
            the message is stored in the same notation either way. */}
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-5 pt-3">
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
                onClick={() => setComposerMode(value)}
                className={cx(
                  'rounded-md px-3 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                  composerMode === value ? 'bg-mint-soft font-medium text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {t(`composerModes.${value}`)}
              </button>
            ))}
          </div>
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
        <div className="mx-auto grid max-w-3xl grid-cols-[auto_auto_1fr_auto] items-end gap-2 px-5 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <TextArea
            ref={composerRef}
            rows={2}
            value={input}
            // Unlike a streaming reply, an import has no end the reader is waiting
            // on in the composer, so the field itself is held with the rest.
            disabled={importing}
            aria-label={t('placeholder')}
            placeholder={t('placeholder')}
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
            className="col-span-4 max-h-48 min-h-12 resize-none overflow-y-auto border-focus/50 bg-surface"
          />
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
            onClick={() => filePicker.current?.click()}
          >
            <Icon name="attach" className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('direction')}
            title={t('directionHint')}
            disabled={Boolean(mode) || importing}
            onClick={toggleDirection}
          >
            {/* The asterisk sits high in its em box, so what is centred is the box
                and not the glyph. The nudge centres the glyph. */}
            <span className="translate-y-[0.18em] text-base leading-none">*</span>
          </Button>
          {mode ? (
            <Button className="col-start-4 min-w-24" variant="secondary" onClick={() => abortRef.current?.abort()}>
              {t('stop')}
            </Button>
          ) : (
            <Button className="col-start-4 min-w-24" variant="primary" disabled={!input.trim() || attaching || drawing || mutating || importing || scriptsPending} onClick={submit}>
              {t('send')}
            </Button>
          )}
        </div>
      </div>

      {/* What the header holds on a wide screen, on a narrow one. The notes panel
          has a whole section of the page to open into, so the sheet only opens it
          and gets out of the way. */}
      {sheetOpen ? (
        <BottomSheet title={t('settings')} onClose={() => setSheetOpen(false)}>
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
            disabled={settingsLocked}
            onChange={(patch) => void updateSettings(patch)}
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
        <ScriptDialog prompt={scriptPrompt} name={characterName} onDone={() => setScriptPrompt(null)} />
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
