// @vitest-environment jsdom
/**
 * A plot image a conversation has not opened yet, where the image would be.
 *
 * The reference is the same `{{img::slug}}` it always was; what changes is what
 * the slug resolves to — the marker a locked asset gets instead of its bytes.
 * So the placeholder and the flip are one thing to test: the same message, drawn
 * against a map that locks the slug and then against one that does not.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../messages/ko.json';
import { lockedSrc } from '../src/lib/assets';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const { MessageBody } = await import('../src/components/MessageBody');

const OPEN = '/api/plots/sty_1/assets/kiss';

let host: HTMLElement;
let root: Root;

async function render(assets: Map<string, string>): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(MessageBody, {
          content: '문이 열린다. {{img::kiss}}',
          assets,
        }) as ReactNode,
      }),
    );
  });
}

const locked = (): HTMLElement | null => host.querySelector('[data-testid="locked-image"]');
const image = (): HTMLImageElement | null => host.querySelector('img[data-chat-image]');

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a locked plot image in a message', () => {
  it('draws the card, with the kind of condition and nothing else', async () => {
    await render(new Map([['kiss', lockedSrc('keyword')]]));

    expect(locked()).not.toBeNull();
    expect(locked()!.textContent).toContain(messages.chat.lockedImage);
    expect(locked()!.textContent).toContain(messages.chat.lockedHints.keyword);
    // No request for a picture nobody may see yet, and no hint of what opens it.
    expect(image()).toBeNull();
    expect(host.innerHTML).not.toContain(OPEN);
    // The prose around the reference is untouched.
    expect(host.textContent).toContain('문이 열린다.');
  });

  it('names each kind by what it waits on', async () => {
    await render(new Map([['kiss', lockedSrc('turns')]]));
    expect(locked()!.textContent).toContain(messages.chat.lockedHints.turns);

    await render(new Map([['kiss', lockedSrc('relationship')]]));
    expect(locked()!.textContent).toContain(messages.chat.lockedHints.relationship);
  });

  it('becomes the image itself once the chat has opened it', async () => {
    await render(new Map([['kiss', lockedSrc('keyword')]]));
    expect(locked()).not.toBeNull();

    // What the `done` event's unlock — or the read after it — leaves behind.
    await render(new Map([['kiss', OPEN]]));
    expect(locked()).toBeNull();
    expect(image()?.getAttribute('src')).toBe(OPEN);
  });
});
