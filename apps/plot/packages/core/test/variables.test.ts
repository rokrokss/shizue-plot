import { describe, expect, it } from 'vitest';
import { applyMacros } from '../src/macro.js';
import {
  applyVariableDelta,
  checkVariableDelta,
  computeVariables,
  diffVariables,
  emptyVariables,
  fitVariableDelta,
  MAX_DELTA_KEYS,
  MAX_VARIABLE_NAME_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  readVariable,
  parseDefaultVariables,
  resolveGetVars,
  serializeDefaultVariables,
  stripVariableMacros,
  type FoldItem,
} from '../src/variables.js';

describe('computeVariables', () => {
  it('folds setvar over the branch, last write winning', () => {
    expect(computeVariables(['{{setvar::hp::50}}', '중간', '{{setvar::hp::40}}'])).toEqual({ hp: '40' });
  });

  it('adds and subtracts with addvar', () => {
    expect(computeVariables(['{{setvar::hp::50}}', '{{addvar::hp::-12}}', '{{addvar::hp::2}}'])).toEqual({
      hp: '40',
    });
  });

  it('treats an unset or non-numeric variable as zero for addvar', () => {
    expect(computeVariables(['{{addvar::gold::5}}'])).toEqual({ gold: '5' });
    expect(computeVariables(['{{setvar::gold::많음}}', '{{addvar::gold::5}}'])).toEqual({ gold: '5' });
  });

  it('trims float noise instead of printing it', () => {
    expect(computeVariables(['{{addvar::x::0.1}}', '{{addvar::x::0.2}}'])).toEqual({ x: '0.3' });
  });

  it('starts from the defaults and lets the branch override them', () => {
    expect(computeVariables(['{{addvar::hp::-10}}'], { hp: '100', name: '아리아' })).toEqual({
      hp: '90',
      name: '아리아',
    });
  });

  it('is case-insensitive and tolerates spacing', () => {
    expect(computeVariables(['{{ SetVar :: hp :: 7 }}'])).toEqual({ hp: ' 7 ' });
  });

  it('keeps a value containing the argument separator', () => {
    expect(computeVariables(['{{setvar::note::a::b}}'])).toEqual({ note: 'a::b' });
  });

  it('skips malformed macros rather than throwing', () => {
    expect(computeVariables(['{{setvar::::1}}', '{{addvar::hp::많이}}', '{{setvar::hp}}'])).toEqual({});
    expect(computeVariables(['{{setvar::hp::5}}', '{{addvar::hp::많이}}'])).toEqual({ hp: '5' });
  });

  it('folds onto a map that was already folded, which is what lets the chat do it a token at a time', () => {
    const branch = ['{{setvar::hp::50}}', '{{addvar::hp::-10}}', '{{addvar::hp::-5}} {{setvar::mood::평온}}'];
    const defaults = { hp: '100', gold: '3' };

    const wholesale = computeVariables(branch, defaults);
    const incremental = computeVariables(
      branch.slice(2),
      computeVariables(branch.slice(0, 2), defaults),
    );
    expect(incremental).toEqual(wholesale);
    expect(wholesale).toEqual({ hp: '35', gold: '3', mood: '평온' });
  });

  it('reads several macros out of one message, in order', () => {
    expect(computeVariables(['{{setvar::hp::10}} 그리고 {{addvar::hp::5}}'])).toEqual({ hp: '15' });
  });

  it('counts up and down with incvar and decvar, in the order written', () => {
    expect(computeVariables(['{{incvar::n}}{{IncVar :: n }}', '{{setvar::n::10}} {{decvar::n}}'])).toEqual({ n: '9' });
    expect(computeVariables(['{{incvar::n}} {{setvar::n::10}}'])).toEqual({ n: '10' });
    expect(computeVariables(['{{decvar::x}}'])).toEqual({ x: '-1' });
  });

  it('counts a value that is not a number as zero for incvar, as addvar does', () => {
    expect(computeVariables(['{{setvar::m::많음}}', '{{incvar::m}}'])).toEqual({ m: '1' });
  });

  it('skips an incvar without a key or with an argument it does not take', () => {
    expect(computeVariables(['{{incvar::}}', '{{incvar::n::5}}', '{{decvar}}'])).toEqual({});
  });
});

