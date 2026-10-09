import { describe, expect, it } from 'vitest';
import { renderTemplate, RenderBudgetExhausted, type CbsContext } from '../src/lib/cbs';
import { TAINT, stripTaint } from '../src/lib/taint';

const ctx = (overrides: Partial<CbsContext> = {}): CbsContext => ({
  variables: { hp: '40', max: '100', mood: 'angry', party: '아리아, 세이, 루미' },
  assets: new Map([['smile', '/api/plots/c1/assets/smile']]),
  relationship: { affection: 62, trust: 11 },
  turn: 7,
  char: '아리아',
  user: '민준',
  ...overrides,
});

/**
 * Rendering with the taint bookkeeping taken back off, which is what everything
 * below this line is about. Where the marks land is its own subject, at the foot
 * of the file, and the sanitizer is the only thing that ever reads them.
 */
/**
 * The allowance a real render is given by `renderDisplayPlan`. Generous here, so
 * that the tests below are about template semantics; what the engine charges it
 * for, and what happens when it runs out, is its own subject at the foot of file.
 */
const generous = (): ((chars: number) => void) => {
  let left = 1_000_000;
  return (chars) => {
    left -= chars;
    if (left < 0) throw new RenderBudgetExhausted('test allowance');
  };
};

const render = (template: string, overrides?: Partial<CbsContext>): string =>
  stripTaint(renderTemplate(template, ctx(overrides), generous()));

describe('simple macros', () => {
  it('substitutes the chat bindings', () => {
    expect(render('{{char}}와 {{user}}, {{turn}}턴')).toBe('아리아와 민준, 7턴');
  });

  it('reads variables through getvar and blanks an unknown key', () => {
    expect(render('{{getvar::hp}}/{{getvar::max}} {{getvar::none}}')).toBe('40/100 ');
  });

  it('resolves an asset reference to its url and an unknown slug to nothing', () => {
    expect(render('<img src="{{img::smile}}">')).toBe('<img src="/api/plots/c1/assets/smile">');
    expect(render('<img src="{{img::none}}">')).toBe('<img src="">');
  });

  it('reads relationship axes and rejects an axis that does not exist', () => {
    expect(render('{{rel::affection}} {{rel::fear}}')).toBe('62 0');
    expect(render('{{rel::mood}}')).toBe('{{rel::mood}}');
  });

  it('renders an unknown macro as visible text rather than swallowing it', () => {
    expect(render('{{nope::a}} {{whatever}}')).toBe('{{nope::a}} {{whatever}}');
  });

  it('escapes everything it substitutes', () => {
    expect(render('{{getvar::x}}', { variables: { x: '<img src=x onerror=alert(1)>' } })).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(render('{{char}}', { char: '<b>' })).toBe('&lt;b&gt;');
  });
});

describe('names that belong to Object.prototype', () => {
  const NAMES = ['toString', 'valueOf', 'hasOwnProperty', '__proto__', 'constructor'];

  /** The map a real render is given: null-prototype, straight from the fold. */
  const withVariable = (name: string, value: string): Partial<CbsContext> => {
    const variables = Object.create(null) as Record<string, string>;
    variables[name] = value;
    return { variables };
  };

  it('reads one through getvar', () => {
    for (const name of NAMES) {
      expect(render(`{{getvar::${name}}}`, withVariable(name, '가치')), name).toBe('가치');
    }
  });

  it('reads one as a bare identifier in an expression', () => {
    for (const name of NAMES) {
      expect(render(`{{calc::${name} + 1}}`, withVariable(name, '41')), name).toBe('42');
      expect(render(`{{#if ${name} > 5}}높음{{/if}}`, withVariable(name, '9')), name).toBe('높음');
    }
  });

  it('iterates one with each', () => {
    for (const name of NAMES) {
      expect(render(`{{#each ${name}}}[{{slot}}]{{/each}}`, withVariable(name, 'a,b')), name).toBe('[a][b]');
    }
  });

  it('treats an unset one as unset rather than inheriting a method', () => {
    // Given an ordinary object — which a caller may still hand us — `toString`
    // would otherwise resolve to a function and be rendered as its source.
    for (const name of NAMES) {
      expect(render(`[{{getvar::${name}}}]`, { variables: {} }), name).toBe('[]');
      expect(render(`{{#each ${name}}}x{{/each}}`, { variables: {} }), name).toBe('');
      expect(render(`{{#if ${name}}}있음{{/if}}`, { variables: {} }), name).toBe('');
    }
  });
});

