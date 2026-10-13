import { describe, expect, it, vi } from 'vitest';
import { pickHashRand } from '@shizue/core/cbs';
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

  it('reads variables through getvar and writes RisuAI’s null for an unknown key', () => {
    expect(render('{{getvar::hp}}/{{getvar::max}} {{getvar::none}}')).toBe('40/100 null');
  });

  it('still reads an unset variable as unset, not as the word null', () => {
    // SillyTavern's `{{if}}` finds the word `null` true, and an unset variable false.
    expect(render('{{if {{getvar::none}}}}있음{{else}}없음{{/if}}')).toBe('없음');
    expect(render('{{if .none}}있음{{else}}없음{{/if}}')).toBe('없음');
    expect(render('{{#if none}}있음{{/if}}{{calc::none + 1}}')).toBe('1');
    expect(render('{{#each none}}x{{/each}}')).toBe('');
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
      expect(render(`[{{getvar::${name}}}]`, { variables: {} }), name).toBe('[null]');
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

  it('runs the plot’s manual trigger of that name, as RisuAI’s does, and fills the composer otherwise', () => {
    const triggerNames = new Set(['공격', '"x']);
    expect(render('{{button::베기::공격}}', { triggerNames })).toBe(
      '<button type="button" risu-trigger="공격">베기</button>',
    );
    expect(render('{{button::인사::안녕}}', { triggerNames })).toBe(
      '<button type="button" data-shizue-fill="안녕">인사</button>',
    );
    // A trigger's name is escaped like any other value.
    expect(render('{{button::a::"x}}', { triggerNames })).toBe('<button type="button" risu-trigger="&quot;x">a</button>');
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

describe("RisuAI's {{#each LIST as name}}", () => {
  it('iterates a JSON array written inline, naming the item', () => {
    expect(render('{{#each ["a","b"] as item}}[{{slot::item}}]{{/each}}')).toBe('[a][b]');
  });

  it('iterates a JSON array a variable holds', () => {
    expect(
      render('{{#each {{getvar::list}} as name}}<li>{{slot::name}}</li>{{/each}}', {
        variables: { list: '["아리아","세이"]' },
      }),
    ).toBe('<li>아리아</li><li>세이</li>');
  });

  it('splits anything that is not a JSON array on §, as RisuAI does', () => {
    expect(render('{{#each 사과§배§감 as x}}[{{slot::x}}]{{/each}}')).toBe('[사과][배][감]');
    // A comma is not RisuAI's separator, and a bare name is not a variable there.
    expect(render('{{#each a,b as x}}[{{slot::x}}]{{/each}}')).toBe('[a,b]');
    expect(render('{{#each party as x}}[{{slot::x}}]{{/each}}')).toBe('[party]');
    expect(render('{{#each {"a":1} as x}}[{{slot::x}}]{{/each}}')).toBe('[{&quot;a&quot;:1}]');
  });

  it('writes an item that is not a string as JSON', () => {
    expect(render('{{#each [1,{"hp":2},null] as x}}[{{slot::x}}]{{/each}}')).toBe(
      '[1][{&quot;hp&quot;:2}][null]',
    );
  });

  it('renders nothing for an empty array, and an unset variable’s null as RisuAI does', () => {
    expect(render('{{#each [] as x}}[{{slot::x}}]{{/each}}')).toBe('');
    // `{{getvar}}` of an unset variable is the word `null`, which is no JSON array
    // and so — split on `§` — one item, as in RisuAI.
    expect(render('{{#each {{getvar::none}} as x}}[{{slot::x}}]{{/each}}')).toBe('[null]');
  });

  it('resolves each name to its own block, the outer one winning a shared name as in RisuAI', () => {
    expect(
      render('{{#each ["a","b"] as x}}{{#each ["1","2"] as y}}[{{slot::x}}{{slot::y}}]{{/each}}{{/each}}'),
    ).toBe('[a1][a2][b1][b2]');
    // RisuAI pastes the outer block's items over `{{slot::x}}` before the inner block runs.
    expect(render('{{#each ["a"] as x}}{{#each ["1"] as x}}[{{slot::x}}]{{/each}}{{/each}}')).toBe('[a]');
  });

  it('leaves a name no block gave as written', () => {
    expect(render('{{#each ["a"] as x}}[{{slot::y}}]{{/each}}')).toBe('[{{slot::y}}]');
    expect(render('{{slot::x}}')).toBe('{{slot::x}}');
  });

  it('unindents the body and trims the whole, unless it is ::keep', () => {
    const body = '\n  <li>{{slot::x}}</li>\n';
    expect(render(`{{#each ["a","b"] as x}}${body}{{/each}}`)).toBe('<li>a</li><li>b</li>');
    expect(render(`{{#each::keep ["a","b"] as x}}${body}{{/each}}`)).toBe(
      '\n  <li>a</li>\n\n  <li>b</li>\n',
    );
  });

  it('escapes an item, and never runs one as a macro the way RisuAI would', () => {
    expect(
      render('{{#each {{getvar::list}} as x}}[{{slot::x}}]{{/each}}', {
        variables: { list: '["<b>", "{{getvar::hp}}"]' },
      }),
    ).toBe('[&lt;b&gt;][{{getvar::hp}}]');
  });

  it('keeps ours: a bare name is a comma-separated variable, and any slot is the current item', () => {
    expect(render('{{#each party}}[{{slot}}|{{slot::member}}]{{/each}}')).toBe(
      '[아리아|아리아][세이|세이][루미|루미]',
    );
  });

  it('is paid for per iteration, and runs out rather than being cut short', () => {
    // The core stops an `#each` at 5,000 iterations and keeps what it has; a
    // status window with its tail missing is not one to draw, so the page's own
    // allowance runs out first and the whole render is given up.
    const list = (length: number) => JSON.stringify(Array.from({ length }, () => 'x'));
    for (const length of [4_500, 6_000]) {
      expect(() =>
        render('{{#each {{getvar::list}} as x}}{{slot::x}}{{/each}}', { variables: { list: list(length) } }),
      ).toThrow(RenderBudgetExhausted);
    }
    expect(render('{{#each {{getvar::list}} as x}}{{slot::x}}{{/each}}', { variables: { list: list(3) } })).toBe(
      'xxx',
    );
  });
});

describe('RisuAI templates', () => {
  const risu = (template: string, variables: Record<string, string>, overrides: Partial<CbsContext> = {}) =>
    render(template, { variables, ...overrides });

  it('nests conditions the way RisuAI cards write them', () => {
    const gauge = '{{#if {{? ($mp>-100)&($mp<251)}}}}<b>보통</b>{{/if}}{{#if {{? ($mp>250)}}}}<b>높음</b>{{/if}}';
    expect(risu(gauge, { mp: '120' })).toBe('<b>보통</b>');
    expect(risu(gauge, { mp: '300' })).toBe('<b>높음</b>');
    expect(risu('{{#if {{equal::{{getvar::outfit}}::casual}}}}평상복{{:else}}다른 옷{{/if}}', { outfit: 'suit' })).toBe(
      '다른 옷',
    );
  });

  it('reads a nested condition as RisuAI does — 1 or true — and a written-out one as ours', () => {
    expect(risu('{{#if {{getvar::n}}}}a{{/if}}{{#if n}}b{{/if}}', { n: '5' })).toBe('b');
  });

  it('draws an image where the markup has text, and gives its address inside a tag or a stylesheet', () => {
    expect(render('<div>{{img::smile}}</div>')).toBe(
      '<div><img src="/api/plots/c1/assets/smile" alt="smile"></div>',
    );
    expect(render('<div title="a>b" style="background:url({{img::smile}})">{{raw::smile}}</div>')).toBe(
      '<div title="a>b" style="background:url(/api/plots/c1/assets/smile)">/api/plots/c1/assets/smile</div>',
    );
    expect(render('<style>.a > .b { background: url({{image::smile}}) }</style><i>{{emotion::smile}}</i>')).toBe(
      '<style>.a > .b { background: url(/api/plots/c1/assets/smile) }</style><i><img src="/api/plots/c1/assets/smile" alt="smile"></i>',
    );
    expect(render('<img src="{{#if 1}}{{img::smile}}{{/if}}">')).toBe('<img src="/api/plots/c1/assets/smile">');
  });

  it('composes an image name at render time and resolves it by the card’s own names', () => {
    const resolveAsset = (ref: string) => (ref.toLowerCase() === 'wet_coat_2.webp' ? 'smile' : undefined);
    const template = '{{img::{{#if {{? ($rain=1)}}}}wet_{{/if}}{{getvar::outfit}}_2.webp}}';
    expect(risu(template, { rain: '1', outfit: 'coat' }, { resolveAsset })).toBe(
      '<img src="/api/plots/c1/assets/smile" alt="smile">',
    );
    expect(risu(template, { rain: '0', outfit: 'coat' }, { resolveAsset })).toBe('');
  });

  it('drops the asset macros a message has no counterpart for', () => {
    expect(render('[{{bg::a}}{{bgm::b}}{{audio::c}}{{video::d}}{{video-img::e}}{{inlay::f}}{{source::char}}]')).toBe('[]');
  });

  it('never lets a value reach past its own argument or name a foreign image', () => {
    expect(risu('{{getvar::x}}', { x: '{{img::smile}}' })).toBe('{{img::smile}}');
    expect(risu('{{equal::{{getvar::x}}::a}}', { x: 'a::a' })).toBe('0');
    expect(risu('[{{img::{{getvar::x}}}}]', { x: 'https://tracker.example.test/p.png' })).toBe('[]');
    expect(risu('{{random::{{getvar::x}}::{{getvar::x}}}}', { x: '<b>' })).toBe('&lt;b&gt;');
  });

  it('lays out by the window width, as RisuAI cards do', () => {
    vi.stubGlobal('window', { innerWidth: 500 });
    try {
      expect(render('{{#if {{? {{screen_width}} <= 768 }} }}좁음{{/if}}')).toBe('좁음');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('SillyTavern templates', () => {
  it('decides {{if}} on ST truth, reading .name as the chat variable', () => {
    expect(render('{{if .hp}}<b>HP {{getvar::hp}}</b>{{else}}없음{{/if}} · {{if !.none}} 평온 {{/if}}')).toBe(
      '<b>HP 40</b> · 평온',
    );
    expect(render('{{if {{getvar::flag}}}}켜짐{{else}}꺼짐{{/if}}', { variables: { flag: 'off' } })).toBe('꺼짐');
  });

  it('formats with trim, newline and space, the trim mark surviving the escaping', () => {
    expect(render('<b>a</b>\n{{trim}}\n<i>{{getvar::mood}}</i>{{newline}}{{space::2}}끝')).toBe(
      '<b>a</b><i>angry</i>\n  끝',
    );
  });

  it('renders an unclosed {{if}} as its own escaped source, like any unclosed block', () => {
    expect(render('{{if .hp}}열림')).toBe('{{if .hp}}열림');
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
    // char, user, turn, rel and an image's address are ours, so a link built
    // from them stands.
    expect(marked('{{char}} {{user}} {{turn}} {{rel::affection}} {{raw::smile}}')).toBe(
      '아리아 민준 7 62 /api/plots/c1/assets/smile',
    );
  });

  it('leaves an image unmarked even when the model chose which one', () => {
    expect(marked('<a href="{{img::{{getvar::face}}}}">', { variables: { face: 'smile' } })).toBe(
      '<a href="/api/plots/c1/assets/smile">',
    );
  });

  it('marks what a RisuAI function computed from a marked argument, and not from the template', () => {
    expect(marked('{{equal::{{getvar::mood}}::angry}} {{equal::a::a}}')).toBe('#1# 1');
    expect(marked(`{{random::${TAINT}잡힘${TAINT}}}`)).toBe('#잡힘#');
  });

  it('marks an each item, because the list is usually a variable', () => {
    expect(marked('{{#each party}}[{{slot}}]{{/each}}')).toBe('[#아리아#][#세이#][#루미#]');
    expect(marked('{{#each ["a"] as x}}[{{slot::x}}]{{/each}}')).toBe('[#a#]');
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

  it('never lets a capture choose which function runs or open a block', () => {
    // A capture is bound into the template before it is parsed, marked; the
    // mark is what keeps it an argument rather than a name or a keyword.
    expect(marked(`{{${TAINT}getvar::mood${TAINT}}}`)).toBe('#{{getvar::mood}}#');
    expect(marked(`{{${TAINT}#if 1${TAINT}}}x`)).toBe('#{{#if 1}}#x');
  });

  it('carries the mark through a macro that reads a marked argument', () => {
    // The mark is stripped to parse the expression and put back on the answer.
    expect(marked(`{{calc::${TAINT}40${TAINT} + 2}}`)).toBe('#42#');
  });
});

describe('what the browser tells RisuAI’s functions', () => {
  // The branch after its greeting, numbered as `chatIndex` numbers it.
  const branch: Partial<CbsContext> = {
    messages: [
      { role: 'user', data: '안녕', time: Date.UTC(2026, 9, 1, 3) },
      { role: 'char', data: '<b>반가워</b>', time: Date.UTC(2026, 9, 1, 3, 1) },
      { role: 'user', data: '잘 지냈어?', time: Date.UTC(2026, 9, 1, 3, 2) },
    ],
    wholeBranch: true,
    chatIndex: 1,
    lastMessageId: 2,
    chatId: 'chat-1',
  };

  const marked = (template: string, overrides?: Partial<CbsContext>): string =>
    renderTemplate(template, ctx(overrides), generous()).replaceAll(TAINT, '#');

  it('answers the chat functions over a whole branch, from this message', () => {
    expect(render('{{lastmessage}}|{{previous_user_chat}}|{{chat_index}}/{{lastmessageid}}', branch)).toBe(
      '잘 지냈어?|안녕|1/2',
    );
    expect(render('{{previous_chat_log::1}}', branch)).toBe('&lt;b&gt;반가워&lt;/b&gt;');
    expect(render('{{history::role}}', branch)).toBe(
      '[&quot;user: 안녕&quot;,&quot;char: &lt;b&gt;반가워&lt;/b&gt;&quot;,&quot;user: 잘 지냈어?&quot;]',
    );
  });

  it('leaves them as written over a stretch of the branch, keeping its own numbering', () => {
    const windowed = { ...branch, wholeBranch: false };
    expect(render('{{lastmessage}} {{history}} {{previous_user_chat}}', windowed)).toBe(
      '{{lastmessage}} {{history}} {{previous_user_chat}}',
    );
    expect(render('{{chat_index}}/{{lastmessageid}}', windowed)).toBe('1/2');
  });

  it('never lets a message become markup, and marks it so a link built of it is inert', () => {
    const tracker = {
      ...branch,
      messages: [{ role: 'char' as const, data: 'https://tracker.example.test/"><script>' }],
      chatIndex: 0,
      lastMessageId: 0,
    };
    expect(marked('<a href="{{lastmessage}}">{{lastmessage}}</a>', tracker)).toBe(
      '<a href="#https://tracker.example.test/&quot;&gt;&lt;script&gt;#">#https://tracker.example.test/&quot;&gt;&lt;script&gt;#</a>',
    );
  });

  it('says whose message it is, and whether it is the greeting', () => {
    expect(render('{{role}} {{isfirstmsg}}', branch)).toBe('char 0');
    expect(render('{{role}} {{isfirstmsg}}', { ...branch, chatIndex: 2 })).toBe('user 0');
    expect(render('{{role}} {{isfirstmsg}}', { ...branch, chatIndex: -1 })).toBe('char 1');
    // Without a place on the branch there is nothing to say.
    expect(render('{{role}} {{isfirstmsg}}')).toBe('{{role}} {{isfirstmsg}}');
  });

  it('picks as RisuAI does: the chat, and the branch’s length', () => {
    const index = Math.floor(pickHashRand(3, 'chat-1') * 4);
    expect(render('{{pick::a::b::c::d}}', branch)).toBe(['a', 'b', 'c', 'd'][index]);
    // One draw for the whole render, so two picks over the same options agree.
    const both = render('{{pick::a::b::c::d}}{{pick::a::b::c::d}}', branch);
    expect(both[0]).toBe(both[1]);
  });

  it('reads the reader’s global variables, and leaves getglobalvar as written without them', () => {
    const globals = { globalVariables: { met: '1', toggle_dark: '1' } };
    expect(render('{{getglobalvar::met}} {{getglobalvar::none}} {{? @met + 1}}', globals)).toBe('1 null 2');
    expect(render('{{#when::toggle::dark}}어둡게{{/when}}', globals)).toBe('어둡게');
    expect(render('{{#if @met}}만남{{/if}}', globals)).toBe('만남');
    expect(render('{{getglobalvar::met}}')).toBe('{{getglobalvar::met}}');
    expect(marked('{{getglobalvar::met}}', globals)).toBe('#1#');
  });

  it('lists the open images, and answers for the screen, the clock and the language', () => {
    expect(render('{{assetlist}} {{emotionlist}}', { assetNames: ['face.png', 'smile'] })).toBe(
      '[&quot;face.png&quot;,&quot;smile&quot;] [&quot;face.png&quot;,&quot;smile&quot;]',
    );
    expect(render('{{assetlist}}')).toBe('{{assetlist}}');
    expect(render('{{metadata::language}}', { locale: 'ko' })).toBe('ko');
    expect(render('{{comment::메모}}')).toBe('<div class="risu-comment">메모</div>');
    expect(render('{{unixtime}}')).toMatch(/^\d+$/);
    vi.stubGlobal('window', { innerWidth: 500, innerHeight: 900 });
    try {
      expect(render('{{screen_width}}x{{screen_height}}')).toBe('500x900');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the display unescape', () => {
  it('shows what #escape and #puredisplay kept as written, as text', () => {
    expect(render('{{#escape}}{{getvar::hp}}{{/escape}}')).toBe('{{getvar::hp}}');
    expect(render('{{#puredisplay}}{{getvar::hp}}{{/puredisplay}}')).toBe('{{getvar::hp}}');
  });

  it('turns an escaped angle bracket into an entity, never a tag', () => {
    expect(render('{{deabo}}b{{deabc}}굵게{{<}}/b{{>}}')).toBe('&lt;b&gt;굵게&lt;/b&gt;');
  });

  it('leaves the markup #escape does not escape — only braces and parentheses, as RisuAI', () => {
    expect(render('{{#escape}}<b>(굵게)</b>{{/escape}}')).toBe('<b>(굵게)</b>');
  });
});