describe('computeVariables with macros nested in a value', () => {
  it('evaluates the value against the variables the branch holds at that point', () => {
    expect(computeVariables(['{{setvar::hp::10}}', '{{setvar::hp::{{calc::{{getvar::hp}}-3}}}}'])).toEqual({
      hp: '7',
    });
    expect(computeVariables(['{{setvar::hp::{{? $hp - 3}}}}'], { hp: '10' })).toEqual({ hp: '7' });
    expect(
      computeVariables(['{{setvar::total::{{sum::{{getvar::a}}::{{getvar::b}}}}}}'], { a: '2', b: '0.5' }),
    ).toEqual({ a: '2', b: '0.5', total: '2.5' });
    expect(computeVariables(['{{setvar::low::{{less::{{getvar::hp}}::5}}}}'], { hp: '3' })).toEqual({
      hp: '3',
      low: '1',
    });
  });

  it('sees what an earlier macro of the same message set', () => {
    expect(computeVariables(['{{setvar::hp::10}} 그리고 {{setvar::hp::{{? $hp * 2}}}}'])).toEqual({ hp: '20' });
    expect(computeVariables(['{{setvar::a::1}}{{setvar::b::{{getvar::a}}}}{{setvar::a::2}}'])).toEqual({
      a: '2',
      b: '1',
    });
  });

  it('evaluates a nested delta, and a nested key', () => {
    expect(computeVariables(['{{addvar::hp::{{getvar::damage}}}}'], { hp: '10', damage: '-4' })).toEqual({
      hp: '6',
      damage: '-4',
    });
    expect(computeVariables(['{{incvar::{{getvar::target}}}}'], { target: 'gold' })).toEqual({
      target: 'gold',
      gold: '1',
    });
  });

  it('reads an unset variable as RisuAI writes it, null', () => {
    expect(computeVariables(['{{setvar::name::[{{getvar::nobody}}]}}'])).toEqual({ name: '[null]' });
  });

  it('stores a macro it does not know as written, as RisuAI does', () => {
    expect(computeVariables(['{{setvar::greeting::{{user}}님, {{getvar::hp}}}}'], { hp: '5' })).toEqual({
      hp: '5',
      greeting: '{{user}}님, 5',
    });
  });

  it('folds onto a map that was already folded the same way it folds the whole branch', () => {
    const branch = ['{{setvar::hp::50}}', '{{setvar::hp::{{calc::{{getvar::hp}}-10}}}}', '{{addvar::hp::{{getvar::hp}}}}'];
    const wholesale = computeVariables(branch);
    expect(computeVariables(branch.slice(1), computeVariables(branch.slice(0, 1)))).toEqual(wholesale);
    expect(wholesale).toEqual({ hp: '80' });
  });

  it('takes a name that belongs to Object.prototype through a nested value too', () => {
    const variables = computeVariables(['{{setvar::constructor::{{getvar::toString}}!}}'], { toString: '가치' });
    expect(readVariable(variables, 'constructor')).toBe('가치!');
  });

  it('rolls the same way every time the branch is replayed', () => {
    const branch = ['{{setvar::mood::{{random::기쁨::슬픔::분노::평온}}}} {{setvar::dice::{{roll::d20}}}}'];
    const first = computeVariables(branch);
    expect(['기쁨', '슬픔', '분노', '평온']).toContain(first['mood']);
    expect(Number(first['dice'])).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 5; i += 1) expect(computeVariables(branch)).toEqual(first);
  });

  it('stops a value that keeps doubling instead of taking the chat down with it', () => {
    const doubling = '{{setvar::x::{{getvar::x}}{{getvar::x}}}}';
    const branch = ['{{setvar::x::ab}}', ...Array.from({ length: 40 }, () => doubling), '{{setvar::done::1}}'];
    const variables = computeVariables(branch);
    expect(variables['x']!.length).toBeLessThanOrEqual(100_000);
    expect(variables['x']!.length).toBeGreaterThan(50_000);
    expect(variables['done']).toBe('1');
  });
});

