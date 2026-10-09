'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrandGarden } from '@/components/Brand';
import { Icon } from '@/components/Icon';
import { PlotGrid } from '@/components/PlotCard';
import { Button, buttonClass, cx, ErrorText, Spinner, TextInput } from '@/components/ui';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { apiGet } from '@/lib/api';
import {
  applyPage,
  failPage,
  initialFeed,
  orderTags,
  readHiddenTags,
  restartFeed,
  withoutHiddenTags,
  writeHiddenTags,
  type FeedState,
} from '@/lib/hub';
import type { ExploreResult } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useErrorMessage } from '@/lib/useErrorMessage';

const SORTS = ['recent', 'weekly', 'chats', 'likes'] as const;
type Sort = (typeof SORTS)[number];

const SORT_LABEL: Record<Sort, 'sortRecent' | 'sortWeekly' | 'sortChats' | 'sortLikes'> = {
  recent: 'sortRecent',
  // Ranked on the trailing week: what is rising, beside what is simply biggest.
  weekly: 'sortWeekly',
  chats: 'sortChats',
  likes: 'sortLikes',
};

const SEARCH_DEBOUNCE_MS = 300;

const isSort = (value: string | null): value is Sort => SORTS.includes(value as Sort);

/**
 * The public catalogue, and the app's landing page. `language` is the UI locale
 * and nothing else — the hard partition of the architecture, so there is no
 * content-language switcher here; the header locale switcher is it.
 *
 * The filters live in the URL and nowhere else, which is read with
 * `useSearchParams` — so the page needs a boundary it can suspend at while it is
 * prerendered.
 */
export default function PlotsFeedPage() {
  const common = useTranslations('common');

  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-20">
          <Spinner label={common('loading')} />
        </div>
      }
    >
      <Catalogue />
    </Suspense>
  );
}

