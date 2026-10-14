import { describe, expect, it } from 'vitest';
import {
  coerceDisplayDepth,
  displayScriptPatternError,
  inDisplayDepth,
  MAX_DISPLAY_DEPTH,
  MAX_DISPLAY_PATTERN_LENGTH,
} from '../src/displayScript.js';

describe('coerceDisplayDepth', () => {
  it('keeps whole, non-negative bounds and drops the rest as no limit', () => {
    expect(coerceDisplayDepth({ minDepth: 0, maxDepth: 4 })).toEqual({ minDepth: 0, maxDepth: 4 });
    expect(coerceDisplayDepth({})).toEqual({});
    expect(coerceDisplayDepth({ minDepth: null, maxDepth: '' })).toEqual({});
    expect(coerceDisplayDepth({ minDepth: -1, maxDepth: -3 })).toEqual({});
    expect(coerceDisplayDepth({ minDepth: 'abc', maxDepth: Number.NaN })).toEqual({});
    expect(coerceDisplayDepth({ minDepth: Infinity })).toEqual({});
  });

  it('reads numeric strings and rounds inward, so whole depths run as ST runs them', () => {
    expect(coerceDisplayDepth({ minDepth: '2', maxDepth: '7' })).toEqual({ minDepth: 2, maxDepth: 7 });
    expect(coerceDisplayDepth({ minDepth: 1.2, maxDepth: 3.8 })).toEqual({ minDepth: 2, maxDepth: 3 });
  });

  it('caps a bound, and keeps a minimum above the maximum as written', () => {
    expect(coerceDisplayDepth({ minDepth: 10 ** 9 })).toEqual({ minDepth: MAX_DISPLAY_DEPTH });
    expect(coerceDisplayDepth({ minDepth: 5, maxDepth: 2 })).toEqual({ minDepth: 5, maxDepth: 2 });
  });
});

describe('inDisplayDepth', () => {
  it('runs inside both bounds, inclusive, and everywhere without them', () => {
    const range = { minDepth: 1, maxDepth: 3 };
    expect([0, 1, 2, 3, 4].map((depth) => inDisplayDepth(range, depth))).toEqual([false, true, true, true, false]);
    expect(inDisplayDepth({}, 1000)).toBe(true);
    expect(inDisplayDepth({ maxDepth: 0 }, 0)).toBe(true);
    expect(inDisplayDepth({ maxDepth: 0 }, 1)).toBe(false);
  });

  it('holds a message with no depth — one hidden from the AI — to no range', () => {
    expect(inDisplayDepth({ minDepth: 1, maxDepth: 1 }, undefined)).toBe(true);
  });

  it('runs a script whose minimum is above its maximum nowhere', () => {
    expect([0, 2, 5].some((depth) => inDisplayDepth({ minDepth: 5, maxDepth: 2 }, depth))).toBe(false);
  });
});

