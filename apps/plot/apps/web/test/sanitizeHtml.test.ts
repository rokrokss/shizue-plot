// @vitest-environment jsdom
/**
 * Regression suite for the trust boundary.
 *
 * Every case here is a vector that must stay dead. Loosening the sanitizer is
 * allowed only if this file still passes — a creator's card breaking is a bug,
 * a creator's card running script is an incident.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '@adobe/css-tools';
import { sanitizeCustomHtml, splitStylesheet } from '../src/lib/sanitizeHtml';
import { TAINT } from '../src/lib/taint';

/** Case-insensitive "the output does not contain any of these" assertion. */
function expectClean(html: string, ...forbidden: string[]): string {
  const output = sanitizeCustomHtml(html);
  const lower = output.toLowerCase();
  for (const needle of forbidden) expect(lower).not.toContain(needle.toLowerCase());
  return output;
}

describe('script execution', () => {
  it('removes <script> and its contents', () => {
    expectClean('<div>안전</div><script>alert(1)</script>', '<script', 'alert(1)');
  });

  it('removes every on* handler, however it is written', () => {
    expectClean(
      '<div onclick="alert(1)" ONMOUSEOVER=alert(2) on\tfocus="x">텍스트</div>',
      'onclick',
      'onmouseover',
      'onfocus',
      'alert',
    );
  });

  it('removes handlers on elements it otherwise keeps', () => {
    const output = expectClean('<img src="/a.png" onerror="alert(1)">', 'onerror', 'alert');
    expect(output).toContain('<img');
  });

  it('does not fall for an unclosed-tag mXSS attempt', () => {
    expectClean('<div><p>x<script src="//evil/a.js">', '<script', 'evil');
  });
});

describe('urls', () => {
  it('drops javascript: and data: hrefs', () => {
    expectClean('<a href="javascript:alert(1)">클릭</a>', 'javascript:', 'alert');
    expectClean('<a href="JaVaScRiPt&#58;alert(1)">클릭</a>', 'javascript', 'alert');
    expectClean('<a href="data:text/html,<script>alert(1)</script>">클릭</a>', 'data:', '<script');
  });

  it('drops a data: image source', () => {
    expectClean('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">', '<img', 'data:');
  });

  it('keeps an http(s) link but never lets it reach back into the opener', () => {
    const output = sanitizeCustomHtml('<a href="https://example.test/a">링크</a>');
    expect(output).toContain('href="https://example.test/a"');
    expect(output).toContain('rel="noopener noreferrer nofollow"');
  });

  it('drops a link that is not http(s), keeping its text', () => {
    const output = expectClean('<a href="/local">로컬</a>', 'href');
    expect(output).toContain('로컬');
  });

  it('keeps a same-origin image and drops every foreign one, beacons included', () => {
    expect(sanitizeCustomHtml('<img src="/api/plots/x/assets/a">')).toContain(
      '/api/plots/x/assets/a',
    );
    expectClean('<img src="//evil.test/track.png">', '<img');
    expectClean('<img src="https://evil.test/track.png">', '<img', 'evil.test');
  });

  it("keeps a card's music from our own origin and nothing from anywhere else", () => {
    // RisuAI's `{{audio::…}}` player, and the one a card writes out with a <source>.
    expect(sanitizeCustomHtml('<audio controls autoplay loop src="/api/plots/x/assets/bgm"></audio>')).toBe(
      '<audio controls="" autoplay="" loop="" src="/api/plots/x/assets/bgm"></audio>',
    );
    expect(
      sanitizeCustomHtml(
        '<audio controls loop preload="none"><source src="/api/plots/x/assets/bgm" type="audio/mpeg"></audio>',
      ),
    ).toBe('<audio controls="" loop="" preload="none"><source src="/api/plots/x/assets/bgm" type="audio/mpeg"></audio>');
    expectClean('<audio autoplay src="https://evil.test/beacon.mp3"></audio>', '<audio', 'evil.test');
    expectClean('<audio controls><source src="//evil.test/a.mp3"></audio>', '<source', 'evil.test');
    expectClean('<audio autoplay src="data:audio/mpeg;base64,SUQz"></audio>', '<audio', 'data:');
    // The background music's marker, which the chat page plays from.
    expect(sanitizeCustomHtml('<span data-shizue-bgm="/api/plots/x/assets/bgm"></span>')).toBe(
      '<span data-shizue-bgm="/api/plots/x/assets/bgm"></span>',
    );
    expectClean('<span data-shizue-bgm="https://evil.test/a.mp3"></span>', 'evil.test', 'data-shizue-bgm');
  });
});

