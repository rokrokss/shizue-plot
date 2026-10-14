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

  /** Each of `texts` translated, from the cache where it can be. */
  async translate(messageId: string, texts: readonly string[]): Promise<ReadonlyMap<string, string>> {
    await this.loaded;
    const known = this.cached.get(messageId);
    if (known && texts.every((text) => known.has(text))) return known;
    await this.turn();
    try {
      const { texts: made } = await apiSend<{ texts: Record<string, string> }>(
        'POST',
        `/api/chats/${this.chatId}/messages/${messageId}/translation`,
        { language: this.language, texts },
      );
      const merged = new Map([...(this.cached.get(messageId) ?? []), ...Object.entries(made)]);
      this.cached.set(messageId, merged);
      return merged;
    } finally {
      this.running -= 1;
      this.waiting.pop()?.();
    }
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
): RowTranslation {
  const active = Boolean(translator && messageId);
  const shown = useRef(new Map<string, readonly string[]>());
  const [asked, setAsked] = useState<string[]>([]);
  const [arrived, setArrived] = useState<ReadonlyMap<string, string>>(NO_TEXTS);
  const [status, setStatus] = useState<RowTranslationStatus>('idle');
  const [original, setOriginal] = useState(false);
  const [attempt, setAttempt] = useState(0);

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
    setStatus('pending');
    translator.translate(messageId, asked).then(
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
  const body = useMemo(() => (active ? { texts, report } : undefined), [active, texts, report]);
  return {
    body,
    status: active && asked.length > 0 ? status : 'idle',
    original,
    toggleOriginal: useCallback(() => setOriginal((was) => !was), []),
    retry: useCallback(() => setAttempt((count) => count + 1), []),
  };
}

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
  const [key] = useState(() => Math.random().toString(36).slice(2));
  const [near, setNear] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const on = translation !== undefined;
  // Watched only while the row is translated: a body that is not costs no observer.
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
      { rootMargin: '800px 0px' },
    );
    observer.current.observe(element);
  }, [on]);

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

  const report = translation?.report;
  useEffect(() => {
    if (!report || streaming || !near) return;
    report(key, texts);
    return () => report(key, []);
  }, [report, key, texts, streaming, near]);

  return useMemo(() => {
    const map = translation?.texts;
    if (!parts || !map || map.size === 0) return { segments, runs, ref };
    return {
      segments: segments.map((segment, index) => {
        const own = parts.segments[index];
        return own ? ({ ...segment, html: applyParts(own, map) } as S) : segment;
      }),
      runs: runs.map((own, index) =>
        own
          ? own.map((run, at) => {
              const blocks = parts.runs[index]![at]!;
              return { ...run, blocks: blocks.map((block) => applyParts(block, map)) } as R;
            })
          : null,
      ),
      ref,
    };
  }, [parts, translation?.texts, segments, runs, ref]);
}