describe('computeVariables inside a block', () => {
  it('runs only the branch the condition takes', () => {
    const branch = ['{{#if {{? $hp < 5}}}}{{setvar::state::위험}}{{:else}}{{setvar::state::안정}}{{/if}}'];
    expect(computeVariables(branch, { hp: '3' })['state']).toBe('위험');
    expect(computeVariables(branch, { hp: '10' })['state']).toBe('안정');
  });

  it('decides the condition with what the same message set before it', () => {
    expect(
      computeVariables(['{{setvar::hp::0}}{{#if {{equal::{{getvar::hp}}::0}}}}{{setvar::dead::1}}{{/if}}']),
    ).toEqual({ hp: '0', dead: '1' });
  });

  it('reads RisuAI #when and SillyTavern if the same way', () => {
    const routes = '{{#when::route::vis::1}}{{setvar::hp::10}}{{/when}}{{#when::route::vis::6}}{{setvar::hp::60}}{{/when}}';
    expect(computeVariables([routes], { route: '6' })['hp']).toBe('60');
    expect(computeVariables(['{{if .flag}}{{incvar::n}}{{else}}{{decvar::n}}{{/if}}'], { flag: '1' })['n']).toBe('1');
    expect(computeVariables(['{{if .flag}}{{incvar::n}}{{else}}{{decvar::n}}{{/if}}'])['n']).toBe('-1');
  });
});

describe('names that belong to Object.prototype', () => {
  /**
   * Every one of these arrives in practice — a model writes `{{setvar::state::…}}`
   * one turn and `{{setvar::constructor::…}}` the next, and a public card's
   * greeting reaches every reader. On an ordinary object `toString` resolves to a
   * function the fold then tries to trim, and `__proto__` is swallowed whole on
   * assignment. Neither may be a way to break a chat.
   */
  const NAMES = ['toString', 'valueOf', 'hasOwnProperty', '__proto__', 'constructor'];

  it('stores one with setvar and reads it back', () => {
    for (const name of NAMES) {
      const variables = computeVariables([`{{setvar::${name}::가치}}`]);
      expect(readVariable(variables, name), name).toBe('가치');
      expect(Object.keys(variables), name).toEqual([name]);
    }
  });

  it('counts one with addvar instead of throwing', () => {
    for (const name of NAMES) {
      const variables = computeVariables([`{{addvar::${name}::1}}`, `{{addvar::${name}::2}}`]);
      expect(readVariable(variables, name), name).toBe('3');
    }
  });

  it('takes one as a default, even from a card object that has a prototype', () => {
    for (const name of NAMES) {
      // What jsonb hands back: an ordinary object, not one of ours.
      const defaults = JSON.parse(`{"${name}": "7"}`) as Record<string, string>;
      expect(readVariable(computeVariables([], defaults), name), name).toBe('7');
      expect(
        readVariable(computeVariables([`{{addvar::${name}::1}}`], defaults), name),
        name,
      ).toBe('8');
    }
  });

  it('resolves one through getvar', () => {
    for (const name of NAMES) {
      const variables = computeVariables([`{{setvar::${name}::가치}}`]);
      expect(resolveGetVars(`[{{getvar::${name}}}]`, variables), name).toBe('[가치]');
      expect(applyMacros(`{{getvar::${name}}}`, { char: 'a', user: 'b', variables }), name).toBe('가치');
    }
  });

  it('inherits nothing, so an unset name reads as unset', () => {
    const variables = computeVariables(['{{setvar::hp::1}}']);
    expect(Object.getPrototypeOf(variables)).toBeNull();
    for (const name of NAMES) {
      expect(readVariable(variables, name), name).toBeUndefined();
      expect(resolveGetVars(`{{getvar::${name}}}`, variables), name).toBe('');
    }
  });

  it('reads safely even from a map it did not build', () => {
    expect(readVariable({}, 'toString')).toBeUndefined();
    expect(readVariable({ toString: '1' }, 'toString')).toBe('1');
    expect(Object.getPrototypeOf(emptyVariables())).toBeNull();
  });

  it('parses one out of a card default block', () => {
    const parsed = parseDefaultVariables('toString=1\n__proto__=2')!;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(readVariable(parsed, 'toString')).toBe('1');
    expect(readVariable(parsed, '__proto__')).toBe('2');
  });
});