describe('{{button}}', () => {
  it('emits an inert button carrying the text to fill in', () => {
    expect(render('{{button::인사::안녕하세요}}')).toBe(
      '<button type="button" data-shizue-fill="안녕하세요">인사</button>',
    );
  });

  it('uses the label as the fill text when only one argument is given', () => {
    expect(render('{{button::안녕}}')).toBe('<button type="button" data-shizue-fill="안녕">안녕</button>');
  });

  it('escapes both the label and the fill text', () => {
    expect(render('{{button::<b>::" onclick="alert(1)}}')).toBe(
      '<button type="button" data-shizue-fill="&quot; onclick=&quot;alert(1)">&lt;b&gt;</button>',
    );
  });
});

describe('{{calc}}', () => {
  it('does arithmetic with the usual precedence', () => {
    expect(render('{{calc::2 + 3 * 4}}')).toBe('14');
    expect(render('{{calc::(2 + 3) * 4}}')).toBe('20');
    expect(render('{{calc::7 % 4}}')).toBe('3');
    expect(render('{{calc::-3 + 10}}')).toBe('7');
  });

  it('reads variables, spelled bare or as getvar', () => {
    expect(render('{{calc::hp * 100 / max}}')).toBe('40');
    expect(render('{{calc::getvar::hp + 1}}')).toBe('41');
  });

  it('treats division by zero as zero instead of infinity', () => {
    expect(render('{{calc::5 / 0}}')).toBe('0');
  });

  it('trims float noise', () => {
    expect(render('{{calc::0.1 + 0.2}}')).toBe('0.3');
  });

  it('compares, answering 1 or 0', () => {
    expect(render('{{calc::hp > 30}} {{calc::hp > 300}}')).toBe('1 0');
  });

  it('shows a malformed expression as text rather than breaking the message', () => {
    expect(render('앞 {{calc::2 +}} 뒤')).toBe('앞 {{calc::2 +}} 뒤');
    expect(render('{{calc::2 @ 3}}')).toBe('{{calc::2 @ 3}}');
    expect(render('{{calc::(1 + 2}}')).toBe('{{calc::(1 + 2}}');
  });
});

describe('{{#if}}', () => {
  it('keeps the body when the condition holds and drops it otherwise', () => {
    expect(render('{{#if hp < 50}}위험{{/if}}')).toBe('위험');
    expect(render('{{#if hp > 50}}안전{{/if}}')).toBe('');
  });

  it('compares strings when the operands are not numbers', () => {
    expect(render('{{#if mood == "angry"}}화남{{/if}}')).toBe('화남');
    expect(render('{{#if mood == "calm"}}평온{{/if}}')).toBe('');
  });

  it('treats a bare variable as a truth value', () => {
    expect(render('{{#if hp}}있음{{/if}}')).toBe('있음');
    expect(render('{{#if none}}있음{{/if}}')).toBe('');
    expect(render('{{#if zero}}있음{{/if}}', { variables: { zero: '0' } })).toBe('');
  });

  it('nests', () => {
    expect(render('{{#if hp < 50}}A{{#if mood == "angry"}}B{{/if}}C{{/if}}')).toBe('ABC');
  });
});

describe('{{#each}}', () => {
  it('repeats its body over a comma-separated variable', () => {
    expect(render('{{#each party}}<li>{{slot}}</li>{{/each}}')).toBe(
      '<li>아리아</li><li>세이</li><li>루미</li>',
    );
  });

  it('accepts a list written out inline', () => {
    expect(render('{{#each a,b}}[{{slot}}]{{/each}}')).toBe('[a][b]');
  });

  it('renders nothing for an empty list', () => {
    expect(render('{{#each none}}x{{/each}}')).toBe('');
  });

  it('escapes the item, which comes from the model', () => {
    expect(render('{{#each list}}{{slot}}{{/each}}', { variables: { list: '<b>' } })).toBe('&lt;b&gt;');
  });
});

