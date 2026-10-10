/**
 * Moving a SillyTavern library over: what the scan found, what an earlier run
 * already brought in, and the run itself — one item at a time, in the order the
 * pieces depend on each other.
 *
 * What leaves the browser is exactly what the API calls below send: the chosen
 * card files and their linked World Info files, the extra lorebook entries and
 * display scripts converted here, persona names and descriptions, and the chats
 * converted to our message shape in batches. The scan's own inputs —
 * `settings.json`, the rest of the backup — are never part of a request.
 *
 * Every API call goes through the injected `fetch`, and the core converters come
 * in through `ImportDeps`, so the whole flow runs in a test without a server.
 */
import type { DisplayScript, ImportedChatMessage, LoreEntry } from '@shizue/core';
import {
  FileTooLargeError,
  type convertSillyTavernChat,
  type StCharacter,
  type StChatFile,
  type StConvertedChat,
  type StFile,
  type StGroup,
  type StManifest,
  type StPersona,
} from '@shizue/core/sillytavern';
import { ApiError, toApiError } from '../api';
import {
  MAX_CARD_IMPORT_BYTES,
  MAX_CHARACTERS_PER_PLOT,
  type Persona,
  type PlotDetail,
  type PlotMember,
} from '../types';

/** Hashes one lookup may ask about; mirrors the API. */
export const LOOKUP_LIMIT = 1000;
/** One chat batch: at most this many messages and this many bytes of JSON. */
export const BATCH_MESSAGES = 500;
export const BATCH_BYTES = 4_000_000;
/**
 * Versions (swipes) one imported message may carry, rows a whole imported chat
 * (every version is one), and characters one version; mirror the API.
 */
export const MAX_IMPORT_VERSIONS = 20;
export const MAX_IMPORTED_ROWS = 20_000;
export const MAX_IMPORT_VERSION_LENGTH = 100_000;
/** Room left in a batch for the fields around `messages` (ids, title, file name). */
const ENVELOPE_BYTES = 16 * 1024;

const failure = (code: string, message: string): ApiError => new ApiError(0, code, message);

const asApiError = (caught: unknown): ApiError =>
  caught instanceof ApiError
    ? caught
    : failure('unknown', caught instanceof Error ? caught.message : String(caught));

const baseName = (path: string): string => path.split('/').pop() ?? path;

/** The bytes as a Blob part; the scanner's reads are always plain ArrayBuffers. */
const bytesPart = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => bytes as Uint8Array<ArrayBuffer>;

/** Lowercase hex SHA-256 — the same digest the API records for an upload. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytesPart(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ── what is already here ────────────────────────────────────────────────────

/** POST /api/imports/lookup — what of these hashes an earlier import brought in. */
export interface ImportLookup {
  characters: { sha256: string; plotId: string; characterId: string }[];
  chats: { sha256: string; chatId: string; importing: boolean }[];
}

/** The lookup arranged for the questions the review and the run ask of it. */
export interface ExistingIndex {
  plotsBySha: Map<string, string[]>;
  shasByPlot: Map<string, Set<string>>;
  chats: Map<string, { chatId: string; importing: boolean }>;
}

export function indexLookup(lookup: ImportLookup): ExistingIndex {
  const plotsBySha = new Map<string, string[]>();
  const shasByPlot = new Map<string, Set<string>>();
  for (const { sha256, plotId } of lookup.characters) {
    plotsBySha.set(sha256, [...(plotsBySha.get(sha256) ?? []), plotId]);
    shasByPlot.set(plotId, (shasByPlot.get(plotId) ?? new Set()).add(sha256));
  }
  const chats = new Map(
    lookup.chats.map(({ sha256, chatId, importing }) => [sha256, { chatId, importing }]),
  );
  return { plotsBySha, shasByPlot, chats };
}

/**
 * The plot an earlier run made of this card on its own. The same card also sits
 * in every group plot it was imported with, so the one that counts is the plot
 * holding no other card of this library.
 */
export function soloPlotOf(sha256: string, index: ExistingIndex): string | null {
  return (
    (index.plotsBySha.get(sha256) ?? []).find((plotId) => index.shasByPlot.get(plotId)?.size === 1) ??
    null
  );
}

/**
 * The plot an earlier run made of a group: one holding every member's card,
 * preferably nothing more. A group of one is its member's own plot.
 */
export function groupPlotOf(shas: string[], index: ExistingIndex): string | null {
  const [first, ...rest] = shas;
  if (first === undefined) return null;
  const candidates = (index.plotsBySha.get(first) ?? []).filter((plotId) =>
    rest.every((sha) => index.shasByPlot.get(plotId)?.has(sha)),
  );
  return (
    candidates.find((plotId) => index.shasByPlot.get(plotId)?.size === shas.length) ??
    candidates[0] ??
    null
  );
}

