// @vitest-environment jsdom
/**
 * HTML a message writes itself, mounted.
 *
 * A greeting's status panel or a `<br>` in a reply is drawn as RisuAI draws it —
 * as markup, through the same trust boundary as a display script's output —
 * while the blocks with no HTML in them keep everything the prose path gives
 * them: speakers, dialogue, the word reveal, the plot's own pictures.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { PublicMember } from '../src/lib/types';

vi.mock('@/lib/displayPlanner', () => ({
  displayPlanner: { plan: () => new Promise(() => undefined), cached: () => undefined, warm: () => true, stop: () => undefined },
}));

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const { MessageBody } = await import('../src/components/MessageBody');

const OPEN = '/api/plots/sty_1/assets/kiss';
const ROSTER: PublicMember[] = [{ id: 'c1', name: '아리아', avatarUrl: null }];

let host: HTMLElement;
let root: Root;

function render(props: Record<string, unknown>): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(MessageBody, {
          assets: new Map([
            ['kiss', OPEN],
          ]),
          ...props,
        } as never) as ReactNode,
      }),
    );
  });
}

/** The sanitized markup islands, in order. */
const islands = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.message-body > .shizue-msg')];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('HTML in a message', () => {
  it("draws a greeting's status panel as an element, not as tag text", () => {
    render({ content: '<div style="color:red">HP 10</div>\n\n*그녀가 웃는다.*' });

    const panel = islands()[0]!.querySelector('div');
    expect(panel?.textContent).toBe('HP 10');
    expect(panel?.style.color).toBe('red');
    expect(host.textContent).not.toContain('<div');
    // The prose after it is still the prose path's.
    expect(host.querySelector('.message-body > p > em')?.textContent).toBe('그녀가 웃는다.');
  });

  it('folds the reasoning a reply closed in <Thoughts>, as RisuAI does, and leaves an open one as its text', () => {
    render({ content: '<Thoughts>\n그가 *왜* 왔을까.\n</Thoughts>\n\n"어서 와."' });
    const fold = islands()[0]!.querySelector('details');
    expect(fold?.querySelector('summary')?.textContent).toBe('생각의 사슬');
    expect(fold?.hasAttribute('open')).toBe(false);
    // One HTML block to the markdown, as markdown-it reads `<details>` up to a blank line: RisuAI shows the `*` too.
    expect(fold?.textContent).toContain('그가 *왜* 왔을까.');
    expect(host.textContent).not.toContain('Thoughts');
    expect(host.textContent).toContain('어서 와.');

    // Cut off before it closed: nothing to fold, and the sanitizer keeps no `<thoughts>`.
    render({ content: '<Thoughts>\n그가 왜 왔을까' });
    expect(host.querySelector('details')).toBeNull();
    expect(host.textContent).toContain('그가 왜 왔을까');
    expect(host.textContent).not.toContain('<Thoughts>');
  });

  it('draws markdown around and between the tags', () => {
    render({ content: '<details>\n<summary>상태</summary>\n\n**HP** 10\n\n</details>' });

    const details = islands()[0]!.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toBe('상태');
    expect(details?.querySelector('strong')?.textContent).toBe('HP');
  });

  it('neutralizes script, handlers, javascript: links and foreign resources', () => {
    render({
      content: [
        '<script>window.pwned = 1</script>',
        '<img src="/a.png" onerror="window.pwned = 2">',
        '<a href="javascript:alert(1)">클릭</a>',
        '<img src="https://evil.test/p.png">',
        '<div style="background:url(https://evil.test/x)">배경</div>',
        '<span style="color:red">빨강</span> ![x](https://evil.test/m.png)',
      ].join('\n\n'),
    });

    const html = host.innerHTML.toLowerCase();
    for (const needle of ['<script', 'onerror', 'javascript:', 'evil.test']) {
      expect(html).not.toContain(needle);
    }
    expect((window as unknown as Record<string, unknown>)['pwned']).toBeUndefined();
    expect(host.textContent).toContain('클릭');
    expect(host.textContent).toContain('배경');
  });

  it('scopes a stylesheet under the message, like a display script’s', () => {
    render({ content: '<style>\n.box { color: red; }\n</style>\n\n<div class="box">상자</div>' });

    const sheet = host.querySelector('.shizue-msg style')?.textContent ?? '';
    expect(sheet).toContain('.shizue-msg .x-shizue-box');
    expect(host.querySelector('.x-shizue-box')?.textContent).toBe('상자');
  });

  it("draws the plot's own pictures inside markup", () => {
    render({ content: '<div class="frame">{{img::kiss}}</div>' });

    const images = [...host.querySelectorAll('img')];
    expect(images.map((image) => image.getAttribute('src'))).toEqual([OPEN]);
  });

  it("plays the plot's music and video written in plain text, as RisuAI's parseAdditionalAssets does", () => {
    // parser.svelte.ts `parseAdditionalAssets`: `{{video::…}}` is
    // `<video controls autoplay loop>`, `{{audio::…}}` `<audio controls autoplay
    // loop>`, `{{asset::…}}` naming a video a muted looping one, wherever they stand.
    render({
      content: '*문이 열린다.*\n\n{{video::clip}}\n\n{{audio::theme}} 노래가 흐른다.\n\n{{asset::clip}}{{video::없음}}',
      assets: new Map([
        ['clip', '/api/plots/sty_1/assets/clip#shizue-video'],
        ['theme', '/api/plots/sty_1/assets/theme'],
      ]),
    });

    const videos = [...host.querySelectorAll('video')];
    expect(videos.map((video) => [video.getAttribute('src'), video.hasAttribute('controls'), video.hasAttribute('muted')])).toEqual([
      ['/api/plots/sty_1/assets/clip#shizue-video', true, false],
      ['/api/plots/sty_1/assets/clip#shizue-video', false, true],
    ]);
    expect(host.querySelector('audio')?.getAttribute('src')).toBe('/api/plots/sty_1/assets/theme');
    expect(host.textContent).toContain('노래가 흐른다.');
    expect(host.textContent).not.toContain('{{');
    // The prose around them is still the prose path's.
    expect(host.querySelector('.message-body > p > em')?.textContent).toBe('문이 열린다.');
  });

  it('holds a link to one rule however it is written', () => {
    render({
      content: '[밖](https://example.test/a) [안](/settings)\n\n<a href="https://example.test/b">밖2</a> <a href="/settings">안2</a>',
    });

    const links = [...host.querySelectorAll('a[href]')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://example.test/a',
      'https://example.test/b',
    ]);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    }
    expect(host.textContent).toContain('안');
    expect(host.textContent).toContain('안2');
  });

  it('leaves HTML inside a code sample as code, with its copy bar', () => {
    render({ content: '```html\n<div style="color:red">x</div>\n```' });

    expect(islands()).toEqual([]);
    expect(host.querySelector('.code-block-copy')).not.toBeNull();
    expect(host.querySelector('pre')?.textContent).toBe('<div style="color:red">x</div>\n');
  });
});

