import { describe, expect, it } from 'vitest';
import {
  assetResolver,
  CbsExpressionError,
  CbsSyntaxError,
  evaluateCbs,
  evaluateExpression,
  findAssetMacros,
  parseCbs,
  replaceAssetMacros,
  type CbsHost,
} from '../src/cbs.js';

/** The language alone: variables, and nothing of any host's own. */
const run = (template: string, variables: Record<string, string> = {}, host: CbsHost = {}): string =>
  evaluateCbs(template, parseCbs(template), {
    variable: (name) => (Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : undefined),
    random: () => 0,
    ...host,
  });

describe('parseCbs', () => {
  it('nests macros inside arguments and blocks inside both', () => {
    const [node] = parseCbs('{{img::{{#if {{? $a=1}}}}x_{{/if}}{{getvar::b}}.png}}');
    expect(node?.type).toBe('macro');
    if (node?.type !== 'macro') return;
    expect(node.body.map((child) => child.type)).toEqual(['text', 'block', 'macro', 'text']);
  });

  it('closes a block with its own name or with a bare {{/}}', () => {
    expect(() => parseCbs('{{#if 1}}a{{/}}', { strict: true })).not.toThrow();
    expect(() => parseCbs('{{#when 1}}a{{/when}}', { strict: true })).not.toThrow();
    expect(() => parseCbs('{{#if_pure 1}}a{{/if}}', { strict: true })).not.toThrow();
  });

  it('refuses, when strict, what lenient parsing repairs', () => {
    for (const template of ['{{#if 1}}열림', 'x{{/if}}', '{{#if 1}}x{{/each}}']) {
      expect(() => parseCbs(template, { strict: true }), template).toThrow(CbsSyntaxError);
      expect(() => parseCbs(template), template).not.toThrow();
    }
  });

  it('reads an unclosed {{ and an unopened }} as text, in either mode', () => {
    expect(run('a {{ b }} c}}')).toBe('a {{ b }} c}}');
    expect(() => parseCbs('a {{ b', { strict: true })).not.toThrow();
  });

  it('closes the innermost block with any closer when lenient, as RisuAI does', () => {
    expect(run('{{#if 1}}a{{/each}}b')).toBe('ab');
  });

  it('opens ST {{if}} without the #, and closes it with {{/if}} or {{/}} only', () => {
    const [node] = parseCbs('{{if {{getvar::a}}}}x{{else}}y{{/if}}', { strict: true });
    expect(node?.type === 'block' && node.kind).toBe('st_if');
    expect(() => parseCbs('{{IF:a::b}}x{{/}}', { strict: true })).not.toThrow();
    expect(() => parseCbs('{{if a}}x{{/when}}', { strict: true })).toThrow(CbsSyntaxError);
    // ST's scoped form of another macro is text to it, not the end of the block.
    expect(run('{{if 1}}a{{/setvar}}b{{/if}}')).toBe('a{{/setvar}}b');
  });

  it('leaves ST forms that open nothing as written: the inline {{if::c::then}}, a bare {{if}}', () => {
    expect(run('{{if::1::x}} 그리고 {{if 1}}y{{/if}}')).toBe('{{if::1::x}} 그리고 y');
    expect(run('{{if}}a{{/if}}')).toBe('{{if}}a{{/if}}');
    expect(run('{{if 1}}열림')).toBe('{{if 1}}열림');
    expect(() => parseCbs('{{if 1}}열림', { strict: true })).toThrow(CbsSyntaxError);
  });

  it('reads each dialect’s else in its own blocks only', () => {
    expect(run('{{#if 1}}a{{else}}b{{/if}}')).toBe('a{{else}}b');
    expect(run('{{if 1}}a{{:else}}b{{/if}}')).toBe('a{{:else}}b');
    expect(run('a{{else}}b')).toBe('a{{else}}b');
  });

  it('caps nesting', () => {
    const blocks = (n: number): string => `${'{{#if 1}}'.repeat(n)}x${'{{/if}}'.repeat(n)}`;
    expect(run(blocks(8))).toBe('x');
    expect(() => parseCbs(blocks(9), { strict: true })).toThrow(CbsSyntaxError);
    const macros = `${'{{equal::'.repeat(40)}${'::}}'.repeat(40)}`;
    expect(() => parseCbs(macros, { strict: true })).toThrow(CbsSyntaxError);
    expect(() => parseCbs(macros)).not.toThrow();
  });
});