describe('stripVariableMacros', () => {
  it('drops setvar and addvar but nothing else', () => {
    expect(stripVariableMacros('앞 {{setvar::hp::1}}{{addvar::hp::1}} 뒤 {{img::a}}')).toBe(
      '앞  뒤 {{img::a}}',
    );
  });

  it('drops incvar and decvar too, and leaves one it would not fold', () => {
    expect(stripVariableMacros('앞{{incvar::n}}{{ DecVar :: n }}뒤 {{incvar::n::5}}')).toBe('앞뒤 {{incvar::n::5}}');
  });

  it('drops one with a nested value whole, and nothing around it', () => {
    expect(stripVariableMacros('앞 {{setvar::hp::{{calc::{{getvar::hp}}-3}}}} 뒤 {{getvar::hp}}}}')).toBe(
      '앞  뒤 {{getvar::hp}}}}',
    );
  });

  it('drops one in either branch of a block, and leaves the block', () => {
    expect(stripVariableMacros('{{#if {{getvar::x}}}}가{{setvar::x::1}}{{:else}}나{{addvar::y::2}}{{/if}}')).toBe(
      '{{#if {{getvar::x}}}}가{{:else}}나{{/if}}',
    );
  });

  it('reads a name and its arguments the way the fold does, so the two always agree', () => {
    // The evaluator's reading: case, `_` and spaces ignored, and `:` separating
    // where the author never wrote `::`.
    expect(computeVariables(['{{SET_VAR:hp:3}}'])).toEqual({ hp: '3' });
    expect(stripVariableMacros('앞{{SET_VAR:hp:3}}뒤')).toBe('앞뒤');
  });

  it('leaves one that was never closed as written', () => {
    expect(stripVariableMacros('앞 {{setvar::x::{{getvar::y}} 뒤')).toBe('앞 {{setvar::x::{{getvar::y}} 뒤');
  });
});

describe('resolveGetVars', () => {
  it('substitutes known keys and blanks unknown ones', () => {
    expect(resolveGetVars('HP {{getvar::hp}}/{{getvar::max}}', { hp: '40' })).toBe('HP 40/');
  });
});

describe('applyMacros with variables', () => {
  it('resolves getvar while leaving setvar in place for the model to see', () => {
    expect(
      applyMacros('{{getvar::hp}} {{setvar::hp::9}}', { char: 'a', user: 'b', variables: { hp: '3' } }),
    ).toBe('3 {{setvar::hp::9}}');
  });

  it('leaves getvar alone when there is no chat to derive variables from', () => {
    expect(applyMacros('{{getvar::hp}}', { char: 'a', user: 'b' })).toBe('{{getvar::hp}}');
  });

  it('still leaves image references alone', () => {
    expect(applyMacros('{{img::smile}}', { char: 'a', user: 'b', variables: {} })).toBe('{{img::smile}}');
  });
});

describe('defaultVariables serialization', () => {
  it('parses RisuAI key=value blocks', () => {
    expect(parseDefaultVariables('hp=100\nname=아리아\n\nbroken')).toEqual({ hp: '100', name: '아리아' });
  });

  it('parses an object too, which is what our own editor stores', () => {
    expect(parseDefaultVariables({ hp: '100', bad: 3 })).toEqual({ hp: '100' });
  });

  it('is undefined when there is nothing to seed', () => {
    expect(parseDefaultVariables('')).toBeUndefined();
    expect(parseDefaultVariables({})).toBeUndefined();
    expect(parseDefaultVariables(undefined)).toBeUndefined();
  });

  it('round-trips through the block form', () => {
    const variables = { hp: '100', mood: '평온' };
    expect(parseDefaultVariables(serializeDefaultVariables(variables))).toEqual(variables);
  });
});

