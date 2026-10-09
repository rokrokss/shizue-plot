import { describe, expect, it } from 'vitest';
import { activateLore } from '../src/lorebook.js';
import type { LoreEntry } from '../src/types.js';

const entry = (overrides: Partial<LoreEntry> & { content: string }): LoreEntry => ({
  keys: [],
  secondaryKeys: [],
  selective: false,
  enabled: true,
  constant: false,
  insertionOrder: 0,
  caseSensitive: false,
  useRegex: false,
  position: 'before_char',
  ...overrides,
});

// One "token" per character keeps budget assertions readable.
const countChars = (text: string): number => text.length;

describe('activateLore', () => {
  it('always activates constant entries and skips disabled ones', () => {
    const entries = [
      entry({ content: 'always', constant: true }),
      entry({ content: 'off', constant: true, enabled: false }),
      entry({ content: 'never', keys: ['없는키'] }),
    ];
    expect(activateLore(entries, '아무 말', 1000, countChars).map((e) => e.content)).toEqual(['always']);
  });

  it('matches plain keys as substrings, honouring caseSensitive', () => {
    const entries = [
      entry({ content: 'insensitive', keys: ['Dragon'] }),
      entry({ content: 'sensitive', keys: ['Dragon'], caseSensitive: true }),
    ];
    expect(activateLore(entries, 'a dragon appears', 1000, countChars).map((e) => e.content)).toEqual([
      'insensitive',
    ]);
    expect(activateLore(entries, 'a Dragon appears', 1000, countChars)).toHaveLength(2);
  });

  it('requires a secondary key match for selective entries', () => {
    const entries = [
      entry({ content: 'selective', keys: ['금서'], secondaryKeys: ['지하'], selective: true }),
    ];
    expect(activateLore(entries, '금서를 찾는다', 1000, countChars)).toHaveLength(0);
    expect(activateLore(entries, '지하 서고의 금서', 1000, countChars)).toHaveLength(1);
  });

  it('treats keys as regular expressions when useRegex is set', () => {
    const entries = [entry({ content: 'regex', keys: ['검(술|객)'], useRegex: true })];
    expect(activateLore(entries, '떠돌이 검객', 1000, countChars)).toHaveLength(1);
    expect(activateLore(entries, '떠돌이 상인', 1000, countChars)).toHaveLength(0);
  });

  it('matches regex substrings and preserves case sensitivity', () => {
    const entries = [
      entry({ content: 'insensitive', keys: ['Dragon\\d+'], useRegex: true }),
      entry({ content: 'sensitive', keys: ['Dragon\\d+'], useRegex: true, caseSensitive: true }),
    ];
    expect(activateLore(entries, 'a dragon42 appears', 1000, countChars).map((e) => e.content)).toEqual(['insensitive']);
    expect(activateLore(entries, 'a Dragon42 appears', 1000, countChars)).toHaveLength(2);
  });

  it('handles backtracking attacks in primary and secondary keys without blocking', () => {
    const attacks = ['(a+)+$', 'a+a+a+a+a+a+a+a+a+a+b'];
    const entries = attacks.flatMap((key) => [
      entry({ content: 'primary', keys: [key], useRegex: true }),
      entry({ content: 'secondary', keys: ['a'], secondaryKeys: [key], selective: true, useRegex: true }),
    ]);
    const start = performance.now();
    expect(activateLore(entries, 'a'.repeat(10_000) + '!', 1000, countChars)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('skips invalid, unsupported and oversized regex keys without a JS fallback', () => {
    const entries = ['[', '(a)\\1', '(?=dragon)dragon', 'a'.repeat(513)].map((key) =>
      entry({ content: 'unsafe', keys: [key], useRegex: true }),
    );
    expect(activateLore(entries, 'dragon ' + 'a'.repeat(600), 1000, countChars)).toEqual([]);
  });

  it('orders by insertionOrder and cuts off at the token budget', () => {
    const entries = [
      entry({ content: 'cccc', constant: true, insertionOrder: 3 }),
      entry({ content: 'aaaa', constant: true, insertionOrder: 1 }),
      entry({ content: 'bbbb', constant: true, insertionOrder: 2 }),
    ];
    expect(activateLore(entries, '', 100, countChars).map((e) => e.content)).toEqual([
      'aaaa',
      'bbbb',
      'cccc',
    ]);
    expect(activateLore(entries, '', 9, countChars).map((e) => e.content)).toEqual(['aaaa', 'bbbb']);
    expect(activateLore(entries, '', 3, countChars)).toEqual([]);
  });
});

describe('activateLore - recursive scanning', () => {
  // A activates on the scan text, its content triggers B, and B's triggers C.
  const chain = [
    entry({ content: 'A는 B를 부른다', keys: ['시작'], insertionOrder: 1 }),
    entry({ content: 'B는 C를 부른다', keys: ['B'], insertionOrder: 2 }),
    entry({ content: 'C 엔트리', keys: ['C'], insertionOrder: 3 }),
  ];

  it('does not rescan by default', () => {
    expect(activateLore(chain, '시작', 1000, countChars).map((e) => e.content)).toEqual([
      'A는 B를 부른다',
    ]);
  });

  it('follows a chain of three entries in two extra passes', () => {
    expect(activateLore(chain, '시작', 1000, countChars, true).map((e) => e.content)).toEqual([
      'A는 B를 부른다',
      'B는 C를 부른다',
      'C 엔트리',
    ]);
  });

  it('stops after two extra passes', () => {
    const longer = [...chain, entry({ content: 'D 엔트리', keys: ['C 엔트리'], insertionOrder: 4 })];
    expect(activateLore(longer, '시작', 1000, countChars, true).map((e) => e.content)).toEqual([
      'A는 B를 부른다',
      'B는 C를 부른다',
      'C 엔트리',
    ]);
  });

  it('activates mutually triggering entries once each instead of looping', () => {
    const mutual = [
      entry({ content: '갑은 을을 안다', keys: ['시작', '을'], insertionOrder: 1 }),
      entry({ content: '을은 갑을 안다', keys: ['갑'], insertionOrder: 2 }),
    ];
    expect(activateLore(mutual, '시작', 1000, countChars, true).map((e) => e.content)).toEqual([
      '갑은 을을 안다',
      '을은 갑을 안다',
    ]);
  });

  it('does not retrigger constant entries on later passes', () => {
    const withConstant = [
      entry({ content: '상수 엔트리', constant: true, insertionOrder: 1 }),
      entry({ content: '상수 엔트리를 언급', keys: ['상수'], insertionOrder: 2 }),
    ];
    expect(activateLore(withConstant, '', 1000, countChars, true).map((e) => e.content)).toEqual([
      '상수 엔트리',
      '상수 엔트리를 언급',
    ]);
  });

  it('spends one budget across every pass and stops when it runs out', () => {
    const cost = chain.map((e) => e.content.length);
    // Enough for the first two links, so the third pass finds C but cannot pay for it.
    const twoLinks = activateLore(chain, '시작', cost[0]! + cost[1]!, countChars, true);
    expect(twoLinks.map((e) => e.content)).toEqual(['A는 B를 부른다', 'B는 C를 부른다']);
    // One token short of B: the recursion stops with only the first pass kept.
    const oneLink = activateLore(chain, '시작', cost[0]! + cost[1]! - 1, countChars, true);
    expect(oneLink.map((e) => e.content)).toEqual(['A는 B를 부른다']);
  });
});
