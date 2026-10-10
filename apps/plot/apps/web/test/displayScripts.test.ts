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
import type { DisplayScript } from '../src/lib/types';

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

  it('applies scripts in order and never re-matches inside earlier output', () => {
    const segments = applyDisplayScripts(
      '[status] hp=50',
      context([
        script({ order: 1, in: 'HP', out: '<b>겹침</b>' }),
        script({ order: 0 }),
      ]),
    );
    expect(html(segments)).toEqual(['<div class="x-shizue-hp">HP 50</div>']);
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

  it('binds the chat variables and platform values a template asks for', () => {
    const segments = applyDisplayScripts(
      '[status] hp=50',
      context([script({ out: '<p>{{getvar::gold}} {{char}} {{calc::$1 / 2}}</p>' })]),
    );
    expect(html(segments)).toEqual(['<p>12 아리아 25</p>']);
  });

  it('never lets a captured value introduce markup or a macro', () => {
    const segments = applyDisplayScripts(
      'say:<img src=x onerror=alert(1)>',
      context([script({ in: 'say:(.*)', out: '<p>$1</p>' })]),
    );
    expect(html(segments)[0]).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');

    const macro = applyDisplayScripts(
      'say:{{button::라벨::텍스트}}',
      context([script({ in: 'say:(.*)', out: '<p>$1</p>' })]),
    );
    expect(macro.filter((segment) => segment.kind === 'html')[0]).toBeDefined();
    expect(html(macro)[0]).not.toContain('<button');
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

describe('actions', () => {
  it('move_top lifts the match above the prose', () => {
    const segments = applyDisplayScripts(
      '인사 [status] hp=50 끝',
      context([script({ action: 'move_top' })]),
    );
    expect(segments[0]).toEqual({ kind: 'html', html: '<div class="x-shizue-hp">HP 50</div>' });
    expect(text(segments)).toEqual(['인사 ', ' 끝']);
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

  it('does not reach the sanitizer even once', () => {
    // The first match is charged for its template and for what it rendered before
    // either is handed on, so a single hostile template costs nothing either.
    const segments = applyDisplayScripts('hp=1', context([counter(hostile)]));
    expect(plain(segments, 'hp=1')).toBe(true);
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