describe('script deltas in the fold', () => {
  it("lays a message's delta over its own macros, a null unsetting", () => {
    expect(
      computeVariables(
        [{ content: '{{setvar::hp::50}}{{setvar::flag::1}}', variableDelta: { hp: '7', mood: '좋음', flag: null } }],
        { route: '1' },
      ),
    ).toEqual({ route: '1', hp: '7', mood: '좋음' });
    // A default the scripts unset is gone too.
    expect(computeVariables([{ content: '', variableDelta: { route: null } }], { route: '1' })).toEqual({});
  });

  it('folds the next message on top of the delta, not under it', () => {
    expect(
      computeVariables([{ content: '안녕', variableDelta: { hp: '10' } }, '{{addvar::hp::5}}']),
    ).toEqual({ hp: '15' });
  });

  it('keeps a delta on its own node: a sibling, and a regenerate of it, never see it', () => {
    const root = { content: '문 앞이다', variableDelta: null };
    const user = { content: '{{setvar::hp::90}} 문을 연다' };
    const replyWithScripts = { content: '삐걱', variableDelta: { door: 'open', hp: '80' } };
    const sibling = { content: '잠겨 있다' };

    expect(computeVariables([root, user, replyWithScripts])).toEqual({ hp: '80', door: 'open' });
    expect(computeVariables([root, user, sibling])).toEqual({ hp: '90' });
    // What a regenerate generates from: the branch without the head it replaces.
    expect(computeVariables([root, user])).toEqual({ hp: '90' });
  });

  it('takes a delta on the greeting root over the plot defaults, as a click on an opening leaves one', () => {
    expect(
      computeVariables([{ content: '{{setvar::hp::100}}어서 와', variableDelta: { route: '2' } }], {
        route: '1',
      }),
    ).toEqual({ route: '2', hp: '100' });
  });

  it('folds onto an already folded map exactly as it folds the whole branch', () => {
    const branch: FoldItem[] = [
      { content: '{{setvar::hp::50}}', variableDelta: { gold: '3' } },
      { content: '{{addvar::hp::-10}}', variableDelta: null },
      { content: '{{addvar::gold::2}}', variableDelta: { hp: null, mood: '평온' } },
    ];
    const defaults = { hp: '100' };
    expect(computeVariables(branch.slice(1), computeVariables(branch.slice(0, 1), defaults))).toEqual(
      computeVariables(branch, defaults),
    );
    expect(computeVariables(branch, defaults)).toEqual({ gold: '5', mood: '평온' });
  });

  it('stores names that belong to Object.prototype, as parsed JSON hands them over', () => {
    const variableDelta = JSON.parse('{"__proto__":"1","constructor":"2","toString":null}') as Record<
      string,
      string | null
    >;
    const variables = computeVariables([{ content: '', variableDelta }], { toString: 'x' });
    expect(Object.getPrototypeOf(variables)).toBeNull();
    expect(readVariable(variables, '__proto__')).toBe('1');
    expect(readVariable(variables, 'constructor')).toBe('2');
    expect(readVariable(variables, 'toString')).toBeUndefined();
  });

  it('ignores a stored value that is neither a string nor null', () => {
    const variableDelta = JSON.parse('{"hp": 5, "mood": "좋음"}') as Record<string, string | null>;
    expect(computeVariables([{ content: '', variableDelta }], { hp: '1' })).toEqual({ hp: '1', mood: '좋음' });
  });

  it('is absolute, so laying the same delta twice changes nothing', () => {
    const item = { content: '{{addvar::hp::5}}', variableDelta: { hp: '1', gone: null } };
    const once = computeVariables([item], { hp: '10', gone: 'x' });
    expect(applyVariableDelta(once, item.variableDelta)).toEqual(once);
  });

  it('reproduces where the scripts ended whatever order they ran in around the macros', () => {
    // RisuAI runs input triggers before the message exists, so a `{{setvar}}`
    // reading the same key sees the trigger's write — the order a fold of the
    // macros alone cannot know. The browser stores the difference instead.
    const parent = { x: '0' };
    const content = '{{setvar::x::{{getvar::x}}!}}';
    const afterInputTrigger = { ...parent, x: 'trig' };
    const afterMacros = computeVariables([content], afterInputTrigger);
    const final = { ...afterMacros, y: 'start' };
    const variableDelta = diffVariables(final, computeVariables([content], parent));

    expect(variableDelta).toEqual({ x: 'trig!', y: 'start' });
    expect(computeVariables([{ content, variableDelta }], parent)).toEqual(final);
  });
});

