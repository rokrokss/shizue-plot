/**
 * What a work's creator loads from other hosts — pictures, music, stylesheets,
 * web fonts — fetched once at import and kept as the plot's own assets, its
 * references rewritten to them (the owner's call: RisuAI draws a card's HTML as
 * written, so it loads them in the reader's browser; nothing a chat draws here
 * may contact a third host, see `@shizue/core` `externalAssets.ts`).
 *
 * Which texts: the openings, the stylesheet, each member's stylesheet, the
 * background and the display scripts' templates — the work's — and each RisuAI
 * module's stylesheet, background and display scripts. Never the prompt's text
 * (descriptions, lore): changing it would change what the model reads. A web
 * font the prompt's text imports is brought in all the same, into the
 * stylesheet, the text left as it is — the model writes it back into a reply,
 * where RisuAI would load it (`promptSources`).
 *
 * A stylesheet's `{{raw::name}}` — how a RisuAI card, and this app's charx
 * export, write one of the card's own assets into CSS — is written as that
 * asset's address too, once the assets are stored: a stylesheet is never read
 * as CBS (`rewriteAssetAddresses`).
 *
 * How each reference ends up:
 *
 * - A picture, a font or music (`url()`, `src=`) is fetched and stored under a
 *   name that is its address (`localizedName`), and the reference points at the
 *   asset (`/api/plots/:id/assets/:slug`).
 * - A template address (a capture, a draw, a chat variable) is fetched once per
 *   value the slot is known to take (`templateCandidates`) and the reference
 *   points at the by-name route with the slot left in
 *   (`/api/plots/:id/assets/by-name/…`), so the value the renderer writes finds
 *   its copy — and one nobody foresaw is a missing picture on our own origin,
 *   not a request out. A `{{getvar::…}}` slot — in the path, or holding the
 *   host (`src="{{getvar::cdn}}/face.png"`) — takes what the card sets the
 *   variable to: its default and its literal `setvar`s (`cardVariableValues`);
 *   one the card never sets to an address is no miss, only nothing to bring.
 * - An `@import`ed stylesheet is fetched, its own `url()`s and `@import`s
 *   localized in turn (to `IMPORT_DEPTH`), and inlined where it stood, under its
 *   media list. A web font's stylesheet (`isFontStylesheet`) imported by a
 *   template — a display script's `<style>`, an opening — goes to the
 *   stylesheet of the work or module instead, once: a Korean family is hundreds
 *   of `@font-face` slices, which a message would otherwise carry and sanitize
 *   every time it is drawn, and a font face is the page's whatever declares it.
 *   (A member's own stylesheet inlines it: its families are that member's.)
 *
 * A RisuAI module a reader puts in their own library is localized the same way
 * (`localizeReaderModule`), into pictures of the module's own.
 *
 * Whatever fails stays as written — still refused at render — and is counted:
 * `failed` for an address that could not be fetched or was not one of the four
 * kinds, `overLimit` for one the caps below left unfetched. A template value
 * that answers 404 is a guess that missed and counts as nothing; a template no
 * value of which arrived counts as failed.
 *
 * The bytes are stored as they arrive and the rows written later, under the
 * plot's row lock with the plot's asset cap, in the same transaction that
 * rewrites the texts — re-read under the lock, so an edit made meanwhile is
 * kept and only the references this run resolved change. An asset of the plot
 * already named for an address is reused rather than fetched again, so a second
 * card importing the same font fetches nothing twice.
 */
import {
  ASSET_ADDRESS_MACRO,
  assetResolver,
  bracketLists,
  cardVariableValues,
  findExternal,
  inlinableCss,
  isFontStylesheet,
  linearCaptures,
  localizedName,
  localizedTemplateName,
  MAX_CREATOR_CSS_LENGTH,
  parseUrlTemplate,
  rewriteAssetAddresses,
  rewriteExternal,
  sniffFont,
  sniffMedia,
  templateCandidates,
  templateUrl,
  underMedia,
  withoutLocalSources,
  type DisplayScript,
  type NormalizedCard,
  type PlotCustomUi,
  type PlotModule,
  type ReaderModuleAsset,
  type UrlTemplate,
} from '@shizue/core';
import { characters, plotAssets, plots, type NewPlotAsset } from '@shizue/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { assetUrl, MAX_ASSETS_PER_PLOT, normalizeSlug, saveAsset, uniqueSlug } from './assets.js';
import type { AppDeps } from './deps.js';
import { MAX_READER_MODULE_ASSETS, readerModuleAssetUrl } from './readerModules.js';
import { guardedFetch, PinnedAgent, pooledTransport, type GuardOptions } from './scriptFetch.js';
import { deleteQuietly, readerModuleAssetKey } from './storage.js';

/* ------------------------------------------------------------------ caps */

const MIB = 1024 * 1024;

/**
 * The caps of one import's fetching. A file is held to its kind's, read off
 * its bytes; an import to the totals, past which what is left is `overLimit`.
 *
 * - Pictures 10MB and music 20MB each, as a card's own would be sized; fonts
 *   4MB (a Google Fonts slice is ~50KB, a whole Latin family a few hundred, a
 *   whole CJK TTF is past it — the slices are what a sheet should name);
 *   a stylesheet 2MB (Noto Serif KR and SC at three weights is a 626KB sheet).
 *   A file is asked for under the cap of the kind its address names
 *   (`kindOf`), so a declared length past it is refused before the body comes.
 * - 800 files and 128MB an import: that same sheet names 675 slices, ~34MB;
 *   the portraits a template asks for are a few hundred at most. The plot's
 *   own 1000-asset cap still holds over all of it.
 * - 400 template guesses an import, 200 values a slot.
 * - 30s a request, 120s the whole fetch, 16 at a time, stylesheets first. The
 *   import is one HTTP request (the web's proxy waits 180s, next.config.ts).
 *   Connections are kept open between requests (`pooledTransport`, pooled by
 *   the addresses each was pinned to): a fresh TLS handshake made a 50KB font
 *   slice two seconds on a slow link, and a Korean family is hundreds of them
 *   from one host.
 * - `@import` three deep.
 */
