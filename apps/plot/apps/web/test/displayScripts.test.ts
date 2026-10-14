// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  applyDisplayScripts,
  MAX_HTML_CHARS,
  MAX_MATCHES_PER_SCRIPT,
  MAX_SCANNED_CHARS,
  MAX_SEGMENTS,
  readCustomUiEnabled,
  sameVariables,
  writeCustomUiEnabled,
  type DisplayContext,
  type Segment,
} from '../src/lib/displayScripts';
import { sanitizeCustomHtml } from '../src/lib/sanitizeHtml';
import type { DisplayScript } from '../src/lib/types';
import { normalizeCard } from '@shizue/core';

const script = (overrides: Partial<DisplayScript> = {}): DisplayScript => ({
  in: '\\[status\\] hp=(\\d+)',
  out: '<div class="hp">HP $1</div>',
  order: 0,
  enabled: true,
  ...overrides,
});

const context = (scripts: DisplayScript[], overrides: Partial<DisplayContext> = {}): DisplayContext => ({
  scripts,
  variables: { gold: '12' },
  assets: new Map(),
  relationship: null,
  turn: 1,
  char: '아리아',
  user: '민준',
  ...overrides,
});

const html = (segments: Segment[]): string[] =>
  segments.filter((segment) => segment.kind === 'html').map((segment) => segment.html);
const text = (segments: Segment[]): string[] =>
  segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text);

describe('applyDisplayScripts', () => {
  it('leaves the message alone when there is nothing to apply', () => {
    expect(applyDisplayScripts('안녕', context([]))).toEqual([{ kind: 'text', text: '안녕' }]);
    expect(applyDisplayScripts('안녕', context([script({ enabled: false })]))).toEqual([
      { kind: 'text', text: '안녕' },
    ]);
  });

  it('splits the message around the match and renders it as html', () => {
    const segments = applyDisplayScripts('앞 [status] hp=50 뒤', context([script()]));
    expect(text(segments)).toEqual(['앞 ', ' 뒤']);
    expect(html(segments)).toEqual(['<div class="x-shizue-hp">HP 50</div>']);
  });

  it('rewrites every occurrence, not just the first', () => {
    const segments = applyDisplayScripts('[status] hp=50 그리고 [status] hp=20', context([script()]));
    expect(html(segments)).toHaveLength(2);
  });

  it('applies scripts in order, each over what the ones before it wrote', () => {
    // Scripts chain, as RisuAI's and SillyTavern's do: a later pattern sees an
    // earlier template's text. This used to be refused outright — an earlier
    // output was final — and imported cards that build a panel in several steps
    // came out as raw tags. The provenance tests below are what make it safe.
    const segments = applyDisplayScripts(
      '[status] hp=50',
      context([
        script({ order: 1, in: 'HP', out: '<b>겹침</b>' }),
        script({ order: 0 }),
      ]),
    );
    expect(html(segments)).toEqual(['<div class="x-shizue-hp"><b>겹침</b> 50</div>']);
  });

  it('binds $&, numbered and named groups', () => {
    const segments = applyDisplayScripts(
      'hp=50/100',
      context([script({ in: 'hp=(?<now>\\d+)/(\\d+)', out: '<i>$& $1 $2 $<now></i>' })]),
    );
    expect(html(segments)).toEqual(['<i>hp=50/100 50 100 50</i>']);
  });

  it('leaves an unused group reference as literal text', () => {
    const segments = applyDisplayScripts('hp=50', context([script({ in: 'hp=(\\d+)', out: '<i>$1 $7</i>' })]));
    expect(html(segments)).toEqual(['<i>50 $7</i>']);
  });

  it('reads two digits as String.prototype.replace does', () => {
    // `$10` is group 10 when there is one, and `$1` then `0` when there is not;
    // `$01` is group 1. The expected strings are what `replace` itself gives.
    const ten = '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)';
    expect(
      html(applyDisplayScripts('abcdefghij', context([script({ in: ten, out: '<i>$10 $11 $1 $01</i>' })]))),
    ).toEqual([`<i>${'abcdefghij'.replace(new RegExp(ten), '$10 $11 $1 $01')}</i>`]);
    expect('abcdefghij'.replace(new RegExp(ten), '$10 $11 $1 $01')).toBe('j a1 a a');

    expect(
      html(applyDisplayScripts('hp=50', context([script({ in: 'hp=(\\d+)', out: '<i>$10|$01</i>' })]))),
    ).toEqual(['<i>500|50</i>']);
  });

  it('binds nothing for a group that took no part in the match, as replace does', () => {
    const segments = applyDisplayScripts('b', context([script({ in: '(a)|(b)', out: '<i>[$1|$2]</i>' })]));
    expect(html(segments)).toEqual(['<i>[|b]</i>']);
  });

  it('still binds $0 to the whole match, where replace would leave it literal', () => {
    const segments = applyDisplayScripts('hp=50', context([script({ in: 'hp=(\\d+)', out: '<i>$0</i>' })]));
    expect(html(segments)).toEqual(['<i>hp=50</i>']);
  });

  it('runs scripts with the same order in list order', () => {
    const segments = applyDisplayScripts(
      'x',
      context([
        script({ order: 1, in: 'z', out: '<u>$&</u>' }),
        script({ order: 0, in: 'x', out: 'y' }),
        script({ order: 0, in: 'y', out: '<b>z</b>' }),
      ]),
    );
    // x → y, then y → <b>z</b>, then the z inside is wrapped. Reversed, the tie
    // would leave a bare `y`.
    expect(html(segments)).toEqual(['<b><u>z</u></b>']);
  });

  it('binds the chat variables and platform values a template asks for', () => {
    const segments = applyDisplayScripts(
      '[status] hp=50',
      context([script({ out: '<p>{{getvar::gold}} {{char}} {{calc::$1 / 2}}</p>' })]),
    );
    expect(html(segments)).toEqual(['<p>12 아리아 25</p>']);
  });

  it('reads a captured value as markup and CBS, as RisuAI does, and the sanitizer still holds it', () => {
    // The owner's call of 2026-10-14 (`bindCapture`): the model's words in a
    // template are the template's, as in RisuAI, and only the sanitizer stands
    // between them and the page.
    const segments = applyDisplayScripts(
      'say:<img src=x onerror=alert(1)>',
      context([script({ in: 'say:(.*)', out: '<p>$1</p>' })]),
    );
    expect(html(segments)[0]).toBe('<p><img src="x"></p>');

    const macro = applyDisplayScripts(
      'say:{{button::라벨::텍스트}}',
      context([script({ in: 'say:(.*)', out: '<p>$1</p>' })]),
    );
    expect(html(macro)[0]).toBe(
      '<p><button type="button" class="x-shizue-button-default" data-shizue-fill="텍스트">라벨</button></p>',
    );
  });

  it('walks a list a capture holds, as RisuAI does', () => {
    const segments = applyDisplayScripts(
      'items:["검","방패"]',
      context([script({ in: 'items:(.+)', out: '<ul>{{#each $1 as item}}<li>{{slot::item}}</li>{{/each}}</ul>' })]),
    );
    expect(html(segments)).toEqual(['<ul><li>검</li><li>방패</li></ul>']);
  });

  it('reads a macro a capture completes', () => {
    const segments = applyDisplayScripts(
      'stat:gold',
      context([script({ in: 'stat:(\\w+)', out: '<b>{{getvar::$1}}</b>' })]),
    );
    expect(html(segments)).toEqual(['<b>12</b>']);
  });

  it('disables a script whose pattern does not compile', () => {
    const segments = applyDisplayScripts('x', context([script({ in: '([' })]));
    expect(segments).toEqual([{ kind: 'text', text: 'x' }]);
  });

  it('does not loop on a pattern that can match nothing', () => {
    const segments = applyDisplayScripts('ab', context([script({ in: 'x*', out: '<i>·</i>' })]));
    expect(html(segments).length).toBeLessThanOrEqual(3);
  });
});

