import { describe, expect, it } from 'vitest';
import {
  assetResolver,
  CbsExpressionError,
  CbsSyntaxError,
  evaluateCbs,
  evaluateExpression,
  findAssetMacros,
  MAX_CBS_BLOCK_DEPTH,
  parseCbs,
  pickHashRand,
  replaceAssetMacros,
  type CbsChat,
  type CbsHost,
  type CbsHostData,
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
    expect(run(blocks(MAX_CBS_BLOCK_DEPTH))).toBe('x');
    expect(() => parseCbs(blocks(MAX_CBS_BLOCK_DEPTH + 1), { strict: true })).toThrow(CbsSyntaxError);
    const macros = `${'{{equal::'.repeat(40)}${'::}}'.repeat(40)}`;
    expect(() => parseCbs(macros, { strict: true })).toThrow(CbsSyntaxError);
    expect(() => parseCbs(macros)).not.toThrow();
  });

  it('reads conditions nested as deep as a RisuAI preset nests its toggles', () => {
    // The owner's "소악마" preset nests toggle and model conditions 39 deep, and
    // RisuAI reads every level: an unset toggle's section is left out, a set one's kept.
    const level = (n: number): string =>
      n === 0 ? 'core' : `{{#if {{? {{getglobalvar::toggle_on}}=1 }}}}on${n}{{/if}}{{#if {{? {{getglobalvar::toggle_off}}=1 }}}}off${n}{{/if}}{{#if 1}}${level(n - 1)}{{/if}}`;
    const out = evaluateCbs(level(40), parseCbs(level(40)), {
      variable: () => undefined,
      globalVariable: (name) => (name === 'toggle_on' ? '1' : undefined),
    });
    expect(out).toContain('core');
    expect(out).toContain('on40');
    expect(out).not.toContain('off');
    expect(out).not.toContain('{{');
  });
});

