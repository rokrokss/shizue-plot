import { describe, expect, it } from 'vitest';
import { activateLore, loreEntryKey, type ActivateLoreInput } from '../src/lorebook.js';
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

/** The single-scan-text form most cases are written in: one message, depth 1. */
const activate = (
  entries: LoreEntry[],
  scanText: string,
  budgetTokens: number,
  countTokens: (text: string) => number,
  recursiveScanning = false,
): LoreEntry[] =>
  activateLore(entries, { history: [scanText], scanDepth: 1, budgetTokens, countTokens, recursiveScanning })
    .entries;

describe('activateLore', () => {
  it('always activates constant entries and skips disabled ones', () => {
    const entries = [
      entry({ content: 'always', constant: true }),
      entry({ content: 'off', constant: true, enabled: false }),
      entry({ content: 'never', keys: ['없는키'] }),
    ];
    expect(activate(entries, '아무 말', 1000, countChars).map((e) => e.content)).toEqual(['always']);
  });

  it('matches plain keys as substrings, honouring caseSensitive', () => {
    const entries = [
      entry({ content: 'insensitive', keys: ['Dragon'] }),
      entry({ content: 'sensitive', keys: ['Dragon'], caseSensitive: true }),
    ];
    expect(activate(entries, 'a dragon appears', 1000, countChars).map((e) => e.content)).toEqual([
      'insensitive',
    ]);
    expect(activate(entries, 'a Dragon appears', 1000, countChars)).toHaveLength(2);
  });

  it('requires a secondary key match for selective entries', () => {
    const entries = [
      entry({ content: 'selective', keys: ['금서'], secondaryKeys: ['지하'], selective: true }),
    ];
    expect(activate(entries, '금서를 찾는다', 1000, countChars)).toHaveLength(0);
    expect(activate(entries, '지하 서고의 금서', 1000, countChars)).toHaveLength(1);
  });

  it('treats keys as regular expressions when useRegex is set', () => {
    const entries = [entry({ content: 'regex', keys: ['검(술|객)'], useRegex: true })];
    expect(activate(entries, '떠돌이 검객', 1000, countChars)).toHaveLength(1);
    expect(activate(entries, '떠돌이 상인', 1000, countChars)).toHaveLength(0);
  });

  it('matches regex substrings and preserves case sensitivity', () => {
    const entries = [
      entry({ content: 'insensitive', keys: ['Dragon\\d+'], useRegex: true }),
      entry({ content: 'sensitive', keys: ['Dragon\\d+'], useRegex: true, caseSensitive: true }),
    ];
    expect(activate(entries, 'a dragon42 appears', 1000, countChars).map((e) => e.content)).toEqual(['insensitive']);
    expect(activate(entries, 'a Dragon42 appears', 1000, countChars)).toHaveLength(2);
  });

  it('handles backtracking attacks in primary and secondary keys without blocking', () => {
    const attacks = ['(a+)+$', 'a+a+a+a+a+a+a+a+a+a+b'];
    const entries = attacks.flatMap((key) => [
      entry({ content: 'primary', keys: [key], useRegex: true }),
      entry({ content: 'secondary', keys: ['a'], secondaryKeys: [key], selective: true, useRegex: true }),
    ]);
    const start = performance.now();
    expect(activate(entries, 'a'.repeat(10_000) + '!', 1000, countChars)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('skips invalid, unsupported and oversized regex keys without a JS fallback', () => {
    const entries = ['[', '(a)\\1', '(?=dragon)dragon', 'a'.repeat(513)].map((key) =>
      entry({ content: 'unsafe', keys: [key], useRegex: true }),
    );
    expect(activate(entries, 'dragon ' + 'a'.repeat(600), 1000, countChars)).toEqual([]);
  });

  it('orders by insertionOrder and cuts off at the token budget', () => {
    const entries = [
      entry({ content: 'cccc', constant: true, insertionOrder: 3 }),
      entry({ content: 'aaaa', constant: true, insertionOrder: 1 }),
      entry({ content: 'bbbb', constant: true, insertionOrder: 2 }),
    ];
    expect(activate(entries, '', 100, countChars).map((e) => e.content)).toEqual([
      'aaaa',
      'bbbb',
      'cccc',
    ]);
    expect(activate(entries, '', 9, countChars).map((e) => e.content)).toEqual(['aaaa', 'bbbb']);
    expect(activate(entries, '', 3, countChars)).toEqual([]);
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
    expect(activate(chain, '시작', 1000, countChars).map((e) => e.content)).toEqual([
      'A는 B를 부른다',
    ]);
  });

  it('follows a chain of three entries in two extra passes', () => {
    expect(activate(chain, '시작', 1000, countChars, true).map((e) => e.content)).toEqual([
      'A는 B를 부른다',
      'B는 C를 부른다',
      'C 엔트리',
    ]);
  });

  it('stops after two extra passes', () => {
    const longer = [...chain, entry({ content: 'D 엔트리', keys: ['C 엔트리'], insertionOrder: 4 })];
    expect(activate(longer, '시작', 1000, countChars, true).map((e) => e.content)).toEqual([
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
    expect(activate(mutual, '시작', 1000, countChars, true).map((e) => e.content)).toEqual([
      '갑은 을을 안다',
      '을은 갑을 안다',
    ]);
  });

  it('does not retrigger constant entries on later passes', () => {
    const withConstant = [
      entry({ content: '상수 엔트리', constant: true, insertionOrder: 1 }),
      entry({ content: '상수 엔트리를 언급', keys: ['상수'], insertionOrder: 2 }),
    ];
    expect(activate(withConstant, '', 1000, countChars, true).map((e) => e.content)).toEqual([
      '상수 엔트리',
      '상수 엔트리를 언급',
    ]);
  });

  it('spends one budget across every pass and stops when it runs out', () => {
    const cost = chain.map((e) => e.content.length);
    // Enough for the first two links, so the third pass finds C but cannot pay for it.
    const twoLinks = activate(chain, '시작', cost[0]! + cost[1]!, countChars, true);
    expect(twoLinks.map((e) => e.content)).toEqual(['A는 B를 부른다', 'B는 C를 부른다']);
    // One token short of B: the recursion stops with only the first pass kept.
    const oneLink = activate(chain, '시작', cost[0]! + cost[1]! - 1, countChars, true);
    expect(oneLink.map((e) => e.content)).toEqual(['A는 B를 부른다']);
  });
});

const run = (entries: LoreEntry[], input: Partial<ActivateLoreInput> & { history: string[] }) =>
  activateLore(entries, { scanDepth: 4, budgetTokens: 1000, countTokens: countChars, ...input });
const contents = (result: { entries: LoreEntry[] }): string[] => result.entries.map((e) => e.content);

/** A random source that hands out the given values in order. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++] ?? 0;
};

describe('loreEntryKey', () => {
  it('follows what the entry matches and says, not where it sits', () => {
    const base = entry({ content: '왕궁의 비밀', keys: ['왕궁'] });
    expect(loreEntryKey(base)).toMatch(/^[0-9a-f]{8}$/);
    expect(loreEntryKey({ ...base, insertionOrder: 9, enabled: false, sticky: 3 })).toBe(loreEntryKey(base));
    expect(loreEntryKey({ ...base, content: '왕궁의 다른 비밀' })).not.toBe(loreEntryKey(base));
    expect(loreEntryKey({ ...base, keys: ['궁'] })).not.toBe(loreEntryKey(base));
    expect(loreEntryKey({ ...base, secondaryKeys: ['밤'] })).not.toBe(loreEntryKey(base));
  });
});

describe('activateLore - selective logic', () => {
  const logic = (selectiveLogic?: LoreEntry['selectiveLogic']) =>
    entry({
      content: 'hit',
      keys: ['금서'],
      secondaryKeys: ['지하', '밤'],
      selective: true,
      ...(selectiveLogic ? { selectiveLogic } : {}),
    });
  const hits = (e: LoreEntry, text: string): boolean => run([e], { history: [text] }).entries.length === 1;

  it('reads an absent logic as and_any', () => {
    expect(hits(logic(), '지하의 금서')).toBe(true);
    expect(hits(logic(), '금서')).toBe(false);
  });

  it('applies and_all, not_any and not_all to the secondary keys', () => {
    expect(hits(logic('and_all'), '지하의 금서')).toBe(false);
    expect(hits(logic('and_all'), '밤, 지하의 금서')).toBe(true);
    expect(hits(logic('not_any'), '금서')).toBe(true);
    expect(hits(logic('not_any'), '지하의 금서')).toBe(false);
    expect(hits(logic('not_all'), '지하의 금서')).toBe(true);
    expect(hits(logic('not_all'), '밤, 지하의 금서')).toBe(false);
    // The primary key is still required whatever the logic.
    expect(hits(logic('not_any'), '아무것도')).toBe(false);
  });
});

describe('activateLore - scan depth', () => {
  const history = ['오래된 용', '중간', '최근'];

  it('scans the book depth unless the entry sets its own', () => {
    const dragon = entry({ content: 'dragon', keys: ['용'] });
    expect(contents(run([dragon], { history, scanDepth: 2 }))).toEqual([]);
    expect(contents(run([dragon], { history, scanDepth: 3 }))).toEqual(['dragon']);
    expect(contents(run([{ ...dragon, scanDepth: 3 }], { history, scanDepth: 1 }))).toEqual(['dragon']);
    expect(contents(run([{ ...dragon, scanDepth: 1 }], { history, scanDepth: 3 }))).toEqual([]);
  });

  it('gives a depth-0 entry only the recursion text, and leaves constants alone', () => {
    const chain = [
      entry({ content: '용의 둥지', keys: ['최근'], insertionOrder: 1 }),
      entry({ content: 'nest', keys: ['둥지', '최근'], scanDepth: 0, insertionOrder: 2 }),
      entry({ content: 'always', constant: true, scanDepth: 0, insertionOrder: 3 }),
    ];
    expect(contents(run(chain, { history }))).toEqual(['용의 둥지', 'always']);
    expect(contents(run(chain, { history, recursiveScanning: true }))).toEqual(['용의 둥지', 'nest', 'always']);
  });
});

describe('activateLore - timed effects', () => {
  const dragon = entry({ content: 'dragon', keys: ['용'] });
  const key = loreEntryKey(dragon);
  const at = (chatLength: number, lastTriggered: Record<string, number> = {}) => ({ chatLength, lastTriggered });

  it('holds a delayed entry until the chat is long enough', () => {
    const delayed = { ...dragon, delay: 5 };
    expect(contents(run([delayed], { history: ['용'], timed: at(4) }))).toEqual([]);
    expect(contents(run([delayed], { history: ['용'], timed: at(5) }))).toEqual(['dragon']);
  });

  it('keeps a sticky entry active without a scan, and does not count it as a trigger', () => {
    const sticky = { ...dragon, sticky: 2 };
    const fresh = run([sticky], { history: ['용'], timed: at(3) });
    expect(fresh.triggered).toEqual([key]);
    // Triggered at 3: active through 5 without its keyword, then it needs one again.
    for (const g of [4, 5]) {
      const carried = run([sticky], { history: ['고요한 밤'], timed: at(g, { [key]: 3 }) });
      expect(contents(carried), `g=${g}`).toEqual(['dragon']);
      expect(carried.triggered).toEqual([]);
    }
    expect(contents(run([sticky], { history: ['고요한 밤'], timed: at(6, { [key]: 3 }) }))).toEqual([]);
    expect(run([sticky], { history: ['용'], timed: at(6, { [key]: 3 }) }).triggered).toEqual([key]);
  });

  it('blocks a cooled-down entry for its window after the sticky one', () => {
    const cooled = { ...dragon, cooldown: 2 };
    expect(contents(run([cooled], { history: ['용'], timed: at(4, { [key]: 3 }) }))).toEqual([]);
    expect(contents(run([cooled], { history: ['용'], timed: at(5, { [key]: 3 }) }))).toEqual([]);
    expect(contents(run([cooled], { history: ['용'], timed: at(6, { [key]: 3 }) }))).toEqual(['dragon']);

    const both = { ...dragon, sticky: 1, cooldown: 1 };
    expect(contents(run([both], { history: [''], timed: at(4, { [key]: 3 }) }))).toEqual(['dragon']);
    expect(contents(run([both], { history: ['용'], timed: at(5, { [key]: 3 }) }))).toEqual([]);
    expect(contents(run([both], { history: ['용'], timed: at(6, { [key]: 3 }) }))).toEqual(['dragon']);
  });

  it('ignores records of a disabled or edited entry', () => {
    const sticky = { ...dragon, sticky: 5 };
    expect(contents(run([{ ...sticky, enabled: false }], { history: [''], timed: at(4, { [key]: 3 }) }))).toEqual([]);
    expect(contents(run([{ ...sticky, content: 'edited' }], { history: [''], timed: at(4, { [key]: 3 }) }))).toEqual(
      [],
    );
  });
});

describe('activateLore - probability', () => {
  it('rolls each fresh trigger, constants included, and records only the ones that pass', () => {
    const entries = [
      entry({ content: 'likely', keys: ['용'], probability: 60, insertionOrder: 1 }),
      entry({ content: 'unlikely', constant: true, probability: 30, insertionOrder: 2 }),
      entry({ content: 'never', keys: ['용'], probability: 0, insertionOrder: 3 }),
      entry({ content: 'sure', keys: ['용'], insertionOrder: 4 }),
    ];
    // 50 < 60 passes, 50 < 30 fails, 0 < 0 fails; `sure` is never rolled.
    const result = run(entries, { history: ['용'], random: sequence(0.5, 0.5, 0) });
    expect(contents(result)).toEqual(['likely', 'sure']);
    expect(result.triggered).toEqual([loreEntryKey(entries[0]!), loreEntryKey(entries[3]!)]);
  });

  it('does not roll a sticky carry-over again', () => {
    const sticky = entry({ content: 'dragon', keys: ['용'], probability: 1, sticky: 3 });
    const result = run([sticky], {
      history: [''],
      timed: { chatLength: 4, lastTriggered: { [loreEntryKey(sticky)]: 3 } },
      random: () => 0.99,
    });
    expect(contents(result)).toEqual(['dragon']);
  });
});

describe('activateLore - inclusion groups', () => {
  const a = entry({ content: 'A', keys: ['용'], group: '날씨', groupWeight: 1, insertionOrder: 1 });
  const b = entry({ content: 'B', keys: ['용'], group: '날씨', groupWeight: 3, insertionOrder: 2 });
  const free = entry({ content: 'free', keys: ['용'], insertionOrder: 3 });

  it('keeps one member per group, drawn by weight', () => {
    // Total weight 4: a roll under 1/4 lands on A, anything above on B.
    expect(contents(run([a, b, free], { history: ['용'], random: () => 0.2 }))).toEqual(['A', 'free']);
    expect(contents(run([a, b, free], { history: ['용'], random: () => 0.3 }))).toEqual(['B', 'free']);
  });

  it('lets a sticky member hold its group', () => {
    const stickyA = { ...a, sticky: 3 };
    const result = run([stickyA, b], {
      history: ['용'],
      timed: { chatLength: 4, lastTriggered: { [loreEntryKey(stickyA)]: 3 } },
      random: () => 0.99,
    });
    expect(contents(result)).toEqual(['A']);
    expect(result.triggered).toEqual([]);
  });

  it('drops an entry that loses any of its groups', () => {
    const both = entry({ content: 'both', keys: ['용'], group: '날씨, 시간', insertionOrder: 1 });
    const time = entry({ content: 'time', keys: ['용'], group: '시간', insertionOrder: 2 });
    // `both` wins 날씨 against A, then loses 시간 to `time`: it leaves, and 날씨 stays empty.
    const result = run([{ ...a, insertionOrder: 0 }, both, time], {
      history: ['용'],
      random: sequence(0.9, 0.9),
    });
    expect(contents(result)).toEqual(['time']);
  });
});

describe('activateLore - triggered keys', () => {
  it('records recursion activations but not entries the budget cut', () => {
    const entries = [
      entry({ content: 'A는 B를 부른다', keys: ['시작'], insertionOrder: 1 }),
      entry({ content: 'B', keys: ['B'], insertionOrder: 2 }),
      entry({ content: 'too long to fit', keys: ['시작'], insertionOrder: 3 }),
    ];
    const result = run(entries, { history: ['시작'], budgetTokens: 12, recursiveScanning: true });
    expect(contents(result)).toEqual(['A는 B를 부른다']);
    expect(result.triggered).toEqual([loreEntryKey(entries[0]!)]);

    const roomy = run(entries.slice(0, 2), { history: ['시작'], recursiveScanning: true });
    expect(roomy.triggered).toEqual(entries.slice(0, 2).map(loreEntryKey));
  });
});