describe('chaining', () => {
  const ordered = (...scripts: Partial<DisplayScript>[]): DisplayScript[] =>
    scripts.map((overrides, order) => script({ order, ...overrides }));

  it('keeps a block one script opened in one piece after a later one rewrote its middle', () => {
    const scripts = ordered(
      { in: '\\[pic (\\w+)\\]', out: '{{#if {{equal::{{getvar::show}}::1}}}}<p>[img $1]</p>{{/if}}' },
      { in: '\\[img (\\w+)\\]', out: '<b>$1</b>' },
    );
    expect(html(applyDisplayScripts('[pic face]', context(scripts, { variables: { show: '1' } })))).toEqual([
      '<p><b>face</b></p>',
    ]);
    // Read before the next script runs, as RisuAI reads it: the block is gone, and
    // the later script finds nothing to rewrite.
    expect(html(applyDisplayScripts('[pic face]', context(scripts, { variables: { show: '0' } })))).toEqual([]);
  });

  it('leaves a block one script opened for a later one to close', () => {
    const segments = applyDisplayScripts(
      '[a]',
      context(
        ordered(
          { in: '\\[a\\]', out: '{{#if {{equal::{{getvar::gold}}::12}}}}<i>open [close]' },
          { in: '\\[close\\]', out: 'shut</i>{{/if}}' },
        ),
      ),
    );
    expect(html(segments)).toEqual(['<i>open shut</i>']);
  });

  it('matches across the model’s words and an earlier script’s markup', () => {
    const segments = applyDisplayScripts(
      'A <pk-panel>hp 5</pk-panel> B',
      context(
        ordered(
          { in: 'hp (\\d+)', out: '<i>$1</i>' },
          { in: '<pk-panel>([\\s\\S]*?)</pk-panel>', out: '<div class="card">$1</div>' },
        ),
      ),
    );
    expect(text(segments)).toEqual(['A ', ' B']);
    expect(html(segments)).toEqual(['<div class="x-shizue-card"><i>5</i></div>']);
  });

  it('reads the model’s words as RisuAI does, however many scripts move them, and nothing runs', () => {
    const segments = applyDisplayScripts(
      '<pk-panel>{{getvar::secret}} <b>굵게</b><script>alert(1)</script><img src="x" onerror="alert(1)"></pk-panel>',
      context(
        ordered(
          {
            in: '<pk-panel>([\\s\\S]*?)</pk-panel>',
            out: '{{#if {{equal::1::1}}}}<div class="card">$1</div>{{/if}}',
          },
          // A later script reaches into the captured words and wraps part of them.
          { in: '굵게', out: '<u>$&</u>' },
        ),
        { variables: { secret: 'SHOWN' } },
      ),
    );
    const [island] = html(segments);
    expect(island).toContain('<div class="x-shizue-card">SHOWN <b><u>굵게</u></b>');
    expect(island).not.toContain('<script');
    expect(island).not.toContain('onerror');
  });

  it('lets $& put the model’s words back for a later script to match again', () => {
    const segments = applyDisplayScripts(
      'hp=5',
      context(ordered({ in: 'hp=(\\d+)', out: '<span>$&</span>' }, { in: 'hp=', out: '<b>HP </b>' })),
    );
    expect(html(segments)).toEqual(['<span><b>HP </b>5</span>']);
  });

  it('keeps the model’s words prose when a template only rearranges them', () => {
    // RisuAI cards trim the blank lines around an image this way; nothing of the
    // creator's is added, so it is still markdown, not an island.
    const segments = applyDisplayScripts(
      'a\n\n<img src="x">\n\nb',
      context(ordered({ in: '\\s*(<img src="[^"]*">)\\s*', out: '$1' })),
    );
    expect(segments).toEqual([{ kind: 'text', text: 'a<img src="x">b' }]);
  });

  it('keeps a zero-length match inside the block it fell in', () => {
    const segments = applyDisplayScripts(
      '[s]',
      context(ordered({ in: '\\[s\\]', out: '<p>ab</p>' }, { in: '(?=b)', out: '<i>·</i>' })),
    );
    expect(html(segments)).toEqual(['<p>a<i>·</i>b</p>']);
  });

  it('draws a RisuAI card’s panel and picture the way the card builds them', () => {
    // Parma Knights' scripts, cut down: trim around an image, show it on the last
    // turns only, draw it if the plot has one by that name, and wrap the panel.
    const scripts = ordered(
      { in: '<pk-time>\\s*(.+?)\\s*\\|\\s*(.+?)\\s*</pk-time>', out: '<div class="pk-time">$1 · $2</div>' },
      { in: '\\s*(<img src="[^"]*">)\\s*', out: '$1' },
      {
        in: '<img src="(.+?)">',
        out: '{{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-2}}}}}}\n<img src="$1">\n{{/if}}',
      },
      {
        in: '<img src="(([^"\\-]+)(-[^"]*)?)"?>',
        out:
          '{{#when::{{contains::{{assetlist}}::$1}}}}<div class="image-container" ' +
          'style="background-image: url(\'{{raw::$1}}\');"></div>{{/when}}',
      },
      { in: '<pk-panel>([\\s\\S]*?)</pk-panel>', out: '<div class="pk-card">$1</div>' },
    );
    const content = '부임 첫날.\n\n<img src="face">\n\n<pk-panel>\n<pk-time>1247 | 본부</pk-time>\n</pk-panel>';
    const bound = (overrides: Partial<DisplayContext>) =>
      context(scripts, {
        assets: new Map([['face', '/api/plots/p/assets/face']]),
        assetNames: ['face'],
        chatIndex: -1,
        lastMessageId: -1,
        ...overrides,
      });

    const drawn = applyDisplayScripts(content, bound({}));
    expect(text(drawn)).toEqual(['부임 첫날.']);
    const [picture, panel] = html(drawn);
    expect(picture).toContain('class="x-shizue-image-container"');
    expect(picture).toContain("url('/api/plots/p/assets/face')");
    expect(panel).toBe('<div class="x-shizue-pk-card">\n<div class="x-shizue-pk-time">1247 · 본부</div>\n</div>');

    // No image by that name: the reference goes, rather than drawing a broken one.
    expect(html(applyDisplayScripts(content, bound({ assetNames: [] })))[0]).not.toContain('image-container');
    // An old turn: the card keeps pictures to the last three.
    expect(html(applyDisplayScripts(content, bound({ chatIndex: 0, lastMessageId: 9 })))[0]).not.toContain(
      'image-container',
    );
  });
});