export const LOCALIZE_LIMITS = {
  fileBytes: { image: 10 * MIB, audio: 20 * MIB, font: 4 * MIB },
  stylesheetBytes: 2 * MIB,
  maxFiles: 800,
  maxBytes: 128 * MIB,
  maxGuesses: 400,
  guessesPerSlot: 200,
  requestTimeoutMs: 30_000,
  deadlineMs: 120_000,
  concurrency: 16,
  importDepth: 3,
};

/* ----------------------------------------------------------- the network */

/** One answer from another host: its status, its declared type and its body. */
export interface RemoteResponse {
  status: number;
  contentType: string;
  bytes: Uint8Array;
}

/** What a reference is fetched as — a stylesheet, or the kind of file its address names (`kindOf`). */
export type RemoteKind = 'stylesheet' | 'image' | 'audio' | 'font';

const FONT_EXTENSION = /\.(?:woff2?|ttf|otf)$/i;
const AUDIO_EXTENSION = /\.(?:mp3|ogg|wav|flac|m4a)$/i;

/** The kind of file an address names by its extension — a picture when it names none (an image CDN's often doesn't). */
export function kindOf(url: string): Exclude<RemoteKind, 'stylesheet'> {
  const path = new URL(url).pathname;
  return FONT_EXTENSION.test(path) ? 'font' : AUDIO_EXTENSION.test(path) ? 'audio' : 'image';
}

/** A GET of another host's resource; throws for anything that did not answer. Tests hand in their own. */
export type RemoteFetch = (url: string, kind: RemoteKind, signal: AbortSignal) => Promise<RemoteResponse>;

/**
 * A browser's words: a web font service picks the format by who asks
 * (Google Fonts answers WOFF2 in unicode-range slices to this one), and an
 * image CDN picks one the asker can draw. Nothing of the reader's — this is
 * the server asking, for the work.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 shizue-plot/1';
const HEADERS: Record<RemoteKind, Readonly<Record<string, string>>> = {
  stylesheet: { 'user-agent': USER_AGENT, accept: 'text/css,*/*;q=0.1', 'accept-encoding': 'identity' },
  image: { 'user-agent': USER_AGENT, accept: 'image/webp,image/apng,image/*,*/*;q=0.8', 'accept-encoding': 'identity' },
  audio: { 'user-agent': USER_AGENT, accept: 'audio/*,*/*;q=0.8', 'accept-encoding': 'identity' },
  font: { 'user-agent': USER_AGENT, accept: '*/*', 'accept-encoding': 'identity' },
};

/**
 * The connections every import's fetch shares (`pooledTransport`), kept open
 * between requests and across imports: as many idle as the import has in flight,
 * each closed after 15s unused, none of them holding the process up.
 */
let sharedAgent: PinnedAgent | undefined;
const localizeAgent = (): PinnedAgent =>
  (sharedAgent ??= new PinnedAgent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxFreeSockets: LOCALIZE_LIMITS.concurrency,
    timeout: 15_000,
    scheduling: 'lifo',
  }));

/**
 * The fetch the import makes, through the same guard as a card script's
 * `request` (`guardedFetch`): https only, public addresses only, pinned, every
 * redirect vetted, a deadline and a body cap — and never this app's own hosts.
 * Over kept-open connections (`pooledTransport`) unless a transport is given.
 */
export function createRemoteFetch(
  options: { ownOrigins?: readonly string[] | (() => readonly string[]) } & Pick<GuardOptions, 'resolve' | 'transport'> = {},
): RemoteFetch {
  // Read each time: a phone's tunnel to this machine comes and goes (`tunnel.ts`).
  const ownOrigins = typeof options.ownOrigins === 'function' ? options.ownOrigins : () => options.ownOrigins as readonly string[] | undefined ?? [];
  const own = { has: (host: string): boolean => ownOrigins().some((origin) => new URL(origin).hostname.replace(/\.$/, '') === host) };
  const transport = options.transport ?? pooledTransport(localizeAgent());
  return async (url, kind, signal) => {
    const response = await guardedFetch(url, {
      ...(options.resolve ? { resolve: options.resolve } : {}),
      transport,
      refuse: (target) => own.has(target.hostname.replace(/\.$/, '')),
      signal,
      timeoutMs: LOCALIZE_LIMITS.requestTimeoutMs,
      maxBytes: kind === 'stylesheet' ? LOCALIZE_LIMITS.stylesheetBytes : LOCALIZE_LIMITS.fileBytes[kind],
      headers: HEADERS[kind],
    });
    const type = response.headers['content-type'];
    return { status: response.status, contentType: (Array.isArray(type) ? type[0] : type) ?? '', bytes: response.bytes };
  };
}

/** The declared types a stylesheet may come as. */
const STYLESHEET_TYPES = new Set(['text/css', 'text/plain']);
/** The declared types a file may come as; the bytes then decide (`sniffMedia`, `sniffFont`). */
const FILE_TYPE = /^(?:image\/|audio\/|font\/|application\/(?:font-|x-font-|vnd\.ms-opentype|octet-stream)|binary\/octet-stream|$)/;

const mediaType = (contentType: string): string => contentType.split(';')[0]!.trim().toLowerCase();

