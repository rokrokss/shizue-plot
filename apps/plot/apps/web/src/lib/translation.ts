'use client';

/**
 * What the reader sees translated (ARCHITECTURE §11 언어 모드): a chat's
 * translator, a row's request, and a message body's texts.
 *
 * RisuAI translates a message after its display scripts and before its markdown
 * (`ParseMarkdown(…, 'pretranslate')`, then `postTranslationParse`). The body
 * does the same: what it translates is its prose blocks and the text of its
 * markup as they stand once the scripts ran, before anything is drawn — so a
 * status window is found by the card's own words, and a speaker's `이름:` has
 * already named the bubble before a translator could rename it. Tags, styles and
 * scripts are never sent (`markupParts`).
 *
 * The original is what is drawn until the translation arrives. Nothing here is
 * ever in a generation's way: a row asks once its reply has settled.
 */
import {
  applyParts,
  markupParts,
  partTexts,
  proseParts,
  type TextPart,
  type TranslationLanguage,
} from '@shizue/core/translation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiSend } from './api';

const NO_TEXTS: ReadonlyMap<string, string> = new Map();

/** Requests a page keeps open at once; RisuAI awaits at ten, the API refuses past four. */
const CONCURRENCY = 2;

/**
 * One chat's translations into one language: what the server holds, read once
 * (`GET /api/chats/:id/translations`), and the requests for the rest, a couple
 * at a time and the newest first — the newest message is the one on screen.
 */
export class ChatTranslator {
  private readonly cached = new Map<string, Map<string, string>>();
  private readonly waiting: (() => void)[] = [];
  private running = 0;
  private readonly loaded: Promise<void>;

  constructor(
    readonly chatId: string,
    readonly language: TranslationLanguage,
  ) {
    this.loaded = apiGet<{ translations?: Record<string, Record<string, string>> }>(
      `/api/chats/${chatId}/translations?language=${language}`,
    )
      .then(({ translations }) => {
        for (const [messageId, texts] of Object.entries(translations ?? {})) {
          this.cached.set(messageId, new Map(Object.entries(texts)));
        }
      })
      // Nothing read is nothing cached: the rows ask for what they show.
      .catch(() => undefined);
  }

  /**
   * Each of `texts` translated, from the cache where it can be — or, where the
   * reader asked for it again (`regenerate`, RisuAI's 다시 번역), from the model
   * whatever the cache holds.
   */
  async translate(messageId: string, texts: readonly string[], regenerate = false): Promise<ReadonlyMap<string, string>> {
    await this.loaded;
    const known = this.cached.get(messageId);
    if (!regenerate && known && texts.every((text) => known.has(text))) return known;
    await this.turn();
    try {
      const { texts: made } = await apiSend<{ texts: Record<string, string> }>(
        'POST',
        `/api/chats/${this.chatId}/messages/${messageId}/translation`,
        { language: this.language, texts, ...(regenerate ? { regenerate: true } : {}) },
      );
      return this.keep(messageId, made);
    } finally {
      this.running -= 1;
      this.waiting.pop()?.();
    }
  }

  /** The reader's own wording for some of a message's texts (RisuAI's 번역 수정), kept where the model's was. */
  async correct(messageId: string, texts: Record<string, string>): Promise<ReadonlyMap<string, string>> {
    await this.loaded;
    const { texts: kept } = await apiSend<{ texts: Record<string, string> }>(
      'PUT',
      `/api/chats/${this.chatId}/messages/${messageId}/translation`,
      { language: this.language, texts },
    );
    return this.keep(messageId, kept);
  }

  private keep(messageId: string, texts: Record<string, string>): ReadonlyMap<string, string> {
    const merged = new Map([...(this.cached.get(messageId) ?? []), ...Object.entries(texts)]);
    this.cached.set(messageId, merged);
    return merged;
  }

  private turn(): Promise<void> {
    if (this.running < CONCURRENCY) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }
}

/** The page's translator for the chat in `language`, or null where nothing is translated. */
export function useChatTranslator(chatId: string, language: TranslationLanguage | null): ChatTranslator | null {
  return useMemo(() => (language ? new ChatTranslator(chatId, language) : null), [chatId, language]);
}

/** What a row hands each of its bodies. */
export interface BodyTranslation {
  /** What has arrived, by text; empty while the reader looks at the original. */
  texts: ReadonlyMap<string, string>;
  /** A body says which texts it shows, once it has settled; `[]` as it goes. */
  report: (body: string, texts: readonly string[]) => void;
  /**
   * What a translated block goes through before it is drawn: the card's
   * `edittrans` scripts (RisuAI's `applyEdittransRegex`). Never the original.
   */
  edit?: ((text: string) => string) | undefined;
}