describe('diffVariables and applyVariableDelta', () => {
  it('round-trips: the diff laid over its base is the target', () => {
    const base = { hp: '10', gold: '3', mood: '평온' };
    const target = { hp: '7', gold: '3', door: 'open' };
    const delta = diffVariables(target, base);
    expect(delta).toEqual({ hp: '7', door: 'open', mood: null });
    expect(applyVariableDelta(base, delta)).toEqual(target);
  });

  it('is null for two maps that say the same thing', () => {
    expect(diffVariables({ a: '1' }, { a: '1' })).toBeNull();
    expect(diffVariables({}, {})).toBeNull();
  });

  it('touches neither input', () => {
    const base = { hp: '10' };
    const next = applyVariableDelta(base, { hp: null, gold: '1' });
    expect(base).toEqual({ hp: '10' });
    expect(next).toEqual({ gold: '1' });
    expect(Object.getPrototypeOf(next)).toBeNull();
  });
});

describe('checkVariableDelta', () => {
  it('reads strings and nulls into a map without a prototype', () => {
    const check = checkVariableDelta(JSON.parse('{"hp":"7","__proto__":null}'));
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(Object.getPrototypeOf(check.delta)).toBeNull();
    expect(Object.keys(check.delta!)).toEqual(['hp', '__proto__']);
    expect(readVariable(check.delta as Record<string, string>, '__proto__')).toBeNull();
  });

  it('takes null, nothing and an empty object as no delta', () => {
    expect(checkVariableDelta(null)).toEqual({ ok: true, delta: null });
    expect(checkVariableDelta(undefined)).toEqual({ ok: true, delta: null });
    expect(checkVariableDelta({})).toEqual({ ok: true, delta: null });
  });

  it('refuses anything else, and anything past the caps', () => {
    const refused = (value: unknown): boolean => !checkVariableDelta(value).ok;
    expect(refused([])).toBe(true);
    expect(refused('hp=1')).toBe(true);
    expect(refused({ hp: 1 })).toBe(true);
    expect(refused({ hp: { nested: '1' } })).toBe(true);
    expect(refused({ '': '1' })).toBe(true);
    expect(refused({ ['k'.repeat(MAX_VARIABLE_NAME_LENGTH + 1)]: '1' })).toBe(true);
    expect(refused({ hp: 'v'.repeat(MAX_VARIABLE_VALUE_LENGTH + 1) })).toBe(true);
    expect(refused({ 'h\u0000p': '1' })).toBe(true);
    expect(refused({ hp: 'a\u0000b' })).toBe(true);
    expect(
      refused(Object.fromEntries(Array.from({ length: MAX_DELTA_KEYS + 1 }, (_, i) => [`k${i}`, '1']))),
    ).toBe(true);
    // Every entry within its own cap, the whole past the total.
    const wide = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v'.repeat(MAX_VARIABLE_VALUE_LENGTH)]),
    );
    expect(refused(wide)).toBe(true);
  });

  it('holds a map to the limits it is given', () => {
    expect(checkVariableDelta({ a: '1', b: '2' }, { keys: 1, chars: 100 }).ok).toBe(false);
    expect(checkVariableDelta({ a: '12345' }, { keys: 5, chars: 5 }).ok).toBe(false);
    expect(checkVariableDelta({ a: '1234' }, { keys: 5, chars: 5 }).ok).toBe(true);
  });

  it('takes the hundreds of writes a Realm card makes in one turn', () => {
    // 치트용사's first reply sets 370-odd; the old cap of 512 refused a delta past it whole.
    const turn = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`status_${i}`, `값 ${i}`]));
    expect(checkVariableDelta(turn)).toMatchObject({ ok: true });
  });
});

