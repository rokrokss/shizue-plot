/**
 * The `<order N>` repair's judgement, without a database: what the import before
 * 353c976 stored, and which plots that makes ours to rewrite. The run against a
 * database is in api.test.ts ('display-order repair').
 */
import type { DisplayScript } from '@shizue/core';
import { describe, expect, it } from 'vitest';
import { currentDisplayScripts, judgeDisplayOrder, legacyDisplayScripts } from '../src/maintenance/displayOrder.js';

const risu = (customScripts: unknown[]): Record<string, unknown> => ({ risuai: { customScripts } });

/** RisuAI runs beta (3), then alpha (1), then gamma (0). */
const ordered = risu([
  { comment: '', in: 'alpha', out: '<i>A</i>', type: 'editdisplay', ableFlag: true, flag: 'g<order 1>' },
  { comment: '', in: 'beta', out: '<i>B</i>', type: 'editdisplay', ableFlag: true, flag: '<order 3>' },
  { comment: '', in: 'x', out: 'y', type: 'editinput' },
  { comment: '', in: 'gamma', out: '<i>C</i>', type: 'editdisplay' },
]);

/** What the old import stored: RisuAI's numbers, which run lowest first here — alpha, gamma, beta. */
const OLD: DisplayScript[] = [
  { in: 'alpha', out: '<i>A</i>', flags: 'g', order: 1, enabled: true },
  { in: 'beta', out: '<i>B</i>', order: 3, enabled: true },
  { in: 'gamma', out: '<i>C</i>', order: 2, enabled: true },
];

/** Today's: RisuAI's sequence, numbered down it. */
const NOW: DisplayScript[] = [
  { in: 'beta', out: '<i>B</i>', order: 0, enabled: true },
  { in: 'alpha', out: '<i>A</i>', flags: 'g', order: 1, enabled: true },
  { in: 'gamma', out: '<i>C</i>', order: 2, enabled: true },
];

describe('the import before 353c976', () => {
  it('took RisuAI’s numbers as they were, and today’s takes its sequence', () => {
    expect(legacyDisplayScripts(ordered)).toEqual({ scripts: OLD, ordered: true });
    expect(currentDisplayScripts(ordered)).toEqual(NOW);
  });

  it('read an order from `out`, and from the flag field with ableFlag off', () => {
    const card = risu([
      { in: 'a', out: '<order 5>\n<b>a</b>', type: 'editdisplay' },
      { in: 'b', out: '<b>b</b>', type: 'editdisplay', ableFlag: false, flag: 'i<order 9><move_top>' },
    ]);
    expect(legacyDisplayScripts(card)).toEqual({
      scripts: [
        { in: 'a', out: '<b>a</b>', order: 5, enabled: true },
        { in: 'b', out: '<b>b</b>', order: 9, action: 'move_top', enabled: true },
      ],
      ordered: true,
    });
  });

  it('counted an entry without a pattern before dropping it', () => {
    const card = risu([
      { in: '', out: 'nothing', type: 'editdisplay' },
      { in: 'a', out: 'A', type: 'editdisplay' },
    ]);
    expect(legacyDisplayScripts(card)).toEqual({
      scripts: [{ in: 'a', out: 'A', order: 1, enabled: true }],
      ordered: false,
    });
  });
});

describe('which plots are rewritten', () => {
  it('rewrites scripts that are exactly the old import’s, and then finds them current', () => {
    // As jsonb gives them back: its own key order.
    const stored = OLD.map((script) => Object.fromEntries(Object.entries(script).reverse()) as unknown as DisplayScript);
    expect(judgeDisplayOrder(stored, [{}, ordered])).toEqual({ kind: 'fix', scripts: NOW });
    expect(judgeDisplayOrder(NOW, [ordered])).toEqual({ kind: 'current' });
    // Today's import tags them as the member's own, and that is current too — for that member's card.
    const tagged = NOW.map((script) => ({ ...script, memberId: 'member-2' }));
    expect(judgeDisplayOrder(tagged, [{}, ordered], ['member-1', 'member-2'])).toEqual({ kind: 'current' });
    expect(judgeDisplayOrder(tagged, [ordered, {}], ['member-1', 'member-2'])).toEqual({ kind: 'edited' });
  });

  it('leaves scripts the creator changed', () => {
    const edited = OLD.map((script, index) => (index === 0 ? { ...script, out: '<b>A</b>' } : script));
    expect(judgeDisplayOrder(edited, [ordered])).toEqual({ kind: 'edited' });
    // Reordered by hand into RisuAI's sequence, but not as today's import numbers it.
    expect(judgeDisplayOrder([{ ...OLD[1]!, order: 0 }, { ...OLD[0]!, order: 5 }, OLD[2]!], [ordered])).toEqual({
      kind: 'edited',
    });
  });

  it('does not touch a plot whose card has no `<order N>`', () => {
    // An older move script still holds its `g`, which today's import would take
    // away — but that is not this repair's to make.
    const card = risu([{ in: 'hp', out: '<b>hp</b>', type: 'editdisplay', ableFlag: true, flag: 'g<move_top>' }]);
    const old = legacyDisplayScripts(card);
    expect(old.ordered).toBe(false);
    expect(old.scripts).not.toEqual(currentDisplayScripts(card));
    expect(judgeDisplayOrder(old.scripts, [card])).toEqual({ kind: 'unaffected' });
    expect(judgeDisplayOrder(undefined, [ordered])).toEqual({ kind: 'unaffected' });
  });
});
