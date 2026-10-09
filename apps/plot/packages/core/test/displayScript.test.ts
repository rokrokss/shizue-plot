import { describe, expect, it } from 'vitest';
import {
  displayScriptPatternError,
  MAX_DISPLAY_PATTERN_LENGTH,
} from '../src/displayScript.js';

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

  it('rejects every alternation under an unbounded quantifier, ambiguous or not', () => {
    // `(a|aa)+` is the one that motivated the rule: exponential, and its branches
    // are not duplicates, so no "are these the same?" test would ever see it.
    for (const source of ['(a|aa)+', '(a|b)*', '(\\s|\\s\\s)+', '(a|a)+', '(ab|ab)*', '(foo|bar)+']) {
      expect(displayScriptPatternError(source), source).toBe('unsafe_repetition');
    }
    // Bounded repetition of a choice is finite, so it stays legal.
    expect(displayScriptPatternError('(a|b){1,3}')).toBeNull();
    // …and so does an alternation that is not repeated at all.
    expect(displayScriptPatternError('^(status|state): (\\d+)$')).toBeNull();
  });

  it('reads a pipe inside a character class as the literal it is', () => {
    expect(displayScriptPatternError('([a|b])+')).toBeNull();
    expect(displayScriptPatternError('(a\\|b)+')).toBeNull();
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