describe('evaluateCbs - RisuAI functions', () => {
  it('compares as RisuAI does: equal on text, greater and less on numbers', () => {
    expect(run('{{equal::a::a}}{{equal::a::A}}{{notequal::a::b}}{{not_equal::a::a}}')).toBe('1010');
    expect(run('{{greater::10::9}}{{greater_equal::3::3}}{{less::2::10}}{{less_equal::4::3}}')).toBe('1110');
    // Without its second operand a comparison is NaN in RisuAI, which is false.
    expect(run('{{greater::5}}{{equal::a}}{{notequal::a}}')).toBe('001');
  });

  it('reads 1 as the only truth for and, or and not', () => {
    expect(run('{{and::1::1}}{{and::1::true}}{{or::0::1}}{{or::yes::no}}{{not::1}}{{not::0}}')).toBe('101001');
  });

  it('sums arguments, a JSON array or a §-list, counting what is not a number as 0', () => {
    expect(run('{{sum::1::2::x::3.5}}')).toBe('6.5');
    expect(run('{{sum::[1,2,3]}} {{sum::4§5}}')).toBe('6 9');
  });

  it('picks among arguments, a JSON array or one list split on commas and colons', () => {
    const at = (r: number) => ({ random: () => r });
    expect(run('{{random::가::나::다}}', {}, at(0.99))).toBe('다');
    expect(run('{{random:가, 나}}', {}, at(0.6))).toBe('나');
    expect(run('{{random::["x","y"]}}', {}, at(0.6))).toBe('y');
    expect(run('{{random::a\\,b,c}}', {}, at(0))).toBe('a,b');
  });

  it('rolls N, dN and XdY within their bounds, and leaves a silly roll alone', () => {
    expect(run('{{roll::100}}', {}, { random: () => 0.999 })).toBe('100');
    expect(run('{{roll:d20}}', {}, { random: () => 0 })).toBe('1');
    expect(run('{{roll::2d6}}', {}, { random: () => 0.999 })).toBe('12');
    expect(run('{{roll::1000d6}} {{roll::abc}}')).toBe('{{roll::1000d6}} {{roll::abc}}');
  });

  it('reads variables, unset ones as empty', () => {
    expect(run('[{{getvar::hp}}][{{getvar::none}}]', { hp: '40' })).toBe('[40][]');
  });

  it('keeps a value one argument and never reads it as a macro', () => {
    expect(run('{{equal::{{getvar::v}}::a::b}}', { v: 'a::b' })).toBe('0');
    expect(run('{{equal::{{getvar::v}}::a}}', { v: 'a' })).toBe('1');
    expect(run('{{getvar::v}}', { v: '{{getvar::secret}}' })).toBe('{{getvar::secret}}');
  });

  it('leaves an unknown macro exactly as written, without evaluating inside it', () => {
    let reads = 0;
    const counted: CbsHost = { variable: () => String((reads += 1)) };
    expect(run('{{setvar::x::{{getvar::y}}}}', {}, counted)).toBe('{{setvar::x::{{getvar::y}}}}');
    expect(reads).toBe(0);
    // A name built at render time is not a name the author chose.
    expect(run('{{{{getvar::f}}::1}}', { f: 'not' })).toBe('{{{{getvar::f}}::1}}');
  });

  it('drops comments', () => {
    expect(run('a{{// {{getvar::x}} 메모}}b')).toBe('ab');
  });
});