describe('beside the speaker split', () => {
  it('still attributes the prose next to a markup block, and still marks its dialogue', () => {
    render({
      roster: ROSTER,
      content: '<div class="hp">HP 10</div>\n\n아리아: 「돌아가라.」 *칼을 든다*',
    });

    expect(islands()).toHaveLength(1);
    const spoken = host.querySelector('[data-testid="speech-character"]');
    expect(spoken?.getAttribute('data-speaker')).toBe('아리아');
    expect(spoken?.querySelector('q[data-dialogue]')?.textContent).toBe('「돌아가라.」');
  });

  it('draws a speaker line inside markup as the markup’s text, with no face', () => {
    render({ roster: ROSTER, content: '<div class="status">\n아리아: HP 10\n</div>' });

    expect(host.querySelector('[data-testid="speech-character"]')).toBeNull();
    expect(islands()[0]!.textContent).toContain('아리아: HP 10');
  });
});

/**
 * The bubble rule (docs/design/shizue-ui.md): a box of markup — a status window —
 * is the creator's layout and stands outside the speaker's bubble at the flow's
 * width; markup that only dresses words stays in the bubble with them.
 */
describe('a reply with markup in it, in its speaker’s bubbles', () => {
  const owned = { roster: ROSTER, speaker: '아리아', mode: 'reply' };

  it('stands a status window outside the bubbles, and says the name once', () => {
    render({ ...owned, content: '*책을 덮는다.*\n\n<div class="hp">HP 10</div>\n\n가자.' });

    const panel = host.querySelector('.message-html')!;
    expect(panel.textContent).toBe('HP 10');
    expect(panel.closest('.chat-bubble, [data-testid="speech-character"]')).toBeNull();
    const bubbles = [...host.querySelectorAll('.chat-bubble')];
    expect(bubbles.map((node) => node.textContent)).toEqual(['책을 덮는다.', '가자.']);
    // The second stretch keeps the column and says neither face nor name again.
    expect([...host.querySelectorAll('.chat-name')].map((node) => node.textContent)).toEqual(['아리아']);
    expect(host.querySelectorAll('[data-testid="speech-character"]')).toHaveLength(2);
  });

  it('keeps a coloured line in the bubble it is part of', () => {
    render({ ...owned, content: '*웃는다.*\n\n그럼 <span style="color:red">들어와.</span>\n\n어서.' });

    const bubbles = [...host.querySelectorAll('.chat-bubble')];
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.querySelector('.message-html span')?.textContent).toBe('들어와.');
    expect(bubbles[0]!.textContent).toContain('어서.');
  });

  it('dims the 지문 in the bubble and leaves the reader’s own bare', () => {
    render({ ...owned, content: '*웃는다.* 안녕.' });
    expect(host.querySelector('.chat-bubble em')?.textContent).toBe('웃는다.');

    render({ content: '*손을 흔든다.* 안녕.' });
    expect(host.querySelector('.chat-bubble')).toBeNull();
    expect(host.querySelector('em')?.textContent).toBe('손을 흔든다.');
  });
});

