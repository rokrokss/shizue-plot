/**
 * The companion repair's judgement, without a database: what the plot import
 * before 355e738 left on a work, and which works that makes ours to finish. The
 * run against a database is in api.test.ts ('member-scripts repair').
 */
import { emptyCard, emptyVariables, type DisplayScript, type NormalizedCard, type PlotCustomUi } from '@shizue/core';
import { describe, expect, it } from 'vitest';
import { judgeMemberScripts, legacyCustomUiOfCard, type RepairMember } from '../src/maintenance/memberScripts.js';

const script = (name: string, order: number, memberId?: string): DisplayScript => ({
  in: `\\[${name}\\]`,
  out: `<div class="${name}">$&</div>`,
  order,
  enabled: true,
  ...(memberId ? { memberId } : {}),
});

const variables = (entries: Record<string, string>) => Object.assign(emptyVariables(), entries);

/** A card as the import stored it: one display script, and a stylesheet and variables if given. */
function card(name: string, { css, vars }: { css?: string; vars?: Record<string, string> } = {}): NormalizedCard {
  return {
    ...emptyCard(name),
    displayScripts: [script(name, 0)],
    ...(vars ? { defaultVariables: variables(vars) } : {}),
    extensions: css ? { risuai: { backgroundHTML: `<div>${name}</div><style>${css}</style>` } } : {},
  };
}

const member = (id: string, made: NormalizedCard): RepairMember => ({ id, name: made.name, card: made });

const lumi = member('lumi-id', card('lumi', { css: '.lumi { color: red; }', vars: { hp: '100', mood: 'calm' } }));
const nox = member('nox-id', card('nox', { css: '.nox { color: blue; }', vars: { hp: '50', gold: '3' } }));
const ria = member('ria-id', card('ria'));

/** What the plot import before 355e738 stored off lumi: its scripts untagged, its stylesheet the work's. */
const OLD: PlotCustomUi = {
  displayScripts: [script('lumi', 0)],
  css: '.lumi { color: red; }',
  defaultVariables: variables({ hp: '100', mood: 'calm' }),
};

describe('which works are repaired', () => {
  it("lifts the companions' scripts, stylesheets and variables as their own, and leaves the first card's untagged", () => {
    expect(legacyCustomUiOfCard(lumi.card)).toEqual(OLD);
    // As jsonb gives it back: its own key order.
    const stored = Object.fromEntries(Object.entries(OLD).reverse()) as PlotCustomUi;
    const verdict = judgeMemberScripts(stored, [lumi, nox, ria]);
    expect(verdict).toEqual({
      kind: 'fix',
      customUi: {
        // The work's own stays untagged, running on every message; the companions' after it.
        displayScripts: [script('lumi', 0), script('nox', 1, 'nox-id'), script('ria', 2, 'ria-id')],
        css: '.lumi { color: red; }',
        memberCss: { 'nox-id': '.nox { color: blue; }' },
        // One namespace, the work's value kept.
        defaultVariables: variables({ hp: '100', mood: 'calm', gold: '3' }),
      },
      lifted: ['nox-id', 'ria-id'],
      conflicts: [{ member: 'nox', names: ['hp'] }],
    });
    // No companion's background, and nothing left to do once it is stored.
    if (verdict.kind !== 'fix') throw new Error('unreachable');
    expect(verdict.customUi.backgroundHtml).toBeUndefined();
    expect(judgeMemberScripts(verdict.customUi, [lumi, nox, ria])).toEqual({ kind: 'current' });
  });

  it('lifts into a work whose first card brought nothing', () => {
    const plain = member('plain-id', emptyCard('plain'));
    const verdict = judgeMemberScripts(null, [plain, ria]);
    expect(verdict).toMatchObject({ kind: 'fix', customUi: { displayScripts: [script('ria', 0, 'ria-id')] } });
  });

  it('leaves a work whose custom UI changed since the import', () => {
    // The creator's edit to the work's own script.
    const edited = { ...OLD, displayScripts: [{ ...script('lumi', 0), out: '<b>$&</b>' }] };
    expect(judgeMemberScripts(edited, [lumi, nox])).toEqual({ kind: 'edited' });
    // A script added after the import — by the creator, or by an importer — is not the old import's either.
    expect(judgeMemberScripts({ ...OLD, displayScripts: [script('lumi', 0), script('all', 1)] }, [lumi, nox])).toEqual({
      kind: 'edited',
    });
    // Emptied: the first card had a custom UI, and its creator took it off.
    expect(judgeMemberScripts(null, [lumi, nox])).toEqual({ kind: 'edited' });
  });

  it('judges by the member the plot was made of, not by where the roster has moved it', () => {
    // Nox first in creation order: the work's custom UI is not what nox would have made.
    expect(judgeMemberScripts(OLD, [nox, lumi])).toEqual({ kind: 'edited' });
  });

  it("finds today's imports current, and leaves a work shaped since with a companion missing", () => {
    const today: PlotCustomUi = {
      displayScripts: [script('lumi', 0, 'lumi-id'), script('nox', 1, 'nox-id')],
      css: '.lumi { color: red; }',
      memberCss: { 'nox-id': '.nox { color: blue; }' },
      backgroundHtml: '<div>lumi</div>',
    };
    expect(judgeMemberScripts(today, [lumi, nox])).toEqual({ kind: 'current' });
    expect(judgeMemberScripts(today, [lumi, nox, ria])).toEqual({ kind: 'edited' });
    // A card of variables alone is current once the work has every name.
    const counting = member('count-id', { ...emptyCard('count'), defaultVariables: variables({ gold: '1' }) });
    expect(judgeMemberScripts({ ...today, defaultVariables: variables({ gold: '9' }) }, [lumi, nox, counting])).toEqual({
      kind: 'current',
    });
  });

  it('has nothing to do where no companion brings anything', () => {
    expect(judgeMemberScripts(OLD, [lumi, member('plain-id', emptyCard('plain'))])).toEqual({ kind: 'unaffected' });
  });

  it('waits on fix:display-order while the first card still runs in the old order, and lifts after it', () => {
    const risu = {
      risuai: {
        customScripts: [
          { comment: '', in: 'alpha', out: 'A', type: 'editdisplay', ableFlag: true, flag: '<order 1>' },
          { comment: '', in: 'beta', out: 'B', type: 'editdisplay', ableFlag: true, flag: '<order 3>' },
        ],
      },
    };
    /** What the import before 353c976 stored on the card and on the plot: RisuAI's numbers, lowest first. */
    const old: DisplayScript[] = [
      { in: 'alpha', out: 'A', order: 1, enabled: true },
      { in: 'beta', out: 'B', order: 3, enabled: true },
    ];
    const first = member('first-id', { ...emptyCard('first'), displayScripts: old, extensions: risu });
    expect(judgeMemberScripts({ displayScripts: old }, [first, ria])).toEqual({ kind: 'order-first' });
    // What `fix:display-order` leaves: today's sequence.
    const reordered: DisplayScript[] = [
      { in: 'beta', out: 'B', order: 0, enabled: true },
      { in: 'alpha', out: 'A', order: 1, enabled: true },
    ];
    expect(judgeMemberScripts({ displayScripts: reordered }, [first, ria])).toMatchObject({
      kind: 'fix',
      customUi: { displayScripts: [...reordered, script('ria', 2, 'ria-id')] },
    });
  });
});