describe('evaluateCbs - calc', () => {
  it('evaluates {{? …}} and {{calc::…}}, nested macros pasted in first', () => {
    const vars = { mp: '120', hp: '40', luck: '3', favor: '4' };
    expect(run('{{? ($mp>-100)&($mp<251)}}', vars)).toBe('1');
    expect(run('{{? ($mp>250)}}', vars)).toBe('0');
    expect(run('{{calc::{{getvar::hp}}-10}}', vars)).toBe('30');
    expect(run('{{? ({{roll::100}}<{{sum::{{getvar::luck}}::{{getvar::favor}}}})}}', vars, { random: () => 0 })).toBe(
      '1',
    );
  });

  it('formats answers without float noise and treats division by zero as 0', () => {
    expect(run('{{calc::0.1+0.2}} {{calc::5/0}} {{calc::2^10}}')).toBe('0.3 0 1024');
  });

  it('shows an expression it cannot read as written', () => {
    expect(run('{{calc::2 +}} {{? (1}}')).toBe('{{calc::2 +}} {{? (1}}');
  });
});

describe('evaluateExpression', () => {
  const vars: Record<string, string> = { hp: '40', mood: 'angry', bad: 'x' };
  const evaluate = (source: string) => evaluateExpression(source, (name) => vars[name] ?? '');

  it('reads $name as a number and a bare name as text', () => {
    expect(evaluate('$hp + 2')).toBe(42);
    expect(evaluate('$bad + $none')).toBe(0);
    expect(evaluate('mood == "angry"')).toBe(1);
    expect(evaluate('getvar::hp * 2')).toBe(80);
  });

  it('speaks both spellings of equality and logic', () => {
    expect(evaluate('$hp=40')).toBe(1);
    expect(evaluate('$hp == 40 && $hp != 41')).toBe(1);
    expect(evaluate('($hp<10)|($hp>30)')).toBe(1);
    expect(evaluate('!($hp>30)')).toBe(0);
    expect(evaluate('3 ≤ 3')).toBe(1);
  });

  it('binds comparisons tighter than & and |', () => {
    expect(evaluate('$hp > 10 & $hp < 20')).toBe(0);
    expect(evaluate('1 + 2 * 3 ^ 2')).toBe(19);
  });

  it('refuses what it cannot read, and parentheses deep enough to be an attack', () => {
    expect(() => evaluate('2 @ 3')).toThrow(CbsExpressionError);
    expect(() => evaluate(`${'('.repeat(1000)}1${')'.repeat(1000)}`)).toThrow(CbsExpressionError);
  });
});

describe('evaluateCbs - blocks', () => {
  it('takes #if on RisuAI truth: the first word is 1 or true', () => {
    expect(run('{{#if 1}}a{{/if}}{{#if true}}b{{/if}}{{#if 0}}c{{/if}}{{#if yes}}d{{/if}}')).toBe('ab');
    expect(run('{{#if {{getvar::n}}}}보임{{/if}}', { n: '5' })).toBe('');
    expect(run('{{#if {{? {{getvar::w}} <= 768 }} }}좁음{{/if}}', { w: '500' })).toBe('좁음');
  });

  it('takes the other branch after {{:else}}', () => {
    expect(run('{{#if {{equal::{{getvar::o}}::a}}}}A{{:else}}B{{/if}}', { o: 'b' })).toBe('B');
  });

  it('trims #if the way RisuAI does, and keeps #if_pure as written', () => {
    expect(run('[{{#if 1}}\n   줄 하나\n   줄 둘\n{{/if}}]')).toBe('[줄 하나\n줄 둘]');
    expect(run('[{{#if_pure 1}}\n  그대로\n{{/if_pure}}]')).toBe('[\n  그대로\n]');
  });

  it('reads #when plainly, or right to left through its operators', () => {
    const vars = { o: 'casual', n: '7' };
    expect(run('{{#when 1}}a{{/when}}{{#when 0}}b{{:else}}c{{/when}}')).toBe('ac');
    expect(run('{{#when::not::0}}a{{/when}}')).toBe('a');
    expect(run('{{#when::{{getvar::o}}::is::casual}}a{{/when}}', vars)).toBe('a');
    expect(run('{{#when::{{getvar::n}}::>=::10}}a{{:else}}b{{/when}}', vars)).toBe('b');
    expect(run('{{#when::1::and::{{equal::{{getvar::o}}::casual}}}}a{{/when}}', vars)).toBe('a');
    expect(run('{{#when::o::vis::casual}}a{{/when}}{{#when::var::n}}b{{/when}}', vars)).toBe('a');
  });

  it('keeps whitespace in #when only when asked, and trims blank edge lines otherwise', () => {
    expect(run('[{{#when 1}}\n\n  a\n\n{{/when}}]')).toBe('[  a]');
    expect(run('[{{#when::keep::1}}\n a\n{{/when}}]')).toBe('[\n a\n]');
  });

  it('does not evaluate the branch it does not take', () => {
    let reads = 0;
    run('{{#if 0}}{{getvar::x}}{{/if}}', {}, { variable: () => String((reads += 1)) });
    expect(reads).toBe(0);
  });

  it('leaves a block no host handles as written', () => {
    expect(run('{{#each a,b}}{{slot}}{{/each}}')).toBe('{{#each a,b}}{{slot}}{{/each}}');
  });
});

