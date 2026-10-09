// @vitest-environment jsdom
/**
 * Regression suite for the trust boundary.
 *
 * Every case here is a vector that must stay dead. Loosening the sanitizer is
 * allowed only if this file still passes — a creator's card breaking is a bug,
 * a creator's card running script is an incident.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeCustomHtml } from '../src/lib/sanitizeHtml';
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
    expectClean('<style>.a { position: fixed; top: 0 }</style>', 'fixed');
    expectClean('<div style="position:fixed;inset:0">x</div>', 'fixed');
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
});

describe('css escapes and comments', () => {
  it('sees through a hex escape in a property value', () => {
    // `f\69xed` is `fixed`. The raw-string check this replaced did not know that.
    expectClean('<style>.a{position:f\\69xed;top:0}</style>', 'f\\69xed', 'position');
    expectClean('<style>.a{position:\\66 ixed}</style>', 'position');
    expectClean('<div style="position:f\\69xed">x</div>', 'position');
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
      'animation:spin 1s',
      'backdrop-filter:blur(2px)',
    ]) {
      expectClean(`<style>.a{${declaration}}</style>`, declaration.split(':')[0]!);
    }
  });

  it('rejects a custom property, so var() has nothing foreign to expand to', () => {
    expectClean('<style>.a{--leak:url(https://evil.test/x);background:var(--leak)}</style>', 'evil.test');
    expectClean('<style>.a{background:var(--x, url(https://evil.test/y))}</style>', 'evil.test');
  });

  it('allows only the positions that stay inside the message', () => {
    expect(sanitizeCustomHtml('<div style="position:absolute;top:0">x</div>')).toContain('position: absolute');
    expectClean('<style>.a{position:sticky}</style>', 'position');
    expectClean('<style>.a{position:fixed}</style>', 'position');
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
  it('drops id, so nothing can be targeted from outside the message', () => {
    expectClean('<div id="app">x</div>', 'id=');
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