describe('RisuAI’s order', () => {
  const ordered = (...scripts: Partial<DisplayScript>[]): DisplayScript[] =>
    scripts.map((overrides, order) => script({ order, ...overrides }));

  it('reads the message’s own CBS before any script matches', () => {
    const segments = applyDisplayScripts(
      '{#if {{equal::{{getvar::gold}}::12}} #}보임',
      context(ordered({ in: '\\{#if 1 #\\}', out: '' }, { in: '\\{#if 0 #\\}', out: '' })),
    );
    expect(segments).toEqual([{ kind: 'text', text: '보임' }]);
  });

  it('reads each script’s output again before the next one sees it', () => {
    // A RisuAI card's picker (Ivy, Kang Seo-woo): one script writes a marker out
    // of a condition, and a later one strips the marker the condition became.
    const segments = applyDisplayScripts(
      'R10 start.\n{#if {{equal::1::1}} #}R10 GREETING\n[PICK]',
      context(
        ordered(
          { in: '\\[PICK\\]', out: '<div class="r10">{#if {{equal::1::0}} #}R10 PICKER</div>' },
          { in: '\\{#if 1 #\\}', out: '' },
          { in: '\\{#if 0 #\\}', out: '' },
        ),
      ),
    );
    expect(text(segments).join('')).toBe('R10 start.\nR10 GREETING\n');
    expect(html(segments)).toEqual(['<div class="x-shizue-r10">R10 PICKER</div>']);
  });

  it('leaves the message’s pictures to its prose, and draws one a script takes into its markup', () => {
    const assets = new Map([['smile', '/api/plots/c1/assets/smile']]);
    const prose = applyDisplayScripts('앞 {{img::smile}} 뒤', context(ordered({ in: '없음', out: 'x' }), { assets }));
    expect(prose).toEqual([{ kind: 'text', text: '앞 {{img::smile}} 뒤' }]);
    const wrapped = applyDisplayScripts(
      '앞 {{img::smile}} 뒤',
      context(ordered({ in: '^[\\s\\S]*$', out: '<div class="wrap">$&</div>' }), { assets }),
    );
    expect(html(wrapped)).toEqual([
      '<div class="x-shizue-wrap">앞 <img src="/api/plots/c1/assets/smile" alt="smile"> 뒤</div>',
    ]);
  });

  it('reads a message’s own CBS with no script at all, as RisuAI reads every message it shows', () => {
    // A card with no display script: a `{{getvar}}` the model wrote, and RisuAI's name tag.
    expect(applyDisplayScripts('<user>, 금화 {{getvar::gold}}닢', context([]))).toEqual([
      { kind: 'text', text: '민준, 금화 12닢' },
    ]);
    // Values stay prose: the model's markup in one is the message's own HTML, drawn by its rules.
    expect(applyDisplayScripts('{{getvar::note}}', context([], { variables: { note: '<b>굵게</b>' } }))).toEqual([
      { kind: 'text', text: '<b>굵게</b>' },
    ]);
  });

  it('draws {{random}} again when RisuAI would redraw — the variables or the text moved — and not otherwise', () => {
    const drawn = (content: string, overrides: Partial<DisplayContext>): string =>
      text(applyDisplayScripts(content, context([], overrides))).join('');
    const roll = '{{random}} {{roll::20}} {{randint::1::1000}}';
    const at = { drawKey: 'chat\u0000vars-a', chatIndex: 3 };
    // Another message arriving builds new bindings; the same redraw draws the same.
    expect(drawn(roll, at)).toBe(drawn(roll, { ...at, lastMessageId: 9 }));
    expect(drawn(roll, { ...at, drawKey: 'chat\u0000vars-b' })).not.toBe(drawn(roll, at));
    expect(drawn(`${roll} 다시`, at).startsWith(drawn(roll, at))).toBe(false);
    // Two messages that say the same thing still draw apart.
    expect(drawn(roll, { ...at, chatIndex: 4 })).not.toBe(drawn(roll, at));
    // A script's template draws on from where the message's own CBS left off.
    const scripted = applyDisplayScripts(
      '[status] hp=50',
      context([script({ out: '<div class="hp">{{random::가,나,다,라,마,바,사,아}}{{random}}</div>' })], at),
    );
    expect(html(scripted)).toEqual(
      html(
        applyDisplayScripts(
          '[status] hp=50',
          context([script({ out: '<div class="hp">{{random::가,나,다,라,마,바,사,아}}{{random}}</div>' })], { ...at, turn: 7 }),
        ),
      ),
    );
  });

  it('answers {{trigger_id}} as RisuAI does: the button that just ran, else null', () => {
    expect(applyDisplayScripts('id={{trigger_id}}', context([]))).toEqual([{ kind: 'text', text: 'id=null' }]);
    expect(applyDisplayScripts('id={{triggerid}}', context([], { triggerId: 'tab-2' }))).toEqual([
      { kind: 'text', text: 'id=tab-2' },
    ]);
  });
});

