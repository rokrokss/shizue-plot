'use client';

import { Icon } from '@/components/Icon';
import { componentNames } from '@shizue/core/component';
import { NARRATION_PREFIX } from '@shizue/core/narration';
import { isSceneMessage, sceneSpanAt } from '@shizue/core/scene';
import { computeVariables, type Variables } from '@shizue/core/variables';
import { useFormatter, useTranslations } from 'next-intl';
import { Fragment, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { AiBadge, AiNotice } from '@/components/AiNotice';
import { AttachmentChips } from '@/components/AttachmentChips';
import { Avatar } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { ChatPanel } from '@/components/ChatPanel';
import { ChatSettings } from '@/components/ChatSettings';
import { MessageRow } from '@/components/MessageRow';
import { MoreActions } from '@/components/MoreActions';
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
import { chatRowMeta, relativeDay } from '@/lib/chatRows';
import { COMPOSER_MODES, composeTurn, type ComposerMode } from '@/lib/composerMode';
import type { ComponentContext } from '@/lib/componentCalls';
import { toggleDirectionMarkup } from '@/lib/directionMarkup';
import { streamsNarration } from '@/lib/narrator';
import {
  readCustomUiEnabled,
  sameVariables,
  writeCustomUiEnabled,
  type DisplayContext,
} from '@/lib/displayScripts';
import { reconcileSend } from '@/lib/reconcile';
import { streamGeneration } from '@/lib/sse';
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

  const [input, setInput] = useState('');
  /** How the composer's text is meant: a line, a description, or the narrator's. */
  const [composerMode, setComposerMode] = useState<ComposerMode>('dialogue');
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

  // The fold of the persisted branch, and of the branch without its head — the
  // two bases every mode builds on. Both depend only on server state, so a
  // streamed token never re-folds the history.
  const persistedVariables = useMemo(
    () => computeVariables(fold.messages.map((message) => message.content), fold.defaults),
    [fold],
  );
  const variablesBeforeHead = useMemo(
    () => computeVariables(fold.messages.slice(0, -1).map((message) => message.content), fold.defaults),
    [fold],
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
    return computeVariables(pending, base);
  }, [active, mode, last, persistedVariables, variablesBeforeHead, pendingUser, streamText]);

  // …and the same values keep the same object, so the memoized message bodies do
  // not re-run their regexes, their template and two DOMPurify passes for a token
  // that moved nothing.
  const variables = useStableVariables(liveVariables);

  /** The plot's cast, which is what a reply's `이름:` lines are read against. */
  const members = plot?.characters ?? NO_MEMBERS;
  const characterName = plot?.name ?? state?.chat.title ?? '';
  // Who the conversation is with, once either read has said so.
  useDocumentTitle(characterName);
  const personaName = personas.find((persona) => persona.id === state?.chat.personaId)?.name;
  const youLabel = t('you');
  /** User turns taken on this branch, for `{{turn}}`. */
  const turn = messages.filter((message) => message.role === 'user').length + (mode === 'send' ? 1 : 0);
  const axes = state?.chat.relationship?.axes ?? null;

  const display = useMemo<DisplayContext | undefined>(() => {
    if (!customUi || scripts.length === 0) return undefined;
    return {
      scripts,
      variables,
      assets: assetUrls,
      relationship: axes,
      turn,
      char: characterName,
      user: personaName ?? youLabel,
    };
  }, [customUi, scripts, variables, assetUrls, axes, turn, characterName, personaName, youLabel]);

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
        char: characterName,
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
    characterName,
    personaName,
    youLabel,
    assetUrls,
    suggestInput,
    maySendTurn,
    sendTurn,
  ]);

  async function run(next: StreamMode, content?: string, turnOptions?: SendOptions): Promise<void> {
    // A drawn scene holds the same per-chat slot a generation does, so asking for
    // one while the picture is on its way would only come back a 429.
    if (mode || drawing || mutationRef.current) return;
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

    let rejection: unknown = null;
    let streamError: string | null = null;
    let aborted = false;
    /** How much of a reply arrived, which decides whether there is any to keep. */
    let received = 0;
    try {
      const result = await streamGeneration(
        next === 'send' ? `/api/chats/${id}/messages` : `/api/chats/${id}/${next}`,
        next === 'send' ? { content, ...turnOptions } : undefined,
        (text) => {
          received += text.length;
          append(text);
        },
        controller.signal,
      );
      if (result.kind === 'error') streamError = result.code ? toMessage(new ApiError(0, result.code, result.message)) : result.message;
      aborted = result.kind === 'aborted';
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
          setInput((current) => (current.trim() ? `${content ?? ''}\n${current}` : (content ?? '')));
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
  const rowMeta = chatRowMeta(view);

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
  function submit(): void {
    if (!input.trim() || mode || drawing || mutationRef.current || attaching) return;
    // The chip is a way of typing: what is stored is the plain convention, the
    // same one the reader could have written the marks of by hand.
    const content = composeTurn(input, composerMode);
    const attachmentIds = uploadedIds(chips);
    setInput('');
    void run('send', content, attachmentIds.length > 0 ? { attachmentIds } : undefined);
  }

  const info = last ? state.siblings[last.id] : undefined;
  // A drawn scene takes the same per-chat slot a generation does, so while one is
  // in flight the row of actions is withheld exactly as it is while text streams.
  const showActions = !mode && !drawing && !mutating && Boolean(last);
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
  const settingsLocked = Boolean(mode) || drawing || mutating;
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
              customUi={customUi}
              onToggleCustomUi={(enabled) => {
                writeCustomUiEnabled(enabled);
                setCustomUi(enabled);
              }}
            />
          </div>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
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
          // The one thing a display script's button can do: put its text in the
          // composer. Sending stays the user's decision.
          onClick={(event) => {
            const button = (event.target as HTMLElement).closest?.('[data-shizue-fill]');
            if (button) setInput(button.getAttribute('data-shizue-fill') ?? '');
          }}
        >
          <AiNotice />

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
                  name={message.role === 'user' ? t('you') : characterName}
                  avatar={plot?.coverUrl ?? null}
                  roster={members}
                  assets={messageAssets}
                  attachments={message.attachments}
                  {...(display ? { display } : {})}
                  {...(components ? { components } : {})}
                  previousSameRole={meta.previousSameRole}
                  streaming={message.streaming}
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
            disabled={Boolean(mode) || drawing}
            onClick={() => void suggest()}
          >
            <span aria-hidden="true">✦</span>
            {t('suggest')}
          </Button>
        </div>
        <div className="mx-auto grid max-w-3xl grid-cols-[auto_auto_1fr_auto] items-end gap-2 px-5 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <TextArea
            ref={composerRef}
            rows={2}
            value={input}
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
            disabled={Boolean(mode)}
            onClick={() => filePicker.current?.click()}
          >
            <Icon name="attach" className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('direction')}
            title={t('directionHint')}
            disabled={Boolean(mode)}
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
            <Button className="col-start-4 min-w-24" variant="primary" disabled={!input.trim() || attaching || drawing || mutating} onClick={submit}>
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

      {/* The whole window is the drop target while a file is over it, so the
          overlay is the only thing that has to say where it will land. */}
      {dropping ? (
        <div
          data-testid="attachment-drop"
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-canvas/70 backdrop-blur-sm"
        >
          <span className="rounded-xl border border-dashed border-muted px-6 py-4 text-sm tracking-wide text-fg">
            {t('attach')}
          </span>
        </div>
      ) : null}
    </div>
  );
}