describe('evaluateCbs - SillyTavern {{if}}', () => {
  const branch = (condition: string, variables: Record<string, string> = {}, host: CbsHost = {}) =>
    run(`{{if ${condition}}}예{{else}}아니오{{/if}}`, variables, host);

  it('holds unless the condition is empty, false, off or 0', () => {
    for (const v of ['', 'false', 'FALSE', 'Off', ' 0 ']) expect(branch('{{getvar::v}}', { v }), v).toBe('아니오');
    for (const v of ['1', 'true', 'yes', 'no', '00', '-1']) expect(branch('{{getvar::v}}', { v }), v).toBe('예');
  });

  it('inverts on a leading !', () => {
    expect(branch('!0')).toBe('예');
    expect(branch('! {{getvar::v}}', { v: 'x' })).toBe('아니오');
  });

  it('reads .name and $name as the chat variable, there being no globals', () => {
    const vars = { hp: '3', off: 'off' };
    expect([branch('.hp', vars), branch('$hp', vars), branch('.off', vars), branch('.none', vars)]).toEqual([
      '예',
      '예',
      '아니오',
      '아니오',
    ]);
    expect(branch('!$none', vars)).toBe('예');
    // ST's shorthand names start with an ASCII letter; anything else is plain text.
    expect(branch('.호감', { 호감: '0' })).toBe('예');
    expect(branch('{{getvar::호감}}', { 호감: '0' })).toBe('아니오');
  });

  it('asks a bare name as a macro, and reads one nothing answers as its text', () => {
    const host: CbsHost = { macro: ({ name }) => (name === 'description' ? { text: '' } : undefined) };
    expect(branch('description', {}, host)).toBe('아니오');
    expect(branch('noop')).toBe('아니오');
    expect(branch('anything')).toBe('예');
  });

  it('reads a composed condition as its text, never as a name to look up', () => {
    expect(branch('{{getvar::w}}', { w: '.none' })).toBe('예');
    const host: CbsHost = { macro: ({ name }) => (name === 'description' ? { text: '' } : undefined) };
    expect(branch('{{getvar::w}}', { w: 'description' }, host)).toBe('예');
  });

  it('evaluates only the branch it takes, and an else belongs to the innermost if', () => {
    let reads = 0;
    run('{{if 0}}{{getvar::x}}{{else}}b{{/if}}', {}, { variable: () => String((reads += 1)) });
    expect(reads).toBe(0);
    expect(run('{{if 1}}{{if 0}}a{{else}}b{{/if}}{{else}}c{{/if}}')).toBe('b');
  });

  it('trims and dedents by the first line, keeping a deeper indent where #if flattens it', () => {
    const list = '\n  - a\n    - b\n  - c\n';
    expect(run(`[{{if 1}}${list}{{/if}}]`)).toBe('[- a\n  - b\n- c]');
    expect(run(`[{{#if 1}}${list}{{/if}}]`)).toBe('[- a\n- b\n- c]');
  });

  it('leaves {{#if}} to RisuAI, whose truth is 1 or true', () => {
    expect(run('{{#if yes}}a{{/if}}{{if yes}}b{{/if}}')).toBe('b');
  });

  it('keeps a condition on a variable whole where the host has none', () => {
    const template = '{{if .hp}}a{{/if}} {{if {{getvar::x}}}}b{{/if}} {{if 1}}c{{/if}}';
    expect(evaluateCbs(template, parseCbs(template))).toBe('{{if .hp}}a{{/if}} {{if {{getvar::x}}}}b{{/if}} c');
  });
});