describe('actions', () => {
  it('move_top lifts the match above the prose', () => {
    const segments = applyDisplayScripts(
      '인사 [status] hp=50 끝',
      context([script({ action: 'move_top' })]),
    );
    expect(segments[0]).toEqual({ kind: 'html', html: '<div class="x-shizue-hp">HP 50</div>' });
    // The prose closes over the hole the match left, as it does in RisuAI.
    expect(text(segments)).toEqual(['인사  끝']);
  });

  it('move_bottom drops the match below the prose', () => {
    const segments = applyDisplayScripts(
      '인사 [status] hp=50 끝',
      context([script({ action: 'move_bottom' })]),
    );
    expect(segments[segments.length - 1]).toEqual({
      kind: 'html',
      html: '<div class="x-shizue-hp">HP 50</div>',
    });
  });

  it('repeat_back reuses the previous same-role match when this turn has none', () => {
    const segments = applyDisplayScripts(
      '아무 말도 하지 않았다',
      context([script({ action: 'repeat_back' })]),
      '[status] hp=50',
    );
    expect(segments[0]).toEqual({ kind: 'html', html: '<div class="x-shizue-hp">HP 50</div>' });
    expect(text(segments)).toEqual(['아무 말도 하지 않았다']);
  });

  it('repeat_back prefers this turn own match', () => {
    const segments = applyDisplayScripts(
      '[status] hp=20',
      context([script({ action: 'repeat_back' })]),
      '[status] hp=50',
    );
    expect(html(segments)).toEqual(['<div class="x-shizue-hp">HP 20</div>']);
  });

  it('repeat_back renders nothing when there is no previous match either', () => {
    const segments = applyDisplayScripts(
      '조용하다',
      context([script({ action: 'repeat_back' })]),
      '이전에도 조용했다',
    );
    expect(html(segments)).toEqual([]);
  });
});