/**
 * YouTube's player, the one frame a card may draw from another host (the web
 * sanitizer's `rewriteFrame`): a page the reader's browser shows, not a file to
 * bring in, so it is neither fetched nor counted as a miss.
 */
const PLAYER_ADDRESS = /^(?:https?:)?\/\/www\.youtube(?:-nocookie)?\.com\/embed\//i;

/**
 * The comment an inlined stylesheet opens with: where it came from, for the
 * creator reading their sheet, and how a later run sees it is already there.
 */
const sourceMark = (url: string): string => `/* ${url.replace(/\*\//g, '*%2F')} */`;

/* --------------------------------------------------------------- the run */

/**
 * Which of a plot's texts a run reads: the work's own, and which modules (by id,
 * or all). `member` narrows the work's to what one companion brought when it
 * joined (`/characters/import`): the display scripts tagged with it, its own
 * stylesheet, and the openings from `introsFrom` on — the rest of the work is
 * the studio's to save, and was brought in when it was imported.
 */
export interface LocalizeScope {
  plot: boolean;
  modules: 'all' | readonly string[];
  member?: { id: string; introsFrom: number };
}

export interface LocalizeOutcome {
  /** Distinct addresses left as written: unfetchable, of a kind a chat cannot use, too large, or a template nothing arrived for. */
  failed: number;
  /** Distinct addresses this import's caps left unfetched. */
  overLimit: number;
  /** Files stored. */
  stored: number;
  /** The asset ids each module's texts brought, for its record (`PlotModule.assets`). */
  moduleAssets: Map<string, string[]>;
}

export type LocalizeDeps = Pick<AppDeps, 'db' | 'storage'> & { remoteFetch: RemoteFetch };

/** A text a run reads, where it lives and what it may do. */
interface Field {
  text: string;
  /** Whose: the work's, or a module's id. */
  unit: string;
  /** A stylesheet: an `@import` in it is inlined where it stands. */
  stylesheet: boolean;
  /** A member's own stylesheet: its fonts stay in it. */
  member?: true;
  /** A display script's template: its captures are known. */
  script?: DisplayScript;
}

const WORK = '';

/** A plot's texts as a run reads and rewrites them. */
interface State {
  intros: string[];
  customUi: PlotCustomUi;
}

/**
 * Walks the texts of `scope` in `state`, handing each to `edit`; a string it
 * answers replaces that text in the copy returned.
 */
function mapFields(state: State, scope: LocalizeScope, edit: (field: Field) => string | undefined): State {
  const take = (field: Field): string => edit(field) ?? field.text;
  const ui = state.customUi;
  const member = scope.member;
  const scripts = (list: readonly DisplayScript[] | undefined, unit: string): DisplayScript[] | undefined =>
    list?.map((script) => {
      if (unit === WORK && member && script.memberId !== member.id) return script;
      const out = take({ text: script.out, unit, stylesheet: false, script });
      return out === script.out ? script : { ...script, out };
    });
  const next: PlotCustomUi = { ...ui };
  let intros = state.intros;
  if (scope.plot) {
    intros = state.intros.map((text, at) =>
      member && at < member.introsFrom ? text : take({ text, unit: WORK, stylesheet: false }),
    );
    if (ui.css !== undefined && !member) next.css = take({ text: ui.css, unit: WORK, stylesheet: true });
    if (ui.backgroundHtml !== undefined && !member) {
      next.backgroundHtml = take({ text: ui.backgroundHtml, unit: WORK, stylesheet: false });
    }
    if (ui.memberCss) {
      next.memberCss = Object.fromEntries(
        Object.entries(ui.memberCss).map(([id, css]) => [
          id,
          member && id !== member.id ? css : take({ text: css, unit: WORK, stylesheet: true, member: true }),
        ]),
      );
    }
    if (ui.displayScripts) next.displayScripts = scripts(ui.displayScripts, WORK)!;
  }
  if (ui.modules) {
    next.modules = ui.modules.map((module) => {
      if (scope.modules !== 'all' && !scope.modules.includes(module.id)) return module;
      return {
        ...module,
        ...(module.css !== undefined ? { css: take({ text: module.css, unit: module.id, stylesheet: true }) } : {}),
        ...(module.backgroundHtml !== undefined
          ? { backgroundHtml: take({ text: module.backgroundHtml, unit: module.id, stylesheet: false }) }
          : {}),
        ...(module.displayScripts ? { displayScripts: scripts(module.displayScripts, module.id)! } : {}),
      };
    });
  }
  return { intros, customUi: next };
}

/** The fields of a card the prompt reads and nothing draws: its definitions and its lore. */
const definitionsOf = (card: NormalizedCard): string[] => [
  card.description,
  card.personality,
  card.scenario,
  card.systemPrompt,
  card.postHistoryInstructions,
  card.mesExample,
  ...card.lorebook.map((entry) => entry.content),
];

/**
 * The prompt's texts in `scope`, by whose they are, read for the web fonts they
 * `@import`. Nothing draws them — but the model reads them, and a card that shows
 * the model a status window in its lore or description (Status Window Bot's
 * `<style>@import url(…fonts.googleapis.com…)`) gets it written back in a reply,
 * where RisuAI draws it and the font loads. Here a reply's `@import` is refused
 * like any request out, so the font has to be the work's already: the import
 * fetches it and puts it in the stylesheet of the work or the module, as a
 * template's is (`hoist`), and the text itself stays as written. The work's are
 * every member's and the plot lore — or, for a member joining (`scope.member`),
 * that member's alone; a module's are its lore.
 */