export type RowTranslationStatus = 'idle' | 'pending' | 'done' | 'failed';

export interface RowTranslation {
  /** Absent where the row is not translated. */
  body: BodyTranslation | undefined;
  status: RowTranslationStatus;
  /** Whether the reader asked for the original back. */
  original: boolean;
  toggleOriginal: () => void;
  retry: () => void;
  /** Asks the model again for every text the row shows, past the cache — RisuAI's 다시 번역. */
  retranslate: () => void;
  /** Each text the row shows, with what it reads as now: what the reader corrects. */
  pairs: readonly (readonly [string, string])[];
  /** Keeps the reader's wording for those texts — RisuAI's 번역 수정. */
  correct: (texts: Record<string, string>) => Promise<void>;
}

/**
 * One message's translation: the texts its bodies show — a reader's turn is
 * several bodies — asked for together, once each set of them settles.
 * `messageId` undefined is a row that is not translated (another mode, a reply
 * still streaming, a turn not stored yet).
 */
export function useRowTranslation(
  translator: ChatTranslator | null | undefined,
  messageId: string | undefined,
  edit?: ((text: string) => string) | undefined,
): RowTranslation {
  const active = Boolean(translator && messageId);
  const shown = useRef(new Map<string, readonly string[]>());
  const [asked, setAsked] = useState<string[]>([]);
  const [arrived, setArrived] = useState<ReadonlyMap<string, string>>(NO_TEXTS);
  const [status, setStatus] = useState<RowTranslationStatus>('idle');
  const [original, setOriginal] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** The next ask goes past the cache: the reader asked for it again. */
  const regenerate = useRef(false);

  const report = useCallback((body: string, texts: readonly string[]) => {
    if (texts.length === 0) shown.current.delete(body);
    else shown.current.set(body, texts);
    const union = [...new Set([...shown.current.values()].flat())];
    setAsked((before) => (before.length === union.length && before.every((text, at) => text === union[at]) ? before : union));
  }, []);

  // Another language, or another message in this row: what arrived was for that.
  useEffect(() => setArrived(NO_TEXTS), [translator, messageId]);

  useEffect(() => {
    if (!translator || !messageId || asked.length === 0) return;
    let live = true;
    const again = regenerate.current;
    regenerate.current = false;
    setStatus('pending');
    translator.translate(messageId, asked, again).then(
      (texts) => {
        if (!live) return;
        setArrived(texts);
        setStatus('done');
      },
      () => live && setStatus('failed'),
    );
    return () => {
      live = false;
    };
  }, [translator, messageId, asked, attempt]);

  const texts = original ? NO_TEXTS : arrived;
  const body = useMemo(() => (active ? { texts, report, edit } : undefined), [active, texts, report, edit]);
  const pairs = useMemo(() => asked.map((text) => [text, arrived.get(text) ?? text] as const), [asked, arrived]);
  const correct = useCallback(
    async (corrected: Record<string, string>) => {
      if (!translator || !messageId) return;
      const kept = await translator.correct(messageId, corrected);
      setArrived(kept);
      setOriginal(false);
    },
    [translator, messageId],
  );
  return {
    body,
    status: active && asked.length > 0 ? status : 'idle',
    original,
    toggleOriginal: useCallback(() => setOriginal((was) => !was), []),
    retry: useCallback(() => setAttempt((count) => count + 1), []),
    retranslate: useCallback(() => {
      regenerate.current = true;
      setOriginal(false);
      setAttempt((count) => count + 1);
    }, []),
    pairs,
    correct,
  };
}

/**
 * Whether an element has come near the screen (800px), watched only while `on`
 * — a part of a row that is not translated costs no observer — and settled
 * once it has. Near is measured in the list it scrolls in (`data-message-list`):
 * against the viewport, the list clips a row before the margin applies, so a
 * row the list has scrolled away from never came near.
 */
function useNearScreen(on: boolean): { near: boolean; ref: (element: HTMLElement | null) => void } {
  const [near, setNear] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element || !on) return;
    if (typeof IntersectionObserver !== 'function') {
      setNear(true);
      return;
    }
    observer.current = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.current?.disconnect();
        }
      },
      { root: element.closest('[data-message-list]'), rootMargin: '800px 0px' },
    );
    observer.current.observe(element);
  }, [on]);
  return { near, ref };
}