describe('how many matches a script rewrites', () => {
  const twice = '[status] hp=50 그리고 [status] hp=20';

  it('rewrites the first match only when the script carries flags without g', () => {
    // RisuAI's reading, and SillyTavern's: `replace` with a pattern that is not global.
    const segments = applyDisplayScripts(twice, context([script({ flags: 'i' })]));
    expect(html(segments)).toEqual(['<div class="x-shizue-hp">HP 50</div>']);
    expect(text(segments)).toEqual([' 그리고 [status] hp=20']);
  });

  it('rewrites every match with g, or with no flags at all', () => {
    expect(html(applyDisplayScripts(twice, context([script({ flags: 'gi' })])))).toHaveLength(2);
    expect(html(applyDisplayScripts(twice, context([script()])))).toHaveLength(2);
    expect(html(applyDisplayScripts(twice, context([script({ flags: '' })])))).toHaveLength(2);
  });

  it('moves the first match only when the flags have no g, and leaves the rest in place', () => {
    const segments = applyDisplayScripts(twice, context([script({ action: 'move_top', flags: 'u' })]));
    expect(segments[0]).toEqual({ kind: 'html', html: '<div class="x-shizue-hp">HP 50</div>' });
    expect(text(segments)).toEqual([' 그리고 [status] hp=20']);
  });

  it('still moves every match for a script written in the editor, which carries no flags', () => {
    const segments = applyDisplayScripts(twice, context([script({ action: 'move_bottom' })]));
    expect(html(segments)).toHaveLength(2);
    expect(text(segments)).toEqual([' 그리고 ']);
  });

  it('runs an imported RisuAI script the way RisuAI does', () => {
    const card = normalizeCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '루미',
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
        character_version: '',
        extensions: {
          risuai: {
            customScripts: [
              {
                in: '\\[status\\] hp=(\\d+)',
                out: '<div class="hp">HP $1</div>',
                type: 'editdisplay',
                ableFlag: true,
                flag: 'gi<move_top, order 3>',
              },
            ],
          },
        },
      },
    });
    const segments = applyDisplayScripts(twice.toUpperCase(), context(card.displayScripts ?? []));
    // Case-blind from the `i`, moved by the directive, and once: the move took the `g`.
    expect(segments[0]).toEqual({ kind: 'html', html: '<div class="x-shizue-hp">HP 50</div>' });
    expect(text(segments)).toEqual([' 그리고 [STATUS] HP=20']);
  });
});