describe('displayScriptPatternError', () => {
  it('accepts the patterns a status window is actually written with', () => {
    for (const source of [
      '\\[status\\] hp=(\\d+)',
      '^\\s*<status>([\\s\\S]*?)</status>\\s*$',
      'hp=(?<now>\\d+)/(\\d+)',
      '\\{\\{(affection|trust)\\}\\}',
      '[a-z]+\\d*',
      '[ab]+',
      '(?:abc)+',
      'a{2,4}(b{1,3})+',
      '(\\d{1,3})+',
      '\\[status\\]\\s*hp=(\\d+)',
      '[0-9-]+',
    ]) {
      expect(displayScriptPatternError(source), source).toBeNull();
    }
  });

  it('rejects a quantified group that repeats unboundedly inside itself', () => {
    // The classic catastrophic shapes: every one of these freezes a tab on a long
    // near-match, and every one of them is cheap to spot before it is stored.
    for (const source of [
      '^(a+)+$',
      '(a*)*',
      '(a+)*',
      '(\\d+)+$',
      '(?:x+)+',
      '([a-z]+\\s*)+$',
      '(a+){2,}',
      '(a|b|(c+))+',
    ]) {
      expect(displayScriptPatternError(source), source).toBe('unsafe_repetition');
    }
  });

  it('rejects an alternation under an unbounded quantifier that can split a text two ways', () => {
    // `(a|aa)+` is the one that motivated the rule: exponential, and its branches
    // are not duplicates, so no "are these the same?" test would ever see it.
    for (const source of ['(a|aa)+', '(\\s|\\s\\s)+', '(a|a)+', '(ab|ab)*', '(ab|AB)+', '(a|b+)+', '(a|)+', '(?:a|[ab])+']) {
      expect(displayScriptPatternError(source), source).toBe('unsafe_repetition');
    }
    // Bounded repetition of a choice is finite, so it stays legal.
    expect(displayScriptPatternError('(a|b){1,3}')).toBeNull();
    // …and so does an alternation that is not repeated at all.
    expect(displayScriptPatternError('^(status|state): (\\d+)$')).toBeNull();
  });

  it('accepts a repeated choice of plain words none of which starts another', () => {
    // At each point at most one of them can match, so there is one way through.
    for (const source of ['(a|b)*', '(foo|bar)+', '(?:<br>|<\\/div><div class="ep-p">)*', '(\\n|\\t)+', '(?:x\\||y)+']) {
      expect(displayScriptPatternError(source), source).toBeNull();
    }
  });

  it('accepts a repeat inside a repeat when a character it cannot match closes it', () => {
    // The status-line shapes Realm cards are written with, which the earlier
    // rule refused: the run has to stop at the first closing mark, so where each
    // iteration ends is forced.
    for (const source of [
      '((?:⟦호감:[^⟧]*⟧)+)\\s*♣️\\[status\\]♣️',
      '♣️\\[status\\]♣️((?:⟦호감:[^⟧]*⟧)*)\\s+(?=⟦호감:)',
      '[ \\t]*\\n(?:[ \\t]*\\n)+[ \\t]*',
      '\\n\\s*-\\s*(?:의뢰|퀘스트)완료\\s*:\\s*⟦[^⟧\\n]*⟧(?:⟦[^⟧\\n]*⟧)*',
      '(?:\\s*-\\s*⟦[^⟧]*⟧)+',
      '(?:[^\\u2016]*?\\u2016)+',
    ]) {
      expect(displayScriptPatternError(source), source).toBeNull();
    }
  });

  it('rejects a closed repeat whose closing mark it could match, or that is left open', () => {
    for (const source of [
      // `\s` takes a newline, so the run is not closed by it.
      '(?:\\s*\\n)+',
      // `.` is read with `s`: the screen never sees the flags.
      '(?:.*\\n)+',
      // Case-insensitively `[a-z]` takes `A`.
      '(?:[a-z]+A)+',
      // The second run is open, and the gaps between b's split any number of ways.
      '(?:a*ba*)+',
      // Two runs back to back.
      '(?:a*a*b)+',
      // A closing mark that may be missing closes nothing.
      '(?:⟦[^⟧]*⟧?)+',
      // A choice nested inside, even of words, is not looked into.
      '(?:⟦(?:호감|신뢰):[^⟧]*⟧)+',
    ]) {
      expect(displayScriptPatternError(source), source).toBe('unsafe_repetition');
    }
  });

  it('reads a pipe inside a character class as the literal it is', () => {
    expect(displayScriptPatternError('([a|b])+')).toBeNull();
    expect(displayScriptPatternError('(a\\|b)+')).toBeNull();
    // …and a run closed by an escaped pipe as closed by that character.
    expect(displayScriptPatternError('(?:[^|]*\\|)+')).toBeNull();
  });

  it('is not fooled by an escaped quantifier or one inside a character class', () => {
    expect(displayScriptPatternError('(a\\+)+')).toBeNull();
    expect(displayScriptPatternError('([+*])+')).toBeNull();
    // …and a real one next to them is still caught.
    expect(displayScriptPatternError('(a\\+b+)+')).toBe('unsafe_repetition');
  });

  it('does not treat an escaped paren as a group', () => {
    expect(displayScriptPatternError('\\(a+\\)+')).toBeNull();
  });

  it('rejects a pattern the engine will not compile', () => {
    expect(displayScriptPatternError('([')).toBe('invalid');
    expect(displayScriptPatternError('(?<')).toBe('invalid');
  });

  it('rejects a pattern past the length cap', () => {
    expect(displayScriptPatternError('a'.repeat(MAX_DISPLAY_PATTERN_LENGTH))).toBeNull();
    expect(displayScriptPatternError('a'.repeat(MAX_DISPLAY_PATTERN_LENGTH + 1))).toBe('too_long');
  });

  it('screens the patterns that motivated the screen', () => {
    // Both are standard catastrophic-backtracking demonstrations against a long
    // run of a's followed by anything else. Neither may reach a reader's tab, and
    // no render deadline can interrupt the single `exec` either of them starts.
    expect(displayScriptPatternError('^(a+)+$')).toBe('unsafe_repetition');
    expect(displayScriptPatternError('(a|aa)+$')).toBe('unsafe_repetition');
  });
});

describe('what the screen does not see', () => {
  /**
   * Pinned so nobody mistakes this screen for a guarantee. Every pattern here is
   * exponential in the length of the line it scans and every one is accepted: the
   * first has no parenthesis for the rule to look at, the second is a character
   * class chain the module comment explicitly declares legal, and the third puts
   * an ambiguous body under a *bounded* quantifier, which `isUnbounded` says
   * nothing about.
   *
   * They are not executed here, for the obvious reason. What makes them survivable
   * is that the web client runs matching in a worker it can terminate.
   */
  it('accepts patterns that are catastrophic anyway', () => {
    for (const source of [
      '\\[status\\] hp=\\d+ a+a+a+a+a+a+a+a+a+a+b',
      '[a-z]+[a-z]+[a-z]+[a-z]+[a-z]+[a-z]+[a-z]+[a-z]+X',
      '(a|aa){1,20}$',
    ]) {
      expect(displayScriptPatternError(source), source).toBeNull();
    }
  });
});