describe('evaluateCbs - SillyTavern formatting', () => {
  it('writes newlines and spaces, one or a whole count of them', () => {
    expect(run('a{{newline}}b{{newline::2}}c{{space}}d{{space::3}}e{{space::0}}f')).toBe('a\nb\n\nc d   ef');
    expect(run('[{{space::{{getvar::n}}}}]', { n: '2' })).toBe('[  ]');
  });

  it('leaves a count that is not a whole number, or past the cap, as written', () => {
    const odd = '{{newline::x}}{{space::-1}}{{space::1.5}}{{space::101}}{{space::1::2}}';
    expect(run(odd)).toBe(odd);
  });

  it('drops {{noop}}', () => {
    expect(run('a{{noop}}b')).toBe('ab');
  });

  it('deletes {{trim}} with the line breaks around it, once everything is expanded', () => {
    expect(run('a\n\n{{trim}}\r\n\nb')).toBe('ab');
    expect(run('a {{trim}} b')).toBe('a  b');
    expect(run('a{{newline}}{{trim}}{{newline::2}}b')).toBe('ab');
    expect(run('{{if 1}}a\n{{/if}}{{trim}}\n{{#if 1}}b{{/if}}')).toBe('ab');
    // `{{trim::x}}` is RisuAI's string trim, which this engine does not do.
    expect(run('{{trim:: x }}')).toBe('{{trim:: x }}');
  });
});

describe('evaluateCbs - taint', () => {
  /** Shows where the host's marks land, with variables marked and nothing else. */
  const marked = (template: string, variables: Record<string, string>) =>
    run(template, variables, { emit: (value) => (value.untrusted ? `#${value.text}#` : value.text) });

  it('marks what reads a variable, and what is computed from a marked argument', () => {
    expect(marked('{{getvar::x}} {{equal::{{getvar::x}}::a}} {{equal::a::a}} {{calc::1+1}}', { x: 'a' })).toBe(
      '#a# #1# 1 #2#',
    );
    expect(marked('{{random::{{getvar::x}}}}', { x: 'z' })).toBe('#z#');
  });
});

describe('asset macros', () => {
  it('finds every alias with its kind, and no ref for a composed one', () => {
    const text = '{{img::a}} {{Image:: b }} {{raw::c}} {{video-img::d}} {{img::{{getvar::o}}.png}} {{char}}';
    expect(findAssetMacros(text).map(({ kind, ref }) => [kind, ref])).toEqual([
      ['image', 'a'],
      ['image', 'b'],
      ['url', 'c'],
      ['drop', 'd'],
      ['image', null],
    ]);
  });

  it('replaces them in place and leaves everything else as written', () => {
    expect(replaceAssetMacros('앞 {{img::a}} {{getvar::x}} {{bgm::b}} 뒤', (macro) => `<${macro.ref}>`)).toBe(
      '앞 <a> {{getvar::x}} <b> 뒤',
    );
  });
});

describe('assetResolver', () => {
  const resolve = assetResolver([
    { slug: 'smile', name: null },
    { slug: 'profile-png', name: 'Profile.png' },
    { slug: 'asset-3', name: '웃음' },
    { slug: 'wet-coat-1', name: 'wet_coat_1.webp' },
    { slug: 'night', name: 'smile' },
  ]);

  it('takes the slug first, then the card name without case, then either without extension', () => {
    expect(resolve('smile')).toBe('smile');
    expect(resolve('profile.png')).toBe('profile-png');
    expect(resolve('PROFILE')).toBe('profile-png');
    expect(resolve('웃음.png')).toBe('asset-3');
    expect(resolve(' wet_coat_1.webp ')).toBe('wet-coat-1');
  });

  it('falls back to the slug the import would have folded the reference into', () => {
    expect(resolve('Wet Coat 1')).toBe('wet-coat-1');
  });

  it('names nothing it cannot find, rather than guessing at the nearest', () => {
    expect(resolve('profil')).toBeUndefined();
    expect(resolve('')).toBeUndefined();
  });
});
