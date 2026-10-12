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
  displayPlanner: { plan: () => new Promise(() => undefined), stop: () => undefined },
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
            ['secret', '#shizue-lock:keyword'],
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

  it("draws the plot's own pictures inside markup, and leaves a locked one out", () => {
    render({ content: '<div class="frame">{{img::kiss}}{{img::secret}}</div>' });

    const images = [...host.querySelectorAll('img')];
    expect(images.map((image) => image.getAttribute('src'))).toEqual([OPEN]);
    expect(host.innerHTML).not.toContain('shizue-lock');
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

describe('indented text', () => {
  it('is a paragraph, not a code block', () => {
    render({ content: '첫 줄\n\n    들여 쓴 문단' });

    expect(host.querySelector('pre')).toBeNull();
    expect(host.querySelector('.code-block')).toBeNull();
    expect(host.textContent).toContain('들여 쓴 문단');
  });
});

describe('while streaming', () => {
  it('reveals the prose being written next to a settled panel', () => {
    render({ content: '<div style="color:red">HP 10</div>\n\n그는 천천히 웃었다', streaming: true });

    expect(islands()[0]!.querySelector('div')?.style.color).toBe('red');
    expect(host.querySelectorAll('.shizue-reveal').length).toBeGreaterThan(0);
  });

  it('draws a panel the model has opened and not yet closed, without its half-typed tags', () => {
    render({ content: '<div style="color:red">HP 10\n<span cla', streaming: true });

    const panel = islands()[0]!.querySelector('div');
    expect(panel?.style.color).toBe('red');
    expect(panel?.textContent).toContain('HP 10');
    expect(host.textContent).not.toContain('<span');
  });
});
