/**
 * Paging a long branch backwards, and keeping what was paged in when the turn
 * that follows refetches the head window.
 */
import { computeVariables } from '@shizue/core/variables';
import { describe, expect, it } from 'vitest';
import {
  foldBase,
  headAnchor,
  mergeRefetched,
  prependWindow,
  type VariableAnchor,
} from '../src/lib/chatHistory';
import type { ChatMessage, ChatState, Variables } from '../src/lib/types';

/**
 * One branch — a → b → c → d → e — and a fork off b, x → y. Every state below is
 * a window on one of the two, so what a message's parent is has to be the same
 * wherever it turns up.
 */
const PARENTS: Record<string, string | null> = {
  a: null,
  b: 'a',
  c: 'b',
  d: 'c',
  e: 'd',
  x: 'b',
  y: 'x',
  // A message of some third branch, whose parent nothing here has loaded.
  q: 'unknown',
};

const message = (id: string, role: ChatMessage['role'] = 'assistant'): ChatMessage => ({
  id,
  parentId: PARENTS[id] ?? null,
  role,
  content: `${role}:${id}`,
  source: 'user',
  directions: null,
  model: null,
  promptTokens: null,
  completionTokens: null,
  attachments: [],
  createdAt: '2026-08-11T00:00:00.000Z',
});

const state = (ids: string[], hasMore?: boolean): ChatState => ({
  chat: {
    id: 'chat-1',
    plotId: 'plot-1',
    personaId: null,
    title: '리안',
    model: 'echo/echo',
    note: '',
    preset: 'standard',
    headMessageId: ids[ids.length - 1] ?? null,
    memory: null,
    memorySettings: null,
    relationship: null,
    relationshipEnabled: true,
    narrator: null,
    allowComponentTurns: false,
    statusWindowEnabled: true,
    choicesEnabled: true,
    reasoningEffort: null,
    absentCharacterIds: [],
    noteIds: [],
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  },
  path: ids.map((id) => message(id)),
  siblings: Object.fromEntries(ids.map((id) => [id, { index: 0, total: 1, ids: [id] }])),
  ...(hasMore === undefined ? {} : { hasMore }),
});

const ids = (next: ChatState): string[] => next.path.map((entry) => entry.id);

