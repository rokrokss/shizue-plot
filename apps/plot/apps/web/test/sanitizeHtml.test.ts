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
  it('removes a frame of any host but YouTube’s player, and object and embed', () => {
    expectClean('<iframe src="https://evil.test"></iframe>', '<iframe', 'evil.test');
    expectClean('<object data="x.swf"></object>', '<object');
    expectClean('<embed src="x.swf">', '<embed');
  });

  it('unwraps a form and keeps its controls, so nothing of it can submit anywhere', () => {
    const output = expectClean(
      '<form action="https://evil.test" method="post" target="_top" enctype="text/plain"><input name="p">' +
        '<textarea name="t"></textarea><select name="s"><option>1</option></select>' +
        '<button type="submit" formaction="https://evil.test" formmethod="post" formtarget="_top">보내기</button>' +
        '<input type="submit" formaction="https://evil.test"></form>',
      '<form',
      'evil.test',
      'action',
      'method',
      'formtarget',
      'enctype',
    );
    for (const kept of ['<input name="x-shizue-p">', '<textarea name="x-shizue-t">', '<select name="x-shizue-s">', '<option>1</option>']) {
      expect(output).toContain(kept);
    }
    expect(output).toContain('<button type="button">보내기</button>');
    // With no form to belong to, Enter in the field and the submit input have nothing to send.
    const holder = document.createElement('div');
    holder.innerHTML = output;
    for (const control of Array.from(holder.querySelectorAll('input, textarea, select, button'))) {
      expect((control as HTMLInputElement).form).toBeNull();
    }
    // Nor can a control join one of the page's forms by its id.
    expectClean('<input form="composer-form"><button form="composer-form">x</button>', 'form=');
  });

  it('removes base, link and meta, which retarget the whole page', () => {
    expectClean('<base href="https://evil.test/">', '<base');
    expectClean('<link rel="stylesheet" href="https://evil.test/x.css">', '<link', 'evil.test');
    expectClean('<meta http-equiv="refresh" content="0;url=https://evil.test">', '<meta');
  });
});

describe('YouTube’s player, the one frame RisuAI draws', () => {
  const PLAYER =
    ' sandbox="allow-scripts allow-same-origin" allow="autoplay; encrypted-media; fullscreen; picture-in-picture"' +
    ' referrerpolicy="strict-origin-when-cross-origin" loading="lazy"';

  it('keeps a player under our sandbox and permissions, never the card’s', () => {
    expect(
      sanitizeCustomHtml(
        '<iframe width="320" height="180" src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=5&amp;autoplay=1" title="BGM" ' +
          'frameborder="0" allow="camera; microphone; geolocation" sandbox="allow-scripts allow-same-origin allow-top-navigation allow-popups" ' +
          'referrerpolicy="unsafe-url" allowfullscreen class="video"></iframe>',
      ),
    ).toBe(
      '<iframe width="320" height="180" src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=5&amp;autoplay=1" title="BGM" ' +
        'frameborder="0" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" sandbox="allow-scripts allow-same-origin" ' +
        'referrerpolicy="strict-origin-when-cross-origin" class="x-shizue-video" loading="lazy"></iframe>',
    );
  });

  it('keeps the cookieless player and a playlist’s', () => {
    expect(sanitizeCustomHtml('<iframe src="https://www.youtube-nocookie.com/embed/videoseries?list=PL1"></iframe>')).toBe(
      `<iframe src="https://www.youtube-nocookie.com/embed/videoseries?list=PL1"${PLAYER}></iframe>`,
    );
  });

  it('removes a frame of any other address, decided on the parsed URL', () => {
    for (const src of [
      'https://evil.test/embed/x',
      'http://www.youtube.com/embed/x',
      '//www.youtube.com/embed/x',
      'https://youtube.com/embed/x',
      'https://www.youtube.com.evil.test/embed/x',
      'https://www.youtube.com@evil.test/embed/x',
      'https://user:pass@www.youtube.com/embed/x',
      'https://www.youtube.com:8443/embed/x',
      'https://evil.test/?https://www.youtube.com/embed/x',
      'https://www.youtube.com/embed/../redirect?q=https://evil.test',
      'https://www.youtube.com/embed/%2e%2e/redirect?q=https://evil.test',
      'https://www.youtube.com/embed/x/../../redirect',
      'https://www.youtube.com/embed/',
      'https://www.youtube.com/watch?v=x',
      'https://www.youtube.com/embed\\x',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '/api/plots/x/assets/page.html',
    ]) {
      expectClean(`<iframe src="${src}"></iframe>`, '<iframe');
    }
    expectClean('<iframe></iframe>', '<iframe');
    expectClean('<iframe srcdoc="<b>x</b>"></iframe>', '<iframe', 'srcdoc');
  });

  it('holds no frame while its block is still being written, which draws it again on every token', () => {
    const html = '<div><iframe src="https://www.youtube.com/embed/x"></iframe>노래</div>';
    expect(sanitizeCustomHtml(html, { live: true })).toBe('<div>노래</div>');
    expect(sanitizeCustomHtml(html)).toContain('<iframe');
  });
});

