// @vitest-environment jsdom
/**
 * The illustration gallery in the notes panel: what this conversation has opened
 * of the work's images, and what it has not.
 *
 * The section is a reward, so it only exists where there is something to earn —
 * a plot whose pictures are simply drawn wherever a message asks for them has
 * nothing to collect, and gets no gallery at all.
 *
 * `createElement` rather than JSX, matching `chatPanelFeatures.test.ts`.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { Illustration } from '../src/lib/assets';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: unknown }) =>
    createElement('a', { href }, children as never),
}));

const { ChatPanel } = await import('../src/components/ChatPanel');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

function render(illustrations: Illustration[]): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        timeZone: 'Asia/Seoul',
        messages,
        children: createElement(ChatPanel, {
          members: [],
          note: '',
          notes: [],
          noteIds: [],
          memory: null,
          memorySettings: null,
          relationship: null,
          relationshipEnabled: true,
          narrator: null,
          illustrations,
          customUi: true,
          allowComponentTurns: false,
          statusWindow: false,
          statusWindowEnabled: true,
          choices: false,
          choicesEnabled: true,
          disabled: false,
          onSaveNote: async () => undefined,
          onToggleNote: async () => undefined,
          onSaveMemory: async () => undefined,
          onSaveMemorySettings: async () => undefined,
          onToggleRelationship: async () => undefined,
          onSaveNarrator: async () => undefined,
          onToggleCustomUi: () => undefined,
          onToggleComponentTurns: async () => undefined,
          onToggleStatusWindow: async () => undefined,
          onToggleChoices: async () => undefined,
        }),
      }),
    );
  });
}

const section = (): HTMLElement | null => host.querySelector('[data-testid="chat-illustrations"]');
const open = (): HTMLButtonElement[] => [
  ...host.querySelectorAll<HTMLButtonElement>('[data-testid="illustration-open"]'),
];
const shut = (): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>('[data-testid="illustration-locked"]'),
];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the illustration gallery', () => {
  it('says nothing about a plot with nothing to unlock', () => {
    render([{ slug: 'smile', src: '/api/plots/sty_1/assets/smile', kind: null, locked: false }]);
    expect(section()).toBeNull();
  });

  it('draws the open ones and leaves the rest as silhouettes with their hint', () => {
    render([
      { slug: 'smile', src: '/api/plots/sty_1/assets/smile', kind: null, locked: false },
      { slug: 'kiss', src: null, kind: 'keyword', locked: true },
      { slug: 'ending', src: null, kind: 'relationship', locked: true },
    ]);

    expect(section()).not.toBeNull();
    expect(open()).toHaveLength(1);
    expect(open()[0]!.querySelector('img')?.getAttribute('src')).toBe(
      '/api/plots/sty_1/assets/smile',
    );
    expect(shut()).toHaveLength(2);
    // The kind, and only the kind: the condition itself is the creator's.
    expect(shut()[0]!.textContent).toContain(messages.chat.lockedHints.keyword);
    expect(shut()[1]!.textContent).toContain(messages.chat.lockedHints.relationship);
    expect(host.innerHTML).not.toContain('assets/kiss');
  });

  it('opens an unlocked image into the lightbox the chat already has', () => {
    render([
      { slug: 'kiss', src: '/api/plots/sty_1/assets/kiss', kind: 'keyword', locked: false },
    ]);

    act(() => {
      open()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="lightbox"]')).not.toBeNull();
  });
});