describe('the render budget', () => {
  /** Every cap answers the same way: the message, exactly as the model wrote it. */
  const isPlain = (segments: Segment[], content: string): boolean =>
    segments.length === 1 && segments[0]!.kind === 'text' && segments[0]!.text === content;

  it('does not scan a message longer than the cap', () => {
    const long = `[status] hp=50 ${'가'.repeat(MAX_SCANNED_CHARS)}`;
    expect(isPlain(applyDisplayScripts(long, context([script()])), long)).toBe(true);
    // One character under, and it is transformed as usual.
    const short = `[status] hp=50 ${'가'.repeat(MAX_SCANNED_CHARS - 20)}`;
    expect(html(applyDisplayScripts(short, context([script()])))).toHaveLength(1);
  });

  it('abandons a message that matches more times than a script may', () => {
    const many = 'hp=1 '.repeat(MAX_MATCHES_PER_SCRIPT + 1);
    const segments = applyDisplayScripts(many, context([script({ in: 'hp=(\\d+)', out: '<i>$1</i>' })]));
    expect(isPlain(segments, many)).toBe(true);
  });

  it('abandons a message that would be cut into more pieces than the cap', () => {
    const many = 'hp=1 '.repeat(MAX_SEGMENTS);
    const segments = applyDisplayScripts(many, context([script({ in: 'hp=(\\d+)', out: '<i>$1</i>' })]));
    expect(isPlain(segments, many)).toBe(true);
  });

  it('abandons a message that would produce more html than the cap', () => {
    // Few matches, enormous template: the match and segment caps never fire, and
    // the output cap is the only thing between the reader and a megabyte of DOM.
    const wide = `<div>${'x'.repeat(MAX_HTML_CHARS * 0.6)}</div>`;
    const content = 'hp=1 hp=2';
    const segments = applyDisplayScripts(
      content,
      context([script({ in: 'hp=(\\d+)', out: wide })]),
    );
    expect(isPlain(segments, content)).toBe(true);
  });

  it('abandons a message once the deadline passes, mid-run', () => {
    const content = 'hp=1 hp=2 hp=3 hp=4';
    let clock = 0;
    // First call sets the deadline; every check after it is already too late.
    const now = (): number => (clock += 10_000);
    const segments = applyDisplayScripts(
      content,
      context([script({ in: 'hp=(\\d+)', out: '<i>$1</i>' })]),
      '',
      now,
    );
    expect(isPlain(segments, content)).toBe(true);
  });

  it('renders plainly rather than partially when a later script blows a cap', () => {
    const content = `[status] hp=50 ${'hp=1 '.repeat(MAX_MATCHES_PER_SCRIPT + 1)}`;
    const segments = applyDisplayScripts(
      content,
      context([script({ order: 0 }), script({ order: 1, in: 'hp=(\\d+)', out: '<i>$1</i>' })]),
    );
    // The first script had already matched; nothing of it survives the abandon.
    expect(isPlain(segments, content)).toBe(true);
  });
});

describe('zero-length matches', () => {
  /**
   * Resuming at `lastIndex + 1` lands between the halves of a surrogate pair, and
   * a unicode-aware engine rounds that back down to where the pair starts — so
   * the same empty match is found again, forever. The budget stops the spin, but
   * a spin that has to be stopped means the message never renders: these assert
   * the transform actually completes, which is what pins the code-point advance.
   */
  it('walks astral text one code point at a time under the u flag', () => {
    const segments = applyDisplayScripts(
      '🙂🙂',
      context([script({ in: '(?=)', flags: 'gu', out: '<i>·</i>' })]),
    );
    expect(text(segments)).toEqual(['🙂', '🙂']);
    expect(html(segments)).toHaveLength(3);
  });

  it('does the same under the v flag', () => {
    const segments = applyDisplayScripts(
      '🙂🙂🙂',
      context([script({ in: 'x*', flags: 'gv', out: '<i>·</i>' })]),
    );
    expect(text(segments)).toEqual(['🙂', '🙂', '🙂']);
    // Never a half of a pair on its own — that is mojibake on screen.
    expect(text(segments).join('')).toBe('🙂🙂🙂');
  });

  it('still advances by one for a pattern that is not unicode-aware', () => {
    const segments = applyDisplayScripts('ab', context([script({ in: 'x*', out: '<i>·</i>' })]));
    expect(text(segments)).toEqual(['a', 'b']);
  });
});

describe('sameVariables', () => {
  it('is true only when both maps say the same thing', () => {
    expect(sameVariables({ hp: '1' }, { hp: '1' })).toBe(true);
    expect(sameVariables({}, {})).toBe(true);
    expect(sameVariables({ hp: '1' }, { hp: '2' })).toBe(false);
    expect(sameVariables({ hp: '1' }, { hp: '1', gold: '2' })).toBe(false);
    expect(sameVariables({ hp: '1', gold: '2' }, { hp: '1' })).toBe(false);
    expect(sameVariables({ hp: '1' }, { gold: '1' })).toBe(false);
  });
});