describe('fitVariableDelta', () => {
  it('keeps every write that fits, and drops nothing when all do', () => {
    const turn = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`status_${i}`, `값 ${i}`]));
    const fitted = fitVariableDelta(turn);
    expect(fitted.dropped).toBe(0);
    expect(fitted.reason).toBeUndefined();
    expect(Object.keys(fitted.delta!)).toHaveLength(600);
    expect(Object.getPrototypeOf(fitted.delta)).toBeNull();
    expect(fitVariableDelta(null)).toEqual({ delta: null, dropped: 0 });
  });

  it('leaves out only the writes past a limit, in the order they were made, and says why', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_DELTA_KEYS + 3 }, (_, i) => [`k${i}`, '1']));
    const fitted = fitVariableDelta(many);
    expect(fitted.dropped).toBe(3);
    expect(fitted.reason).toBe(`may hold at most ${MAX_DELTA_KEYS} variables`);
    expect(Object.keys(fitted.delta!)).toEqual(Object.keys(many).slice(0, MAX_DELTA_KEYS));
    // What it keeps is a delta the API takes.
    expect(checkVariableDelta(fitted.delta)).toMatchObject({ ok: true });
  });

  it('drops a bad write on its own, and keeps an unset wherever its name fits', () => {
    const fitted = fitVariableDelta(
      {
        hp: '7',
        ['k'.repeat(MAX_VARIABLE_NAME_LENGTH + 1)]: '1',
        big: 'v'.repeat(30),
        gone: null,
        'h\u0000p': '1',
        mp: '3',
      },
      { keys: 10, chars: 20 },
    );
    // `big` would pass the size; `gone` (4) and `mp` (3) still fit after it.
    expect(fitted.delta).toEqual({ hp: '7', gone: null, mp: '3' });
    expect(fitted.dropped).toBe(3);
    expect(fitted.reason).toBe(`variable names must be 1 to ${MAX_VARIABLE_NAME_LENGTH} characters`);
  });

  it('answers with no delta when nothing fits', () => {
    expect(fitVariableDelta({ hp: 'a\u0000b' })).toEqual({ delta: null, dropped: 1, reason: 'must not contain U+0000' });
  });
});

describe('computeVariables - names, setdefaultvar and #each', () => {
  it('stores {{user}} and {{char}} as the names it is given, and as written without them', () => {
    const text = '{{setvar::who::{{user}}와 {{char}}, <bot>}}';
    expect(computeVariables([text])).toEqual({ who: '{{user}}와 {{char}}, <bot>' });
    expect(computeVariables([text], {}, { user: '민준', char: '서리 골짜기' })).toEqual({
      who: '민준와 서리 골짜기, 서리 골짜기',
    });
  });

  it("sets with {{setdefaultvar}} only what is unset, empty or RisuAI's null", () => {
    const text = '{{setdefaultvar::a::1}}{{setdefaultvar::b::1}}{{setdefaultvar::c::1}}{{setdefaultvar::d::1}}';
    expect(computeVariables([text], { b: '', c: 'null', d: '7' })).toEqual({ a: '1', b: '1', c: '1', d: '7' });
  });

  it('runs the variable macros of an #each body once per item', () => {
    expect(computeVariables(['{{#each [1,2,3] as n}}{{addvar::sum::{{slot::n}}}}{{/each}}'])).toEqual({ sum: '6' });
    expect(computeVariables(['{{#each list}}{{addvar::count::1}}{{/each}}'], { list: 'a, b' })).toEqual({
      list: 'a, b',
      count: '2',
    });
  });

  it('stops an #each that runs away, keeping what folded before it', () => {
    const variables = computeVariables(['{{setvar::a::1}}{{#each {{range::[5000]}} as n}}{{incvar::n}}{{/each}}']);
    expect(variables['a']).toBe('1');
    expect(Number(variables['n'])).toBeLessThanOrEqual(1_000);
  });

  it('strips {{setdefaultvar}} from a screen like the rest', () => {
    expect(stripVariableMacros('앞{{setdefaultvar::a::1}}뒤')).toBe('앞뒤');
  });
});