describe('framed, embedded and form elements', () => {
  it('removes iframe, object and embed', () => {
    expectClean('<iframe src="https://evil.test"></iframe>', '<iframe', 'evil.test');
    expectClean('<object data="x.swf"></object>', '<object');
    expectClean('<embed src="x.swf">', '<embed');
  });

  it('removes forms and every input control', () => {
    expectClean(
      '<form action="https://evil.test"><input name="p"><textarea></textarea>' +
        '<select><option>1</option></select></form>',
      '<form',
      '<input',
      '<textarea',
      '<select',
      'evil.test',
    );
  });

  it('removes base, link and meta, which retarget the whole page', () => {
    expectClean('<base href="https://evil.test/">', '<base');
    expectClean('<link rel="stylesheet" href="https://evil.test/x.css">', '<link', 'evil.test');
    expectClean('<meta http-equiv="refresh" content="0;url=https://evil.test">', '<meta');
  });
});

describe('svg and mathml', () => {
  it('removes svg along with its event handlers', () => {
    expectClean(
      '<svg><animate onbegin="alert(1)" attributeName="x"></animate></svg>',
      '<svg',
      '<animate',
      'onbegin',
      'alert',
    );
  });

  it('removes an svg foreignObject wrapper', () => {
    expectClean(
      '<svg><foreignObject><div onclick="alert(1)">x</div></foreignObject></svg>',
      '<svg',
      'foreignobject',
      'onclick',
    );
  });

  it('removes an svg <script> however it is nested', () => {
    expectClean('<svg><g><script>alert(1)</script></g></svg>', '<script', 'alert(1)');
  });

  it('removes mathml, including the annotation-xml mXSS carrier', () => {
    expectClean(
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<math',
      '<mglyph',
      'onerror',
      'alert',
    );
    expectClean(
      '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>',
      '<math',
      'annotation-xml',
      '<script',
    );
  });
});