function Catalogue() {
  const t = useTranslations('explore');
  const rebrand = useTranslations('rebrand');
  const common = useTranslations('common');
  const locale = useLocale();
  const toMessage = useErrorMessage();
  const router = useRouter();
  const pathname = usePathname();
  useDocumentTitle(t('title'));

  /**
   * The filters are the URL — read every render rather than copied into state,
   * so a Back, a Forward or a link that arrives with different params moves them
   * exactly as the reader's own click does. A `sort` nobody recognizes reads as
   * the default rather than as a filter.
   */
  const params = useSearchParams();
  const sortParam = params.get('sort');
  const sort: Sort = isSort(sortParam) ? sortParam : 'recent';
  const tag = params.get('tag') ?? '';
  const query = params.get('q') ?? '';

  /**
   * The last write still in flight. A replace commits a beat after it is asked
   * for, and until it does `useSearchParams` still shows the old filters — so a
   * second click inside that beat has to merge over what was just written, not
   * over what is still showing, or it would quietly undo the first. The moment
   * the params move at all — the write landing, or a Back — the URL is the
   * truth again and the snapshot is dropped.
   */
  const pending = useRef<{ sort: Sort; tag: string; q: string } | null>(null);
  // Dropped after commit, not during render: a concurrent render that never
  // commits must not take the snapshot away from the UI still on screen.
  useEffect(() => {
    pending.current = null;
  }, [sort, tag, query]);

  /**
   * …and the way back in. The defaults are left off, so a reader who has touched
   * nothing still has the bare path to copy, and `scroll: false` keeps a filter
   * change from throwing them back to the top of the grid.
   */
  const setFilters = useCallback(
    (next: { sort?: Sort; tag?: string; q?: string }): void => {
      const merged = { ...(pending.current ?? { sort, tag, q: query }), ...next };
      pending.current = merged;
      const written = new URLSearchParams();
      if (merged.sort !== 'recent') written.set('sort', merged.sort);
      if (merged.tag) written.set('tag', merged.tag);
      if (merged.q) written.set('q', merged.q);
      const search = written.toString();
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    },
    [router, pathname, sort, tag, query],
  );

  /** What is being typed. `q` is the committed value a beat behind it. */
  const [draft, setDraft] = useState(query);
  /**
   * A navigation moves `q` with nobody typing, and the field has to follow it.
   * The field's own debounced write is not a move — there `q` has only just
   * caught up with what is already in it.
   */
  const committed = useRef(query);
  if (committed.current !== query) {
    committed.current = query;
    if (query !== draft.trim()) setDraft(query);
  }

  const [feed, setFeed] = useState<FeedState>(initialFeed);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Tags this browser has muted. Read after mount so the markup hydrates cleanly. */
  const [hidden, setHidden] = useState<string[]>([]);
  const [managingHidden, setManagingHidden] = useState(false);
  const hiddenPopover = useRef<HTMLDivElement>(null);
  const hiddenTrigger = useRef<HTMLButtonElement>(null);
  /** Single source of truth for the current filter generation. */
  const generationRef = useRef(initialFeed.generation);
  const { cursor, error } = feed;

  useEffect(() => setHidden(readHiddenTags()), []);

  /** The set is small and browser-local, so it is stored on every change. */
  function mute(next: string[]): void {
    writeHiddenTags(next);
    setHidden(next);
  }

  function hide(value: string): void {
    if (!hidden.includes(value)) mute([...hidden, value]);
    // The chip that was just muted cannot stay the active filter.
    if (tag === value) setFilters({ tag: '' });
  }

  /** Shuts the popover and leaves the reader on the button they opened it from. */
  const closeHidden = useCallback((): void => {
    setManagingHidden(false);
    hiddenTrigger.current?.focus();
  }, []);

  // The same two exits `MoreActions` has: Escape hands the focus back, and a
  // press outside only closes — the pointer has already chosen where to stand.
  useEffect(() => {
    if (!managingHidden) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && !hiddenPopover.current?.contains(target)) {
        setManagingHidden(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeHidden();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [managingHidden, closeHidden]);

  // Hiding is a per-browser preference, so it filters what came back rather than
  // the query — the pages the server hands out stay the same for everyone.
  const items = useMemo(
    () => (feed.items === null ? null : withoutHiddenTags(feed.items, hidden)),
    [feed.items, hidden],
  );

  // The typed text reaches the URL a beat later, so a search is one navigation
  // rather than one per keystroke. Nothing is written when it already says what
  // the field does — which is every mount, and every arrival from elsewhere.
  //
  // The write is kept flushable because it fires on a timer: left alone it can
  // land while a link's navigation is in flight, and the router honours the
  // later dispatch — the timer's replace wins and quietly cancels the click
  // that was already taking the reader away. Committing at most a beat of
  // typing early is harmless; losing a navigation is not.
  const flushSearch = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (draft.trim() === query) {
      flushSearch.current = null;
      return;
    }
    // The ref doubles as the once-guard: a flush leaves the timer armed, and a
    // commit the timer repeats after the flush would be dispatched after the
    // navigation the flush ran ahead of — and cancel it all over again.
    const commit = (): void => {
      if (flushSearch.current === null) return;
      flushSearch.current = null;
      setFilters({ q: draft.trim() });
    };
    flushSearch.current = commit;
    const timer = setTimeout(commit, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      flushSearch.current = null;
    };
  }, [draft, query, setFilters]);

  // …and the flush itself: any link click still inside the debounce window
  // commits the pending write during the capture phase, so it is dispatched
  // before the navigation and is superseded by it rather than the other way
  // round. Document-level because the racing link is as likely to be the
  // header's as a card's.
  useEffect(() => {
    function onClick(event: MouseEvent): void {
      if (!flushSearch.current) return;
      if (event.target instanceof Element && event.target.closest('a[href]')) {
        flushSearch.current();
      }
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  const url = useCallback(
    (next?: string): string => {
      const params = new URLSearchParams({ language: locale, sort });
      if (query) params.set('q', query);
      if (tag) params.set('tag', tag);
      if (next) params.set('cursor', next);
      return `/api/explore?${params.toString()}`;
    },
    [locale, sort, query, tag],
  );

  // Every filter change starts a new generation and aborts the page in flight.
  // The abort only saves the request; it is the generation that keeps a late
  // response — including a "load more" issued under the old filter — from
  // landing on the new list.
  useEffect(() => {
    const controller = new AbortController();
    const generation = (generationRef.current += 1);
    setFeed(restartFeed(generation));
    apiGet<ExploreResult>(url(), controller.signal).then(
      (page) => setFeed((current) => applyPage(current, generation, page, false)),
      (caught: unknown) => {
        const message = controller.signal.aborted ? '' : toMessage(caught);
        setFeed((current) => (message ? failPage(current, generation, message) : current));
      },
    );
    return () => controller.abort();
  }, [url, toMessage]);

  async function loadMore(): Promise<void> {
    if (!cursor || loadingMore) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    try {
      const page = await apiGet<ExploreResult>(url(cursor));
      setFeed((current) => applyPage(current, generation, page, true));
    } catch (caught) {
      const message = toMessage(caught);
      setFeed((current) => failPage(current, generation, message));
    } finally {
      setLoadingMore(false);
    }
  }

  // Chips come from what is on screen (plus the active tag, which the narrowed
  // results always contain) — no separate tag catalogue to keep in sync. Reserved
  // genres lead; muted tags are not offered at all.
  const tags = useMemo(() => {
    const muted = new Set(hidden);
    const seen = new Set<string>(tag ? [tag] : []);
    for (const plot of items ?? []) for (const value of plot.tags) seen.add(value);
    return orderTags([...seen].filter((value) => !muted.has(value)));
  }, [items, tag, hidden]);

  // Whether the empty grid is the catalogue's doing or the viewer's: a search, a
  // tag filter, or rows this browser muted.
  const narrowed = Boolean(query || tag) || (items?.length ?? 0) < (feed.items?.length ?? 0);

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-10">
      <section className="brand-dots relative grid overflow-hidden rounded-3xl border-2 border-fg bg-mint-soft shadow-card md:grid-cols-[1fr_280px]">
        <div className="p-6 sm:p-8 lg:p-10">
          <span className="inline-flex items-center gap-2 rounded-full border border-fg bg-surface px-3 py-1.5 text-xs font-semibold">
            <span aria-hidden="true" className="size-2 bg-accent" />{rebrand('eyebrow')}
          </span>
          <h1 className="mt-5 max-w-xl text-3xl leading-tight font-bold tracking-tight sm:text-4xl">{rebrand('journeyTitle')}</h1>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted sm:text-base">{rebrand('journeySubtitle')}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a href="#plot-catalogue" className={buttonClass('primary')}>
              {rebrand('explore')}<Icon name="arrow" className="size-4" />
            </a>
            <Link href="/plots" className={buttonClass('secondary')}>{rebrand('create')}</Link>
          </div>
        </div>
        <div className="hidden items-center justify-center pr-8 md:flex"><BrandGarden compact /></div>
      </section>

      <div id="plot-catalogue" className="mt-10 scroll-mt-20">
        <h2 className="text-xl font-bold tracking-tight">{t('title')}</h2>
        <p className="mt-1.5 text-sm text-muted">{t('subtitle')}</p>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
          {SORTS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={sort === value}
              onClick={() => setFilters({ sort: value })}
              className={cx(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                sort === value ? 'bg-mint-soft font-semibold text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {t(SORT_LABEL[value])}
            </button>
          ))}
        </div>
        <TextInput
          type="search"
          value={draft}
          aria-label={t('searchPlaceholder')}
          placeholder={t('searchPlaceholder')}
          onChange={(event) => setDraft(event.target.value)}
          className="w-full sm:w-72"
        />

      </div>

      {tags.length > 0 || hidden.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <ul className="flex flex-wrap gap-1.5">
            {tags.length > 0 ? (
              <li>
                <TagChip label={t('allTags')} active={!tag} onClick={() => setFilters({ tag: '' })} />
              </li>
            ) : null}
            {tags.map((value) => (
              <li key={value} className="flex items-center">
                <TagChip
                  label={value}
                  active={tag === value}
                  onClick={() => setFilters({ tag: tag === value ? '' : value })}
                  onHide={() => hide(value)}
                  hideLabel={t('hideTag', { tag: value })}
                />
              </li>
            ))}
          </ul>

          {hidden.length > 0 ? (
            <div ref={hiddenPopover} className="relative">
              <button
                ref={hiddenTrigger}
                type="button"
                data-testid="hidden-tags-toggle"
                aria-expanded={managingHidden}
                onClick={() => setManagingHidden((open) => !open)}
                className="rounded-full border border-line px-3 py-1 text-xs text-muted transition-colors hover:text-fg"
              >
                {t('hiddenTags', { count: hidden.length })}
              </button>
              {managingHidden ? (
                <div className="absolute top-full left-0 z-10 mt-1.5 w-56 rounded-xl border border-line bg-surface p-3 shadow-lg">
                  <p className="text-xs text-muted">{t('hiddenTagsHint')}</p>
                  <ul className="mt-2 space-y-1">
                    {hidden.map((value) => (
                      <li key={value} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs text-fg">{value}</span>
                        <button
                          type="button"
                          onClick={() => mute(hidden.filter((entry) => entry !== value))}
                          className="text-xs text-muted transition-colors hover:text-link"
                        >
                          {t('unhideTag')}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      {items === null ? (
        <div className="flex justify-center py-20">
          <Spinner label={common('loading')} />
        </div>
      ) : items.length === 0 ? (
        <div className="mt-6 flex flex-col items-center rounded-2xl border border-line bg-surface px-5 py-14 text-center">
          <span className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-mint-soft"><Icon name="book" className="size-6" /></span>
          <p className="text-sm text-muted">{narrowed ? t('emptyFiltered') : t('empty')}</p>
          {narrowed ? (
            <Button className="mt-5" onClick={() => { setDraft(''); setFilters({ q: '', tag: '' }); mute([]); }}>{rebrand('resetFilters')}</Button>
          ) : (
            <Link href="/plots" className={buttonClass('primary', 'md', 'mt-5')}>{rebrand('create')}</Link>
          )}
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <PlotGrid plots={items} />
          {cursor ? (
            <div className="flex justify-center">
              <Button busy={loadingMore} onClick={() => void loadMore()}>
                {t('more')}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Filter chip. With `onHide` it grows a mute control — nested buttons, so two of them. */
function TagChip({
  label,
  active,
  onClick,
  onHide,
  hideLabel,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  onHide?: () => void;
  hideLabel?: string;
}) {
  const tone = active ? 'bg-accent text-accent-ink' : 'bg-raised text-muted hover:text-fg';

  return (
    <span className={cx('inline-flex items-center rounded-full text-xs transition-colors', tone)}>
      <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        className={cx('rounded-full py-1 pl-3', onHide ? 'pr-1.5' : 'pr-3')}
      >
        {label}
      </button>
      {onHide ? (
        <button
          type="button"
          aria-label={hideLabel}
          title={hideLabel}
          onClick={onHide}
          className="rounded-full py-1 pr-2.5 pl-0.5 opacity-60 transition-opacity hover:opacity-100"
        >
          <span aria-hidden>✕</span>
        </button>
      ) : null}
    </span>
  );
}