describe('svg and mathml', () => {
  it('keeps an inline SVG icon, its viewBox, paths and namespaced class', () => {
    const output = sanitizeCustomHtml(
      '<span class="stat"><svg class="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
        '<path d="M12 2 2 22h20Z" fill="currentColor" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>' +
        '<circle cx="12" cy="12" r="3" transform="rotate(-90 12 12)"/></svg>HP</span>',
    );
    expect(output).toContain('<svg class="x-shizue-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">');
    expect(output).toContain('<path d="M12 2 2 22h20Z" fill="currentColor" stroke="#fff" stroke-width="2" stroke-linejoin="round">');
    expect(output).toContain('<circle cx="12" cy="12" r="3" transform="rotate(-90 12 12)">');
  });

  it('keeps an SVG pointing at its own gradient, filter and clip path by the folded id', () => {
    const output = sanitizeCustomHtml(
      '<svg viewBox="0 0 10 10"><defs><linearGradient id="hp"><stop offset="0" stop-color="#f00"/></linearGradient>' +
        '<linearGradient id="hp2" href="#hp"/><radialGradient id="glow" xlink:href="#hp"/>' +
        '<filter id="blur"><feGaussianBlur stdDeviation="1"/></filter><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
        '<rect fill="url(#hp)" stroke="url(\'#glow\')" filter="url(#blur)" clip-path="url(#c)" width="10" height="2"/>' +
        '<text><textPath href="#arc">길</textPath></text></svg>',
    );
    for (const kept of [
      'id="x-shizue-hp"',
      'href="#x-shizue-hp"',
      'fill="url(#x-shizue-hp)"',
      'stroke="url(#x-shizue-glow)"',
      'filter="url(#x-shizue-blur)"',
      'clip-path="url(#x-shizue-c)"',
      '<textPath href="#x-shizue-arc">',
    ]) {
      expect(output).toContain(kept);
    }
    expect(output).not.toContain('xlink:href');
  });

  it('refuses an SVG reference to a file anywhere, its own origin included, but a picture of ours', () => {
    const output = expectClean(
      '<svg><rect fill="url(https://evil.test/p.svg#g)" width="1"/><rect filter="url(//evil.test/f.svg#f)" width="2"/>' +
        '<rect mask="image-set(\'https://evil.test/m.png\' 1x)" width="3"/><rect stroke="u\\72l(https://evil.test/x)" width="4"/>' +
        '<rect clip-path="url(/api/plots/x/assets/c.svg#c)" width="5"/>' +
        '<linearGradient href="https://evil.test/g.svg#g"/><textPath xlink:href="/api/plots/x/assets/p.svg#p"/>' +
        '<image href="https://evil.test/t.png"/><image xlink:href="//evil.test/t.png"/><image href="data:image/png;base64,AAAA"/>' +
        '<feImage href="https://evil.test/x.png"/><image href="/api/plots/x/assets/a" width="8"/></svg>',
      'evil.test',
      'data:',
      'clip-path',
      'c.svg',
      'p.svg',
      'feimage',
    );
    // The shapes stay, without what they pointed at; our own picture loads as an <img> would.
    for (const width of ['1', '2', '3', '4', '5']) expect(output).toContain(`<rect width="${width}">`);
    expect(output).toContain('<image href="/api/plots/x/assets/a" width="8">');
    expect(output.match(/<image/g)).toHaveLength(1);
  });

  it('removes svg event handlers, and animate, set and use with their href tricks', () => {
    expectClean('<svg onload="alert(1)"><circle r="4" onclick="alert(2)"/></svg>', 'onload', 'onclick', 'alert');
    expectClean('<svg><animate onbegin="alert(1)" attributeName="x"></animate></svg>', '<animate', 'onbegin', 'alert');
    expectClean(
      '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>',
      '<animate',
      'javascript',
    );
    expectClean('<svg><a><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>', '<set', 'javascript');
    expectClean(
      '<svg><use href="https://evil.test/sprite.svg#i"/><use xlink:href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=#x"/>' +
        '<use href="#icon"/></svg>',
      '<use',
      'evil.test',
      'data:',
    );
    // The animations DOMPurify keeps can still not be aimed at an address.
    expectClean(
      '<svg><a><animateTransform attributeName="href" values="javascript:alert(1)"/>' +
        '<animateMotion attributeName="xlink:href" to="https://evil.test"><mpath href="https://evil.test/p.svg#p"/></animateMotion></a></svg>',
      'attributename',
      'javascript',
      'evil.test',
    );
  });

  it('keeps an SVG link a link only to an http(s) address, opened away from us', () => {
    expectClean('<svg><a href="javascript:alert(1)"><text>x</text></a><a xlink:href="javascript:alert(2)"><text>y</text></a></svg>', 'javascript', 'href');
    const output = sanitizeCustomHtml('<svg><a xlink:href="https://example.test/"><text>z</text></a></svg>');
    expect(output).toContain('href="https://example.test/"');
    expect(output).toContain('rel="noopener noreferrer nofollow"');
    expect(output).not.toContain('xlink:href');
  });

  it('removes an svg foreignObject wrapper', () => {
    expectClean(
      '<svg><foreignObject><div onclick="alert(1)">x</div></foreignObject></svg>',
      'foreignobject',
      'onclick',
    );
  });

  it('removes an svg <script> however it is nested', () => {
    expectClean('<svg><g><script>alert(1)</script></g></svg>', '<script', 'alert(1)');
  });

  it('lifts an SVG’s own stylesheet into the message scope, and lets no markup out of it', () => {
    const output = sanitizeCustomHtml('<svg><style>.ring{stroke:#0f0;stroke-width:4}</style><circle class="ring" r="4"/></svg>');
    expect(output).toMatch(/^<style>\.shizue-msg \.x-shizue-ring \{\s*stroke: #0f0;\s*stroke-width: 4;\s*\}<\/style>/);
    expectClean('<svg><style><img src=x onerror=alert(1)></style></svg>', 'onerror', 'alert');
    expectClean('<svg><style><![CDATA[</style><img src=x onerror=alert(1)>]]></style></svg>', 'onerror', 'alert');
  });

  it('keeps mathml, and kills the annotation-xml and mglyph mXSS carriers', () => {
    expect(sanitizeCustomHtml('<math><mfrac><mi>a</mi><mn>2</mn></mfrac></math>')).toBe('<math><mfrac><mi>a</mi><mn>2</mn></mfrac></math>');
    expectClean('<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', 'onerror', 'alert');
    expectClean(
      '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>',
      'annotation-xml',
      '<script',
    );
    // A MathML `href` would be a link no rule of ours saw.
    expectClean('<math><mi href="javascript:alert(1)">x</mi><mi href="https://evil.test">y</mi></math>', 'href', 'evil.test');
  });
});

/**
 * Whether markup can do nothing but be looked at: no script, no handler, no
 * address that runs or leaves (`href` only on a link to http(s), every `src` ours
 * but the YouTube player's), no form, no popover, no frame but the player, which
 * our sandbox holds.
 */
function expectInert(html: string): void {
  const output = sanitizeCustomHtml(html);
  const holder = document.createElement('template');
  holder.innerHTML = output;
  const forbidden = 'script, object, embed, form, base, link, meta, template, foreignObject, use, animate, set, annotation-xml, iframe:not([sandbox="allow-scripts allow-same-origin"])';
  expect(holder.content.querySelector(forbidden), output).toBeNull();
  for (const element of Array.from(holder.content.querySelectorAll('*'))) {
    for (const { name, value } of Array.from(element.attributes)) {
      const lower = name.toLowerCase();
      expect(lower.startsWith('on'), `${lower} in ${output}`).toBe(false);
      expect(['srcdoc', 'action', 'formaction', 'popover', 'popovertarget', 'command', 'commandfor', 'srcset', 'autofocus'].includes(lower), `${lower} in ${output}`).toBe(false);
      expect(/^\s*(?:javascript|vbscript|data):/i.test(value), `${lower}="${value}"`).toBe(false);
      if (lower === 'src' || lower === 'poster' || lower === 'background') {
        const player = element.tagName.toLowerCase() === 'iframe' && value.startsWith('https://www.youtube');
        expect(player || new URL(value, location.origin).origin === location.origin, `${lower}="${value}"`).toBe(true);
      }
      if (lower === 'href' && !['a', 'area'].includes(element.tagName.toLowerCase())) {
        expect(value.startsWith('#') || new URL(value, location.origin).origin === location.origin, `href="${value}"`).toBe(true);
      }
    }
  }
}

describe('known XSS vectors, against what the RisuAI allowances let in', () => {
  const vectors = [
    // Form controls and their handlers.
    '<input onfocus="alert(1)" autofocus>',
    '<input type="text" onfocus=alert(1) autofocus value="x">',
    '<select onchange="alert(1)" autofocus><option>x</option></select>',
    '<textarea onfocus=alert(1) autofocus>x</textarea>',
    '<input type="image" src="x" onerror="alert(1)">',
    '<input type="image" src="https://evil.test/x.png">',
    '<button formaction="javascript:alert(1)">x</button>',
    '<form><button formaction=javascript:alert(1)>X</button></form>',
    '<form id="f"></form><button form="f" formaction="javascript:alert(1)">X</button>',
    '<isindex action="javascript:alert(1)" type="image">',
    '<details open ontoggle=alert(1)>x</details>',
    '<dialog open onclose=alert(1)>x</dialog>',
    '<div popover id="p" onbeforetoggle=alert(1)>x</div><button popovertarget="p">x</button>',
    '<button command="show-modal" commandfor="d">x</button><dialog id="d">y</dialog>',
    // Frames.
    '<iframe src="javascript:alert(1)"></iframe>',
    '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<iframe src="https://www.youtube.com/embed/x" srcdoc="<script>alert(1)</script>" onload="alert(1)"></iframe>',
    '<iframe src="https://www.youtube.com/embed/x" sandbox="allow-scripts allow-same-origin allow-top-navigation allow-popups"></iframe>',
    // SVG.
    '<svg><script>alert(1)</script></svg>',
    '<svg onload=alert(1)>',
    '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
    '<svg><animateTransform onbegin=alert(1) attributeName=transform>',
    '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>',
    '<svg><animate attributeName="onclick" values="alert(1)"/></svg>',
    '<svg><a xlink:href="javascript:alert(1)"><text x="20" y="20">X</text></a></svg>',
    '<svg><a><animate attributeName=href values=javascript:alert(1) /><text x=20 y=20>X</text></a></svg>',
    '<svg><discard onbegin=alert(1)>',
    '<svg><image href="javascript:alert(1)"/></svg>',
    '<svg><foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe></foreignObject></svg>',
    '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
    '<svg><p><style><img src=x onerror=alert(1)></style></p></svg>',
    // MathML namespace confusion.
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<math><mi><mglyph><svg><mtext><textarea><path id="</textarea><img onerror=alert(1) src=1>">',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    '<math><maction actiontype="statusline#http://evil.test" xlink:href="javascript:alert(1)">x</maction></math>',
    '<math href="javascript:alert(1)">x</math>',
    // Pictures and media that load from elsewhere.
    '<video poster="javascript:alert(1)" src="/api/plots/x/assets/v"></video>',
    '<table background="javascript:alert(1)"><tr><td>x</td></tr></table>',
    '<img src="/a.png" srcset="https://evil.test/a.png 2x">',
    '<picture><source srcset="https://evil.test/a.png"><img src="/a.png"></picture>',
    '<video src="/api/v"><track src="https://evil.test/sub.vtt"></video>',
    '<template><img src=x onerror=alert(1)></template>',
    '<a href="javascript:alert(1)" data-x="1" aria-label="y">x</a>',
    '<area href="javascript:alert(1)">',
  ];
  for (const vector of vectors) {
    it(vector, () => expectInert(vector));
  }
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

  it('drops a selector that starts with a combinator, which would reach past the message', () => {
    for (const selector of ['~ div button', '+ div', '> p', '/* x */ ~ div']) {
      const output = sanitizeCustomHtml(`<style>${selector} { opacity: 0 } .ok { color: red }</style>`);
      expect(output).toContain('.shizue-msg .x-shizue-ok');
      expect(output).not.toContain('opacity');
    }
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

  it('closes a rule the sheet leaves open at its end, as the browser does, and keeps nothing it could not read', () => {
    expect(sanitizeCustomHtml('<style>.a { color: red</style>')).toContain('.shizue-msg .x-shizue-a {\n  color: red;\n}');
    expect(sanitizeCustomHtml('<style>.a { width: calc(1px </style>')).toBe('');
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
      // A function's name is read in any case.
      'Image-set("https://evil.test/x" 1x)',
      '-Webkit-Image-Set("https://evil.test/x" 1x)',
      '\\49 mage-set("https://evil.test/x" 1x)',
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
      '-webkit-user-modify:read-write',
      'user-modify:read-write',
      '-webkit-box-reflect:below',
      'all:initial',
    ]) {
      expectClean(`<style>.a{${declaration}}</style>`, declaration.split(':')[0]!);
    }
  });

  it('keeps the compositing, filters, shapes and 3-D of a RisuAI card, which only draw', () => {
    const declarations = [
      // Ivy, The Vampire Maid's portrait: layers multiplied and screened back together.
      'mix-blend-mode: multiply',
      'background-blend-mode: screen',
      'isolation: isolate',
      'filter: contrast(1.2) grayscale(0.3) drop-shadow(0 0 4px rgba(0,0,0,.5))',
      'backdrop-filter: blur(5px) saturate(1.4)',
      'clip-path: polygon(50% 0, 100% 100%, 0 100%)',
      'clip-path: inset(0 round 12px)',
      'mask-image: linear-gradient(#000, transparent)',
      'perspective: 600px',
      'transform-style: preserve-3d',
      'backface-visibility: hidden',
      'cursor: pointer',
      'pointer-events: none',
      'user-select: none',
      'outline: 1px dashed #c0aa83',
      'grid-template-columns: repeat(auto-fill, minmax(120px, 1fr))',
      'writing-mode: vertical-rl',
      'appearance: none',
    ];
    const output = sanitizeCustomHtml(`<style>.a{${declarations.join(';')}}</style>`);
    for (const kept of declarations) expect(output).toContain(kept);
  });

  it('reads a -webkit- property as the standard one it spells, renames and all', () => {
    const output = sanitizeCustomHtml(
      '<style>@keyframes float{to{opacity:1}}.a{-webkit-backdrop-filter:blur(2px);-webkit-mask-image:linear-gradient(#000,transparent);' +
        '-webkit-text-fill-color:transparent;-webkit-animation:float 10s ease-in-out infinite}</style>',
    );
    expect(output).toContain('-webkit-backdrop-filter: blur(2px)');
    expect(output).toContain('-webkit-mask-image: linear-gradient(#000,transparent)');
    expect(output).toContain('-webkit-text-fill-color: transparent');
    // The card's own keyframes, never the page's.
    expect(output).toContain('-webkit-animation: x-shizue-float 10s ease-in-out infinite');
    expectClean('<style>.a{-webkit-position:sticky}</style>', 'sticky');
  });

  it('takes a url() that names an SVG element only as one of the card’s own, never a file, and none in a cursor', () => {
    for (const declaration of [
      'filter:url(/api/plots/x/assets/f.svg#f)',
      'backdrop-filter:url(/api/plots/x/assets/f.svg#f)',
      'clip-path:url(/api/plots/x/assets/c.svg#c)',
      'mask:url(/api/plots/x/assets/m.svg#m)',
      '-webkit-mask-image:url(/api/plots/x/assets/m.png)',
      'fill:url(https://evil.test/p.svg#p)',
      'stroke:url(/api/plots/x/assets/p.svg#p)',
      'marker-end:url(//evil.test/m.svg#m)',
      'cursor:url(/api/plots/x/assets/c.png), auto',
      'cursor:url(#c), auto',
    ]) {
      expectClean(`<style>.a{${declaration}}</style>`, declaration.split(':')[0]!);
      expectClean(`<div style="${declaration}">x</div>`, declaration.split(':')[0]!);
    }
    // A fragment names an element of the card's own, by the id the DOM pass folds it to.
    const output = sanitizeCustomHtml(
      '<style>.a{filter:url(#blur);clip-path:url("#clip");fill:url( #hp );marker-end:url(#arrow)}</style>' +
        '<div style="mask:url(#m)">x</div>',
    );
    for (const kept of [
      'filter: url(#x-shizue-blur)',
      'clip-path: url(#x-shizue-clip)',
      'fill: url(#x-shizue-hp)',
      'marker-end: url(#x-shizue-arrow)',
      'style="mask: url(#x-shizue-m)"',
    ]) {
      expect(output).toContain(kept);
    }
  });

  it('keeps an SVG gauge’s painting and geometry', () => {
    const declarations = [
      'fill: none',
      'stroke: #22c55e',
      'stroke-width: 4',
      'stroke-dasharray: 100',
      'stroke-dashoffset: 28',
      'stroke-linecap: round',
      'stop-color: #7c3aed',
      'r: 16',
      'cx: 18',
      'paint-order: stroke',
      'transition: stroke-dashoffset 300ms ease',
    ];
    const output = sanitizeCustomHtml(`<style>.ring{${declarations.join(';')}}</style>`);
    for (const kept of declarations) expect(output).toContain(kept);
  });

  it('selects on a card’s data attributes as written, a dot in a value included', () => {
    const output = sanitizeCustomHtml(
      '<style>[data-hp="0.5"] .bar{width:50%}.panel[data-state="low"] .bar{background-color:#f00}' +
        '.x[aria-expanded="true"]{color:red}</style>',
    );
    expect(output).toContain('.shizue-msg [data-hp="0.5"] .x-shizue-bar');
    expect(output).toContain('.shizue-msg .x-shizue-panel[data-state="low"] .x-shizue-bar');
    expect(output).toContain('.shizue-msg .x-shizue-x[aria-expanded="true"]');
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

  it('keeps a card’s data and aria attributes and its roles, as RisuAI does', () => {
    expect(sanitizeCustomHtml('<div data-state="low" data-hp="30" data-v1.2="x" aria-label="체력" aria-hidden="true" role="meter">x</div>')).toBe(
      '<div data-state="low" data-hp="30" data-v1.2="x" aria-label="체력" aria-hidden="true" role="meter">x</div>',
    );
  });

  it('drops the app’s own data attributes, which a card would use to pass for the page', () => {
    expectClean(
      '<div data-shizue-other="2" data-shizue-spoken="" data-testid="message-assistant" data-chat-image="" ' +
        'data-image-group="" data-message-list="" data-hide-icons="" data-dialogue="">x</div>',
      'data-shizue-other',
      'data-shizue-spoken',
      'data-testid',
      'data-chat-image',
      'data-image-group',
      'data-message-list',
      'data-hide-icons',
      'data-dialogue',
    );
  });

  it('cannot make a button run another member’s scripts', () => {
    // The chat page runs a button's trigger as the member its closest
    // `[data-shizue-member][data-shizue-spoken]` names.
    const other = '0a1b2c3d-0000-4000-8000-00000000000b';
    const output = expectClean(
      `<div data-shizue-member="${other}" data-shizue-spoken=""><button risu-trigger="공격">공격</button></div>`,
      'data-shizue-member',
      'data-shizue-spoken',
    );
    expect(output).toContain('data-shizue-trigger="공격"');
  });

  it('folds every attribute that names an element by id, lists included', () => {
    const output = sanitizeCustomHtml(
      '<span id="t">체력</span><meter aria-labelledby="t s" aria-describedby="d" value="3"></meter>' +
        '<input list="opts"><datalist id="opts"><option value="a"></option></datalist>' +
        '<output for="a b"></output><td headers="h1">x</td>' +
        '<img src="/api/plots/x/assets/map" usemap="#m"><map name="m"><area href="https://example.test/" shape="rect" coords="0,0,1,1"><area href="/local"></map>',
    );
    for (const kept of [
      'aria-labelledby="x-shizue-t x-shizue-s"',
      'aria-describedby="x-shizue-d"',
      'list="x-shizue-opts"',
      'id="x-shizue-opts"',
      'for="x-shizue-a x-shizue-b"',
      'usemap="#x-shizue-m"',
      'name="x-shizue-m"',
      '<area href="https://example.test/" shape="rect" coords="0,0,1,1" target="_blank" rel="noopener noreferrer nofollow">',
      '<area>',
    ]) {
      expect(output).toContain(kept);
    }
  });

  it('keeps nothing that lifts a box into the top layer, takes focus or edits the page', () => {
    expectClean(
      '<div popover id="p">x</div><button popovertarget="p" popovertargetaction="show">열기</button>' +
        '<button command="show-modal" commandfor="d">열기</button><dialog id="d">y</dialog>' +
        '<input autofocus><div contenteditable="true">z</div><img src="/a.png" nonce="abc">',
      'popover',
      'command',
      'autofocus',
      'contenteditable',
      'nonce',
    );
  });

  it('holds a poster, an old background picture and a subtitle file to our origin', () => {
    const output = expectClean(
      '<video poster="https://evil.test/p.png" src="/api/plots/x/assets/v"><track src="https://evil.test/sub.vtt"></video>' +
        '<table background="https://evil.test/b.png"><tr><td background="//evil.test/c.png">x</td></tr></table>',
      'evil.test',
      '<track',
      'poster',
      'background',
    );
    expect(output).toContain('<video src="/api/plots/x/assets/v">');
    expect(sanitizeCustomHtml('<video poster="/api/plots/x/assets/p" src="/api/plots/x/assets/v"><track src="/api/plots/x/assets/s"></video>')).toBe(
      '<video poster="/api/plots/x/assets/p" src="/api/plots/x/assets/v"><track src="/api/plots/x/assets/s"></video>',
    );
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

  it('keeps every kind of input, as RisuAI does, and none that loads a picture from elsewhere', () => {
    for (const type of ['text', 'password', 'hidden', 'submit', 'reset', 'file', 'range', 'number', 'date', 'color', 'search']) {
      expect(sanitizeCustomHtml(`<input type="${type}" name="q" value="x">`)).toBe(`<input type="${type}" name="x-shizue-q" value="x">`);
    }
    expect(sanitizeCustomHtml('<input name="q" placeholder="이름">')).toBe('<input name="x-shizue-q" placeholder="이름">');
    expect(sanitizeCustomHtml('<input type="CheckBox">')).toContain('type="checkbox"');
    expect(sanitizeCustomHtml('<input type="image" src="/api/plots/x/assets/a" alt="확인">')).toBe(
      '<input type="image" src="/api/plots/x/assets/a" alt="확인">',
    );
    expectClean('<input type="image" src="https://evil.test/a.png">', '<input', 'evil.test');
  });

  it('keeps a select, its groups and options, and a text area', () => {
    expect(
      sanitizeCustomHtml(
        '<select name="act"><option value="a" selected>공격</option><optgroup label="마법"><option>화염</option></optgroup></select>' +
          '<textarea rows="2" placeholder="메모" maxlength="200"></textarea><fieldset><legend>선택</legend></fieldset>',
      ),
    ).toBe(
      '<select name="x-shizue-act"><option value="a" selected="">공격</option><optgroup label="마법"><option>화염</option></optgroup></select>' +
        '<textarea rows="2" placeholder="메모" maxlength="200"></textarea><fieldset><legend>선택</legend></fieldset>',
    );
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

  // Until 2026-10-15 any one of these dropped the whole sheet. Now each costs what
  // the browser would drop for it, and nothing else.
  it('drops only the rule or the declaration the parser refuses, as the browser does', () => {
    const red = '.shizue-msg .x-shizue-a {\n  color: red;\n}';
    // A stray `}` is read into the next rule's selector, which goes.
    const stray = sanitizeCustomHtml('<style>.a { color: red } } .b { color: blue }</style>');
    expect(stray).toContain(red);
    expect(stray).not.toContain('blue');
    // A comment left open takes the rest of the sheet.
    const comment = sanitizeCustomHtml('<style>.a { color: red } /* never closed .b { color: blue }</style>');
    expect(comment).toContain(red);
    expect(comment).not.toContain('blue');
    // The sheet's end closes the block it left open.
    expect(sanitizeCustomHtml('<style>.a { color: red } .b { color: blue</style>')).toContain(
      '.shizue-msg .x-shizue-b {\n  color: blue;\n}',
    );
    // Renka's and Alice Rawcliffe's sheet, placeholders left for their display
    // scripts: the two declarations with a block in them go, the rule stands.
    const renka = sanitizeCustomHtml(
      '<style>.asset-table{border-collapse:separate;border:3px solid {border};border-radius:15px;max-width:{limit};width:98%}' +
        '.smaller{font-size:15px}</style>',
    );
    expect(renka).toContain('border-collapse: separate;\n  border-radius: 15px;\n  width: 98%;');
    expect(renka).not.toContain('{border}');
    expect(renka).not.toContain('{limit}');
    expect(renka).toContain('.shizue-msg .x-shizue-smaller {\n  font-size: 15px;\n}');
    // Inside a conditional group, and in a `style` attribute, the same.
    const media = sanitizeCustomHtml('<style>@media (max-width: 600px) { .a { border: {b}; color: red } .c { color: green } }</style>');
    expect(media).toContain('color: red');
    expect(media).toContain('color: green');
    expect(media).not.toContain('{b}');
    const inline = sanitizeCustomHtml('<div style="border: 1px solid {border}; color: red; width: calc(1px">x</div>');
    expect(inline).toContain('style="color: red"');
    // A `<` costs its own rule, no longer the sheet.
    const angle = sanitizeCustomHtml('<style>.a::after { content: "<" } .b { color: blue }</style>');
    expect(angle).not.toContain('<"');
    expect(angle).toContain('color: blue');
  });

  it('drops a value that leaves a bracket or a string open, which would swallow the rules after it', () => {
    const output = sanitizeCustomHtml('<style>.a { width: calc(1px } .b { color: blue }</style>');
    expect(output).not.toContain('calc(1px');
    expect(output).toContain('.shizue-msg .x-shizue-b {\n  color: blue;\n}');
  });

  it('keeps a quarter-megabyte sheet whole, every rule of it', () => {
    const big = Array.from({ length: 7200 }, (_, i) => `.r${i} { color: #${(i % 4096).toString(16).padStart(3, '0')}; margin: ${i % 9}px }`).join('\n');
    expect(big.length).toBeGreaterThan(250_000);
    const output = sanitizeCustomHtml(`<style>${big}</style>`);
    expect(output.match(/\.shizue-msg \.x-shizue-r\d+ \{/g)).toHaveLength(7200);
  });
});