describe('evaluateCbs - RisuAI functions', () => {
  it('compares as RisuAI does: equal on text, greater and less on numbers', () => {
    expect(run('{{equal::a::a}}{{equal::a::A}}{{notequal::a::b}}{{not_equal::a::a}}')).toBe('1010');
    expect(run('{{greater::10::9}}{{greater_equal::3::3}}{{less::2::10}}{{less_equal::4::3}}')).toBe('1110');
    // Without its second operand a comparison is NaN in RisuAI, which is false.
    expect(run('{{greater::5}}{{equal::a}}{{notequal::a}}')).toBe('001');
  });

  it('finds text inside text with contains, the way a card asks after an image', () => {
    expect(run('{{contains::["face","door"]::door}}{{contains::abc::d}}{{contains::abc}}')).toBe('100');
    expect(run('{{contains::{{getvar::list}}::face}}', { list: '["face"]' })).toBe('1');
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

  it('rolls N, dN and XdY within their bounds, answering NaN for a roll it cannot read, as RisuAI does', () => {
    expect(run('{{roll::100}}', {}, { random: () => 0.999 })).toBe('100');
    expect(run('{{roll:d20}}', {}, { random: () => 0 })).toBe('1');
    expect(run('{{roll::2d6}}', {}, { random: () => 0.999 })).toBe('12');
    expect(run('{{roll::1000d6}}')).toBe('1000');
    // Past the cap too: RisuAI has none, and would loop.
    expect(run('{{roll::1001d6}} {{roll::abc}} {{roll}}')).toBe('NaN NaN 1');
  });

  it('reads variables, an unset one as RisuAI writes it: null', () => {
    expect(run('[{{getvar::hp}}][{{getvar::none}}]', { hp: '40' })).toBe('[40][null]');
  });

  it('reads the first argument alone as the name, as RisuAI does', () => {
    expect(run('{{getvar::hp::max}}', { hp: '40', 'hp::max': '0' })).toBe('40');
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
    // RisuAI's own name for it.
    expect(run('a{{br}}b{{BR}}c')).toBe('a\nb\nc');
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
    // With an argument it is RisuAI's string trim: the two never meet.
    expect(run('[{{trim:: x }}]')).toBe('[x]');
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

/** Shows where the host's marks land: what a value said, between `#`s. */
const markValues: CbsHost = { emit: (value) => (value.untrusted ? `#${value.text}#` : value.text) };

describe('parseCbs - RisuAI syntax', () => {
  it('reads a RisuAI status panel strictly, where it used to fall back to its own source', () => {
    const panel = [
      '<div>{{#escape}}{a}{{/escape}}',
      '{{#puredisplay}}{{char}}{{/puredisplay}}',
      '{{#pure}}{{#if 1}}…{{/if}}{{/pure}}',
      '{{#code}}\\u0041{{/code}}',
      '{{#func f a}}{{arg::1}}{{/func}}{{call::f::x}}',
      '{#if 1\n줄#}',
      '<user></div>',
    ].join('');
    expect(() => parseCbs(panel, { strict: true })).not.toThrow();
  });

  it('keeps a raw body as written, counting the blocks in it as RisuAI does', () => {
    const [node] = parseCbs('{{#pure}}{{#if 1}}a{{/if}}{{:else}}{{/x}}{{/pure}}');
    expect(node?.type === 'block' && node.kind).toBe('pure');
    expect(node?.type === 'block' && node.body).toEqual([{ type: 'text', text: '{{#if 1}}a{{/if}}{{:else}}' }]);
  });

  it('closes a raw body with its own name or {{/}} when strict, and with any closer when lenient', () => {
    expect(() => parseCbs('{{#pure_display}}x{{/puredisplay}}', { strict: true })).not.toThrow();
    expect(() => parseCbs('{{#escape::keep}}x{{/}}', { strict: true })).not.toThrow();
    expect(() => parseCbs('{{#pure}}x{{/escape}}', { strict: true })).toThrow(CbsSyntaxError);
    expect(() => parseCbs('{{#func f}}x', { strict: true })).toThrow(CbsSyntaxError);
    expect(run('{{#pure}}x{{/escape}}')).toBe('x');
    // Unclosed, it is an opener nobody knows, and what follows is read as usual.
    expect(run('{{#pure}}{{getvar::a}}', { a: '1' })).toBe('{{#pure}}1');
  });

  it('opens only what RisuAI opens: #pure, #puredisplay and #code exactly, #func with a name', () => {
    expect(run('{{#pure x}}a{{/pure}}')).toBe('{{#pure x}}a{{/pure}}');
    expect(run('{{#func}}a{{/func}}')).toBe('{{#func}}a{{/func}}');
  });

  it('reads RisuAI’s legacy {#if}, which only #} closes, and leaves any other {# alone', () => {
    expect(run('{#if 1\n  본문 #}')).toBe('본문');
    expect(run('[{#if 0\n본문#}][{#if -1\nx#}][{#if  1\nx#}]')).toBe('[][][]');
    expect(run('{#if\n열림#}')).toBe('열림');
    expect(run('{#if {{getvar::a}}\n{{getvar::b}}#}', { a: '1', b: '값' })).toBe('값');
    expect(run('{#if 1 한 줄#}')).toBe('{#if 1 한 줄#}');
    expect(run('a{#b{c:d}} {# Jinja #} {#if 1')).toBe('a{#b{c:d}} {# Jinja #} {#if 1');
    expect(() => parseCbs('{#if 1\n열림', { strict: true })).not.toThrow();
  });

  it('reads <user>, <char> and <bot> as the macros, written back as tags when nobody answers', () => {
    const names: CbsHost = {
      macro: ({ name }) => (name === 'user' ? { text: '민준' } : name === 'char' ? { text: '아리아' } : undefined),
    };
    expect(run('<user>와 <CHAR>, <Bot>, {{bot}}', {}, names)).toBe('민준와 아리아, 아리아, 아리아');
    expect(run('<user> <char>')).toBe('<user> <char>');
    expect(run('{{setvar::x::<user>}}')).toBe('{{setvar::x::<user>}}');
    expect(run('{{#pure}}<user>{{/pure}}')).toBe('{{user}}');
    expect(run('<b>굵게</b> <users>')).toBe('<b>굵게</b> <users>');
  });
});

describe('evaluateCbs - RisuAI blocks', () => {
  it('writes #pure as written and #puredisplay with its braces escaped, evaluating neither', () => {
    let reads = 0;
    const counted: CbsHost = { variable: () => String((reads += 1)) };
    expect(run('[{{#pure}}\n  {{getvar::x}} \n{{/pure}}]', {}, counted)).toBe('[{{getvar::x}}]');
    expect(run('{{#puredisplay}} {{char}} {{/puredisplay}}', {}, counted)).toBe('\\{\\{char\\}\\}');
    expect(reads).toBe(0);
  });

  it('swaps #escape’s braces and parentheses for display escapes, trimmed unless ::keep', () => {
    expect(run('[{{#escape}} {a}(b) {{/escape}}]')).toBe('[ab]');
    expect(run('[{{#escape::keep}} {} {{/escape}}]')).toBe('[  ]');
  });

  it('unescapes #code’s result, what a value says included, and writes it as a value', () => {
    expect(run('{{#code}}\n  a\\nb\\u0041\\t|\n{{/code}}')).toBe('a\nbA\t|');
    expect(run('{{#code}}{{getvar::x}}{{/code}}', { x: '\\u003cb\\u003e' }, markValues)).toBe('#<b>#');
  });

  it('defines functions with #func and runs them with call, arguments being values', () => {
    const define = '{{#func greet who}}\n안녕, {{arg::1}} ({{arg::0}})\n{{/func}}';
    expect(run(`${define}[{{call::greet::민준}}]`)).toBe('[안녕, 민준 (greet)]');
    // A call before the definition, or of nothing defined, stays as written.
    expect(run(`{{call::greet::a}}${define}`)).toBe('{{call::greet::a}}');
    expect(run('{{call::nope}}')).toBe('{{call::nope}}');
    expect(run(`${define}{{call::greet::{{getvar::v}}}}`, { v: '{{getvar::secret}}' })).toBe(
      '안녕, {{getvar::secret}} (greet)',
    );
    // An argument the call did not give stays as written, as upstream leaves it.
    expect(run('{{#func f}}[{{arg::2}}]{{/func}}{{call::f::a}}')).toBe('[{{arg::2}}]');
  });

  it('stops at RisuAI’s call stack, counted over the whole text', () => {
    expect(run('{{#func f}}x{{call::f}}{{/func}}{{call::f}}')).toBe(`${'x'.repeat(19)}ERROR: Call stack limit reached`);
  });

  it('keeps temporary variables for one evaluation, a call having its own', () => {
    expect(run('{{settempvar::a::1}}[{{tempvar::a}}][{{gettempvar::b}}]')).toBe('[1][]');
    expect(run('{{settempvar::a::1}}{{#func f}}[{{tempvar::a}}]{{/func}}{{call::f}}')).toBe('[]');
  });

  it('ends the evaluation at {{return}}, or only the call it is in', () => {
    expect(run('앞 {{return::끝}} 뒤')).toBe('끝');
    expect(run('{{#func f}}a{{return::b}}c{{/func}}[{{call::f}}]')).toBe('[b]');
    expect(run('{{return}}')).toBe('null');
  });

  it('cuts what came before with bkspc and erase', () => {
    expect(run('Hello brave world {{bkspc}}!')).toBe('Hello brave!');
    expect(run('One. Two three{{erase}}')).toBe('One.');
    expect(run('[{{#if 1}}a b{{bkspc}}{{/if}}]')).toBe('[a]');
  });

  it('splices a whole {{spread}} argument in as several: the one value that becomes separators', () => {
    expect(run('{{makedict::{{spread::["a=1","b=2"]}}}}')).toBe('{"a":"1","b":"2"}');
    expect(run('{{makearray::x::{{spread::{{getvar::l}}}}}}', { l: '["y","z"]' })).toBe('["x","y","z"]');
  });
});

describe('evaluateCbs - #each', () => {
  const each = (template: string, variables: Record<string, string> = {}, host: CbsHost = {}) =>
    run(template, variables, { each: true, ...host });

  it('iterates RisuAI’s LIST as name: JSON, or a §-list, and items that are not text as JSON', () => {
    expect(each('{{#each ["a","b"] as x}}[{{slot::x}}]{{/each}}')).toBe('[a][b]');
    expect(each('{{#each {{getvar::list}} as x}}[{{slot::x}}]{{/each}}', { list: '사과§배' })).toBe('[사과][배]');
    expect(each('{{#each [1,{"a":2},null] as x}}[{{slot::x}}]{{/each}}')).toBe('[1][{"a":2}][null]');
    expect(each('{{#each [] as x}}x{{/each}}')).toBe('');
  });

  it('reads RisuAI’s older LIST name when the list is a JSON array, and ours otherwise', () => {
    expect(each('{{#each ["a","b"] item}}[{{slot::item}}]{{/each}}')).toBe('[a][b]');
    expect(each('{{#each party}}[{{slot}}]{{/each}}', { party: '아리아, 세이' })).toBe('[아리아][세이]');
    expect(each('{{#each a, b c}}[{{slot}}]{{/each}}')).toBe('[a][b c]');
  });

  it('unindents RisuAI’s body and trims the whole, unless ::keep — never an item’s own whitespace', () => {
    const body = '\n  <li>{{slot::x}}</li>\n';
    expect(each(`{{#each ["a","b"] as x}}${body}{{/each}}`)).toBe('<li>a</li><li>b</li>');
    expect(each(`{{#each::keep ["a"] as x}}${body}{{/each}}`)).toBe('\n  <li>a</li>\n');
    expect(each('{{#each [" a"," b"] as x}}{{slot::x}}{{/each}}')).toBe('a b');
  });

  it('lets an outer name win over an inner one of the same spelling, as RisuAI’s pasting does', () => {
    expect(
      each('{{#each ["a","b"] as x}}{{#each ["1","2"] as y}}[{{slot::x}}{{slot::y}}]{{/each}}{{/each}}'),
    ).toBe('[a1][a2][b1][b2]');
    expect(each('{{#each ["a"] as x}}{{#each ["1"] as x}}[{{slot::x}}]{{/each}}{{/each}}')).toBe('[a]');
    expect(each('{{#each ["a"] as x}}[{{slot::y}}][{{slot:: x}}]{{/each}}')).toBe('[{{slot::y}}][{{slot:: x}}]');
  });

  it('marks every item, and never reads one as a macro', () => {
    expect(each('{{#each {{getvar::l}} as x}}{{slot::x}}{{/each}}', { l: '["{{getvar::l}}"]' }, markValues)).toBe(
      '#{{getvar::l}}#',
    );
  });

  it('is bounded: by the host’s iterate, and without one by a cap of its own', () => {
    const list = JSON.stringify(Array.from({ length: 6_000 }, () => 'x'));
    expect(each('{{#each {{getvar::l}} as x}}{{slot::x}}{{/each}}', { l: list })).toHaveLength(5_000);
    let left = 10;
    const iterate = (): void => {
      if ((left -= 1) < 0) throw new Error('budget');
    };
    expect(() => each('{{#each {{getvar::l}} as x}}x{{/each}}', { l: list }, { iterate })).toThrow('budget');
  });

  it('is left to the host unless it asks for it', () => {
    expect(run('{{#each ["a"] as x}}{{slot::x}}{{/each}}')).toBe('{{#each ["a"] as x}}{{slot::x}}{{/each}}');
  });
});

describe('evaluateCbs - #when’s else, as RisuAI splits it', () => {
  it('splits a block on one line at its first {{:else}}', () => {
    expect(run('{{#when 0}}a{{:else}}b{{:else}}c{{/when}}')).toBe('b{{:else}}c');
  });

  it('splits a block over lines only at a {{:else}} alone on its line, an inline one being text', () => {
    expect(run('{{#when 1}}\na{{:else}}b\n{{/when}}')).toBe('a{{:else}}b');
    expect(run('{{#when 0}}\na\n  {{:else}}  \nb\n{{/when}}')).toBe('b');
    expect(run('{{#when 0}}\na{{:else}}b\n{{/when}}')).toBe('');
  });

  it('gives the else line to neither branch, kept whitespace or not', () => {
    expect(run('[{{#when::keep::1}}\n a\n{{:else}}\n b\n{{/when}}]')).toBe('[\n a]');
    expect(run('[{{#when::keep::0}}\n a\n{{:else}}\n b\n{{/when}}]')).toBe('[ b\n]');
    expect(run('[{{#when 1}}  \n{{:else}}\nb{{/when}}]')).toBe('[]');
  });
});

describe('evaluateCbs - unset variables and null', () => {
  it('writes null for an unset getvar, which ST’s {{if}} still finds false', () => {
    expect(run('{{if {{getvar::none}}}}a{{else}}b{{/if}}')).toBe('b');
    expect(run('{{if !{{getvar::none}}}}a{{else}}b{{/if}}')).toBe('a');
    // A variable set to the word is set.
    expect(run('{{if {{getvar::v}}}}a{{else}}b{{/if}}', { v: 'null' })).toBe('a');
  });

  it('reads it as RisuAI does: false for #if and var, equal to null for vis', () => {
    expect(run('{{#if {{getvar::none}}}}a{{:else}}b{{/if}}')).toBe('b');
    expect(run('{{#when::none::vis::null}}a{{/when}}{{#when::var::none}}b{{:else}}c{{/when}}')).toBe('ac');
    expect(run('{{#when::none::visnot::null}}a{{:else}}b{{/when}}')).toBe('b');
  });

  it('reads an unset name and the word null as 0 in an expression', () => {
    expect(run('{{? {{getvar::none}} + 1}} {{calc::none + 1}} {{? null = 0}} {{? NULL}}')).toBe('1 1 1 0');
    expect(run('{{calc::mood == "angry"}}')).toBe('0');
  });
});

describe('evaluateCbs - RisuAI expressions, globals and toggles', () => {
  const globals = (values: Record<string, string>): CbsHost => ({
    globalVariable: (name) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined),
  });

  it('answers an operand from | and &, as JavaScript does upstream', () => {
    expect(run('{{? $hp | 10}} {{? $mp | 10}} {{? 2&3}} {{? 0&3}}', { hp: '5' })).toBe('5 10 3 0');
  });

  it('reads @name as a global variable, and as 0 without one', () => {
    expect(run('{{? @g + 1}}', {}, globals({ g: '2' }))).toBe('3');
    expect(run('{{? @g + 1}}')).toBe('1');
  });

  it('reads getglobalvar, unset as null, and leaves it as written where there are no globals', () => {
    expect(run('{{getglobalvar::a}} {{getglobalvar::b}}', {}, globals({ a: '1' }))).toBe('1 null');
    expect(run('{{getglobalvar::a}}')).toBe('{{getglobalvar::a}}');
  });

  it('reads #when’s toggles from the globals, off without them', () => {
    const on = globals({ toggle_dark: '1', toggle_mode: 'b' });
    expect(run('{{#when::toggle::dark}}a{{:else}}b{{/when}}', {}, on)).toBe('a');
    expect(run('{{#when::toggle::dark}}a{{:else}}b{{/when}}')).toBe('b');
    expect(run('{{#when::mode::tis::b}}a{{/when}}{{#when::mode::tisnot::b}}c{{/when}}', {}, on)).toBe('a');
    expect(run('{{#when::mode::tis::null}}a{{/when}}')).toBe('a');
  });
});

describe('evaluateCbs - random, pick and rollp', () => {
  const seeded = (length: number): CbsHost => ({ data: { seed: { key: 'chat-1', length } } });

  it('writes random with nothing to pick from at full precision, and a broken array as one option', () => {
    expect(run('{{random}}', {}, { random: () => 0.123456789 })).toBe('0.123456789');
    expect(run('{{random::[a,b]}}')).toBe('[a,b]');
  });

  it('draws a pick once per evaluation, from the chat and its length, as RisuAI does', () => {
    const draw = pickHashRand(3, 'chat-1');
    const expected = ['a', 'b', 'c', 'd', 'e'][Math.floor(draw * 5)]!;
    expect(run('{{pick::a,b,c,d,e}}{{pick::a::b::c::d::e}}', {}, seeded(3))).toBe(expected + expected);
    expect(run('{{pick}}', {}, seeded(3))).toBe(String(draw));
  });

  it('lets a host’s own pick decide, and is random without a seed', () => {
    expect(run('{{pick::a,b}}', {}, { ...seeded(3), pick: () => 1 })).toBe('b');
    expect(run('{{pick::a,b}}', {}, { random: () => 0.9 })).toBe('b');
  });

  it('rolls rollp from the same seed, die i fifteen draws on', () => {
    const die = (i: number): number => Math.floor(pickHashRand(3 + i * 15, 'chat-1') * 6) + 1;
    expect(run('{{rollp::2d6}}', {}, seeded(3))).toBe(String(die(0) + die(1)));
  });
});

describe('evaluateCbs - host data', () => {
  const chat: CbsChat = {
    messages: [
      { role: 'user', data: '안녕', time: Date.UTC(2026, 3, 7, 0, 0, 0) },
      { role: 'char', data: '<b>반가워</b>', time: Date.UTC(2026, 3, 7, 0, 0, 30) },
      { role: 'user', data: '또 왔어', time: Date.UTC(2026, 3, 7, 1, 2, 3) },
    ],
    offset: 0,
    length: 3,
    index: 2,
    greeting: { text: '어서 와', index: -1 },
  };
  const withData = (data: CbsHostData): CbsHost => ({ data });

  it('leaves every function as written where the host gave nothing, or not what it reads', () => {
    const template = '{{lastmessage}} {{description}} {{model}} {{role}} {{chatindex}} {{metadata::version}} {{comment::x}}';
    expect(run(template)).toBe(template);
    expect(run('{{description}} {{lastmessage}}', {}, withData({ user: '민준' }))).toBe('{{description}} {{lastmessage}}');
  });

  it('answers char, bot and user from data, a host’s own answer first', () => {
    expect(run('{{char}} {{bot}} <bot> {{user}}', {}, withData({ char: '아리아', user: '민준' }))).toBe(
      '아리아 아리아 아리아 민준',
    );
    const own: CbsHost = { data: { char: '아리아' }, macro: ({ name }) => (name === 'char' ? { text: '세이' } : undefined) };
    expect(run('{{char}}', {}, own)).toBe('세이');
  });

  it('reads the character’s fields as CBS, with the same host', () => {
    const host = withData({
      user: '민준',
      character: { description: '{{user}}의 친구. HP {{getvar::hp}}', personality: '{{personality}}' },
    });
    expect(run('{{description}}', { hp: '3' }, host)).toBe('민준의 친구. HP 3');
    // A field that asks for itself runs into RisuAI's call stack.
    expect(run('{{personality}}', {}, host)).toBe('ERROR: Call stack limit reached');
  });

  it('answers the chat functions from the branch, marking what a message says', () => {
    const host = withData({ chat: () => chat });
    expect(run('{{chatindex}} {{lastmessageid}} {{firstmsgindex}}', {}, host)).toBe('2 2 -1');
    expect(
      run(
        '{{lastmessage}}|{{previouscharchat}}|{{previoususerchat}}|{{previouschatlog::0}}|{{previouschatlog::9}}',
        {},
        { ...host, ...markValues },
      ),
    ).toBe('#또 왔어#|#<b>반가워</b>#|#안녕#|#안녕#|Out of range');
    // Where the text is no message's, as in RisuAI's prompt: the latest, and nothing.
    const prompt = withData({ chat: () => ({ ...chat, index: -1 }) });
    expect(run('{{lastcharmessage}}|{{lastusermessage}}', {}, prompt)).toBe('<b>반가워</b>|');
  });

  it('writes the history as RisuAI’s JSON, the greeting first, and never reads it as CBS', () => {
    const host = withData({ chat: () => ({ ...chat, messages: [{ role: 'user', data: '{{char}}' }], length: 1 }) });
    expect(run('{{history}}', {}, host)).toBe(
      '["{\\"role\\":\\"char\\",\\"data\\":\\"어서 와\\"}","{\\"role\\":\\"user\\",\\"data\\":\\"{{char}}\\"}"]',
    );
    expect(run('{{history::role}} {{messages::x}}', {}, host)).toBe('["user: {{char}}"] ["{{char}}"]');
    expect(run('{{userhistory}} {{charhistory}}', {}, host)).toBe(
      '["{\\"role\\":\\"user\\",\\"data\\":\\"{{char}}\\"}"] []',
    );
  });

  it('leaves what it cannot see as written when only a later stretch of the branch is loaded', () => {
    const later = withData({ chat: () => ({ ...chat, messages: chat.messages.slice(2), offset: 2 }) });
    expect(run('{{lastmessage}} {{previouschatlog::0}} {{history}}', {}, later)).toBe(
      '또 왔어 {{previouschatlog::0}} {{history}}',
    );
  });

  it('tells a message’s time in the reader’s zone, or why it cannot', () => {
    const clock = { now: new Date(Date.UTC(2026, 3, 7, 2)), timeZone: 'Asia/Seoul', locale: 'en-US' };
    const sent = new Date(chat.messages[2]!.time!);
    const zone = { timeZone: 'Asia/Seoul' };
    expect(run('{{messagetime}} / {{messagedate}} / {{messageidleduration}}', {}, withData({ chat: () => chat, clock }))).toBe(
      `${sent.toLocaleTimeString('en-US', zone)} / ${sent.toLocaleDateString('en-US', zone)} / 1:02:03`,
    );
    expect(run('{{messagetime}}', {}, withData({ chat: () => ({ ...chat, index: -1 }), clock }))).toBe('[Cannot get time]');
    expect(run('{{messageidleduration}}', {}, withData({ chat: () => ({ ...chat, index: 1 }), clock }))).toBe(
      '[No previous user message found]',
    );
  });

  it('answers the model, the screen, metadata and the rest from what the host gave', () => {
    const host = withData({
      user: '민준',
      model: { id: 'claude-x', name: 'Claude X', prefill: true, maxContext: 200000 },
      screen: { width: 390, height: 844 },
      meta: { language: 'ko', mobile: true },
      role: 'char',
      firstMessage: false,
      assets: { names: ['웃음', 'face.png'] },
      prompts: { jailbreak: { text: '', enabled: false }, authorNote: '{{user}} 노트' },
      modules: [{ namespace: 'mod', assets: ['a'] }],
      triggerId: null,
      lorebook: () => [{ key: 'k', content: 'c' }],
    });
    expect(run('{{model}} {{axmodel}} {{prefill}} {{maxcontext}} {{screen_width}}x{{screenheight}}', {}, host)).toBe(
      'claude-x  1 200000 390x844',
    );
    expect(
      run(
        '{{metadata::Version}} {{metadata::major}} {{metadata::lang}} {{metadata::mobile}} {{metadata::modelname}} {{metadata::nope}}',
        {},
        host,
      ),
    ).toBe('2026.8.250 2026 ko 1 Claude X Error: nope is not a valid metadata key.');
    expect(run('{{role}} {{isfirstmsg}} {{assetlist}} {{chardisplayasset}} {{jbtoggled}}[{{jb}}] {{authornote}}', {}, host)).toBe(
      'char 0 ["웃음","face.png"] [] 0[] 민준 노트',
    );
    expect(run('{{moduleenabled::mod}}{{module_enabled::x}} {{moduleassetlist::mod}} {{trigger_id}} {{lorebook}}', {}, host)).toBe(
      '10 ["a"] null ["{\\"key\\":\\"k\\",\\"content\\":\\"c\\"}"]',
    );
  });

  it('draws comment and file only on screen, escaping what a value says, and decodes a file elsewhere', () => {
    const shown = withData({ phase: 'display' });
    expect(run('{{comment::<i>메모</i>}}', {}, shown)).toBe('<div class="risu-comment"><i>메모</i></div>');
    expect(run('{{comment::{{getvar::x}}}}', { x: '<b>' }, shown)).toBe('<div class="risu-comment">&lt;b&gt;</div>');
    expect(run('[{{comment::메모}}]', {}, withData({ phase: 'prompt' }))).toBe('[]');
    expect(run('{{file::a.txt::7JWI64WV}}', {}, withData({}))).toBe('안녕');
    expect(run('{{file::a.txt::7JWI64WV}}', {}, shown)).toBe('<br><div class="risu-file">a.txt</div><br>');
  });

  it('builds ruby and codeblock markup, a value escaped', () => {
    expect(run('{{ruby::漢字::{{getvar::r}}}}', { r: '<かんじ>' })).toBe(
      '<ruby>漢字<rp> (</rp><rt>&lt;かんじ&gt;</rt><rp>) </rp></ruby>',
    );
    expect(run('{{codeblock::<a href="x">}}')).toBe('<pre><code>&lt;a href=&quot;x&quot;&gt;</code></pre>');
    expect(run('{{codeblock::js::a<b}}', {}, withData({ phase: 'display' }))).toBe(
      '<pre><code class="language-js">a&lt;b</code></pre>',
    );
    expect(run('{{codeblock::js::a<b}}')).toBe('<pre-hljs-placeholder lang="js">a&lt;b</pre-hljs-placeholder>');
  });
});

describe('asset macros', () => {
  it('finds every alias with its kind, and no ref for a composed one', () => {
    const text =
      '{{img::a}} {{Image:: b }} {{raw::c}} {{video-img::d}} {{video::e}} {{bg::f}} {{img::{{getvar::o}}.png}} {{char}}';
    expect(findAssetMacros(text).map(({ kind, ref }) => [kind, ref])).toEqual([
      ['image', 'a'],
      ['image', 'b'],
      ['url', 'c'],
      ['videoimg', 'd'],
      ['video', 'e'],
      ['drop', 'f'],
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