describe('prependWindow', () => {
  it('puts the older window in front and takes over its hasMore', () => {
    const merged = prependWindow(state(['c', 'd'], true), state(['a', 'b'], true));
    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged.hasMore).toBe(true);
  });

  it('closes the paging when the older window reached the start', () => {
    const merged = prependWindow(state(['c', 'd'], true), state(['a', 'b'], false));
    expect(merged.hasMore).toBe(false);
  });

  it('never repeats a message that is already loaded', () => {
    const merged = prependWindow(state(['b', 'c'], true), state(['a', 'b'], false));
    expect(ids(merged)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the branch the page is rendering, and gains the older swipe groups', () => {
    const current = state(['c', 'd'], true);
    const merged = prependWindow(current, state(['a', 'b'], false));
    expect(merged.chat).toBe(current.chat);
    expect(Object.keys(merged.siblings).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('mergeRefetched', () => {
  it('keeps the history paged in above a window that overlaps it', () => {
    const loaded = prependWindow(state(['c', 'd'], true), state(['a', 'b'], false));
    const merged = mergeRefetched(loaded, state(['c', 'd', 'e'], true));
    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Older than what was kept: still nothing, whatever the window claimed.
    expect(merged.hasMore).toBe(false);
    expect(merged.chat.headMessageId).toBe('e');
  });

  it('keeps it for a window of nothing but the new turns, which is the usual one', () => {
    const loaded = prependWindow(state(['c', 'd'], true), state(['a', 'b'], false));
    expect(ids(mergeRefetched(loaded, state(['e'], true)))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('follows a fork exactly as far as the two branches agree', () => {
    const loaded = prependWindow(state(['c', 'd'], true), state(['a', 'b'], false));
    // x forks off b, so c and d are no longer on the branch and go.
    expect(ids(mergeRefetched(loaded, state(['x', 'y'], true)))).toEqual(['a', 'b', 'x', 'y']);
  });

  it('takes the whole answer when the two have nothing to be joined by', () => {
    const loaded = prependWindow(state(['c', 'd'], true), state(['a', 'b'], false));
    const merged = mergeRefetched(loaded, state(['q'], true));
    expect(ids(merged)).toEqual(['q']);
    expect(merged.hasMore).toBe(true);
  });

  it('is the answer itself on the first load, for an empty one, and at the root', () => {
    const first = state(['a'], false);
    expect(mergeRefetched(null, first)).toBe(first);
    const empty = state([], false);
    expect(mergeRefetched(state(['a'], false), empty)).toBe(empty);
    // A window that starts at the greeting has nothing older to keep.
    const whole = state(['a', 'b'], false);
    expect(mergeRefetched(state(['a'], false), whole)).toBe(whole);
  });
});

/**
 * The macros of a branch are folded from its first message on, and the client
 * holds a window of it — so what is on screen is not what the fold may start
 * from. These are the two joins above seen from the variables' side.
 */
describe('foldBase', () => {
  /** Whatever the card declares; the floor every fold without an anchor starts at. */
  const CARD: Variables = { 호감도: '0' };

  const macro = (next: ChatState, id: string, content: string): ChatState => ({
    ...next,
    path: next.path.map((entry) => (entry.id === id ? { ...entry, content } : entry)),
  });

  /** What the page renders from: the loaded window folded onto its anchor. */
  const fold = (next: ChatState, anchor: VariableAnchor | null): Variables => {
    const base = foldBase(next.path, anchor, CARD);
    return computeVariables(base.messages.map((entry) => entry.content), base.defaults);
  };

  it('folds the window onto the fold the server sent, and not the window again', () => {
    // c–d is the window; a–b were cut, and the +5 they set is what the server
    // folded into `variableDefaults` for exactly this reason.
    const head: ChatState = {
      ...macro(state(['c', 'd'], true), 'd', '{{addvar::호감도::1}}'),
      variableDefaults: { 호감도: '5' },
    };
    const anchor = headAnchor(head);
    expect(anchor).toEqual({ id: 'c', defaults: { 호감도: '5' } });
    expect(fold(head, anchor)).toEqual({ 호감도: '6' });

    // Paging the cut stretch back in puts its macros on screen — and they are
    // already in the anchor, so folding them a second time would double them.
    const older = macro(state(['a', 'b'], false), 'b', '{{addvar::호감도::5}}');
    const merged = prependWindow(head, older);
    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd']);
    expect(fold(merged, anchor)).toEqual({ 호감도: '6' });
  });

  it('moves to the window a refetch brought back', () => {
    const loaded = state(['a', 'b', 'c'], false);
    const refetched: ChatState = {
      ...macro(state(['d', 'e'], true), 'e', '{{addvar::호감도::1}}'),
      variableDefaults: { 호감도: '9' },
    };
    const anchor = headAnchor(refetched);
    expect(anchor).toEqual({ id: 'd', defaults: { 호감도: '9' } });

    const merged = mergeRefetched(loaded, refetched);
    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // The kept stretch is what the new anchor already accounts for.
    expect(fold(merged, anchor)).toEqual({ 호감도: '10' });
  });

  it('starts from the card’s own defaults on an unwindowed read', () => {
    const whole = macro(state(['a', 'b'], false), 'b', '{{addvar::호감도::2}}');
    const anchor = headAnchor(whole);
    expect(anchor).toEqual({ id: 'a' });
    expect(fold(whole, anchor)).toEqual({ 호감도: '2' });
  });

  it('folds everything, over the card, when the anchor is no longer on the branch', () => {
    // A branch switch: the window the anchor was read from is not here any more.
    const forked = macro(state(['x', 'y'], false), 'y', '{{addvar::호감도::3}}');
    expect(fold(forked, { id: 'c', defaults: { 호감도: '5' } })).toEqual({ 호감도: '3' });
    expect(fold(forked, null)).toEqual({ 호감도: '3' });
  });
});
