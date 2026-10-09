// @vitest-environment jsdom
// Style reset and mood removal are not covered by the saved-style browser flow.
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../messages/ko.json';
import { PlotStyleEditor } from '../src/components/PlotStyleEditor';
import type { PlotStyle } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;
/** Every style the editor has handed back, newest last. */
let handed: (PlotStyle | null)[];

function render(style: PlotStyle | null): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(PlotStyleEditor, {
          style,
          narrator: null,
          onChange: (next: PlotStyle | null) => void handed.push(next),
          onChangeNarrator: () => {},
        }),
      }),
    );
  });
}

const chip = (name: string, value: string): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>(`[data-testid="style-${name}-${value}"]`)!;

async function press(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The style the last press produced. */
const last = (): PlotStyle | null => handed[handed.length - 1] ?? null;

beforeEach(() => {
  handed = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the style section', () => {
  /** The quiet values are the ones the prompt says nothing about; so is the column. */
  it('empties the style when the last option goes back to its default', async () => {
    render({ pacing: 'fast' });
    await press(chip('pacing', 'natural'));
    expect(last()).toBeNull();

    render({ tense: 'past' });
    await press(chip('tense', 'unset'));
    expect(last()).toBeNull();
  });

  it('keeps two moods and lets the third push the oldest out', async () => {
    render({ moods: ['romance', 'healing'] });
    await press(chip('moods', 'angst'));
    expect(last()).toEqual({ moods: ['healing', 'angst'] });

    // Pressing a chosen one is how it is taken back, cap or no cap.
    render({ moods: ['healing', 'angst'] });
    await press(chip('moods', 'healing'));
    expect(last()).toEqual({ moods: ['angst'] });
  });
});