describe('css', () => {
  it('scopes every selector under the message wrapper and namespaces classes', () => {
    const output = sanitizeCustomHtml('<style>.hp { color: red; }</style><div class="hp">x</div>');
    expect(output).toContain('.shizue-msg .x-shizue-hp');
    expect(output).toContain('class="x-shizue-hp"');
    // The unscoped selector must not survive anywhere.
    expect(output).not.toMatch(/(^|[^-])\.hp\b/);
  });

  it('scopes a selector that tries to reach the page root', () => {
    const output = sanitizeCustomHtml('<style>body, html, :root { display: none; }</style>');
    expect(output).toContain('.shizue-msg body');
    expect(output).toContain('.shizue-msg :root');
    // Each selector starts its own line, so an unscoped one would start one too.
    expect(output).not.toMatch(/(^|\n)(body|html|:root)/);
  });

  it('rejects a selector that tries to close its own rule', () => {
    expectClean('<style>.a { color: red } </style><img src=x onerror=alert(1)>', 'onerror', 'alert');
    expect(sanitizeCustomHtml('<style>.a\\{x\\} { color: red }</style>')).not.toContain('color: red');
  });

  it('removes @import', () => {
    expectClean('<style>@import url("https://evil.test/x.css"); .a { color: red }</style>', '@import', 'evil.test');
  });

  it('removes an external url() background, the classic exfiltration channel', () => {
    expectClean('<style>.a { background: url(https://evil.test/p.png) }</style>', 'evil.test');
    expectClean('<style>.a { background: url("//evil.test/p.png") }</style>', 'evil.test');
    expectClean('<div style="background:url(https://evil.test/p.png)">x</div>', 'evil.test');
  });

  it('keeps a same-origin url(), which is what an asset reference produces', () => {
    expect(sanitizeCustomHtml('<style>.a { background: url(/api/plots/x/assets/a) }</style>')).toContain(
      '/api/plots/x/assets/a',
    );
  });

  it('removes declarations that run code or escape the message box', () => {
    expectClean('<style>.a { width: expression(alert(1)) }</style>', 'expression');
    expectClean('<style>.a { -moz-binding: url(/x.xml#y) }</style>', '-moz-binding');
    expectClean('<style>.a { position: sticky; top: 0 }</style>', 'sticky');
    expectClean('<div style="position:sticky;top:0">x</div>', 'sticky');
  });

  it('keeps a RisuAI overlay floating: `fixed` and `inset`, which the box it is drawn in contains', () => {
    // globals.css: the message (or `.shizue-msg` outside one) is the containing
    // block for `fixed` and clips it, so a card's menu floats over its own message.
    expect(sanitizeCustomHtml('<style>.a { position: fixed; inset: 0 }</style>')).toMatch(
      /\.shizue-msg \.x-shizue-a \{\s*position: fixed;\s*inset: 0;/,
    );
    const inline = sanitizeCustomHtml('<div style="position:fixed;right:10px;bottom:104px;inset-inline-start:auto">x</div>');
    expect(inline).toContain('position: fixed');
    expect(inline).toContain('bottom: 104px');
    expect(inline).toContain('inset-inline-start: auto');
  });

  it('drops at-rules it cannot scope, and keeps the ones it can', () => {
    expectClean('<style>@font-face { src: url(https://evil.test/f.woff) }</style>', '@font-face', 'evil.test');
    expect(sanitizeCustomHtml('<style>@media (min-width: 40rem) { .a { color: red } }</style>')).toContain(
      '.shizue-msg .x-shizue-a',
    );
  });

  it('drops a stylesheet it cannot parse rather than passing it through', () => {
    expect(sanitizeCustomHtml('<style>.a { color: red</style>')).not.toContain('color');
  });
  it("keeps a RisuAI card's plot-wide sheet, losing only what it cannot scope", () => {
    // The shapes a real backgroundHTML is made of: a reset, a universal child
    // selector, pseudo-elements, a keyframe animation and a phone breakpoint.
    const output = sanitizeCustomHtml(
      '<style>.pk-gs{all:initial;display:block}.pk-gs *{margin:0}' +
        '@keyframes pulse{from{opacity:0}to{opacity:1}}.pk-q:hover::before{content:"·"}' +
        '@media (max-width:600px){.image-container{width:95vw;height:60vw}}</style>',
    );
    expect(output).toContain('.shizue-msg .x-shizue-pk-gs');
    expect(output).toContain('display: block');
    expect(output).toContain('.shizue-msg .x-shizue-pk-q:hover::before');
    expect(output).toContain('width: 95vw');
    expect(output).not.toContain('all:');
    expect(output).toContain('@keyframes x-shizue-pulse');
  });
});

describe('css escapes and comments', () => {
  it('sees through a hex escape in a property value', () => {
    // `st\69cky` is `sticky`. The raw-string check this replaced did not know that.
    expectClean('<style>.a{position:st\\69cky;top:0}</style>', 'st\\69cky', 'position');
    expectClean('<style>.a{position:\\73 ticky}</style>', 'position');
    expectClean('<div style="position:st\\69cky">x</div>', 'position');
  });

  it('sees through a hex escape in a function name', () => {
    expectClean('<style>.a{background:u\\72l(https://evil.test/x)}</style>', 'evil.test', 'background');
    expectClean('<div style="background:u\\72l(https://evil.test/x)">x</div>', 'evil.test');
  });

  it('sees through an escaped literal', () => {
    expectClean('<style>.a{background:\\75rl(https://evil.test/x)}</style>', 'evil.test');
  });

  it('does not let a comment hide a foreign url', () => {
    expectClean('<style>.a{background:url(/**/https://evil.test/x)}</style>', 'evil.test');
  });
});

describe('css property and function allowlists', () => {
  it('rejects url-bearing functions that never spell url()', () => {
    for (const value of [
      'image-set("https://evil.test/x" 1x)',
      '-webkit-image-set(url(https://evil.test/x) 1x)',
      'cross-fade(url(/a.png), url(https://evil.test/x), 50%)',
      'element(#hero)',
      '-moz-element(#hero)',
      'paint(worklet)',
    ]) {
      expectClean(`<style>.a{background-image:${value}}</style>`, 'evil.test', 'background-image');
      expectClean(`<div style="background-image:${value}">x</div>`, 'evil.test', 'background-image');
    }
  });

  it('rejects a foreign url nested inside an allowed function', () => {
    expectClean(
      '<style>.a{background:linear-gradient(red, url(https://evil.test/x))}</style>',
      'evil.test',
    );
    expectClean('<style>.a{width:calc(1px + element(#x))}</style>', 'element');
  });

  it('rejects properties outside the allowlist, known-dangerous or merely unknown', () => {
    for (const declaration of [
      '-moz-binding:url(/x.xml#y)',
      'behavior:url(/x.htc)',
      'mix-blend-mode:difference',
      '-webkit-user-modify:read-write',
      'backdrop-filter:blur(2px)',
    ]) {
      expectClean(`<style>.a{${declaration}}</style>`, declaration.split(':')[0]!);
    }
  });

  it('holds a custom property to what any declaration carries, so var() has nothing foreign to expand to', () => {
    expectClean('<style>.a{--leak:url(https://evil.test/x);background:var(--leak)}</style>', 'evil.test');
    expectClean('<div style="--leak:image-set(&quot;https://evil.test/x&quot; 1x)">x</div>', 'evil.test', '--leak');
    expectClean('<style>.a{background:var(--x, url(https://evil.test/y))}</style>', 'evil.test');
    // What the value of one may not hold, no property reading it gets: `position` still takes no `fixed`.
    expectClean('<style>.a{--p:fixed;position:var(--p)}</style>', 'position');
    // Ivy, The Vampire Maid's portrait: layers of our own assets set on one, drawn by its sheet.
    const kept = sanitizeCustomHtml(
      `<style>.card{background:var(--asset-bg)}</style><div class="card" style="--asset-bg: url('/api/plots/x/assets/by-name/cdn.test/a.png') 20% / cover no-repeat, url('/api/plots/x/assets/b') 20% / cover no-repeat">x</div>`,
    );
    expect(kept).toContain('background:var(--asset-bg)'.replace(':', ': '));
    expect(kept).toContain("--asset-bg: url('/api/plots/x/assets/by-name/cdn.test/a.png') 20% / cover no-repeat");
  });

  it('allows only the positions that stay inside the message', () => {
    expect(sanitizeCustomHtml('<div style="position:absolute;top:0">x</div>')).toContain('position: absolute');
    expectClean('<style>.a{position:sticky}</style>', 'position');
    expect(sanitizeCustomHtml('<style>.a{position:fixed}</style>')).toContain('position: fixed');
  });

  it('leaves a realistic status-window stylesheet intact', () => {
    const output = sanitizeCustomHtml(
      '<style>.panel{display:flex;gap:8px;padding:4px 8px;color:#eee;background:#222 ' +
        'url(/api/plots/x/assets/bg) no-repeat;border-radius:4px;border:1px solid #444;' +
        'box-shadow:0 1px 2px rgba(0,0,0,.4);font-size:12px;text-align:center;' +
        'width:calc(100% - 4px);transform:translateX(2px)}' +
        '.bar{background-image:linear-gradient(#3a3,#1a1);height:6px}</style>',
    );
    for (const kept of [
      'display: flex',
      'gap: 8px',
      'background: #222 url(/api/plots/x/assets/bg) no-repeat',
      'border-radius: 4px',
      'box-shadow: 0 1px 2px rgba(0,0,0,.4)',
      'width: calc(100% - 4px)',
      'transform: translateX(2px)',
      'background-image: linear-gradient(#3a3,#1a1)',
    ]) {
      expect(output).toContain(kept);
    }
  });
});

describe('url resolution', () => {
  it('rejects a path that resolves off-origin once the browser folds it', () => {
    // `/\evil.test/p` becomes `//evil.test/p`: root-relative by shape, foreign in fact.
    expectClean('<img src="/\\evil.test/p">', '<img');
    expectClean('<style>.a{background:url(/\\evil.test/p)}</style>', 'evil.test', 'background');
    expectClean('<img src="\\/\\/evil.test/p">', '<img');
  });

  it('rejects percent-encoded separators and control characters', () => {
    expectClean('<img src="/%5Cevil.test/p">', '<img');
    expectClean('<img src="/a%00b.png">', '<img');
  });

  it('rejects whitespace inside a url, which the browser strips before resolving', () => {
    expectClean('<img src="/a\tb.png">', '<img');
    expectClean('<img src="htt\np://evil.test/p">', '<img');
    expectClean('<img src="&#9;https://evil.test/p">', '<img');
  });

  it('accepts the shape an asset reference actually produces', () => {
    const url = '/api/plots/8cef8e47-718c-4ca9-9b6e-5dab406e657f/assets/status-bg';
    expect(sanitizeCustomHtml(`<img src="${url}">`)).toContain(url);
    expect(sanitizeCustomHtml(`<style>.a{background:url(${url})}</style>`)).toContain(url);
  });
});

describe('attributes and structure', () => {
  it('folds an id into the namespace, so it never names an element of the page', () => {
    const output = expectClean('<div id="app">x</div>', 'id="app"');
    expect(output).toContain('id="x-shizue-app"');
  });

  it('keeps the button bridge attribute and forces an inert button', () => {
    const output = sanitizeCustomHtml('<button data-shizue-fill="안녕하세요">인사</button>');
    expect(output).toContain('data-shizue-fill="안녕하세요"');
    expect(output).toContain('type="button"');
  });

  it('drops every other data attribute', () => {
    expectClean('<div data-evil="1" data-shizue-other="2">x</div>', 'data-evil', 'data-shizue-other');
  });

  it('keeps the ordinary markup a status window is made of', () => {
    const output = sanitizeCustomHtml(
      '<div class="panel"><table><tr><td colspan="2"><b>HP</b></td></tr></table>' +
        '<meter value="40" max="100"></meter></div>',
    );
    expect(output).toContain('<table>');
    expect(output).toContain('colspan="2"');
    expect(output).toContain('<meter');
  });

  it('answers with nothing at all for empty or unusable input', () => {
    expect(sanitizeCustomHtml('')).toBe('');
    expect(sanitizeCustomHtml('<script>alert(1)</script>')).toBe('');
  });
});

describe('content property', () => {
  it('keeps a decorative pseudo-element but not one that names a resource', () => {
    const kept = sanitizeCustomHtml('<style>.bar::before{content:"";width:4px}</style><div class="bar"></div>');
    expect(kept).toContain('content');

    for (const value of ['attr(data-x)', 'counter(c)', 'image-set("https://evil.test/x" 1x)', 'url(https://evil.test/x)']) {
      expect(sanitizeCustomHtml(`<style>.bar::before{content:${value}}</style><div class="bar"></div>`)).not.toContain('content');
    }
  });
});

describe('a destination the model composed', () => {
  /** What a template hands over: creator markup with marked values already in it. */
  const composed = (...parts: string[]): string => parts.join('');
  const value = (text: string): string => `${TAINT}${text}${TAINT}`;

  it('keeps a link the creator wrote out in full clickable', () => {
    const output = sanitizeCustomHtml('<a href="https://example.test/lumi">여기</a>');
    expect(output).toContain('href="https://example.test/lumi"');
    expect(output).toContain('rel="noopener noreferrer nofollow"');
  });

  it('takes the href off a link whose destination was interpolated', () => {
    // `<a href="{{getvar::url}}">` with the model having set `url`.
    const output = sanitizeCustomHtml(
      composed('<a href="', value('https://evil.test/steal'), '">여기</a>'),
    );
    expect(output).not.toContain('href');
    expect(output).toContain('여기');
  });

  it('shows where it would have gone, so the reader is not guessing', () => {
    const output = sanitizeCustomHtml(
      composed('<a href="', value('https://evil.test/steal'), '">여기</a>'),
    );
    expect(output).toContain('(https://evil.test/steal)');
  });

  it('refuses a href the model only supplied part of', () => {
    // The template pins the origin and interpolates the path — still the model's
    // choice of destination, because the path decides where on that host it goes.
    const output = sanitizeCustomHtml(
      composed('<a href="https://example.test/', value('../../evil'), '">여기</a>'),
    );
    expect(output).not.toContain('href');
  });

  it('bounds what it prints, so a long url cannot take the message over', () => {
    const output = sanitizeCustomHtml(
      composed('<a href="', value(`https://evil.test/${'a'.repeat(500)}`), '">여기</a>'),
    );
    expect(output).toContain(`(https://evil.test/${'a'.repeat(100)}`);
    expect(output).not.toContain('a'.repeat(200));
  });

  it('prints nothing for a destination that was never a link anyway', () => {
    // Not http(s): the href comes off for the reason it always did, and there is
    // no destination worth showing.
    const output = sanitizeCustomHtml(composed('<a href="', value('/local/path'), '">여기</a>'));
    expect(output).not.toContain('href');
    expect(output).not.toContain('/local/path');
  });

  it('leaves no marker anywhere in what it returns', () => {
    const output = sanitizeCustomHtml(
      composed(
        '<div class="',
        value('card'),
        '" style="width: ',
        value('40%'),
        '" title="',
        value('t'),
        '">',
        value('본문'),
        '<img src="/api/a/',
        value('x.png'),
        '"></div>',
      ),
    );
    expect(output).not.toContain(TAINT);
    // …and the marked values still did their job.
    expect(output).toContain('본문');
    expect(output).toContain('width: 40%');
    expect(output).toContain('/api/a/x.png');
  });

  it('lets a marked value through a stylesheet, where url() is the real check', () => {
    const output = sanitizeCustomHtml(
      composed('<style>.a { width: ', value('40%'), '; }</style><div class="a">x</div>'),
    );
    expect(output).toContain('width: 40%');
    expect(output).not.toContain(TAINT);
  });
});

describe("RisuAI's script buttons", () => {
  it('keeps risu-trigger, risu-id and risu-btn under our names, on any element', () => {
    const output = sanitizeCustomHtml(
      '<button risu-trigger="공격" risu-id="b1">베기</button><div risu-btn="open:door">문</div>',
    );
    const holder = document.createElement('div');
    holder.innerHTML = output;
    const button = holder.querySelector('button')!;
    expect(button.getAttribute('data-shizue-trigger')).toBe('공격');
    expect(button.getAttribute('data-shizue-trigger-id')).toBe('b1');
    expect(button.getAttribute('type')).toBe('button');
    expect(holder.querySelector('div')!.getAttribute('data-shizue-btn')).toBe('open:door');
    expect(output).not.toContain('risu-');
  });

  it('keeps a name that would fail a URL check, and still nothing that runs', () => {
    const output = expectClean(
      '<button risu-trigger="javascript:alert(1)" onclick="alert(2)">x</button>',
      'onclick',
      'alert(2)',
    );
    // A trigger's name is a word the page looks up, never a destination.
    expect(output).toContain('data-shizue-trigger="javascript:alert(1)"');
  });

  it('takes the marks off a trigger name a template built from the model’s values', () => {
    const output = sanitizeCustomHtml(['<button risu-trigger="', TAINT, '공격', TAINT, '">x</button>'].join(''));
    expect(output).toContain('data-shizue-trigger="공격"');
    expect(output).not.toContain(TAINT);
  });
});

describe('a member’s own stylesheet', () => {
  const member = '0a1b2c3d-0000-4000-8000-00000000000b';

  it('reaches only the rows of that member’s messages, whatever its rules nest in', () => {
    const output = sanitizeCustomHtml(
      '<style>.status { color: red } @media (min-width: 1px) { .gauge b { width: 10px } }</style>',
      { member },
    );
    expect(output).toContain(`[data-shizue-member="${member}"] .shizue-msg .x-shizue-status`);
    expect(output).toContain(`[data-shizue-member="${member}"] .shizue-msg .x-shizue-gauge b`);
    // No rule escapes to every message: each one names the member.
    expect(output.match(/\.shizue-msg/g)).toHaveLength(2);
    expect(output.match(/\[data-shizue-member="[^"]+"\] \.shizue-msg/g)).toHaveLength(2);
  });

  it('is nothing at all for a scope that is not a member id', () => {
    expect(sanitizeCustomHtml('<style>.a { color: red }</style>', { member: '"] *, x[y="' })).toBe('');
    expect(sanitizeCustomHtml('<style>.a { color: red }</style>', { member: '' })).toBe('');
  });

  it('cannot be claimed by markup: a template writes no member attribute', () => {
    expectClean(`<div data-shizue-member="${member}" class="shizue-msg">x</div>`, 'data-shizue-member', 'class="shizue-msg"');
  });
});

describe('CSS-only toggles', () => {
  /** Sanitized markup inside a message wrapper, in a page that has chrome of its own. */
  function mount(html: string): { page: HTMLElement; message: HTMLElement } {
    document.body.innerHTML =
      '<main id="page"><input type="checkbox" id="settings-open"><textarea id="composer"></textarea></main>' +
      '<div class="shizue-msg" id="message"></div>';
    const message = document.getElementById('message')!;
    message.innerHTML = sanitizeCustomHtml(html);
    return { page: document.getElementById('page')!, message };
  }

  it('keeps a checkbox, its label and the :checked rule that opens the panel', () => {
    const output = sanitizeCustomHtml(
      '<style>.panel{display:none}.t:checked ~ .panel{display:block}#t1:checked + label{color:red}</style>' +
        '<input type="checkbox" id="t1" class="t" checked><label for="t1">열기</label><div class="panel">x</div>',
    );
    expect(output).toContain('.shizue-msg .x-shizue-t:checked ~ .x-shizue-panel');
    expect(output).toContain('.shizue-msg #x-shizue-t1:checked + label');
    expect(output).toMatch(/<input[^>]*type="checkbox"/);
    expect(output).toMatch(/<input[^>]*id="x-shizue-t1"/);
    expect(output).toMatch(/<input[^>]*checked/);
    expect(output).toContain('<label for="x-shizue-t1">열기</label>');
  });

  it('flips the message’s own checkbox from its label', () => {
    const { message } = mount('<input type="checkbox" id="t1"><label for="t1">열기</label>');
    message.querySelector('label')!.click();
    expect(message.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
  });

  it('groups radios by a name in the namespace, so a tab bar switches', () => {
    const output = sanitizeCustomHtml(
      '<label><input type="radio" name="tab-3" checked>A</label><label><input type="radio" name="tab-3">B</label>',
    );
    expect(output.match(/name="x-shizue-tab-3"/g)).toHaveLength(2);
    const { message } = mount(
      '<label><input type="radio" name="tab" checked>A</label><label class="b"><input type="radio" name="tab">B</label>',
    );
    message.querySelector<HTMLElement>('label.x-shizue-b')!.click();
    const [a, b] = Array.from(message.querySelectorAll<HTMLInputElement>('input'));
    expect([a!.checked, b!.checked]).toEqual([false, true]);
  });

  it('never lets an id stand in for one of the page’s', () => {
    mount('<div id="composer">가짜</div><input type="checkbox" id="settings-open">');
    expect(document.getElementById('composer')!.tagName).toBe('TEXTAREA');
    expect(document.getElementById('settings-open')!.closest('#page')).not.toBeNull();
  });

  it('points a label only at the creator’s own inputs, never at the page’s', () => {
    const { page, message } = mount('<label for="settings-open">설정</label><label for="composer">입력</label>');
    for (const label of Array.from(message.querySelectorAll('label'))) label.click();
    expect(page.querySelector<HTMLInputElement>('#settings-open')!.checked).toBe(false);
    expect(document.activeElement).not.toBe(page.querySelector('#composer'));
    expect(message.innerHTML).toContain('for="x-shizue-settings-open"');
  });

  it('keeps no input but a checkbox or a radio', () => {
    for (const type of ['text', 'password', 'hidden', 'submit', 'image', 'file', 'range', '']) {
      expectClean(`<input type="${type}" name="q" src="/a.png" value="x">`, '<input');
    }
    expectClean('<input name="q">', '<input');
    expect(sanitizeCustomHtml('<input type="CheckBox">')).toContain('type="checkbox"');
  });

  it('drops a name or an id with nothing left once it is folded', () => {
    const output = sanitizeCustomHtml('<input type="radio" name="탭" id="상태">');
    expect(output).not.toContain('name=');
    expect(output).not.toContain('id=');
  });
});

describe('animations', () => {
  const member = '0a1b2c3d-0000-4000-8000-00000000000b';

  it('keeps a sheet’s keyframes under its own name and points its animations at them', () => {
    const output = sanitizeCustomHtml(
      '<style>@keyframes blink{50%{opacity:0}}.b{animation:blink 1s steps(1) infinite}' +
        '.c{animation-name:blink, none;animation-duration:2s}</style>',
    );
    expect(output).toContain('@keyframes x-shizue-blink');
    expect(output).toContain('animation: x-shizue-blink 1s steps(1) infinite');
    expect(output).toContain('animation-name: x-shizue-blink, none');
    expect(output).toContain('animation-duration: 2s');
  });

  it('renames in a style attribute too, so a card never runs the page’s own animations', () => {
    const output = sanitizeCustomHtml('<div style="animation: spin 1s linear infinite">x</div>');
    expect(output).toContain('animation: x-shizue-spin 1s linear infinite');
  });

  it('holds every frame to the declaration filter', () => {
    const output = expectClean(
      '<style>@keyframes go{from{position:sticky;top:0}to{background:url(https://evil.test/x);opacity:1}}</style>',
      'sticky',
      'evil.test',
    );
    expect(output).toContain('@keyframes x-shizue-go');
    expect(output).toContain('opacity: 1');
  });

  it('refuses an animation it cannot read rather than passing it through', () => {
    for (const value of ['var(--animate-spin)', 'a\\3b position\\3a fixed', 'a b 1s', 'url(/x) 1s']) {
      expect(sanitizeCustomHtml(`<style>.a{animation:${value}}</style>`)).not.toContain('animation');
    }
    expect(sanitizeCustomHtml('<style>@keyframes ease{to{opacity:1}}</style>')).toBe('');
  });

  it('keeps a member’s animations that member’s', () => {
    const output = sanitizeCustomHtml('<style>@keyframes glow{to{opacity:1}}.g{animation:glow 1s}</style>', { member });
    expect(output).toContain(`@keyframes x-shizue-${member}-glow`);
    expect(output).toContain(`animation: x-shizue-${member}-glow 1s`);
  });
});

describe('fonts', () => {
  it('keeps a font face of our own origin under its own family, which the sheet then asks for first', () => {
    const output = sanitizeCustomHtml(
      '<style>@font-face{font-family:"Hand";src:url(/api/assets/hand.woff2) format("woff2");font-display:swap}' +
        ".a{font-family:'Hand', -apple-system, serif}</style>",
    );
    expect(output).toContain('font-family: "x-shizue-Hand"');
    expect(output).toContain('src: url(/api/assets/hand.woff2) format("woff2")');
    expect(output).toContain('font-display: swap');
    expect(output).toContain('font-family: "x-shizue-Hand", "Hand", "x-shizue--apple-system", -apple-system, serif');
  });

  it('drops a font face that loads from anywhere else, or from the reader’s machine', () => {
    expectClean('<style>@font-face{font-family:F;src:url(https://fonts.example.test/f.woff)}</style>', '@font-face', 'example.test');
    expectClean('<style>@font-face{font-family:Pretendard;src:local("Comic Sans MS")}</style>', '@font-face', 'comic');
    expectClean('<style>@font-face{font-family:F}</style>', '@font-face');
  });

  it('never declares a family under the page’s own name', () => {
    const output = sanitizeCustomHtml('<style>@font-face{font-family:"Pretendard Variable";src:url(/a.woff2)}</style>');
    expect(output).toContain('font-family: "x-shizue-Pretendard Variable"');
    expect(output).not.toMatch(/font-family:\s*"Pretendard Variable"/);
  });

  it('leaves a family list it cannot read as it was', () => {
    const output = sanitizeCustomHtml('<style>.a{font-family:var(--font-sans)}</style>');
    expect(output).toContain('font-family: var(--font-sans)');
  });
});

describe('a long stylesheet, parsed a top-level block at a time', () => {
  /** A sheet with every shape that could fool a cut: nesting, strings, comments and escapes holding braces and semicolons. */
  const tricky = [
    '@import url("https://fonts.example.test/a.css");',
    '/* a { comment } with; braces */',
    '.a::before { content: "}{;"; color: red }',
    ".b[title='{x;}'] { color: blue; }",
    '.c\\{ { margin: 0 }',
    '@media (max-width: 600px) { .d { width: 1px } @supports (display: grid) { .e { display: grid } } }',
    '@keyframes spin { from { opacity: 0 } to { opacity: 1 } }',
    '@font-face { font-family: "F"; src: url(/api/plots/p1/assets/f.woff2) }',
    'stray: junk; .f { color: green }',
    '.g { background: url(/api/plots/p1/assets/x.png); }',
  ].join('\n');

  /** The parsed rules without their places in the source, which a cut moves. */
  const rules = (css: string): unknown =>
    JSON.parse(JSON.stringify(parse(css, { silent: true }).stylesheet.rules, (key, value) => (key === 'position' ? undefined : value)));

  it('cuts only where a top-level block ends, and parses to the same rules as the whole', () => {
    const pieces = splitStylesheet(tricky);
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.join('').replace(/\s+/g, '')).toBe(tricky.replace(/\s+/g, ''));
    expect(pieces.flatMap((piece) => rules(piece) as unknown[])).toEqual(rules(tricky));
    expect(parse(tricky, { silent: true }).stylesheet.parsingErrors).toEqual([]);
  });

  it('sanitizes to what the whole sheet did', () => {
    const output = sanitizeCustomHtml(`<style>${tricky}</style>`);
    expect(output).not.toContain('@import');
    expect(output).toContain('.shizue-msg .x-shizue-a::before {\n  content: "}{;";\n  color: red;\n}');
    expect(output).toContain('@media (max-width: 600px) {\n  .shizue-msg .x-shizue-d');
    expect(output).toContain('@keyframes x-shizue-spin');
    expect(output).toContain('font-family: "x-shizue-F"');
    // The junk before `.f` is read into its selector, as a whole parse reads it, and the rule goes.
    expect(output).not.toContain('green');
    expect(output).toContain('.shizue-msg .x-shizue-g {\n  background: url(/api/plots/p1/assets/x.png);\n}');
    // Rules a line apart, as the library writes one sheet.
    expect(output).toMatch(/color: red;\n\}\n\n@media/);
  });

  it('still drops a sheet the parser refuses anywhere in it', () => {
    expect(sanitizeCustomHtml('<style>.a { color: red } } .b { color: blue }</style>')).toBe('');
    expect(sanitizeCustomHtml('<style>.a { color: red } /* never closed .b { color: blue }</style>')).toBe('');
    expect(sanitizeCustomHtml('<style>.a { color: red } .b { color: blue</style>')).toBe('');
  });

  it('keeps a quarter-megabyte sheet whole, every rule of it', () => {
    const big = Array.from({ length: 7200 }, (_, i) => `.r${i} { color: #${(i % 4096).toString(16).padStart(3, '0')}; margin: ${i % 9}px }`).join('\n');
    expect(big.length).toBeGreaterThan(250_000);
    const output = sanitizeCustomHtml(`<style>${big}</style>`);
    expect(output.match(/\.shizue-msg \.x-shizue-r\d+ \{/g)).toHaveLength(7200);
  });
});