/**
 * A reader who turned custom UI off gets no frames, and the call codes the
 * frames would have stood in for read as the text they are — not as a tag the
 * HTML path draws as an unknown element, which is to say not at all.
 */
describe('a call code with components turned off', () => {
  const NAMES = ['StatusWindow'];

  it('reads as its text in an opening', () => {
    render({ componentNames: NAMES, content: '문을 연다\n<StatusWindow hp={70} name="루미" />' });

    expect(host.textContent).toContain('문을 연다');
    expect(host.textContent).toContain('<StatusWindow hp={70} name="루미" />');
    expect(host.querySelector('iframe')).toBeNull();
  });

  it('reads as its text in the middle of a reply', () => {
    render({ componentNames: NAMES, content: '[status] hp=50 <StatusWindow hp={50} /> 검을 뽑았다' });

    expect(host.textContent).toContain('[status] hp=50 <StatusWindow hp={50} /> 검을 뽑았다');
  });

  it('reads as its text inside markup too', () => {
    render({ componentNames: NAMES, content: '<div class="box">\n<StatusWindow hp={70} />\n</div>' });

    expect(islands()[0]!.textContent).toContain('<StatusWindow hp={70} />');
  });

  it('leaves a tag no component is called by to the HTML path', () => {
    render({ componentNames: NAMES, content: '앞 <Note text="x" /> 뒤' });

    expect(host.textContent).not.toContain('<Note');
  });
});

describe('indented text', () => {
  it('is a paragraph, not a code block', () => {
    render({ content: '첫 줄\n\n    들여 쓴 문단' });

    expect(host.querySelector('pre')).toBeNull();
    expect(host.querySelector('.code-block')).toBeNull();
    expect(host.textContent).toContain('들여 쓴 문단');
  });
});

describe('while streaming', () => {
  it('shows the prose being written as written, next to a drawn panel', () => {
    render({ content: '<div style="color:red">HP 10</div>\n\n그는 *천천히* 웃었다', streaming: true });

    expect(islands()[0]!.querySelector('div')?.style.color).toBe('red');
    expect(host.querySelector('em')).toBeNull();
    expect(host.textContent).toContain('그는 *천천히* 웃었다');
  });

  it('draws a panel the model has opened and not yet closed, without its half-typed tags', () => {
    render({ content: '<div style="color:red">HP 10\n<span cla', streaming: true });

    const panel = islands()[0]!.querySelector('div');
    expect(panel?.style.color).toBe('red');
    expect(panel?.textContent).toContain('HP 10');
    expect(host.textContent).not.toContain('<span');
  });
});

/**
 * RisuAI's display escapes — what `{{#escape}}`, `{{decbo}}`, `{{<}}` and the
 * rest leave in a greeting so nothing reads it as syntax — drawn as the
 * characters they stand for, and only ever as text.
 */
describe('display escapes in a message', () => {
  const LT = '';
  const GT = '';

  it('shows an escaped tag as its text, never as an element', () => {
    render({ content: `${LT}b${GT}굵게${LT}/b${GT}` });

    expect(host.textContent).toContain('<b>굵게</b>');
    expect(host.querySelector('.message-body b')).toBeNull();
    expect(islands()).toHaveLength(0);
  });

  it('shows escaped braces as braces, never as a picture or a macro', () => {
    render({ content: 'img::kiss 그리고 \\{\\{user\\}\\}' });

    expect(host.textContent).toContain('{{img::kiss}} 그리고 {{user}}');
    expect(host.querySelector('img')).toBeNull();
  });

  it('names no speaker with an escaped colon', () => {
    render({ content: '아리아 안녕', roster: ROSTER });

    expect(host.querySelector('[data-testid="speech-character"]')).toBeNull();
    expect(host.textContent).toContain('아리아: 안녕');
  });

  it('keeps an escaped tag text inside markup too', () => {
    render({ content: `<div style="color:red">${LT}i${GT}HP${LT}/i${GT}</div>` });

    const panel = islands()[0]!.querySelector('div');
    expect(panel?.textContent).toBe('<i>HP</i>');
    expect(panel?.querySelector('i')).toBeNull();
  });
});
