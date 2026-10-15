/**
 * RisuAI's module behaviours a work's and a reader's modules share: the toggles
 * (`toggles.ts`), the display scripts sorted with the card's by `<order N>`
 * (`orderedWithModules`), the low-level access a call is held to by the trigger
 * that makes it (`triggerLowLevelAccess`), and a module's toggles read at import.
 */
import { describe, expect, it } from 'vitest';
import { normalizeCard } from '../src/card/normalize.js';
import { exportCardV3 } from '../src/card/export.js';
import { parseRisuModule, plotModuleOf } from '../src/card/risuModule.js';
import { orderedWithModules } from '../src/displayScript.js';
import { chatToggleText, groupToggles, isEmptyGroup, parseToggleSyntax } from '../src/toggles.js';
import { cardScripts, triggerLowLevelAccess } from '../src/triggers/index.js';
import type { DisplayScript } from '../src/types.js';
import { buildRisum } from './helpers/risum.js';

describe('toggles', () => {
  it('reads RisuAI’s syntax line by line, as parseToggleSyntax does', () => {
    expect(
      parseToggleSyntax(
        [
          'rain=비 오는 날',
          'mood=기분=select=맑음,흐림,눈',
          'name=이름=text',
          'memo=메모=textarea',
          '=날씨=caption',
          '=캡션 없음=caption=',
          'x==caption',
          '=구분=divider',
          'g=묶음=group',
          '==groupEnd',
          'lonely',
          '=label only',
          'odd=이상한=kind',
        ].join('\n'),
      ),
    ).toEqual([
      { key: 'rain', value: '비 오는 날', options: [] },
      { key: 'mood', value: '기분', type: 'select', options: ['맑음', '흐림', '눈'] },
      { key: 'name', value: '이름', type: 'text', options: [] },
      { key: 'memo', value: '메모', type: 'textarea', options: [] },
      { key: '', value: '날씨', type: 'caption' },
      { key: '', value: '캡션 없음', type: 'caption' },
      // A caption needs its text; a divider and the group marks stand without.
      { key: '', value: '구분', type: 'divider' },
      { key: 'g', value: '묶음', type: 'group' },
      { key: '', value: '', type: 'groupEnd' },
      // An unknown type is a checkbox, as RisuAI keeps only its three.
      { key: 'odd', value: '이상한', options: [] },
    ]);
    expect(parseToggleSyntax('')).toEqual([]);
    expect(parseToggleSyntax(undefined)).toEqual([]);
  });

  it('lays them out as RisuAI’s sidebar does: groups folded, a repeated divider once, an empty group a checkbox', () => {
    const entries = groupToggles(
      parseToggleSyntax(
        ['a=A', '=선=divider', '=선=divider', 'g=묶음=group', 'b=B', 'c=C=select=1,2', '==groupEnd', 'e=빈 묶음=group', '==groupEnd', 'd=D'].join(
          '\n',
        ),
      ),
    );
    expect(entries.map((entry) => [entry.key, entry.type ?? 'checkbox'])).toEqual([
      ['a', 'checkbox'],
      ['', 'divider'],
      ['g', 'group'],
      ['e', 'group'],
      ['d', 'checkbox'],
    ]);
    expect((entries[2] as { children: { key: string }[] }).children.map((child) => child.key)).toEqual(['b', 'c']);
    expect(isEmptyGroup(entries[3]!)).toBe(true);
  });

  it('puts the modules’ toggles first, in their order, then the members’ own', () => {
    const text = chatToggleText([{ toggles: 'w=작품 모듈' }, {}, { toggles: 'r=독자 모듈' }], ['c=카드']);
    expect(parseToggleSyntax(text).map((toggle) => toggle.key)).toEqual(['w', 'r', 'c']);
  });

  it('puts the reader preset’s toggles before the modules’, as RisuAI puts its preset’s', () => {
    const text = chatToggleText([{ toggles: 'w=작품 모듈' }], ['c=카드'], 'p=프리셋');
    expect(parseToggleSyntax(text).map((toggle) => toggle.key)).toEqual(['p', 'w', 'c']);
  });
});

