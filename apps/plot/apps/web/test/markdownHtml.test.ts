// @vitest-environment jsdom
/**
 * HTML written into a message (`lib/markdown/html.ts`): which blocks are markup,
 * how markdown with HTML enabled is written out, and what is left of it once the
 * trust boundary has been through it. The mounted behaviour is in
 * messageBodyHtml.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { balancePartial } from '../src/lib/markdown/balance';
import {
  markdownToHtml,
  markupChunks,
  renderImageTokensAsHtml,
  renderMarkup,
} from '../src/lib/markdown/html';

const kinds = (md: string): string[] => markupChunks(md).map((chunk) => (chunk.html ? 'html' : 'prose'));

describe('markupChunks', () => {
  it.each([
    ['plain prose', '첫 문단\n\n둘째 문단\n'],
    ['a status panel', '<div style="color:red">HP 10</div>\n\n그는 웃었다.'],
    ['a panel that spans blank lines', '<div class="panel">\n\n**HP** 10\n\n</div>\n\n뒤'],
    ['a stylesheet with blank lines in it', '<style>\n.a { color: red }\n\n.b { color: blue }\n</style>\n\n본문'],
    ['an element never closed', '<div>\n\n가\n\n나'],
  ])('gives back exactly its input for %s', (_, md) => {
    expect(markupChunks(md).map((chunk) => chunk.text).join('')).toBe(md);
  });

  it('keeps a message without tags as one stretch of prose', () => {
    expect(kinds('첫 문단\n\n둘째 문단\n\n- 하나\n- 둘')).toEqual(['prose']);
  });

  it('cuts a block holding a tag out of the prose around it', () => {
    expect(kinds('앞\n\n<div style="color:red">HP 10</div>\n\n그는 웃었다.')).toEqual([
      'prose',
      'html',
      'prose',
    ]);
    expect(kinds('그는 웃었다.<br>그리고 떠났다.')).toEqual(['html']);
  });

  it.each([
    ['a fenced code sample', '```html\n<div>코드</div>\n```'],
    ['a code span', '태그는 `<br>` 로 쓴다'],
    ['an escaped bracket', '\\<div> 는 글자다'],
    ['an autolink', '<https://example.test/a> 참고'],
    ['an email autolink', '<me@example.test> 로'],
    ['a heart', '고마워 <3'],
    ['a tag not yet finished', '그는 <span sty'],
    ['a comparison', 'a < b 이고 c > d'],
  ])('leaves %s as prose', (_, md) => {
    expect(kinds(md)).toEqual(['prose']);
  });

  it('carries an open element across blank lines until it closes', () => {
    const chunks = markupChunks('<div class="panel">\n\n**HP** 10\n\n</div>\n\n뒤');
    expect(chunks).toEqual([
      { html: true, text: '<div class="panel">\n\n**HP** 10\n\n</div>\n\n' },
      { html: false, text: '뒤' },
    ]);
  });

  it('reads a stylesheet or a comment as raw until it ends', () => {
    expect(kinds('<style>\n.a { color: red }\n\n.b { color: blue }\n</style>\n\n본문')).toEqual([
      'html',
      'prose',
    ]);
    expect(kinds('<!-- 메모\n\n아직 메모 -->\n\n본문')).toEqual(['html', 'prose']);
  });

  it('lets an element nobody keeps, or one the browser ends itself, wrap nothing', () => {
    expect(kinds('<Thoughts>생각\n\n그는 웃었다.')).toEqual(['html', 'prose']);
    expect(kinds('<p>문단\n\n그는 웃었다.')).toEqual(['html', 'prose']);
    expect(kinds('<br>\n\n그는 웃었다.')).toEqual(['html', 'prose']);
  });

  it('pairs code spans the way markdown does', () => {
    expect(kinds('`` `<div>` `` 는 코드')).toEqual(['prose']);
    // A run nothing closes is literal, so the tag after it is a tag.
    expect(kinds('`닫히지 않음 <b>굵게</b>')).toEqual(['html']);
  });

  it('stays linear on a block of stray backticks', () => {
    const block = `${'가`나``'.repeat(20_000)}<b>x</b>`;
    const started = performance.now();
    expect(kinds(block)).toEqual(['html']);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('draws two closed panels as two pieces, and an unclosed one to the end', () => {
    expect(kinds('<div>가</div>\n\n<div>나</div>')).toEqual(['html', 'html']);
    expect(kinds('<div>\n\n가\n\n나')).toEqual(['html']);
  });
});

describe('markdownToHtml', () => {
  it('renders markdown around and between tags, as markdown-it with html does', () => {
    expect(markdownToHtml('**굵게** <span style="color:red">빨강</span>')).toBe(
      '<p><strong>굵게</strong> <span style="color:red">빨강</span></p>',
    );
    expect(markdownToHtml('<div>\n\n*기울임*\n\n</div>')).toBe('<div>\n<p><em>기울임</em></p>\n</div>');
  });

  it('leaves markdown inside an HTML block as written, as CommonMark does', () => {
    expect(markdownToHtml('<div>\n**그대로**\n</div>')).toBe('<div>\n**그대로**\n</div>');
  });

  it('escapes text and writes attributes back', () => {
    expect(markdownToHtml('a < b & c <span>x</span>')).toBe('<p>a &lt; b &amp; c <span>x</span></p>');
    expect(markdownToHtml('```ts\nconst a = 1;\n```')).toBe(
      '<pre><code class="language-ts">const a = 1;\n</code></pre>',
    );
    expect(markdownToHtml('3. 셋\n4. 넷')).toContain('<ol start="3">');
  });

  it('reads an indented paragraph as a paragraph, not as code', () => {
    expect(markdownToHtml('<b>x</b>\n\n    들여 쓴 문단')).toBe('<p><b>x</b></p>\n<p>들여 쓴 문단</p>');
  });
});

describe('renderMarkup', () => {
  it('keeps a status panel as an element', () => {
    const html = renderMarkup('<div style="color:red">HP 10</div>');
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const panel = holder.querySelector('div');
    expect(panel?.textContent).toBe('HP 10');
    expect(panel?.getAttribute('style')).toBe('color: red');
  });

  it.each([
    ['a script', '<div>안전</div><script>alert(1)</script>', ['<script', 'alert']],
    ['an event handler', '<img src="/a.png" onerror="alert(1)">', ['onerror', 'alert']],
    ['a javascript: link', '<a href="javascript:alert(1)">클릭</a>', ['javascript', 'alert']],
    ['a javascript: markdown link', '<b>x</b> [클릭](javascript:alert(1))', ['javascript', 'alert']],
    ['a foreign picture', '<img src="https://evil.test/p.png">', ['evil.test', '<img']],
    ['a foreign markdown picture', '<b>x</b> ![x](https://evil.test/p.png)', ['evil.test', '<img']],
    ['a foreign background', '<div style="background:url(https://evil.test/x)">x</div>', ['evil.test']],
    ['a fixed overlay', '<div style="position:fixed;inset:0">x</div>', ['fixed']],
    ['a frame', '<iframe src="https://evil.test"></iframe>', ['iframe', 'evil.test']],
  ])('neutralizes %s', (_, md, forbidden) => {
    const html = renderMarkup(md).toLowerCase();
    for (const needle of forbidden) expect(html).not.toContain(needle);
  });

  it('scopes a stylesheet under the message and namespaces its classes', () => {
    const html = renderMarkup('<style>\n.box { color: red; }\n</style>\n\n<div class="box">상자</div>');
    expect(html).toContain('.shizue-msg .x-shizue-box');
    expect(html).toContain('class="x-shizue-box"');
  });

  it('opens an http(s) link in a new tab, and turns any other address into its label', () => {
    const external = renderMarkup('<a href="https://example.test/a">밖</a>');
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noopener noreferrer nofollow"');
    const markdown = renderMarkup('<b>x</b> [밖](https://example.test/b)');
    expect(markdown).toContain('rel="noopener noreferrer nofollow"');
    expect(renderMarkup('<a href="/settings">안</a>')).not.toContain('href');
  });

  it('keeps the presentational tags cards are written with', () => {
    const html = renderMarkup('<center>가운데</center>\n\n<font color="red">빨강</font> ~~취소~~');
    expect(html).toContain('<center>');
    expect(html).toContain('<font color="red">');
    expect(html).toContain('<del>취소</del>');
  });
});

describe('renderImageTokensAsHtml', () => {
  const assets = new Map([
    ['kiss', '/api/plots/p1/assets/kiss'],
    ['secret', '#shizue-lock:keyword'],
  ]);

  it('writes a reference as a picture, or as its address inside a tag or a stylesheet', () => {
    expect(renderImageTokensAsHtml('<div>{{img::kiss}}</div>', assets)).toBe(
      '<div><img src="/api/plots/p1/assets/kiss" alt="kiss"></div>',
    );
    expect(renderImageTokensAsHtml('<img src="{{img::kiss}}">', assets)).toBe(
      '<img src="/api/plots/p1/assets/kiss">',
    );
    expect(renderImageTokensAsHtml('<style>.a{background:url({{img::kiss}})}</style>', assets)).toBe(
      '<style>.a{background:url(/api/plots/p1/assets/kiss)}</style>',
    );
  });

  it('leaves out a picture this chat has not opened, and one the plot has not got', () => {
    expect(renderImageTokensAsHtml('<div>{{img::secret}}{{img::nobody}}</div>', assets)).toBe('<div></div>');
    expect(renderImageTokensAsHtml('<img src="{{img::secret}}">', assets)).toBe('<img src="">');
  });

  it('gives RisuAI’s {{source::user}} the persona’s picture where an address goes, and nothing else', () => {
    const own = '/api/personas/p1/avatar';
    expect(renderImageTokensAsHtml('<img src="{{source::user}}"><b>{{source::user}}</b>', assets, undefined, own)).toBe(
      `<img src="${own}"><b></b>`,
    );
    // Without a picture, and for the character, whose one picture a plot of several has not got.
    expect(renderImageTokensAsHtml('<img src="{{source::user}}">', assets)).toBe('<img src="">');
    expect(renderImageTokensAsHtml('<img src="{{source::char}}">', assets, undefined, own)).toBe('<img src="">');
  });
});

describe('balancePartial and a tag being typed', () => {
  it('hides the half-written tag at the end, and only that', () => {
    expect(balancePartial('그는 <span sty')).toBe('그는 ');
    expect(balancePartial('그는 <')).toBe('그는 <');
    expect(balancePartial('a < b')).toBe('a < b');
    expect(balancePartial('<span>x</span> 끝')).toBe('<span>x</span> 끝');
    expect(balancePartial('```html\n<div cla')).toBe('```html\n<div cla\n```');
  });
});