describe('malformed templates', () => {
  it('renders an unclosed block as its own escaped source', () => {
    expect(render('<div>{{#if hp}}열림</div>')).toBe('&lt;div&gt;{{#if hp}}열림&lt;/div&gt;');
  });

  it('renders a mismatched close as its own escaped source', () => {
    expect(render('{{#if hp}}x{{/each}}')).toBe('{{#if hp}}x{{/each}}');
  });

  it('renders a stray close as its own escaped source', () => {
    expect(render('x{{/if}}')).toBe('x{{/if}}');
  });

  it('caps nesting so a pathological template cannot blow up the render', () => {
    const open = '{{#if 1}}'.repeat(8);
    const close = '{{/if}}'.repeat(8);
    expect(render(`${open}깊음${close}`)).toBe('깊음');

    const tooDeep = `${'{{#if 1}}'.repeat(9)}깊음${'{{/if}}'.repeat(9)}`;
    expect(render(tooDeep)).toBe(
      tooDeep.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    );
  });

  it('bounds fan-out, which the depth cap does not', () => {
    // Eight legal levels of {{#each}} over a ten-item list is 10^8 renders from a
    // template that fits on one line. It has to come back, and come back fast.
    const list = Array.from({ length: 10 }, (_, i) => `i${i}`).join(',');
    const template = `${'{{#each list}}'.repeat(8)}x${'{{/each}}'.repeat(8)}`;
    const started = Date.now();
    // The budget is the caller's, so running out of it reaches the caller. It is
    // not turned into a short string here: a caller that charges for the result
    // would read thirty characters where a hundred million were spent, and buy the
    // same template again for the next match.
    expect(() => render(template, { variables: { list } })).toThrow(RenderBudgetExhausted);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('lets a fan-out that fits through', () => {
    expect(render('{{#each a,b}}{{#each c,d}}[{{slot}}]{{/each}}{{/each}}')).toBe('[c][d][c][d]');
  });

  it('bounds the output of a template that only repeats text', () => {
    const wide = Array.from({ length: 200 }, (_, i) => `i${i}`).join(',');
    expect(() =>
      render(`{{#each w}}${'x'.repeat(2000)}{{/each}}`, { variables: { w: wide } }),
    ).toThrow(RenderBudgetExhausted);
  });

  it('still hands a template the parser rejects back as its own source', () => {
    // The other half of the contract: a creator's typo is visible rather than
    // fatal, and is not confused with having run out of allowance.
    expect(render('{{#if a}}열림')).toBe('{{#if a}}열림');
  });

  it('leaves creator markup alone — only substituted values are escaped', () => {
    expect(render('<div class="hp">{{getvar::hp}}</div>')).toBe('<div class="hp">40</div>');
  });
});

describe('taint marking', () => {
  const raw = (template: string, overrides?: Partial<CbsContext>): string =>
    renderTemplate(template, ctx(overrides), generous());
  /** Renders with the marks made visible, so a test can say where they are. */
  const marked = (template: string, overrides?: Partial<CbsContext>): string =>
    raw(template, overrides).replaceAll(TAINT, '#');

  it('marks what the model chose and leaves what the platform did', () => {
    // getvar and calc read chat variables, and chat variables are model output.
    expect(marked('{{getvar::hp}}')).toBe('#40#');
    expect(marked('{{calc::hp + 1}}')).toBe('#41#');
    // char, user, turn, rel and img are ours, so a link built from them stands.
    expect(marked('{{char}} {{user}} {{turn}} {{rel::affection}} {{img::smile}}')).toBe(
      '아리아 민준 7 62 /api/plots/c1/assets/smile',
    );
  });

  it('marks an each item, because the list is usually a variable', () => {
    expect(marked('{{#each party}}[{{slot}}]{{/each}}')).toBe('[#아리아#][#세이#][#루미#]');
  });

  it('leaves the creator’s own template untouched', () => {
    expect(marked('<a href="https://example.test/x">링크</a>')).toBe(
      '<a href="https://example.test/x">링크</a>',
    );
  });

  it('refuses a mark the model wrote, so taint stays ours to give', () => {
    // A variable carrying the marker itself must not be able to un-mark anything,
    // nor to leave a stray control character in the output.
    expect(marked('{{getvar::x}}', { variables: { x: `a${TAINT}b` } })).toBe('#ab#');
  });

  it('carries the mark through a macro that reads a marked argument', () => {
    // The mark is stripped to parse the expression and put back on the answer.
    expect(marked(`{{calc::${TAINT}40${TAINT} + 2}}`)).toBe('#42#');
  });
});