describe('a module’s toggles at import', () => {
  it('keeps customModuleToggle from a .risum and from module JSON, and toggles from a charx’s card', () => {
    const module = { name: '토글 모듈', id: 'x', description: '', customModuleToggle: 'rain=비\nmood=기분=select=a,b' };
    const parsed = parseRisuModule(buildRisum({ module, type: 'risuModule' }));
    expect(parsed.toggles).toBe('rain=비\nmood=기분=select=a,b');
    const json = parseRisuModule(new TextEncoder().encode(JSON.stringify({ ...module, type: 'risuModule' })));
    expect(json.toggles).toBe(module.customModuleToggle);
    expect(plotModuleOf(parsed, { id: 'm', name: 'm', description: '', lorebook: [], assets: [], importedFrom: { fileName: 'f', sha256: 's', importedAt: 't' } }).toggles).toBe(
      module.customModuleToggle,
    );
    expect(parseRisuModule(buildRisum({ module: { ...module, customModuleToggle: '' }, type: 'risuModule' })).toggles).toBeUndefined();
  });
});

describe('display scripts with a module’s', () => {
  const script = (name: string, order: number, rank?: number): DisplayScript => ({
    in: name,
    out: name,
    order,
    enabled: true,
    ...(rank !== undefined ? { rank } : {}),
  });

  it('runs the card’s and then the modules’ as they stand while none names an order', () => {
    expect(orderedWithModules([script('b', 7), script('a', 2)], [[script('m', 0)]]).map((one) => [one.in, one.order])).toEqual([
      ['a', 0],
      ['b', 1],
      ['m', 2],
    ]);
  });

  it('sorts them together, highest first and stably, once any names one — a module’s before the card’s', () => {
    const sorted = orderedWithModules([script('a', 0), script('b', 1, 2)], [[script('m', 0, 5), script('n', 1)]]);
    expect(sorted.map((one) => [one.in, one.order])).toEqual([
      ['m', 0],
      ['b', 1],
      ['a', 2],
      ['n', 3],
    ]);
    // Once more with another module is what one pass over all of them gives.
    const again = orderedWithModules(sorted, [[script('r', 0, 3)]]);
    expect(again.map((one) => one.in)).toEqual(
      orderedWithModules([script('a', 0), script('b', 1, 2)], [[script('m', 0, 5), script('n', 1)], [script('r', 0, 3)]]).map(
        (one) => one.in,
      ),
    );
  });

  it('keeps a card’s ranks through its export while they agree with the sequence, and drops them once moved', () => {
    const card = normalizeCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '카드',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '1.0',
        extensions: {
          risuai: {
            customScripts: [
              { in: 'a', out: 'A', type: 'editdisplay', ableFlag: true, flag: 'g' },
              { in: 'b', out: 'B', type: 'editdisplay', ableFlag: true, flag: 'g<order 2>' },
            ],
          },
        },
      },
    });
    expect(card.displayScripts?.map((one) => [one.in, one.order, one.rank])).toEqual([
      ['b', 0, 2],
      ['a', 1, undefined],
    ]);
    expect(normalizeCard(exportCardV3(card)).displayScripts).toEqual(card.displayScripts);
    // The creator ran `a` first: RisuAI's sort by the old ranks would not, so none go out.
    const moved = { ...card, displayScripts: card.displayScripts!.map((one) => ({ ...one, order: one.in === 'a' ? 0 : 1 })) };
    expect(normalizeCard(exportCardV3(moved)).displayScripts?.map((one) => [one.in, one.rank])).toEqual([
      ['a', undefined],
      ['b', undefined],
    ]);
  });
});

describe('low-level access, held to the trigger that calls', () => {
  const lua = (comment: string) => ({ comment, type: 'manual', conditions: [], effect: [{ type: 'triggerlua', code: '' }] });
  const card = (lowLevelAccess: boolean) => ({ extensions: { risuai: { triggerscript: [lua('카드')], lowLevelAccess } } });

  it('answers by the trigger’s own flag — the card’s on the card’s, a module’s on the module’s', () => {
    const scripts = cardScripts(card(false), [{ regex: [], trigger: [lua('모듈')], lowLevelAccess: true }])!;
    // The whole may ask; the card's own trigger may not.
    expect(scripts.lowLevelAccess).toBe(true);
    expect(triggerLowLevelAccess(scripts, 0)).toBe(false);
    expect(triggerLowLevelAccess(scripts, 1)).toBe(true);
    expect(triggerLowLevelAccess(scripts, 2)).toBe(false);
    expect(triggerLowLevelAccess(scripts, -1)).toBe(false);
    // A call naming no trigger is held to the card — which, beside a module, nothing says.
    expect(triggerLowLevelAccess(scripts, undefined)).toBe(false);
  });

  it('answers by the card where no module joined it', () => {
    const open = cardScripts(card(true))!;
    expect(triggerLowLevelAccess(open, 0)).toBe(true);
    expect(triggerLowLevelAccess(open, undefined)).toBe(true);
    expect(triggerLowLevelAccess(cardScripts(card(false))!, 0)).toBe(false);
  });
});