describe('the viewer opt-out', () => {
  it('defaults to on and round-trips through localStorage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });

    expect(readCustomUiEnabled()).toBe(true);
    writeCustomUiEnabled(false);
    expect(readCustomUiEnabled()).toBe(false);
    writeCustomUiEnabled(true);
    expect(readCustomUiEnabled()).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe('a link the model got to write', () => {
  it('renders a creator-written link as a link', () => {
    const segments = applyDisplayScripts(
      '[status] hp=50',
      context([script({ out: '<a href="https://example.test/guide">가이드</a>' })]),
    );
    expect(html(segments)[0]).toContain('href="https://example.test/guide"');
  });

  it('renders one built out of a chat variable as text, address and all', () => {
    // The chat variable is whatever the model's `{{setvar}}` said, so this is the
    // model choosing where the reader lands. It does not get to be a link.
    const segments = applyDisplayScripts(
      '[status] hp=50',
      context([script({ out: '<a href="{{getvar::link}}">여기</a>' })], {
        variables: { link: 'https://evil.test/phish' },
      }),
    );
    const output = html(segments)[0]!;
    expect(output).not.toContain('href');
    expect(output).toContain('여기');
    expect(output).toContain('(https://evil.test/phish)');
  });

  it('does the same when the model only supplied the path', () => {
    const segments = applyDisplayScripts(
      '[status] hp=50',
      context([script({ out: '<a href="https://example.test/{{getvar::path}}">여기</a>' })], {
        variables: { path: 'x' },
      }),
    );
    expect(html(segments)[0]).not.toContain('href');
  });

  it('does the same for a capture, which is model output by another route', () => {
    const segments = applyDisplayScripts(
      '[link] https://evil.test/steal',
      context([
        script({ in: '\\[link\\] (\\S+)', out: '<a href="$1">열기</a>' }),
      ]),
    );
    expect(html(segments)[0]).not.toContain('href');
  });

  it('leaves an asset link alone, because the url is ours', () => {
    const segments = applyDisplayScripts(
      '[status] hp=50',
      context([script({ out: '<img src="{{img::door}}">' })], {
        assets: new Map([['door', '/api/plots/c1/assets/door.png']]),
      }),
    );
    expect(html(segments)[0]).toContain('/api/plots/c1/assets/door.png');
  });

  it('draws a RisuAI card’s image by its own name, through the sanitizer', () => {
    const assets = new Map([['door', '/api/plots/c1/assets/door.png']]);
    const resolveAsset = (ref: string) => (ref === 'Door Open.png' ? 'door' : undefined);
    const segments = applyDisplayScripts(
      '[status] hp=50',
      context(
        [script({ out: '<div class="pic">{{img::Door Open.png}}</div><img class="raw" src="{{raw::Door Open.png}}">' })],
        { assets, resolveAsset },
      ),
    );
    expect(html(segments)[0]).toBe(
      '<div class="x-shizue-pic"><img src="/api/plots/c1/assets/door.png" alt="door"></div>' +
        '<img class="x-shizue-raw" src="/api/plots/c1/assets/door.png">',
    );
  });
});

describe('work that produces nothing', () => {
  /**
   * The trap an output-shaped budget cannot see.
   *
   * Sanitizing is what *discards* expensive input: these declarations are all
   * refused by the property allowlist, so the whole stylesheet comes back as the
   * empty string. Budget only what survives and the counter sits near zero while
   * every match pays for a CSS parse — measured at 8.5s of blocked main thread for
   * a hundred of them, with the output cap reading 800 of 100,000.
   */
  const droppableSheet = (bytes: number): string => {
    let css = '';
    let i = 0;
    while (css.length < bytes) {
      css += `.a${i} { -moz-binding: url(x); -webkit-user-modify: read-write; behavior: url(#x); }\n`;
      i += 1;
    }
    return css;
  };

  /** The whole message, one text run: the transform was abandoned. */
  const plain = (segments: Segment[], content: string): boolean =>
    segments.length === 1 && segments[0]!.kind === 'text' && segments[0]!.text === content;

  const hostile = `<style>${droppableSheet(89_000)}</style><i>$1</i>`;
  const manyMatches = 'hp=1'.repeat(100);
  const counter = (out: string): DisplayScript => script({ in: 'hp=(\\d)', out });

  it('sanitizes to nothing, which is what makes it a trap', () => {
    const segments = applyDisplayScripts('hp=1', context([counter(hostile)]));
    // Whatever this message becomes, the stylesheet contributes eight characters.
    expect(html(segments).join('')).not.toContain('moz-binding');
  });

  it('is charged for the input, so the message falls back to plain text', () => {
    const segments = applyDisplayScripts(manyMatches, context([counter(hostile)]));
    expect(plain(segments, manyMatches)).toBe(true);
  });

  it('pays for what it hands the sanitizer before it hands it over', () => {
    // The template's reads are paid for in the worker; what reaches this thread is
    // charged before the sanitizer sees any of it, so two hostile islands are
    // refused whole rather than sanitized one after the other.
    const segments = applyDisplayScripts('hp=1 hp=1', context([counter(hostile)]));
    expect(plain(segments, 'hp=1 hp=1')).toBe(true);
  });

  it('returns promptly rather than eventually', () => {
    // The assertion above is the real gate — without the input budget it renders a
    // hundred islands instead of falling back. This one states the consequence, at
    // a threshold four times clear of the 8.5s the unbudgeted path took here.
    const start = Date.now();
    applyDisplayScripts(manyMatches, context([counter(hostile)]));
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('charges the rendered string too, not only the template', () => {
    // Both shapes at once, which is the case neither cap alone can see: a template
    // that fits on one line, fans out to seventy kilobytes of stylesheet, and then
    // sanitizes to nothing. Its own length charges 62 characters, so the first
    // charge is blind to it; the output is empty, so the output cap is blind to it.
    const list = Array.from({ length: 2000 }, (_, i) => `i${i}`).join(',');
    const fanOut = context(
      [counter('<style>{{#each list}}.a{{slot}} { -moz-binding: url(x); }{{/each}}</style><i>$1</i>')],
      { variables: { list } },
    );
    // One is affordable and draws…
    expect(html(applyDisplayScripts('hp=1', fanOut))).toHaveLength(1);
    // …two are not, and the message stays as the model wrote it.
    const two = 'hp=1'.repeat(2);
    expect(plain(applyDisplayScripts(two, fanOut), two)).toBe(true);
  });

  it('still renders a message that is merely busy', () => {
    // The guard against paying for the fix with somebody's working card: a hundred
    // ordinary status windows are well inside the budget and all of them draw.
    const segments = applyDisplayScripts(
      manyMatches,
      context([counter('<div class="hp"><b>HP</b> <span>$1</span></div>')]),
    );
    expect(html(segments)).toHaveLength(100);
  });
});

describe('work that expands before anyone charges for it', () => {
  const plain = (segments: Segment[], content: string): boolean =>
    segments.length === 1 && segments[0]!.kind === 'text' && segments[0]!.text === content;

  /** A value no card should carry, and every card is allowed to. */
  const blob = '<'.repeat(2_000_000);
  const at = (out: string): DisplayScript => script({ in: 'hp=(\\d)', out });
  const many = 'hp=1'.repeat(99);

  it('bounds a capture as it is substituted, not once the string exists', () => {
    // The template fits the budget and is nothing but placeholders; the capture is
    // the widest a scanned message allows. Charging the finished string means
    // building it first — four hundred million characters here, 5.7s, and at the
    // fifty thousand placeholders a budget-sized template holds, the heap instead.
    const out = '$1'.repeat(20_000);
    const content = '<'.repeat(20_000);
    const started = Date.now();
    const segments = applyDisplayScripts(content, context([script({ in: '(<+)', out })]));
    expect(plain(segments, content)).toBe(true);
    // Charging as it goes, this is two milliseconds; without it, 5.7 seconds.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('charges a variable before expanding it, through every macro that reads one', () => {
    // Each of these escapes, trims or splits a two-megabyte value once per match.
    for (const out of [
      '<i>{{getvar::blob}}</i>',
      '<i>{{#each blob}}{{slot}}{{/each}}</i>',
      '<i>{{calc::blob}}</i>',
      '<i>{{#if blob}}x{{/if}}</i>',
    ]) {
      const segments = applyDisplayScripts(many, context([at(out)], { variables: { blob } }));
      expect(plain(segments, many), out).toBe(true);
    }
  });

  it('charges the carry-over a repeat_back reuses, like any other match', () => {
    const carried = script({
      in: 'hp=(\\d)',
      out: '<i>{{getvar::blob}}</i>',
      action: 'repeat_back',
    });
    const segments = applyDisplayScripts(
      '아무것도 없음',
      context([carried], { variables: { blob } }),
      'hp=1',
    );
    expect(plain(segments, '아무것도 없음')).toBe(true);
  });

  it('does not let an exhausted engine hand back a small successful answer', () => {
    // A template that legitimately blows the engine's own character cap used to
    // come back as its escaped source: a short string, rendered as an island, and
    // charged as though the work had cost thirty characters. It has to reach the
    // caller who owns the budget instead, and the message falls back.
    const wide = Array.from({ length: 200 }, (_, i) => `i${i}`).join(',');
    const segments = applyDisplayScripts(
      'hp=1',
      context([at(`<i>{{#each w}}${'x'.repeat(2000)}{{/each}}</i>`)], { variables: { w: wide } }),
    );
    expect(plain(segments, 'hp=1')).toBe(true);
  });

  it('still renders a card that reads ordinary variables many times over', () => {
    const segments = applyDisplayScripts(
      many,
      context([at('<b>{{getvar::hp}}</b>/<b>{{calc::hp * 2}}</b>')], { variables: { hp: '40' } }),
    );
    expect(html(segments)).toHaveLength(99);
  });
});

describe('display escapes in a template', () => {
  const island = (out: string): string =>
    html(applyDisplayScripts('[status] hp=40', context([script({ out })])))[0] ?? '';

  it('draws an escaped tag as text, never as an element', () => {
    const drawn = island('<div>{{deabo}}b{{deabc}}$1{{<}}/b{{>}}</div>');
    expect(drawn).toContain('&lt;b&gt;40&lt;/b&gt;');
    expect(drawn).not.toContain('<b>');
  });

  it('turns them back before the sanitizer, which judges what they stand for', () => {
    // After the sanitizer, `https{{dec}}//…` would have passed as a same-origin
    // path and only then become a foreign address.
    expect(sanitizeCustomHtml('<img src="https//tracker.example.test/p.png">')).toContain('tracker');
    const drawn = island(
      '<img src="https{{dec}}//tracker.example.test/p.png"><i>{{#escape}}{{getvar::gold}}{{/escape}}</i>',
    );
    expect(drawn).not.toContain('tracker.example.test');
    expect(drawn).toContain('<i>{{getvar::gold}}</i>');
  });
});
