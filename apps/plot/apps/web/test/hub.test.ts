import { describe, expect, it, vi } from 'vitest';
import {
  addTag,
  applyPage,
  failPage,
  fillPreview,
  HIDDEN_TAGS_KEY,
  initialFeed,
  MAX_TAGS,
  normalizeTags,
  orderTags,
  readHiddenTags,
  restartFeed,
  withoutHiddenTags,
  writeHiddenTags,
  type FeedState,
} from '../src/lib/hub';
import type { ExploreResult, PublicPlot } from '../src/lib/types';

describe('addTag', () => {
  it('trims, caps the length and refuses duplicates', () => {
    expect(addTag([], '  판타지  ')).toEqual(['판타지']);
    expect(addTag([], 'ㄱ'.repeat(30))).toEqual(['ㄱ'.repeat(20)]);
    expect(addTag(['판타지'], '판타지')).toEqual(['판타지']);
  });

  it('ignores empty input and returns the same array when nothing changes', () => {
    const tags = ['판타지'];
    expect(addTag(tags, '   ')).toBe(tags);
    expect(addTag(tags, '판타지')).toBe(tags);
  });

  it('stops at the server-side cap', () => {
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(addTag(full, '하나 더')).toBe(full);
  });
});

describe('normalizeTags', () => {
  it('applies the same rules the server stores the tag column with', () => {
    expect(normalizeTags([' 판타지 ', '판타지', '', 'ㄱ'.repeat(30)])).toEqual([
      '판타지',
      'ㄱ'.repeat(20),
    ]);
    expect(normalizeTags(Array.from({ length: 12 }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS);
  });
});

describe('explore feed', () => {
  const plot = (name: string): PublicPlot => ({ id: name, name }) as unknown as PublicPlot;
  const page = (names: string[], nextCursor: string | null): ExploreResult => ({
    items: names.map(plot),
    nextCursor,
  });
  /** A feed showing the first page of the current filter generation. */
  const loaded: FeedState = {
    generation: 2,
    items: [plot('a')],
    cursor: 'cursor-a',
    error: '',
  };

  it('starts a generation in the loading state', () => {
    expect(restartFeed(initialFeed.generation + 1)).toEqual({
      generation: 1,
      items: null,
      cursor: null,
      error: '',
    });
  });

  it('applies a first page and a load-more of the current generation', () => {
    expect(applyPage(restartFeed(2), 2, page(['a'], 'cursor-a'), false)).toEqual(loaded);
    expect(applyPage(loaded, 2, page(['b'], null), true)).toEqual({
      generation: 2,
      items: [plot('a'), plot('b')],
      cursor: null,
      error: '',
    });
  });

  it('drops a load-more that belongs to a superseded filter', () => {
    // The user changed the sort while "더 보기" was in flight: neither the rows
    // nor the stale cursor may land on the new list.
    const restarted = restartFeed(3);
    expect(applyPage(restarted, 2, page(['stale'], 'cursor-stale'), true)).toBe(restarted);
    expect(applyPage(loaded, 1, page(['stale'], 'cursor-stale'), false)).toBe(loaded);
  });

  it('carries a feed of any item type', () => {
    // A plot catalogue page uses this same
    // state machine — the item type is the only thing that differs.
    const plot = (id: string): PublicPlot => ({ id, title: id }) as unknown as PublicPlot;
    const first = applyPage<PublicPlot>(
      restartFeed(1),
      1,
      { items: [plot('v1')], nextCursor: 'cursor-v1' },
      false,
    );
    expect(first).toEqual({ generation: 1, items: [plot('v1')], cursor: 'cursor-v1', error: '' });
    expect(applyPage(first, 1, { items: [plot('v2')], nextCursor: null }, true)).toEqual({
      generation: 1,
      items: [plot('v1'), plot('v2')],
      cursor: null,
      error: '',
    });
  });

  it('reports failures per generation', () => {
    // A failed first page shows the empty state…
    expect(failPage(restartFeed(3), 3, '실패')).toEqual({
      generation: 3,
      items: [],
      cursor: null,
      error: '실패',
    });
    // …while a failed load-more keeps the rows and the cursor for a retry.
    expect(failPage(loaded, 2, '실패')).toEqual({ ...loaded, error: '실패' });
    expect(failPage(loaded, 1, '실패')).toBe(loaded);
  });
});

describe('fillPreview', () => {
  it('substitutes char and user regardless of case or spacing', () => {
    expect(fillPreview('{{char}}가 {{ USER }}를 본다', '사서', '당신')).toBe('사서가 당신를 본다');
  });

  it('leaves other macros alone', () => {
    expect(fillPreview('{{roll:d6}} {{char}}', '사서', '당신')).toBe('{{roll:d6}} 사서');
  });
});

describe('reserved genre tags', () => {
  it('puts the genres first, in catalogue order, and keeps the rest as they came', () => {
    expect(orderTags(['자유태그', '판타지', '다른태그', '로맨스'])).toEqual([
      '로맨스',
      '판타지',
      '자유태그',
      '다른태그',
    ]);
  });

  it('leaves a list without genres untouched', () => {
    const tags = ['자유태그', '다른태그'];
    expect(orderTags(tags)).toEqual(tags);
  });
});

describe('hidden tags', () => {
  const plot = (name: string, tags: string[]): PublicPlot =>
    ({ id: name, name, tags }) as unknown as PublicPlot;
  const items = [plot('a', ['판타지', '로맨스']), plot('b', ['로맨스']), plot('c', [])];

  it('drops every plot carrying a hidden tag', () => {
    expect(withoutHiddenTags(items, ['로맨스']).map((entry) => entry.name)).toEqual(['c']);
    expect(withoutHiddenTags(items, ['판타지']).map((entry) => entry.name)).toEqual(['b', 'c']);
  });

  it('returns the same list when nothing is hidden or nothing matches', () => {
    expect(withoutHiddenTags(items, [])).toBe(items);
    expect(withoutHiddenTags(items, ['없는태그'])).toEqual(items);
  });

  it('round-trips through localStorage and survives junk in it', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });

    expect(readHiddenTags()).toEqual([]);
    writeHiddenTags(['로맨스', '공포']);
    expect(readHiddenTags()).toEqual(['로맨스', '공포']);

    // Anything unreadable means "nothing hidden" rather than a crash.
    store.set(HIDDEN_TAGS_KEY, 'not json');
    expect(readHiddenTags()).toEqual([]);
    // Non-string members are dropped, not trusted.
    store.set(HIDDEN_TAGS_KEY, JSON.stringify(['공포', 7, null]));
    expect(readHiddenTags()).toEqual(['공포']);
    store.set(HIDDEN_TAGS_KEY, JSON.stringify({ 공포: true }));
    expect(readHiddenTags()).toEqual([]);

    vi.unstubAllGlobals();
  });
});