function promptSources(
  cards: readonly { id: string; card: NormalizedCard }[],
  plotLore: readonly { content: string }[],
  modules: readonly PlotModule[],
  scope: LocalizeScope,
): { text: string; unit: string }[] {
  const sources: { text: string; unit: string }[] = [];
  if (scope.plot) {
    for (const { id, card } of cards) {
      if (scope.member && id !== scope.member.id) continue;
      for (const text of definitionsOf(card)) sources.push({ text, unit: WORK });
    }
    if (!scope.member) for (const entry of plotLore) sources.push({ text: entry.content, unit: WORK });
  }
  for (const module of modules) {
    if (scope.modules !== 'all' && !scope.modules.includes(module.id)) continue;
    for (const entry of module.lorebook) sources.push({ text: entry.content, unit: module.id });
  }
  return sources.filter((source) => source.text.length > 0);
}

/** What a card's prompt side says — where a script's captures and the model's word lists are read from. */
function promptTexts(cards: readonly NormalizedCard[], plotLore: readonly { content: string }[], state: State): string[] {
  const texts: string[] = [...state.intros, ...plotLore.map((entry) => entry.content)];
  for (const card of cards) {
    texts.push(card.firstMes, ...card.alternateGreetings, ...(card.groupOnlyGreetings ?? []), ...definitionsOf(card));
  }
  for (const module of state.customUi.modules ?? []) texts.push(...module.lorebook.map((entry) => entry.content));
  return texts.filter((text) => text.length > 0);
}

/** A file the run stored, waiting for its row. */
interface Stored {
  id: string;
  key: string;
  mime: string;
  name: string;
  /** Static references first, then a stylesheet's fonts, then template guesses: who gets the plot's last rooms. */
  rank: number;
  order: number;
}

/** Why an address was left as written. */
type Miss = 'failed' | 'overLimit';

class OverLimit extends Error {}

