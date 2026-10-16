import { describe, expect, it } from 'vitest';
import { activateLore, loreEntryKey, type ActivateLoreInput } from '../src/lorebook.js';
import type { LoreAliases } from '../src/loreAliases.js';
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

  it('pays for the highest insertionOrder first and sends the survivors lowest first', () => {
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
    // RisuAI and the V3 spec: the lowest insertionOrder is the first to go.
    expect(activate(entries, '', 9, countChars).map((e) => e.content)).toEqual(['bbbb', 'cccc']);
    expect(activate(entries, '', 3, countChars)).toEqual([]);
  });

  it('skips an entry that does not fit and keeps trying the rest', () => {
    const entries = [
      entry({ content: 'aaaa', constant: true, insertionOrder: 1 }),
      entry({ content: 'x'.repeat(8), constant: true, insertionOrder: 2 }),
      entry({ content: 'cc', constant: true, insertionOrder: 3 }),
    ];
    // cc (2) fits, the 8 after it does not and is passed over, aaaa (4) still fits.
    expect(activate(entries, '', 6, countChars).map((e) => e.content)).toEqual(['aaaa', 'cc']);
  });

  it('gives an always-on entry no precedence over a keyword entry ranked above it', () => {
    const entries = [
      entry({ content: 'always', constant: true, insertionOrder: 0 }),
      entry({ content: 'dragon', keys: ['용'], insertionOrder: 5 }),
    ];
    expect(activate(entries, '용이 나타났다', 6, countChars).map((e) => e.content)).toEqual(['dragon']);
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

  it('follows a chain until a pass activates nothing new', () => {
    const longer = [
      ...chain,
      entry({ content: 'D는 E를 부른다', keys: ['C 엔트리'], insertionOrder: 4 }),
      entry({ content: 'E 엔트리', keys: ['E를'], insertionOrder: 5 }),
      entry({ content: '고립', keys: ['아무도 부르지 않는 말'], insertionOrder: 6 }),
    ];
    expect(activate(longer, '시작', 1000, countChars, true).map((e) => e.content)).toEqual([
      'A는 B를 부른다',
      'B는 C를 부른다',
      'C 엔트리',
      'D는 E를 부른다',
      'E 엔트리',
    ]);
  });

  it('stops at its pass cap on a chain longer than any book needs', () => {
    // Link i is triggered by ⟨i⟩ and says ⟨i+1⟩: one more link per pass.
    const links = Array.from({ length: 103 }, (_, i) =>
      entry({ content: `⟨${i + 1}⟩`, keys: [`⟨${i}⟩`], insertionOrder: i }),
    );
    const result = activate(links, '⟨0⟩', 10_000, countChars, true);
    // The first pass and a hundred more.
    expect(result).toHaveLength(101);
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

  it('spends one budget on every pass together, after the recursion has run', () => {
    const cost = chain.map((e) => e.content.length);
    // Room for the last two links: A, ranked lowest, is cut — yet its content
    // still triggered B, as it does in RisuAI. The budget does not end the scan.
    const lastTwo = activate(chain, '시작', cost[1]! + cost[2]!, countChars, true);
    expect(lastTwo.map((e) => e.content)).toEqual(['B는 C를 부른다', 'C 엔트리']);
    const lastOne = activate(chain, '시작', cost[1]! + cost[2]! - 1, countChars, true);
    expect(lastOne.map((e) => e.content)).toEqual(['C 엔트리']);
  });
});

describe('activateLore - expanded text', () => {
  // What the caller's macro expansion would make of each entry; the rest read as written.
  const expanded = new Map<string, string>([
    ['{{#if 0}}긴 조건부 설정 블록{{/if}}', ''],
    ['{{getvar::next}}', 'B를 부른다'],
  ]);
  const textOf = (e: LoreEntry): string => expanded.get(e.content) ?? e.content;

  it('charges an entry for its expanded text, so one that comes out empty costs nothing', () => {
    const conditional = '{{#if 0}}긴 조건부 설정 블록{{/if}}';
    const entries = [
      entry({ content: 'bbbb', constant: true, insertionOrder: 1 }),
      entry({ content: conditional, constant: true, insertionOrder: 2 }),
    ];
    const budget = conditional.length;
    // Measured raw, the false block spends the budget the next entry needed.
    expect(activate(entries, '', budget, countChars).map((e) => e.content)).toEqual([conditional]);
    const result = activateLore(entries, {
      history: [''],
      scanDepth: 1,
      budgetTokens: budget,
      countTokens: countChars,
      textOf,
    });
    expect(result.entries.map((e) => e.content)).toEqual(['bbbb', conditional]);
    // The key stays on the raw text, whatever it expanded to this time.
    expect(result.triggered).toContain(loreEntryKey(entries[1]!));
  });

  it('scans the expanded text on a recursive pass', () => {
    const entries = [
      entry({ content: '{{getvar::next}}', keys: ['시작'], insertionOrder: 1 }),
      entry({ content: 'B 엔트리', keys: ['B를'], insertionOrder: 2 }),
      // Only the raw text names it, and the raw text is not what was sent.
      entry({ content: 'getvar 엔트리', keys: ['getvar'], insertionOrder: 3 }),
    ];
    const result = activateLore(entries, {
      history: ['시작'],
      scanDepth: 1,
      budgetTokens: 1000,
      countTokens: countChars,
      recursiveScanning: true,
      textOf,
    });
    expect(result.entries.map((e) => e.content)).toEqual(['{{getvar::next}}', 'B 엔트리']);
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

describe('activateLore - the greeting', () => {
  // The greeting first, as a branch opens on it; only it names the inn.
  const history = ['여관에 온 걸 환영해', '중간', '최근'];
  const inn = entry({ content: 'inn', keys: ['여관'] });

  it("leaves the greeting out of an entry's scan, as RisuAI's does", () => {
    expect(contents(run([inn], { history, greeting: 0, scanDepth: 10 }))).toEqual([]);
    // No greeting named: every message is scanned.
    expect(contents(run([inn], { history, scanDepth: 3 }))).toEqual(['inn']);
  });

  it("scans it for SillyTavern's entries, the greeting counted in their depth", () => {
    const tavern = { ...inn, sillyTavern: true as const };
    expect(contents(run([tavern], { history, greeting: 0, scanDepth: 3 }))).toEqual(['inn']);
    expect(contents(run([tavern], { history, greeting: 0, scanDepth: 2 }))).toEqual([]);
    // The two kinds side by side, each on its own messages.
    expect(run([inn, tavern], { history, greeting: 0, scanDepth: 3 }).entries).toEqual([tavern]);
    // Or whatever the caller says scans it: a member card SillyTavern wrote.
    expect(contents(run([inn], { history, greeting: 0, scanDepth: 3, scansGreeting: () => true }))).toEqual(['inn']);
    expect(contents(run([tavern], { history, greeting: 0, scanDepth: 3, scansGreeting: () => false }))).toEqual([]);
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
    // ST's effect for a trigger at 3 is `{start: 3, end: 3 + 2}`, removed once the
    // chat reaches `end` (`#checkTimedEffectOfType`): active at 4 without its
    // keyword, gone at 5, where it needs one again.
    const carried = run([sticky], { history: ['고요한 밤'], timed: at(4, { [key]: 3 }) });
    expect(contents(carried)).toEqual(['dragon']);
    expect(carried.triggered).toEqual([]);
    expect(contents(run([sticky], { history: ['고요한 밤'], timed: at(5, { [key]: 3 }) }))).toEqual([]);
    expect(run([sticky], { history: ['용'], timed: at(5, { [key]: 3 }) }).triggered).toEqual([key]);
  });

  it('blocks a cooled-down entry for its window after the sticky one', () => {
    // A cooldown alone is set on the trigger, `{start: 3, end: 5}`: off at 4, back at 5.
    const cooled = { ...dragon, cooldown: 2 };
    expect(contents(run([cooled], { history: ['용'], timed: at(4, { [key]: 3 }) }))).toEqual([]);
    expect(contents(run([cooled], { history: ['용'], timed: at(5, { [key]: 3 }) }))).toEqual(['dragon']);

    // Sticky 1 ends at 4 (`{3, 4}` holds at no length), and the scan that sees it
    // end starts the cooldown there (`#onEnded.sticky`, protected): `{4, 5}`.
    const both = { ...dragon, sticky: 1, cooldown: 1 };
    expect(contents(run([both], { history: [''], timed: at(4, { [key]: 3 }) }))).toEqual([]);
    expect(contents(run([both], { history: ['용'], timed: at(4, { [key]: 3 }) }))).toEqual([]);
    expect(contents(run([both], { history: ['용'], timed: at(5, { [key]: 3 }) }))).toEqual(['dragon']);
  });

  it('starts the cooldown at the scan that saw the sticky effect end', () => {
    // Replies at 2, 4, 6, 8: sticky 3 from 2 holds at 4; the scan at 6 ends it
    // and cools the entry for 3 — through 8 — where `2 + 3` would have let 8 in.
    const both = { ...dragon, sticky: 3, cooldown: 3 };
    const branch = (g: number) => ({ ...at(g, { [key]: 2 }), evaluatedAt: [2, 4, 6].filter((x) => x < g) });
    expect(contents(run([both], { history: [''], timed: branch(4) }))).toEqual(['dragon']);
    expect(contents(run([both], { history: ['용'], timed: branch(6) }))).toEqual([]);
    expect(contents(run([both], { history: ['용'], timed: branch(8) }))).toEqual([]);
    expect(contents(run([both], { history: ['용'], timed: { ...branch(10), evaluatedAt: [2, 4, 6, 8] } }))).toEqual([
      'dragon',
    ]);
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
    // The longest, ranked highest, does not fit; the two below it still do.
    const result = run(entries, { history: ['시작'], budgetTokens: 12, recursiveScanning: true });
    expect(contents(result)).toEqual(['A는 B를 부른다', 'B']);
    expect(result.triggered).toEqual([loreEntryKey(entries[0]!), loreEntryKey(entries[1]!)]);
    expect(result.via.has(entries[2]!)).toBe(false);

    const roomy = run(entries.slice(0, 2), { history: ['시작'], recursiveScanning: true });
    expect(roomy.triggered).toEqual(entries.slice(0, 2).map(loreEntryKey));
  });
});

describe('activateLore - RisuAI matching', () => {
  const castle = entry({ content: 'castle', keys: ['마왕 성'] });
  const fires = (e: LoreEntry, text: string, risuMatching: boolean): boolean =>
    run([e], { history: [text], risuMatching }).entries.length === 1;

  it('ignores spaces on both sides, and only with the setting on', () => {
    expect(fires(castle, '마왕성에 도착했다', true)).toBe(true);
    expect(fires({ ...castle, keys: ['마왕성'] }, '마왕 성에 도착했다', true)).toBe(true);
    expect(fires(castle, '마왕성에 도착했다', false)).toBe(false);
    // Only the space character goes, as in RisuAI: a line break still separates.
    expect(fires({ ...castle, keys: ['마왕성'] }, '마왕\n성', true)).toBe(false);
  });

  it('ignores case even on an entry that asks for it', () => {
    const dragon = entry({ content: 'dragon', keys: ['Red Dragon'], caseSensitive: true });
    expect(fires(dragon, 'a reddragon appears', true)).toBe(true);
    expect(fires(dragon, 'a reddragon appears', false)).toBe(false);
  });

  it('applies to secondary keys too', () => {
    const gate = entry({ content: 'gate', keys: ['성문'], secondaryKeys: ['마왕 성'], selective: true });
    expect(fires(gate, '마왕성의 성문', true)).toBe(true);
    expect(fires(gate, '마왕성의 성문', false)).toBe(false);
  });

  it('does not match what a comment macro says', () => {
    expect(fires(castle, '{{// 마왕성 }}평화로운 마을', true)).toBe(false);
    expect(fires(castle, '{{comment::마왕 성}} 평화로운 마을', true)).toBe(false);
    expect(fires(castle, '{{// 메모}} 마왕성', true)).toBe(true);
  });

  it('reads a key of nothing but spaces as no key', () => {
    expect(fires({ ...castle, keys: ['   '] }, '아무 말', true)).toBe(false);
    expect(fires({ ...castle, keys: [''] }, '아무 말', true)).toBe(false);
  });

  it('leaves regex keys to their own terms', () => {
    const regex = entry({ content: 'regex', keys: ['마왕 성'], useRegex: true });
    expect(fires(regex, '마왕성', true)).toBe(false);
    expect(fires(regex, '마왕 성', true)).toBe(true);
  });
});

describe('activateLore - aliases', () => {
  const dumbledore = entry({ content: 'Albus Dumbledore, headmaster', keys: ['Dumbledore'] });
  /** An entry's aliases by the entry: a list stands for its primary keys alone. */
  const aliasesOf =
    (table: Map<LoreEntry, string[] | LoreAliases>) =>
    (candidate: LoreEntry): LoreAliases | undefined => {
      const aliases = table.get(candidate);
      return Array.isArray(aliases) ? { keys: aliases } : aliases;
    };

  it('takes an alias for a primary key, RisuAI-style: case and spaces aside, inside a word with its particle', () => {
    const aliases = aliasesOf(new Map([[dumbledore, ['덤블 도어', 'ALBUS교장']]]));
    expect(contents(run([dumbledore], { history: ['덤블도어가 웃었다'] }))).toEqual([]);
    for (const risuMatching of [false, true]) {
      const hit = run([dumbledore], { history: ['덤블도어가 웃었다'], aliases, risuMatching });
      expect(contents(hit)).toEqual([dumbledore.content]);
      expect(hit.via.get(dumbledore)).toBe('keyword');
      expect(hit.triggered).toHaveLength(1);
    }
    expect(contents(run([dumbledore], { history: ['albus 교장 선생님'], aliases }))).toEqual([dumbledore.content]);
    expect(contents(run([dumbledore], { history: ['교장 선생님'], aliases }))).toEqual([]);
  });

  it("ignores the entry's own regex, case and whole-word settings on both engines", () => {
    const strict = { ...dumbledore, useRegex: true, caseSensitive: true, keys: ['^Dumbledore$'] };
    const tavern = { ...dumbledore, sillyTavern: true as const, matchWholeWords: true, caseSensitive: true };
    const aliases = aliasesOf(
      new Map([
        [strict, ['덤블도어']],
        [tavern, ['덤블도어']],
      ]),
    );
    expect(contents(run([strict], { history: ['덤블도어에게'], aliases }))).toEqual([dumbledore.content]);
    // An entry SillyTavern wrote, in a RisuAI-run book and in a book ST runs.
    expect(contents(run([tavern], { history: ['덤블도어에게'], aliases }))).toEqual([dumbledore.content]);
    const st = run([tavern], { history: ['덤블도어에게'], aliases, sillyTavern: true, matchWholeWords: true });
    expect(contents(st)).toEqual([dumbledore.content]);
    expect(st.via.get(tavern)).toBe('keyword');
    // Its own English key keeps ST's whole-word rule.
    expect(contents(run([tavern], { history: ['Dumbledores'], sillyTavern: true }))).toEqual([]);
  });

  it("takes a secondary key's alias for that secondary key under every selective logic, on both engines", () => {
    const wand = { ...dumbledore, selective: true, secondaryKeys: ['wand', 'robe'] };
    const anyOf = { ...wand, content: 'and_any' };
    const allOf = { ...wand, content: 'and_all', selectiveLogic: 'and_all' as const };
    const noneOf = { ...wand, content: 'not_any', selectiveLogic: 'not_any' as const };
    const notAll = { ...wand, content: 'not_all', selectiveLogic: 'not_all' as const };
    const book = [anyOf, allOf, noneOf, notAll];
    const korean: LoreAliases = { keys: ['덤블도어'], secondary: [['지팡이'], ['로브']] };
    const aliases = aliasesOf(new Map(book.map((candidate) => [candidate, korean])));
    for (const sillyTavern of [false, true]) {
      const active = (line: string) => contents(run(book, { history: [line], aliases, sillyTavern })).sort();
      expect(active('덤블도어가 웃었다')).toEqual(['not_all', 'not_any']);
      expect(active('덤블도어가 지팡이를 들었다')).toEqual(['and_any', 'not_all']);
      expect(active('덤블도어가 지팡이를 들고 로브를 걸쳤다')).toEqual(['and_all', 'and_any']);
      // A secondary key's own spelling still counts beside its alias, under a primary key's own.
      expect(active('Dumbledore의 wand와 로브')).toEqual(['and_all', 'and_any']);
    }
  });

  it('scores a secondary key found by its alias as found, in group scoring', () => {
    const tower = entry({ content: 'A', keys: ['Hogwarts'], selective: true, secondaryKeys: ['tower'], group: 'place', useGroupScoring: true });
    const hall = entry({ content: 'B', keys: ['Hogwarts'], group: 'place', useGroupScoring: true });
    const aliases = aliasesOf(new Map([[tower, { keys: [], secondary: [['천문탑']] }]]));
    // Tied, the draw's first roll would keep the hall.
    for (const sillyTavern of [false, true]) {
      const result = run([hall, tower], { history: ['Hogwarts 천문탑'], aliases, sillyTavern, random: () => 0 });
      expect(contents(result)).toEqual(['A']);
    }
  });

  it('leaves the secondary keys their say, on both engines', () => {
    const selective = { ...dumbledore, selective: true, secondaryKeys: ['wand'] };
    const unless = { ...selective, selectiveLogic: 'not_any' as const };
    const aliases = aliasesOf(
      new Map([
        [selective, ['덤블도어']],
        [unless, ['덤블도어']],
      ]),
    );
    for (const sillyTavern of [false, true]) {
      expect(contents(run([selective], { history: ['덤블도어가 웃었다'], aliases, sillyTavern }))).toEqual([]);
      expect(contents(run([selective], { history: ['덤블도어의 wand'], aliases, sillyTavern }))).toEqual([selective.content]);
      expect(contents(run([unless], { history: ['덤블도어가 웃었다'], aliases, sillyTavern }))).toEqual([unless.content]);
      expect(contents(run([unless], { history: ['덤블도어의 wand'], aliases, sillyTavern }))).toEqual([]);
    }
  });

  it('is found in what recursion adds, and held back by a cooldown, as a key would be', () => {
    const office = entry({ content: '덤블도어의 집무실은 탑 꼭대기에 있다', keys: ['집무실'] });
    const aliases = aliasesOf(new Map([[dumbledore, ['덤블도어']]]));
    for (const sillyTavern of [false, true]) {
      const chained = run([office, dumbledore], { history: ['집무실로 가자'], aliases, recursiveScanning: true, sillyTavern });
      expect(chained.via.get(dumbledore)).toBe('recursion');
    }
    const cooled = { ...dumbledore, cooldown: 3 };
    const timed = { chatLength: 4, lastTriggered: { [loreEntryKey(cooled)]: 3 } };
    const coolAliases = aliasesOf(new Map([[cooled, ['덤블도어']]]));
    for (const sillyTavern of [false, true]) {
      expect(contents(run([cooled], { history: ['덤블도어'], aliases: coolAliases, timed, sillyTavern }))).toEqual([]);
    }
  });

  it('scores an alias hit as one more primary key in group scoring', () => {
    const a = entry({ content: 'A', keys: ['Hogwarts', 'castle'], group: 'place', useGroupScoring: true });
    const b = entry({ content: 'B', keys: ['Hogwarts'], group: 'place', useGroupScoring: true });
    const aliases = aliasesOf(new Map([[b, ['호그와트']]]));
    // Both match Hogwarts; b's alias is the second hit a has no castle for.
    for (const sillyTavern of [false, true]) {
      expect(contents(run([a, b], { history: ['Hogwarts 호그와트'], aliases, sillyTavern }))).toEqual(['B']);
    }
  });
});
