// @vitest-environment jsdom
/**
 * The sidebar a wide screen keeps beside 설정's one page: what it lists and
 * where it jumps. Which section the page has scrolled to is layout, which jsdom
 * has none of; at the start, the first is the one being read.
 *
 * `createElement` rather than JSX, matching header.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsNav } from '../src/components/SettingsNav';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MESSAGES = {
  brand: { full: 'shizue' },
  settings: {
    title: '설정',
    groups: { ai: 'AI', app: '앱' },
    sections: { models: '모델과 연결', display: '화면', devices: '휴대폰 연결', backup: '백업과 복원' },
  },
};

let host: HTMLElement;
let root: Root;

beforeEach(async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages: MESSAGES,
        children: createElement(SettingsNav) as ReactElement,
      }),
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('SettingsNav', () => {
  it('jumps to each section of the one page, in its groups, the first marked at the start', () => {
    const links = [...host.querySelectorAll('a')];

    expect([...host.querySelectorAll('p')].map((label) => label.textContent)).toEqual(['AI', '앱']);
    // No phone pairing in this build, so no 휴대폰 연결.
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['모델과 연결', '#models'],
      ['화면', '#display'],
      ['백업과 복원', '#backup'],
    ]);
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual(['location', null, null]);
  });
});
