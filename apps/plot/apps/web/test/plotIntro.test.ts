// @vitest-environment jsdom
/**
 * A plot's intro — an imported card's creator notes, often — with HTML in it.
 *
 * The intro is rendered on the server for the public page, and sanitizing needs a
 * DOM the server has not got. So what has to hold, besides the markup being drawn
 * at all: the server and hydration agree (no markup on either), and the markup
 * arrives right after.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import { PlotIntro } from '../src/components/PlotIntro';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

// jsdom has no ResizeObserver; the intro only uses it to decide on the fold.
class NoResize {
  observe(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>)['ResizeObserver'] ??= NoResize;

const NOTES = '<div style="color:red">공지</div>\n\n**굵게** 읽기\n\n    들여 쓴 문단';

const intro = (text: string): ReactNode =>
  createElement(NextIntlClientProvider, {
    locale: 'ko',
    messages,
    children: createElement(PlotIntro, { text }),
  });

let host: HTMLElement;
let root: Root | null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host.remove();
});

describe('PlotIntro', () => {
  it('draws the HTML in the notes, sanitized, and the markdown around it', () => {
    root = createRoot(host);
    act(() => root!.render(intro(NOTES)));

    const panel = host.querySelector('.intro-body > .shizue-msg > div') as HTMLElement | null;
    expect(panel?.textContent).toBe('공지');
    expect(panel?.style.color).toBe('red');
    expect(host.querySelector('strong')?.textContent).toBe('굵게');
    // An indent is an indent, not a code block.
    expect(host.querySelector('pre')).toBeNull();
    expect(host.textContent).toContain('들여 쓴 문단');
  });

  it('fetches nothing from elsewhere and keeps links to the one rule', () => {
    root = createRoot(host);
    act(() =>
      root!.render(
        intro(
          '<img src="https://evil.test/a.png"> ![x](https://evil.test/b.png) ![own](/api/plots/p/assets/a)\n\n' +
            '[밖](https://example.test) [안](/settings)',
        ),
      ),
    );

    expect(host.innerHTML).not.toContain('evil.test');
    expect([...host.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
      '/api/plots/p/assets/a',
    ]);
    const links = [...host.querySelectorAll('a[href]')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://example.test']);
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('renders on the server without the markup, and hydrates into it without a mismatch', async () => {
    const server = renderToString(intro(NOTES));
    expect(server).not.toContain('공지');
    expect(server).toContain('<strong>굵게</strong>');

    host.innerHTML = server;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const recoverable: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(host, intro(NOTES), {
        onRecoverableError: (error) => recoverable.push(error),
      });
    });

    expect(recoverable).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    expect((host.querySelector('.shizue-msg > div') as HTMLElement | null)?.style.color).toBe('red');
  });
});