/** A slot pool: at most `size` requests in flight. */
function pool(size: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (running >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

/** A stylesheet fetched and localized in turn: its text with every reference it could resolve rewritten — later, once places exist. */
interface Sheet {
  css: string;
  font: boolean;
  imports: Map<string, Sheet | null>;
}

/** Where a run keeps what it brings: the names it has already, and how it stores a file. */
interface Keep {
  /** Names (`localizedName`) the unit's own assets already go by: fetched by nobody again. */
  known: ReadonlySet<string>;
  /** Stores a fetched file's bytes, or null for bytes that are none of the kinds it keeps. */
  save(id: string, bytes: Uint8Array): Promise<{ key: string; mime: string } | null>;
}

/** What a run found in the texts and brought in, before any of it has a place (`gather`). */
interface Gathered {
  outcome: LocalizeOutcome;
  /** Nothing to bring and nothing to rewrite: the run ends here. */
  done: boolean;
  stored: Stored[];
  unitOfName: Map<string, string>;
  imports: Map<string, string>;
  promptImports: Map<string, { unit: string; media: string }>;
  templates: Map<string, { template: UrlTemplate; scripts: DisplayScript[]; unit: string }>;
  /** Template address → the names of the values that arrived. */
  filled: Map<string, string[]>;
  sheets: Map<string, Promise<Sheet | Miss | 'notFont'>>;
  misses: Map<string, Miss>;
  miss(address: string, why: Miss): void;
}

/**
 * Steps 1 and 2 of a run: what `scope`'s texts in `state` name, and every file
 * and stylesheet fetched and its bytes kept (`keep`).
 * `cards` and `lore` are what the prompt reads (`promptSources`, `promptTexts`)
 * besides the modules' own lore, which `state` carries.
 */
async function gather(
  deps: Pick<LocalizeDeps, 'remoteFetch'>,
  state: State,
  scope: LocalizeScope,
  cards: readonly { id: string; card: NormalizedCard }[],
  lore: readonly { content: string }[],
  keep: Keep,
): Promise<Gathered> {
  const outcome: LocalizeOutcome = { failed: 0, overLimit: 0, stored: 0, moduleAssets: new Map() };

  // 1. What the texts name.
  const statics = new Map<string, { rank: number; unit: string }>();
  const imports = new Map<string, string>();
  const templates = new Map<string, { template: UrlTemplate; scripts: DisplayScript[]; unit: string }>();
  const misses = new Map<string, Miss>();
  const miss = (address: string, why: Miss): void => {
    if (misses.get(address) !== 'failed') misses.set(address, why);
  };
  /** Whether a stylesheet names one of the work's own assets the RisuAI way (`ASSET_ADDRESS_MACRO`). */
  let addressed = false;
  /** Every drawn text, for the literal `setvar`s a `{{getvar::…}}` slot reads (`cardVariableValues`). */
  const drawn: string[] = [];
  mapFields(state, scope, (field) => {
    drawn.push(field.text);
    if (field.stylesheet && field.text.search(ASSET_ADDRESS_MACRO) >= 0) addressed = true;
    for (const ref of findExternal(field.text)) {
      if (ref.kind === 'src' && PLAYER_ADDRESS.test(ref.address.trim())) continue;
      if (ref.kind === 'import') {
        const url = ref.url;
        if (url) imports.set(url, imports.get(url) ?? field.unit);
        else miss(ref.address, 'failed');
      } else if (ref.url) {
        if (!statics.has(ref.url)) statics.set(ref.url, { rank: 0, unit: field.unit });
      } else {
        const template = parseUrlTemplate(ref.address);
        // A capture means something only in a display script's template.
        if (!template || (template.captures.length > 0 && !field.script)) {
          miss(ref.address, 'failed');
          continue;
        }
        const known = templates.get(ref.address);
        if (known) {
          if (field.script && !known.scripts.includes(field.script)) known.scripts.push(field.script);
        } else {
          templates.set(ref.address, { template, scripts: field.script ? [field.script] : [], unit: field.unit });
        }
      }
    }
    return undefined;
  });
  /** The web fonts the prompt's texts import (`promptSources`), by address: whose, and under what media. */
  const promptImports = new Map<string, { unit: string; media: string }>();
  for (const { text, unit } of promptSources(cards, lore, state.customUi.modules ?? [], scope)) {
    for (const ref of findExternal(text)) {
      if (ref.kind !== 'import' || !ref.url || imports.has(ref.url) || promptImports.has(ref.url)) continue;
      promptImports.set(ref.url, { unit, media: ref.media });
    }
  }
  const gathered: Gathered = {
    outcome,
    done: false,
    stored: [],
    unitOfName: new Map(),
    imports,
    promptImports,
    templates,
    filled: new Map(),
    sheets: new Map(),
    misses,
    miss,
  };
  if (statics.size === 0 && imports.size === 0 && templates.size === 0 && promptImports.size === 0 && !addressed) {
    outcome.failed = [...misses.values()].filter((why) => why === 'failed').length;
    return { ...gathered, done: true };
  }

  // 2. Fetch, store the bytes.
  const deadline = AbortSignal.timeout(LOCALIZE_LIMITS.deadlineMs);
  const slot = pool(LOCALIZE_LIMITS.concurrency);
  const { stored, unitOfName, sheets, filled } = gathered;
  let files = 0;
  let bytes = 0;
  let guesses = 0;
  let order = 0;
  /** Each file once: what its address resolved to — a stored row to be, an asset already there, or nothing. */
  const fileResults = new Map<string, Promise<{ name: string } | Miss | 'missing'>>();

  const request = async (url: string, kind: RemoteKind): Promise<RemoteResponse> => {
    if (deadline.aborted) throw new OverLimit();
    try {
      return await slot(() => deps.remoteFetch(url, kind, deadline));
    } catch (error) {
      if (deadline.aborted) throw new OverLimit();
      throw error;
    }
  };

  const fetchFile = (url: string, rank: number, unit: string, guess = false): Promise<{ name: string } | Miss | 'missing'> => {
    const name = localizedName(url);
    const done = fileResults.get(name);
    if (done) return done;
    const run = (async (): Promise<{ name: string } | Miss | 'missing'> => {
      if (keep.known.has(name)) return { name };
      if (files >= LOCALIZE_LIMITS.maxFiles || bytes >= LOCALIZE_LIMITS.maxBytes) return 'overLimit';
      let response: RemoteResponse;
      try {
        response = await request(url, kindOf(url));
      } catch (error) {
        return error instanceof OverLimit ? 'overLimit' : 'failed';
      }
      if (response.status !== 200) return guess && response.status >= 400 && response.status < 500 ? 'missing' : 'failed';
      if (!FILE_TYPE.test(mediaType(response.contentType))) return 'failed';
      const media = sniffMedia(response.bytes);
      const font = media ? null : sniffFont(response.bytes);
      const kind = media?.kind ?? (font ? 'font' : null);
      // A guess is a picture or music where a template drew one; a font only where a stylesheet named it.
      // A video is a card's to bring in its own file, never fetched from another host.
      if (!kind || kind === 'video' || (guess && kind === 'font')) return 'failed';
      if (response.bytes.byteLength > LOCALIZE_LIMITS.fileBytes[kind]) return 'failed';
      if (files >= LOCALIZE_LIMITS.maxFiles || bytes + response.bytes.byteLength > LOCALIZE_LIMITS.maxBytes) {
        return 'overLimit';
      }
      files += 1;
      bytes += response.bytes.byteLength;
      const id = randomUUID();
      const saved = await keep.save(id, response.bytes);
      if (!saved) {
        files -= 1;
        bytes -= response.bytes.byteLength;
        return 'failed';
      }
      stored.push({ id, key: saved.key, mime: saved.mime, name, rank, order: order++ });
      unitOfName.set(name, unit);
      return { name };
    })();
    fileResults.set(name, run);
    return run;
  };

  /** With `fontOnly` (a prompt's import), a sheet that is not a web font's is 'notFont', and nothing it names is fetched. */
  const fetchSheet = (url: string, depth: number, unit: string, fontOnly = false): Promise<Sheet | Miss | 'notFont'> => {
    const done = sheets.get(url);
    if (done) return done;
    const run = (async (): Promise<Sheet | Miss | 'notFont'> => {
      let response: RemoteResponse;
      try {
        response = await request(url, 'stylesheet');
      } catch (error) {
        return error instanceof OverLimit ? 'overLimit' : 'failed';
      }
      if (response.status !== 200 || !STYLESHEET_TYPES.has(mediaType(response.contentType))) return 'failed';
      const inlinable = inlinableCss(new TextDecoder('utf-8').decode(response.bytes));
      if (inlinable === null) return fontOnly ? 'notFont' : 'failed';
      const css = withoutLocalSources(inlinable);
      const sheet: Sheet = { css, font: isFontStylesheet(css), imports: new Map() };
      if (fontOnly && !sheet.font) return 'notFont';
      const nested: Promise<unknown>[] = [];
      for (const ref of findExternal(css)) {
        if (ref.kind === 'import') {
          if (!ref.url || depth >= LOCALIZE_LIMITS.importDepth) {
            miss(ref.address, 'failed');
            continue;
          }
          const inner = ref.url;
          nested.push(
            fetchSheet(inner, depth + 1, unit).then((result) => {
              if (result === 'notFont') return;
              if (typeof result === 'string') miss(inner, result);
              else sheet.imports.set(inner, result);
            }),
          );
        } else if (ref.url) {
          const file = ref.url;
          nested.push(
            fetchFile(file, 1, unit).then((result) => {
              if (typeof result === 'string' && result !== 'missing') miss(file, result);
            }),
          );
        } else {
          miss(ref.address, 'failed');
        }
      }
      await Promise.all(nested);
      return sheet;
    })();
    sheets.set(url, run);
    return run;
  };

  const tasks: Promise<unknown>[] = [];
  // The stylesheets first: each is one small request that names many files, and
  // a slot pool hands out its places in the order they are asked for.
  for (const [url, unit] of imports) {
    tasks.push(
      fetchSheet(url, 1, unit).then((result) => {
        if (result !== 'notFont' && typeof result === 'string') miss(url, result);
      }),
    );
  }
  // A prompt's import is only ever a font for the stylesheet: one that is not
  // a web font's is no miss, only nothing to bring.
  for (const [url, { unit }] of promptImports) {
    tasks.push(
      fetchSheet(url, 1, unit, true).then((result) => {
        if (result !== 'notFont' && typeof result === 'string') miss(url, result);
      }),
    );
  }
  for (const [url, { rank, unit }] of statics) {
    tasks.push(
      fetchFile(url, rank, unit).then((result) => {
        if (typeof result === 'string') miss(url, result === 'missing' ? 'failed' : result);
      }),
    );
  }
  const texts = promptTexts(
    cards.map((row) => row.card),
    lore,
    state,
  );
  const lists = bracketLists(texts);
  // What the card sets its variables to, for a `{{getvar::…}}` slot: the work's
  // defaults and each member's, and every literal write the texts and triggers hold.
  const risuOf = (card: NormalizedCard): Record<string, unknown> => {
    const risu = card.extensions?.['risuai'];
    return risu !== null && typeof risu === 'object' ? (risu as Record<string, unknown>) : {};
  };
  const variableValues = cardVariableValues(
    Object.assign({}, ...cards.map((row) => row.card.defaultVariables ?? {}), state.customUi.defaultVariables ?? {}),
    [...texts, ...drawn],
    [
      ...cards.flatMap((row) => {
        const triggers = risuOf(row.card)['triggerscript'];
        return Array.isArray(triggers) ? triggers : [];
      }),
      ...(state.customUi.modules ?? []).flatMap((module) => module.trigger),
    ],
  );
  for (const [address, { template, scripts, unit }] of templates) {
    const captured = new Map<number, string[]>();
    for (const script of scripts) {
      for (const [group, values] of linearCaptures(script.in, script.flags ?? '', texts, template.captures)) {
        captured.set(group, [...(captured.get(group) ?? []), ...values]);
      }
    }
    const values = templateCandidates(template, captured, lists, LOCALIZE_LIMITS.guessesPerSlot, variableValues);
    const arrived: string[] = [];
    filled.set(address, arrived);
    // A variable the card never sets to anything an address can hold is nothing to bring, not a miss.
    if (template.variable !== undefined && values.length === 0) continue;
    let skipped = false;
    const runs = values.map((value) => {
      const url = templateUrl(template, value);
      if (url === null) return Promise.resolve();
      // A value another template of the same address already asked for costs no second guess.
      if (!fileResults.has(localizedName(url))) {
        if (guesses >= LOCALIZE_LIMITS.maxGuesses) {
          skipped = true;
          return Promise.resolve();
        }
        guesses += 1;
      }
      return fetchFile(url, 2, unit, true).then((result) => {
        if (typeof result !== 'string') arrived.push(result.name);
        else if (result === 'overLimit') skipped = true;
      });
    });
    tasks.push(
      Promise.all(runs).then(() => {
        if (arrived.length === 0) miss(address, skipped ? 'overLimit' : 'failed');
      }),
    );
  }
  await Promise.all(tasks);
  return gathered;
}

/** Where what a run brought is served, once it has a place (`rewrite`). */
interface Places {
  /** The address the file brought under `name` (`localizedName`) is served at; undefined where it was not kept. */
  file(name: string): string | undefined;
  /** The by-name address a template's values are served at, the template's name (`localizedTemplateName`) after it. */
  byName(templateName: string): string;
  /** The address of one of the unit's own assets a stylesheet names the RisuAI way (`{{raw::…}}`). */
  addressOf(name: string): string | undefined;
}

/**
 * Step 3's rewrite: the texts of `scope` in `before` with every reference the
 * run brought pointed at its place, the imported stylesheets inlined, and the
 * web fonts a template or the prompt imported hoisted into the stylesheet of the
 * work or the module they belong to.
 */
async function rewrite(g: Gathered, before: State, scope: LocalizeScope, places: Places): Promise<State> {
  const fileUrl = (url: string): string | undefined => places.file(localizedName(url));
  /** A sheet's text with what resolved rewritten, its own imports inlined. */
  const resolveSheet = async (url: string, seen: Set<string>): Promise<{ css: string; font: boolean } | null> => {
    const result = await g.sheets.get(url);
    if (!result || typeof result === 'string' || seen.has(url)) return null;
    const inner = new Set(seen).add(url);
    const inlined = new Map<string, string>();
    for (const nested of result.imports.keys()) {
      const done = await resolveSheet(nested, inner);
      if (done) inlined.set(nested, done.css);
    }
    const css = rewriteExternal(result.css, (ref) => {
      if (ref.kind === 'import') {
        const text = ref.url ? inlined.get(ref.url) : undefined;
        return text === undefined ? undefined : underMedia(text, ref.media);
      }
      return ref.url ? fileUrl(ref.url) : undefined;
    });
    return { css: `${sourceMark(url)}\n${css}`, font: result.font };
  };
  const resolvedSheets = new Map<string, { css: string; font: boolean }>();
  for (const url of g.imports.keys()) {
    const done = await resolveSheet(url, new Set());
    if (done) resolvedSheets.set(url, done);
  }
  const byName = (address: string): string | undefined => {
    const entry = g.templates.get(address);
    if (!entry || !(g.filled.get(address)?.some((name) => places.file(name) !== undefined) ?? false)) return undefined;
    return places.byName(localizedTemplateName(entry.template).replace(/^https:\/\//, ''));
  };

  // Hoisted font sheets, by unit, each once.
  const hoisted = new Map<string, string[]>();
  const hoist = (unit: string, url: string, css: string): boolean => {
    const list = hoisted.get(unit) ?? [];
    if (!hoisted.has(unit)) hoisted.set(unit, list);
    if (!list.includes(url)) list.push(url, css);
    return true;
  };
  const after = mapFields(before, scope, (field) => {
    let text = rewriteExternal(field.text, (ref) => {
      if (ref.kind === 'import') {
        const sheet = ref.url ? resolvedSheets.get(ref.url) : undefined;
        if (!sheet) return undefined;
        if (sheet.font && !field.stylesheet) return hoist(field.unit, ref.url!, underMedia(sheet.css, ref.media)) ? '' : undefined;
        return underMedia(sheet.css, ref.media);
      }
      return ref.url ? fileUrl(ref.url) : byName(ref.address);
    });
    // The unit's own assets a stylesheet names the RisuAI way, by the address
    // each has now — a stylesheet is drawn as written, never read as CBS.
    if (field.stylesheet) text = rewriteAssetAddresses(text, places.addressOf);
    return text === field.text ? undefined : text;
  });
  // The fonts the prompt's texts import, after the templates' (`promptSources`).
  for (const [url, { unit, media }] of g.promptImports) {
    const sheet = await resolveSheet(url, new Set());
    if (sheet?.font) hoist(unit, url, underMedia(sheet.css, media));
  }
  // The fonts a template imported, at the end of the stylesheet they now belong to —
  // unless that sheet already holds them, inlined by this run or an earlier one.
  const sheetWith = (css: string | undefined, unit: string): string | undefined => {
    const list = hoisted.get(unit);
    if (!list) return css;
    const added = list
      .filter((_, at) => at % 2 === 1)
      .filter((_, at) => !(css ?? '').includes(sourceMark(list[at * 2]!)))
      .join('\n\n');
    if (!added) return css;
    const joined = [css ?? '', added].filter((part) => part.trim()).join('\n\n');
    if (joined.length > MAX_CREATOR_CSS_LENGTH) {
      for (const url of list.filter((_, at) => at % 2 === 0)) g.miss(url, 'overLimit');
      return css;
    }
    return joined;
  };
  const customUi: PlotCustomUi = { ...after.customUi };
  if (scope.plot && hoisted.has(WORK)) {
    const css = sheetWith(customUi.css, WORK);
    if (css !== undefined) customUi.css = css;
  }
  if (customUi.modules) {
    customUi.modules = customUi.modules.map((module) => {
      const css = sheetWith(module.css, module.id);
      return css !== undefined ? { ...module, css } : module;
    });
  }
  return { intros: after.intros, customUi };
}

/** The run's misses, counted into its outcome. */
function counted(g: Gathered): LocalizeOutcome {
  for (const why of g.misses.values()) {
    if (why === 'failed') g.outcome.failed += 1;
    else g.outcome.overLimit += 1;
  }
  return g.outcome;
}

/**
 * Localizes the external references in `scope`'s texts of a plot: fetches,
 * stores, rewrites, and says what it left.
 */
export async function localizePlot(deps: LocalizeDeps, plotId: string, scope: LocalizeScope): Promise<LocalizeOutcome> {
  const [plot] = await deps.db.select().from(plots).where(eq(plots.id, plotId)).limit(1);
  if (!plot) return { failed: 0, overLimit: 0, stored: 0, moduleAssets: new Map() };
  const state: State = { intros: plot.intros, customUi: plot.customUi ?? {} };
  const cards = await deps.db
    .select({ id: characters.id, card: characters.card })
    .from(characters)
    .where(eq(characters.plotId, plotId));
  const existing = await deps.db
    .select({ name: plotAssets.name })
    .from(plotAssets)
    .where(eq(plotAssets.plotId, plotId));
  const g = await gather(
    deps,
    state,
    scope,
    cards,
    plot.lorebook,
    {
      known: new Set(existing.flatMap((asset) => (asset.name ? [asset.name] : []))),
      save: (id, bytes) => saveAsset(deps.storage, id, bytes, { audio: true, font: true }),
    },
  );
  if (g.done) return g.outcome;
  const { outcome, stored } = g;

  // 3. Rows and texts, under the plot's lock.
  let orphaned = stored.map((file) => file.key);
  try {
    const kept = await deps.db.transaction(async (tx): Promise<Set<string>> => {
      const [locked] = await tx
        .select({ intros: plots.intros, customUi: plots.customUi })
        .from(plots)
        .where(eq(plots.id, plotId))
        .for('update');
      if (!locked) return new Set<string>();
      const rows = await tx
        .select({ slug: plotAssets.slug, name: plotAssets.name })
        .from(plotAssets)
        .where(eq(plotAssets.plotId, plotId));
      const taken = new Set(rows.map((row) => row.slug));
      const slugOf = new Map<string, string>();
      for (const row of rows) if (row.name && !slugOf.has(row.name)) slugOf.set(row.name, row.slug);
      const ranked = [...stored].sort((a, b) => a.rank - b.rank || a.order - b.order);
      const room = Math.max(0, MAX_ASSETS_PER_PLOT - taken.size);
      const fitting = ranked.slice(0, room);
      const inserts: NewPlotAsset[] = [];
      for (const file of fitting) {
        if (slugOf.has(file.name)) continue;
        const base = file.name.replace(/[?#].*$/, '').split('/').pop()!.replace(/\.[^.]*$/, '');
        const slug = uniqueSlug(normalizeSlug(base) ?? 'web', taken);
        taken.add(slug);
        slugOf.set(file.name, slug);
        inserts.push({ id: file.id, plotId, slug, name: file.name, path: file.key, mime: file.mime });
        const unit = g.unitOfName.get(file.name) ?? WORK;
        if (unit !== WORK) outcome.moduleAssets.set(unit, [...(outcome.moduleAssets.get(unit) ?? []), file.id]);
      }
      for (const file of ranked.slice(room)) g.miss(file.name, 'overLimit');
      if (inserts.length > 0) await tx.insert(plotAssets).values(inserts);
      outcome.stored = inserts.length;

      // The work's own assets a stylesheet names the RisuAI way, by the address each has now.
      const resolveName = assetResolver([...rows, ...inserts].map(({ slug, name }) => ({ slug, name: name ?? null })));
      const before: State = { intros: locked.intros, customUi: locked.customUi ?? {} };
      const after = await rewrite(g, before, scope, {
        file: (name) => {
          const slug = slugOf.get(name);
          return slug ? assetUrl(plotId, slug) : undefined;
        },
        byName: (name) => `${assetUrl(plotId, 'by-name')}/${name}`,
        addressOf: (name) => {
          const slug = resolveName(name);
          return slug ? assetUrl(plotId, slug) : undefined;
        },
      });
      const customUi: PlotCustomUi = { ...after.customUi };
      if (customUi.modules) {
        customUi.modules = customUi.modules.map((module) => {
          const assets = outcome.moduleAssets.get(module.id) ?? [];
          return assets.length > 0 ? { ...module, assets: [...module.assets, ...assets] } : module;
        });
      }
      const changed =
        JSON.stringify(after.intros) !== JSON.stringify(locked.intros) ||
        JSON.stringify(customUi) !== JSON.stringify(locked.customUi ?? {});
      if (changed) {
        await tx
          .update(plots)
          .set({
            intros: after.intros,
            customUi: Object.keys(customUi).length > 0 ? customUi : null,
            updatedAt: new Date(),
          })
          .where(eq(plots.id, plotId));
      }
      return new Set(inserts.map((row) => row.path));
    });
    // Only once the rows are in: an object is garbage exactly when no row names it.
    orphaned = stored.map((file) => file.key).filter((key) => !kept.has(key));
  } finally {
    for (const key of orphaned) await deleteQuietly(deps.storage, key);
  }
  return counted(g);
}

/**
 * Localizes what a RisuAI module a reader puts into their library loads from
 * other hosts — its stylesheet, background and display scripts, and a web font
 * its lore imports — as a work's module is localized when the creator imports it
 * (`localizePlot`): fetched once through the same guard, kept as the module's
 * own pictures (`ReaderModuleAsset`, under `reader-modules/`, served to its owner
 * alone), and its references rewritten to them — a template's to the module's
 * by-name route. `module` is not yet in the library (its id is already its row's),
 * so nothing is locked; `assets` are the pictures its file brought, which keep
 * their names and are never fetched again. What is past the module's asset cap,
 * or failed, stays as written and is counted. The caller stores the module and
 * the assets, and deletes the new assets' bytes (`deleteReaderModuleAssets`) if
 * it does not.
 */
export async function localizeReaderModule(
  deps: Pick<LocalizeDeps, 'storage' | 'remoteFetch'>,
  module: PlotModule,
  assets: readonly ReaderModuleAsset[],
): Promise<{ module: PlotModule; assets: ReaderModuleAsset[]; outcome: LocalizeOutcome }> {
  const scope: LocalizeScope = { plot: false, modules: [module.id] };
  const state: State = { intros: [], customUi: { modules: [module] } };
  const g = await gather(
    deps,
    state,
    scope,
    [],
    [],
    {
      known: new Set(assets.map((asset) => asset.name)),
      save: (id, bytes) => saveAsset(deps.storage, id, bytes, { audio: true, font: true, key: readerModuleAssetKey }),
    },
  );
  if (g.done) return { module, assets: [...assets], outcome: g.outcome };
  const ranked = [...g.stored].sort((a, b) => a.rank - b.rank || a.order - b.order);
  const room = Math.max(0, MAX_READER_MODULE_ASSETS - assets.length);
  const added: ReaderModuleAsset[] = ranked.slice(0, room).map((file) => ({ id: file.id, name: file.name, path: file.key, mime: file.mime }));
  for (const file of ranked.slice(room)) {
    g.miss(file.name, 'overLimit');
    await deleteQuietly(deps.storage, file.key);
  }
  g.outcome.stored = added.length;
  const all = [...assets, ...added];
  const byName = new Map<string, string>();
  for (const asset of all) if (!byName.has(asset.name)) byName.set(asset.name, asset.id);
  const resolveName = assetResolver(all.map((asset) => ({ slug: asset.id, name: asset.name })));
  const after = await rewrite(g, state, scope, {
    file: (name) => {
      const id = byName.get(name);
      return id ? readerModuleAssetUrl(module.id, id) : undefined;
    },
    byName: (name) => `${readerModuleAssetUrl(module.id, 'by-name')}/${name}`,
    addressOf: (name) => {
      const id = resolveName(name);
      return id ? readerModuleAssetUrl(module.id, id) : undefined;
    },
  });
  return { module: after.customUi.modules?.[0] ?? module, assets: all, outcome: counted(g) };
}
