// @vitest-environment jsdom
/**
 * The lorebook editor's advanced fields. Every one of them is absent until the
 * creator sets it, and absent is the default the engine reads — so clearing a
 * field has to take it out of the entry, not write the 0 an empty number input
 * parses to (a 0 probability is an entry that never fires).
 *
 * `createElement` rather than JSX, matching bottomSheet.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../messages/ko.json';
import { LorebookEditor } from '../src/components/LorebookEditor';
import type { LoreEntry } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const base: LoreEntry = {
  keys: ['용'],
  secondaryKeys: [],
  selective: false,
  content: '용의 둥지',
  enabled: true,
  constant: false,
  insertionOrder: 0,
  caseSensitive: false,
  useRegex: false,
  position: 'before_char',
};

let host: HTMLElement;
let root: Root;
let changes: LoreEntry[][];

function render(entry: LoreEntry): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(LorebookEditor, {
          entries: [entry],
          onChange: (entries: LoreEntry[]) => changes.push(entries),
        }),
      }),
    );
  });
}

/** The number input under a field caption. */
const field = (caption: string): HTMLInputElement => {
  const label = [...host.querySelectorAll('label')].find((node) =>
    node.querySelector('span')?.textContent?.startsWith(caption),
  );
  return label!.querySelector('input')!;
};

/** Types into a controlled input the way React reads it back. */
function type(node: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  changes = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the advanced lore fields', () => {
  it('sets a number and takes it out again when cleared', () => {
    render(base);
    type(field('발동 확률'), '30');
    expect(changes.at(-1)![0]!.probability).toBe(30);

    render({ ...base, probability: 30, sticky: 2 });
    type(field('발동 확률'), '');
    expect('probability' in changes.at(-1)![0]!).toBe(false);
    type(field('지속'), '');
    expect('sticky' in changes.at(-1)![0]!).toBe(false);
  });

  it('takes the role out with the depth, since a role only means something at a depth', () => {
    render(base);
    type(field('삽입 깊이'), '0');
    expect(changes.at(-1)![0]!.depth).toBe(0);

    render({ ...base, depth: 2, role: 'user' });
    type(field('삽입 깊이'), '');
    const cleared = changes.at(-1)![0]!;
    expect('depth' in cleared || 'role' in cleared).toBe(false);
  });

  it('drops a group that is only whitespace', () => {
    render({ ...base, group: '날씨' });
    type(field('그룹'), '  ');
    expect('group' in changes.at(-1)![0]!).toBe(false);
  });
});
