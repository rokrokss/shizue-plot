import { describe, expect, it } from 'vitest';
import { applyMacros } from '../src/macro.js';
import {
  computeVariables,
  emptyVariables,
  readVariable,
  parseDefaultVariables,
  resolveGetVars,
  serializeDefaultVariables,
  stripVariableMacros,
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