/** Tells the row which texts this part shows — once it has settled and come near — under a key of its own. */
function useReportTexts(
  translation: BodyTranslation | undefined,
  texts: readonly string[],
  streaming: boolean,
  near: boolean,
): void {
  const [key] = useState(() => Math.random().toString(36).slice(2));
  const report = translation?.report;
  useEffect(() => {
    if (!report || streaming || !near) return;
    report(key, texts);
    return () => report(key, []);
  }, [report, key, texts, streaming, near]);
}

/**
 * Lines a row draws beside its bodies rather than in them — a status card's
 * keys and values, the choices — translated as the bodies' prose is: each line
 * cut as a prose block (`proseParts`), text only, and asked for with the rest of
 * the row once it is near. The lines come back in order, translated where the
 * translation has arrived.
 */
export function useLinesTranslation(
  lines: readonly string[],
  translation: BodyTranslation | undefined,
): { lines: readonly string[]; ref: (element: HTMLElement | null) => void } {
  const on = translation !== undefined;
  const { near, ref } = useNearScreen(on);
  const parts = useMemo(() => (on ? lines.map(proseParts) : null), [on, lines]);
  const texts = useMemo(() => (parts ? partTexts(parts.flat()) : []), [parts]);
  // A row hands its lines a translation only once its reply is stored.
  useReportTexts(translation, texts, false, near);
  return useMemo(() => {
    const map = translation?.texts;
    if (!parts || !map || map.size === 0) return { lines, ref };
    return { lines: parts.map((own) => translated(own, map, translation?.edit)), ref };
  }, [parts, translation?.texts, translation?.edit, lines, ref]);
}

/**
 * A block put back together with what arrived, through the card's edittrans
 * scripts — RisuAI runs them on the whole translated message; here each block is
 * what was translated whole.
 */
const translated = (parts: readonly TextPart[], map: ReadonlyMap<string, string>, edit: ((text: string) => string) | undefined): string =>
  edit ? edit(applyParts(parts, map)) : applyParts(parts, map);

/** A run of a message body as the translation reads it: markup whole, or prose by block. */
interface RunLike {
  html: boolean;
  blocks: string[];
}

/**
 * A body's texts, translated where the translation has arrived. `segments` are
 * the message as its display scripts left it (markup islands and text), `runs`
 * each text segment cut by speaker and block — both before any markdown. What
 * is reported is every text a translator should see; what comes back is the
 * same shapes with those texts replaced. A body still streaming reports
 * nothing, and one that is not near the screen waits until it is.
 */
export function useBodyTranslation<S extends { kind: string }, R extends RunLike>(
  segments: readonly S[],
  runs: readonly (R[] | null)[],
  translation: BodyTranslation | undefined,
  streaming: boolean,
): { segments: readonly S[]; runs: readonly (R[] | null)[]; ref: (element: HTMLElement | null) => void } {
  const on = translation !== undefined;
  const { near, ref } = useNearScreen(on);

  const parts = useMemo(() => {
    if (!on) return null;
    return {
      segments: segments.map((segment) =>
        segment.kind === 'html' ? markupParts((segment as unknown as { html: string }).html) : null,
      ),
      runs: runs.map((own) =>
        own ? own.map((run) => (run.html ? [markupParts(run.blocks[0] ?? '')] : run.blocks.map(proseParts))) : null,
      ),
    };
  }, [on, segments, runs]);

  const texts = useMemo(() => {
    if (!parts) return [];
    const all: TextPart[] = [
      ...parts.segments.flatMap((own) => own ?? []),
      ...parts.runs.flatMap((own) => (own ?? []).flat(2)),
    ];
    return partTexts(all);
  }, [parts]);
  useReportTexts(translation, texts, streaming, near);

  return useMemo(() => {
    const map = translation?.texts;
    const edit = translation?.edit;
    if (!parts || !map || map.size === 0) return { segments, runs, ref };
    return {
      segments: segments.map((segment, index) => {
        const own = parts.segments[index];
        return own ? ({ ...segment, html: translated(own, map, edit) } as S) : segment;
      }),
      runs: runs.map((own, index) =>
        own
          ? own.map((run, at) => {
              const blocks = parts.runs[index]![at]!;
              return { ...run, blocks: blocks.map((block) => translated(block, map, edit)) } as R;
            })
          : null,
      ),
      ref,
    };
  }, [parts, translation?.texts, translation?.edit, segments, runs, ref]);
}