/** Asks the API about every hash, a thousand at a time. */
export async function lookupImports(
  fetcher: typeof fetch,
  shas: Iterable<string>,
  signal?: AbortSignal,
): Promise<ImportLookup> {
  const all = [...new Set(shas)];
  const out: ImportLookup = { characters: [], chats: [] };
  for (let at = 0; at < all.length; at += LOOKUP_LIMIT) {
    const res = await fetcher('/api/imports/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sha256: all.slice(at, at + LOOKUP_LIMIT) }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw await toApiError(res);
    const page = (await res.json()) as ImportLookup;
    out.characters.push(...page.characters);
    out.chats.push(...page.chats);
  }
  return out;
}

// ── the review ──────────────────────────────────────────────────────────────

/** A chat file, and whether an earlier run brought it in or left it half done. */
export interface ChatItem {
  chat: StChatFile;
  sha256: string;
  state: 'new' | 'imported' | 'incomplete';
}

export interface CharacterItem {
  /** The card's file name, which is what ST names a character by. */
  key: string;
  character: StCharacter;
  sha256: string;
  /** The plot an earlier run made of it; null while it has none. */
  plotId: string | null;
  /** The card names a World Info file the library does not have. */
  worldMissing: boolean;
  /**
   * The name cannot open a speaker line (`이름: …` reads only up to 40 characters,
   * none of them a colon), so its imported lines would read as narration.
   */
  unspeakable: boolean;
  chats: ChatItem[];
}

export interface GroupItem {
  key: string;
  group: StGroup;
  /** The members that come along — the first ten the library has a card for. */
  members: CharacterItem[];
  /** Members past the roster cap, by name; they are left out. */
  overflow: string[];
  /** Member cards the library does not have, by file name. */
  missing: string[];
  plotId: string | null;
  chats: ChatItem[];
}

export interface PersonaItem {
  key: string;
  persona: StPersona;
  /** A persona of the same name is already in the account; it is not made twice. */
  exists: boolean;
}

export interface Review {
  characters: CharacterItem[];
  groups: GroupItem[];
  personas: PersonaItem[];
  /** Files the browser could not read, so nothing of them can come over. */
  unreadable: string[];
}

/** Every file the review fingerprints: the cards and the chats. */
function fingerprintedFiles(manifest: StManifest): StFile[] {
  const files = new Map<string, StFile>();
  for (const character of manifest.characters) {
    files.set(character.file.path, character.file);
    for (const chat of character.chats) files.set(chat.file.path, chat.file);
  }
  for (const group of manifest.groups) {
    for (const chat of group.chats) files.set(chat.file.path, chat.file);
  }
  return [...files.values()];
}

/**
 * Hashes every card and chat, one file at a time — each is read, digested and
 * let go, so a library of hundreds of cards is never in memory at once.
 */
export async function fingerprint(
  manifest: StManifest,
  {
    digest = sha256Hex,
    signal,
    onProgress,
  }: {
    digest?: (bytes: Uint8Array) => Promise<string>;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<{ hashes: Map<string, string>; unreadable: string[] }> {
  const files = fingerprintedFiles(manifest);
  const hashes = new Map<string, string>();
  const unreadable: string[] = [];
  for (const [index, file] of files.entries()) {
    signal?.throwIfAborted();
    try {
      hashes.set(file.path, await digest(await file.read()));
    } catch {
      unreadable.push(file.path);
    }
    onProgress?.(index + 1, files.length);
  }
  return { hashes, unreadable };
}

/** Longest name a speaker line opens with; mirrors `SPEAKER_RE` in @shizue/core's speech.ts. */
const MAX_SPEAKER_NAME = 40;

/** Whether `이름: …` with this name parses back as that speaker. */
export const speakerNameOk = (name: string): boolean => {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_SPEAKER_NAME && !/[:\n]/.test(trimmed);
};

/** True while a character or group still has something to bring over. */
export const hasWork = (item: { plotId: string | null; chats: ChatItem[] }): boolean =>
  item.plotId === null || item.chats.some((chat) => chat.state !== 'imported');

function chatItems(
  chats: StChatFile[],
  hashes: Map<string, string>,
  index: ExistingIndex,
): ChatItem[] {
  return chats.flatMap((chat) => {
    const sha256 = hashes.get(chat.file.path);
    if (!sha256) return [];
    const found = index.chats.get(sha256);
    const state = !found ? 'new' : found.importing ? 'incomplete' : 'imported';
    return [{ chat, sha256, state } satisfies ChatItem];
  });
}

/**
 * The scan, set against what is already in the account. Pure: the hashes, the
 * lookup and the reader's persona names are all read before this is called.
 */
export function reviewImport(
  manifest: StManifest,
  hashes: Map<string, string>,
  lookup: ImportLookup,
  personaNames: Iterable<string>,
  unreadable: string[] = [],
): Review {
  const index = indexLookup(lookup);
  const characters = manifest.characters.flatMap((character) => {
    const sha256 = hashes.get(character.file.path);
    if (!sha256) return [];
    return [
      {
        key: character.avatar,
        character,
        sha256,
        plotId: soloPlotOf(sha256, index),
        worldMissing: Boolean(character.worldName && !manifest.worlds[character.worldName]),
        unspeakable: !speakerNameOk(character.name),
        chats: chatItems(character.chats, hashes, index),
      } satisfies CharacterItem,
    ];
  });
  const byAvatar = new Map(characters.map((item) => [item.key, item]));

  const groups = manifest.groups.map((group): GroupItem => {
    const found = group.members.flatMap((avatar) => byAvatar.get(avatar) ?? []);
    const members = found.slice(0, MAX_CHARACTERS_PER_PLOT);
    return {
      key: group.id,
      group,
      members,
      overflow: found.slice(MAX_CHARACTERS_PER_PLOT).map((item) => item.character.name),
      missing: group.members.filter((avatar) => !byAvatar.has(avatar)),
      plotId: groupPlotOf(
        members.map((member) => member.sha256),
        index,
      ),
      chats: chatItems(group.chats, hashes, index),
    };
  });

  const names = new Set([...personaNames].map((name) => name.trim()));
  const personas = manifest.personas.map(
    (persona): PersonaItem => ({
      key: persona.avatar,
      persona,
      exists: names.has(persona.name.trim()),
    }),
  );
  return { characters, groups, personas, unreadable };
}

export interface Selection {
  characters: Set<string>;
  groups: Set<string>;
  personas: Set<string>;
}

/** Everything that is not already here, checked; everything that is, not. */
export function defaultSelection(review: Review): Selection {
  return {
    characters: new Set(review.characters.filter(hasWork).map((item) => item.key)),
    groups: new Set(
      review.groups.filter((item) => item.members.length > 0 && hasWork(item)).map((item) => item.key),
    ),
    personas: new Set(review.personas.filter((item) => !item.exists).map((item) => item.key)),
  };
}

export interface ImportOptions {
  chats: boolean;
  /** The extra lorebooks ST links to one character beyond its own (`charLore`). */
  extraLorebooks: boolean;
  /** The lorebooks ST has switched on for every chat. */
  globalLorebooks: boolean;
  /** The regex scripts ST runs on every chat, as display scripts. */
  globalRegex: boolean;
  /** Summarize long imported chats into their memory — on the reader's ChatGPT plan. */
  memoryBackfill: boolean;
}

export const DEFAULT_OPTIONS: ImportOptions = {
  chats: true,
  extraLorebooks: true,
  globalLorebooks: false,
  globalRegex: false,
  memoryBackfill: true,
};

// ── the plan ────────────────────────────────────────────────────────────────

export type ImportStep =
  | { id: string; kind: 'persona'; item: PersonaItem }
  | { id: string; kind: 'character'; item: CharacterItem }
  | { id: string; kind: 'group'; item: GroupItem }
  /** `owner` is the character or group step whose plot the chat goes into. */
  | { id: string; kind: 'chat'; owner: string; item: ChatItem };

/**
 * The run, in dependency order: personas first (a chat's user is matched to one
 * by name), then each character with its chats right behind it, then each group
 * with its chats. Chats an earlier run finished are not planned at all.
 */
export function planImport(review: Review, selection: Selection, options: ImportOptions): ImportStep[] {
  const steps: ImportStep[] = [];
  const chatSteps = (owner: string, chats: ChatItem[]): ImportStep[] =>
    options.chats
      ? chats
          .filter((chat) => chat.state !== 'imported')
          .map((chat) => ({ id: `chat:${chat.chat.file.path}`, kind: 'chat', owner, item: chat }))
      : [];

  for (const item of review.personas) {
    if (selection.personas.has(item.key) && !item.exists) {
      steps.push({ id: `persona:${item.key}`, kind: 'persona', item });
    }
  }
  for (const item of review.characters) {
    if (!selection.characters.has(item.key)) continue;
    const id = `character:${item.key}`;
    steps.push({ id, kind: 'character', item }, ...chatSteps(id, item.chats));
  }
  for (const item of review.groups) {
    if (!selection.groups.has(item.key) || item.members.length === 0) continue;
    const id = `group:${item.key}`;
    steps.push({ id, kind: 'group', item }, ...chatSteps(id, item.chats));
  }
  return steps;
}

// ── batching ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/**
 * Splits a conversation into the batches the import takes: at most
 * `maxMessages` each, and at most `maxBytes` of JSON as the array is sent. A
 * single message larger than that goes alone — it cannot be split, and the API
 * is the one to say whether it fits.
 */
export function batchMessages(
  messages: ImportedChatMessage[],
  { maxMessages = BATCH_MESSAGES, maxBytes = BATCH_BYTES - ENVELOPE_BYTES } = {},
): ImportedChatMessage[][] {
  const batches: ImportedChatMessage[][] = [];
  let current: ImportedChatMessage[] = [];
  // The array's brackets, then each element's bytes and the comma before it.
  let size = 2;
  for (const message of messages) {
    const bytes = jsonBytes(message);
    const grown = size + bytes + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && (current.length >= maxMessages || grown > maxBytes)) {
      batches.push(current);
      current = [message];
      size = 2 + bytes;
    } else {
      current.push(message);
      size = grown;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The message with at most `count` versions: the selected one, and the earliest of the rest. */
function keepVersions(message: ImportedChatMessage, count: number): ImportedChatMessage {
  if (message.versions.length <= count) return message;
  const kept = message.versions
    .map((_, index) => index)
    .filter((index) => index !== message.selected)
    .slice(0, Math.max(count - 1, 0))
    .concat(message.selected)
    .sort((a, b) => a - b);
  return {
    ...message,
    versions: kept.map((index) => message.versions[index]!),
    selected: kept.indexOf(message.selected),
  };
}

/**
 * A message within the versions one imported message may carry: ST keeps every
 * swipe, the import at most `MAX_IMPORT_VERSIONS`. How many went is counted.
 */
export function capVersions(message: ImportedChatMessage): {
  message: ImportedChatMessage;
  dropped: number;
} {
  const capped = keepVersions(message, MAX_IMPORT_VERSIONS);
  return { message: capped, dropped: message.versions.length - capped.versions.length };
}

/**
 * A conversation within the rows one imported chat may hold — every version is
 * a row. Where it has more, the alternatives go first, oldest messages first:
 * the conversation as the reader left it always comes over whole, and the swipes
 * nearest where they will carry on are the ones kept. Undefined when even the
 * selected versions alone do not fit.
 */
export function fitRows(
  messages: ImportedChatMessage[],
  maxRows = MAX_IMPORTED_ROWS,
): { messages: ImportedChatMessage[]; dropped: number } | undefined {
  const rows = messages.reduce((sum, message) => sum + message.versions.length, 0);
  if (rows <= maxRows) return { messages, dropped: 0 };
  if (messages.length > maxRows) return undefined;
  let excess = rows - maxRows;
  const fitted = messages.map((message) => {
    if (excess <= 0 || message.versions.length === 1) return message;
    const drop = Math.min(excess, message.versions.length - 1);
    excess -= drop;
    return keepVersions(message, message.versions.length - drop);
  });
  return { messages: fitted, dropped: rows - maxRows };
}

// ── the run ─────────────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';

/** Why a step brought nothing over, though nothing went wrong. */
export type SkipReason = 'already_imported' | 'persona_exists' | 'chat_empty' | 'owner_failed';

/** Something that went wrong on a step without failing it. */
export interface StepWarning {
  code: 'world_missing' | 'world_unreadable' | 'extras_failed';
  /** The lorebook it is about. */
  name?: string;
  error?: ApiError;
}

/** A member of the plot as the chat converter matches speakers against it. */
export interface CastMember {
  name: string;
  avatar?: string;
}

export type MemoryBackfill = 'queued' | 'not_needed' | 'unavailable';

export interface StepResult {
  status: StepStatus;
  reason?: SkipReason;
  error?: ApiError;
  /** The plot a character or group step made or found, and who is in it. */
  plotId?: string;
  cast?: CastMember[];
  /** The chat a chat step made or found. */
  chatId?: string;
  memoryBackfill?: MemoryBackfill;
  /**
   * What of the source file did not come over: the converter's counts, swipes
   * past the per-message cap, and swipes let go to fit the per-chat row cap.
   */
  dropped?: StConvertedChat['skipped'] & { swipes: number; swipesOverRows: number };
  warnings?: StepWarning[];
}

export type Results = Record<string, StepResult>;

export const initialResults = (steps: ImportStep[]): Results =>
  Object.fromEntries(steps.map((step) => [step.id, { status: 'pending' } satisfies StepResult]));

/** What a run (or a retry) takes up: anything that has not come over yet. */
export function needsRun(result: StepResult | undefined): boolean {
  if (!result) return true;
  return (
    result.status === 'pending' ||
    result.status === 'failed' ||
    result.status === 'cancelled' ||
    result.reason === 'owner_failed'
  );
}

/** The core converters the run uses, injected so a test can stand in for them. */
export interface ImportDeps {
  /** Called as a method, so the page passes a wrapper rather than `window.fetch` itself. */
  fetch: typeof fetch;
  convertChat: typeof convertSillyTavernChat;
  /** `fromLorebookFile` from `@shizue/core/world-info`. */
  lorebookEntries: (json: unknown) => LoreEntry[];
  /** `regexScriptsToDisplayScripts`. */
  displayScripts: (scripts: unknown[]) => DisplayScript[];
}

export interface RunInput {
  manifest: Pick<StManifest, 'worlds' | 'globalWorlds' | 'globalRegex'>;
  steps: ImportStep[];
  options: ImportOptions;
  /**
   * Every card of the library, whether it is in this run or not. A plot is one
   * card's own only if it holds no other card of the library, and that cannot be
   * told from the cards being imported alone.
   */
  cardHashes: string[];
}

interface RunContext extends RunInput {
  deps: ImportDeps;
  signal: AbortSignal | undefined;
  index: ExistingIndex;
  /** The reader's personas by name, including the ones this run made. */
  personas: Map<string, string>;
  results: Results;
  /** Parsed World Info files, read once per run however many plots take them. */
  worlds: Map<string, Promise<LoreEntry[]>>;
  globalScripts: DisplayScript[] | null;
  /** Set once the API says the reader has no model to start a chat on. */
  chatsBlocked: ApiError | null;
}

async function request<T>(
  ctx: RunContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await ctx.deps.fetch(path, {
    method,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(body === undefined
      ? {}
      : body instanceof FormData
        ? { body }
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A file of the library, read now; a read that fails (gone, corrupt, over its cap) says so in our terms. */
async function readFile(file: StFile): Promise<Uint8Array> {
  try {
    return await file.read();
  } catch (caught) {
    const detail = `${file.path}: ${caught instanceof Error ? caught.message : caught}`;
    throw failure(caught instanceof FileTooLargeError ? 'st_file_too_large' : 'st_file_unreadable', detail);
  }
}

/**
 * The card and the World Info file it links, as the import routes take them. The
 * linked file replaces the lorebook embedded in the card, which ST only writes
 * back when the character is saved and so is often older than the file.
 */
async function cardForm(
  character: StCharacter,
  world: { name: string; bytes: Uint8Array } | null,
): Promise<FormData> {
  if (character.file.size > MAX_CARD_IMPORT_BYTES) {
    throw failure('card_too_large', `A card file is at most ${MAX_CARD_IMPORT_BYTES} bytes`);
  }
  const form = new FormData();
  form.append(
    'file',
    new File([bytesPart(await readFile(character.file))], character.avatar, { type: 'image/png' }),
  );
  if (world) {
    form.append('worldInfo', new File([bytesPart(world.bytes)], world.name, { type: 'application/json' }));
  }
  return form;
}

/**
 * Uploads a card to one of the two import routes. A linked World Info file that
 * cannot be read here, or that the API cannot read (`invalid_lorebook`), does not
 * cost the character: the card goes on its own, with its embedded lorebook, and
 * the step says so.
 */
async function uploadCard<T>(
  ctx: RunContext,
  path: string,
  character: StCharacter,
  warnings: StepWarning[],
): Promise<T> {
  const unreadable = (): void => {
    warnings.push({ code: 'world_unreadable', ...(character.worldName ? { name: character.worldName } : {}) });
  };
  const file = character.worldName ? ctx.manifest.worlds[character.worldName] : undefined;
  let world: { name: string; bytes: Uint8Array } | null = null;
  if (file) {
    try {
      world = { name: baseName(file.path), bytes: await readFile(file) };
    } catch {
      ctx.signal?.throwIfAborted();
      unreadable();
    }
  }
  try {
    return await request<T>(ctx, 'POST', path, await cardForm(character, world));
  } catch (caught) {
    if (!world || !(caught instanceof ApiError && caught.code === 'invalid_lorebook')) throw caught;
    unreadable();
    return request<T>(ctx, 'POST', path, await cardForm(character, null));
  }
}

function worldEntries(ctx: RunContext, name: string, file: StFile): Promise<LoreEntry[]> {
  let entries = ctx.worlds.get(name);
  if (!entries) {
    entries = readFile(file).then((bytes) =>
      ctx.deps.lorebookEntries(JSON.parse(new TextDecoder().decode(bytes))),
    );
    ctx.worlds.set(name, entries);
  }
  return entries;
}

/**
 * What a new plot takes after its cards: the extra and global lorebooks appended
 * to its own, the global regex scripts appended to its display scripts, and — for
 * a group — the group's name. One PATCH, and its failure is the plot's warning,
 * not its end: the cast is in and the chats can still come.
 */
async function applyExtras(
  ctx: RunContext,
  plot: PlotDetail,
  characters: StCharacter[],
  name?: string,
): Promise<StepWarning[]> {
  const warnings: StepWarning[] = [];
  const books = new Set<string>();
  if (ctx.options.extraLorebooks) {
    for (const character of characters) for (const book of character.extraWorlds) books.add(book);
  }
  if (ctx.options.globalLorebooks) for (const book of ctx.manifest.globalWorlds) books.add(book);
  // A member's own linked book came in with its card.
  for (const character of characters) if (character.worldName) books.delete(character.worldName);

  const entries: LoreEntry[] = [];
  for (const book of books) {
    const file = ctx.manifest.worlds[book];
    if (!file) {
      warnings.push({ code: 'world_missing', name: book });
      continue;
    }
    try {
      entries.push(...(await worldEntries(ctx, book, file)));
    } catch {
      ctx.signal?.throwIfAborted();
      warnings.push({ code: 'world_unreadable', name: book });
    }
  }
  if (ctx.options.globalRegex && ctx.globalScripts === null) {
    ctx.globalScripts = ctx.deps.displayScripts(ctx.manifest.globalRegex);
  }
  const scripts = ctx.options.globalRegex ? (ctx.globalScripts ?? []) : [];

  const patch: Record<string, unknown> = {};
  if (name && name !== plot.name) patch['name'] = name;
  if (entries.length > 0) patch['lorebook'] = [...plot.lorebook, ...entries];
  if (scripts.length > 0) {
    patch['customUi'] = {
      ...(plot.customUi ?? {}),
      displayScripts: [...(plot.customUi?.displayScripts ?? []), ...scripts],
    };
  }
  if (Object.keys(patch).length === 0) return warnings;
  try {
    await request<PlotDetail>(ctx, 'PATCH', `/api/plots/${plot.id}`, patch);
  } catch (caught) {
    ctx.signal?.throwIfAborted();
    warnings.push({ code: 'extras_failed', error: asApiError(caught) });
  }
  return warnings;
}

/** The plot's members, in the library's order, as the chat converter names them. */
function castOf(members: PlotMember[], items: CharacterItem[]): CastMember[] {
  return items.flatMap((item) => {
    const member = members.find((candidate) => candidate.importedFrom?.sha256 === item.sha256);
    return member ? [{ name: member.name, avatar: item.character.avatar }] : [];
  });
}

/** A one-card plot's cast: its member, found by card hash or, failing that, its first. */
function soloCast(plot: PlotDetail, item: CharacterItem): CastMember[] {
  const cast = castOf(plot.characters, [item]);
  const first = plot.characters[0];
  return cast.length > 0 || !first ? cast : [{ name: first.name, avatar: item.character.avatar }];
}

async function runPersona(
  ctx: RunContext,
  item: PersonaItem,
  result: StepResult,
): Promise<void> {
  const name = item.persona.name.trim();
  if (ctx.personas.has(name)) {
    result.status = 'skipped';
    result.reason = 'persona_exists';
    return;
  }
  const created = await request<Persona>(ctx, 'POST', '/api/personas', {
    name,
    description: item.persona.description,
  });
  ctx.personas.set(name, created.id);
  result.status = 'done';
}

async function runCharacter(
  ctx: RunContext,
  item: CharacterItem,
  result: StepResult,
): Promise<void> {
  // A plot this session already made (a step cancelled after it), or an earlier run's.
  const ours = result.plotId;
  const existing = ours ?? soloPlotOf(item.sha256, ctx.index);
  if (existing) {
    const plot = await request<PlotDetail>(ctx, 'GET', `/api/plots/${existing}`);
    result.plotId = plot.id;
    result.cast = soloCast(plot, item);
    if (ours) result.status = 'done';
    else {
      result.status = 'skipped';
      result.reason = 'already_imported';
    }
    return;
  }
  const warnings: StepWarning[] = [];
  const plot = await uploadCard<PlotDetail>(ctx, '/api/plots/import', item.character, warnings);
  result.plotId = plot.id;
  result.cast = soloCast(plot, item);
  warnings.push(...(await applyExtras(ctx, plot, [item.character])));
  if (warnings.length > 0) result.warnings = warnings;
  result.status = 'done';
}

/**
 * A group becomes one plot: the first member's card makes it, the rest join it
 * one by one. A member that fails leaves the group failed but its plot kept, so
 * a retry adds only the members it does not have yet — read off the plot's own
 * roster by card hash rather than remembered.
 */
async function runGroup(ctx: RunContext, item: GroupItem, result: StepResult): Promise<void> {
  const [first] = item.members;
  if (!first) throw failure('st_group_empty', 'None of the group’s members has a card here');
  const shas = item.members.map((member) => member.sha256);
  const ours = result.plotId;
  const existing = ours ?? groupPlotOf(shas, ctx.index);

  const warnings = [...(result.warnings ?? [])];
  let plot: PlotDetail;
  if (existing) {
    plot = await request<PlotDetail>(ctx, 'GET', `/api/plots/${existing}`);
  } else {
    plot = await uploadCard<PlotDetail>(ctx, '/api/plots/import', first.character, warnings);
    result.plotId = plot.id;
    warnings.push(
      ...(await applyExtras(
        ctx,
        plot,
        item.members.map((member) => member.character),
        item.group.name.trim() || undefined,
      )),
    );
  }
  result.plotId = plot.id;

  const members = [...plot.characters];
  const present = new Set(members.map((member) => member.importedFrom?.sha256));
  let added = 0;
  let failed: ApiError | undefined;
  for (const member of item.members) {
    if (present.has(member.sha256)) continue;
    try {
      const joined = await uploadCard<PlotMember>(
        ctx,
        `/api/plots/${plot.id}/characters/import`,
        member.character,
        warnings,
      );
      members.push(joined);
      present.add(member.sha256);
      added += 1;
    } catch (caught) {
      ctx.signal?.throwIfAborted();
      failed ??= asApiError(caught);
    }
  }
  result.cast = castOf(members, item.members);
  if (warnings.length > 0) result.warnings = warnings;
  if (failed) throw failed;
  if (existing && !ours && added === 0) {
    result.status = 'skipped';
    result.reason = 'already_imported';
    return;
  }
  result.status = 'done';
}

/**
 * One chat file: converted against its plot's cast, created with its first
 * batch, filled with the rest, then closed — and only closing it lets anything
 * else write to it. A chat an interrupted run left open needs nothing here: the
 * create finds it by hash, deletes it and starts over, since what of it arrived
 * is not something either side can tell.
 */
async function runChat(
  ctx: RunContext,
  owner: string,
  item: ChatItem,
  result: StepResult,
): Promise<void> {
  const parent = ctx.results[owner];
  if (!parent?.plotId || !parent.cast || parent.status === 'failed' || parent.status === 'cancelled') {
    result.status = 'skipped';
    result.reason = 'owner_failed';
    return;
  }
  const found = ctx.index.chats.get(item.sha256);
  if (found && !found.importing) {
    result.status = 'skipped';
    result.reason = 'already_imported';
    result.chatId = found.chatId;
    return;
  }
  if (ctx.chatsBlocked) throw ctx.chatsBlocked;

  const text = new TextDecoder().decode(await readFile(item.chat.file));
  const converted = ctx.deps.convertChat(text, { members: parent.cast });
  let swipes = 0;
  const capped = converted.messages.map((source) => {
    const { message, dropped } = capVersions(source);
    swipes += dropped;
    return message;
  });
  if (capped.length === 0) {
    result.dropped = { ...converted.skipped, swipes, swipesOverRows: 0 };
    result.status = 'skipped';
    result.reason = 'chat_empty';
    return;
  }
  // Fitted before anything is written: the API refuses the batch that crosses
  // the cap, after the ones before it went in.
  const fitted = fitRows(capped);
  if (!fitted) throw failure('message_limit', `An imported chat holds at most ${MAX_IMPORTED_ROWS} messages`);
  const { messages } = fitted;
  if (messages.some((message) => message.versions.some((text) => text.length > MAX_IMPORT_VERSION_LENGTH))) {
    throw failure('message_too_long', `One imported message is at most ${MAX_IMPORT_VERSION_LENGTH} characters`);
  }
  result.dropped = { ...converted.skipped, swipes, swipesOverRows: fitted.dropped };
  // ST now writes 'unused' as the header's name, which the converter reads as ''
  // when no user line names one either: then the chat starts on no persona.
  const userName = converted.userName.trim();
  const personaId = userName ? ctx.personas.get(userName) : undefined;
  const [head = [], ...rest] = batchMessages(messages);

  const res = await ctx.deps.fetch('/api/chats/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      plotId: parent.plotId,
      ...(personaId ? { personaId } : {}),
      title: item.chat.name,
      fileName: baseName(item.chat.file.path),
      sha256: item.sha256,
      messages: head,
    }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 409) {
    const body = (await res.clone().json().catch(() => null)) as { code?: string; chatId?: string } | null;
    if (body?.code === 'already_imported') {
      result.status = 'skipped';
      result.reason = 'already_imported';
      if (body.chatId) result.chatId = body.chatId;
      return;
    }
  }
  if (!res.ok) {
    const error = await toApiError(res);
    // No model in the reader's catalog to start a chat on: every chat after this
    // would be refused the same way, so they are not sent; the cards go on.
    if (error.code === 'model_unavailable') ctx.chatsBlocked = error;
    throw error;
  }
  const created = (await res.json()) as { chat: { id: string } };
  result.chatId = created.chat.id;

  for (const batch of rest) {
    ctx.signal?.throwIfAborted();
    await request(ctx, 'POST', `/api/chats/${created.chat.id}/import`, { messages: batch });
  }
  const done = await request<{ memoryBackfill: MemoryBackfill }>(
    ctx,
    'POST',
    `/api/chats/${created.chat.id}/import/complete`,
    { backfillMemory: ctx.options.memoryBackfill },
  );
  result.memoryBackfill = done.memoryBackfill;
  result.status = 'done';
}

/** The chat files the steps still to run would bring over. */
const chatHashes = (steps: ImportStep[]): string[] =>
  steps.flatMap((step) => (step.kind === 'chat' ? [step.item.sha256] : []));

/**
 * Runs every step that has not come over yet, in plan order, and reports each
 * change through `onUpdate`. A step that fails is recorded and the run goes on;
 * a chat whose plot did not come over is skipped with that reason, and a retry
 * picks it up with its plot. Cancelling stops at the request in flight; what had
 * not finished is marked cancelled, and a retry takes it up again.
 *
 * Before anything is written the lookup is asked again, so a retry after a lost
 * response — a plot made on the server that the browser never heard of — finds
 * what it made instead of making it twice.
 */
export async function runImport(
  input: RunInput,
  previous: Results,
  deps: ImportDeps,
  { signal, onUpdate }: { signal?: AbortSignal; onUpdate?: (results: Results) => void } = {},
): Promise<Results> {
  const results: Results = { ...previous };
  const todo = input.steps.filter((step) => needsRun(results[step.id]));
  const publish = (): void => onUpdate?.({ ...results });

  const ctx: RunContext = {
    ...input,
    deps,
    signal,
    index: indexLookup({ characters: [], chats: [] }),
    personas: new Map(),
    results,
    worlds: new Map(),
    globalScripts: null,
    chatsBlocked: null,
  };

  try {
    const personas = await request<Persona[]>(ctx, 'GET', '/api/personas');
    for (const persona of personas) {
      const name = persona.name.trim();
      if (!ctx.personas.has(name)) ctx.personas.set(name, persona.id);
    }
    ctx.index = indexLookup(
      await lookupImports(deps.fetch, [...input.cardHashes, ...chatHashes(todo)], signal),
    );
  } catch (caught) {
    // Nothing has been written yet: every step stays as it was, and the run says why.
    for (const step of todo) {
      results[step.id] = signal?.aborted
        ? { ...results[step.id], status: 'cancelled' }
        : { ...results[step.id], status: 'failed', error: asApiError(caught) };
    }
    publish();
    return results;
  }

  for (const step of todo) {
    if (signal?.aborted) {
      results[step.id] = { ...results[step.id], status: 'cancelled' };
      continue;
    }
    const result: StepResult = { ...results[step.id], status: 'running' };
    delete result.error;
    delete result.reason;
    results[step.id] = result;
    publish();
    try {
      switch (step.kind) {
        case 'persona':
          await runPersona(ctx, step.item, result);
          break;
        case 'character':
          await runCharacter(ctx, step.item, result);
          break;
        case 'group':
          await runGroup(ctx, step.item, result);
          break;
        case 'chat':
          await runChat(ctx, step.owner, step.item, result);
          break;
      }
    } catch (caught) {
      if (signal?.aborted) result.status = 'cancelled';
      else {
        result.status = 'failed';
        result.error = asApiError(caught);
      }
    }
    results[step.id] = { ...result };
  }
  publish();
  return results;
}
