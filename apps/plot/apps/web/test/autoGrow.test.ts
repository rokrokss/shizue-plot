// @vitest-environment jsdom
/**
 * The composer's height follows its text. jsdom has no layout, so the field's
 * scroll height is stood in for — what is under test is that the measurement is
 * taken from a field reset to its natural height, which is the only reason it
 * can ever get shorter again.
 */
import { describe, expect, it } from 'vitest';
import { autoGrow } from '../src/lib/autoGrow';

/** A textarea whose scroll height answers whatever the fake layout says. */
function field(heightFor: (style: string) => number): HTMLTextAreaElement {
  const node = document.createElement('textarea');
  Object.defineProperty(node, 'scrollHeight', { get: () => heightFor(node.style.height) });
  return node;
}

describe('autoGrow', () => {
  it('grows the field to the height of its content', () => {
    const node = field(() => 120);
    autoGrow(node);
    expect(node.style.height).toBe('120px');
  });

  it('measures from the natural height, so a cleared field shrinks back', () => {
    // Layout of a field that is 40px of text in a box it was told to be tall.
    const node = field((height) => (height === 'auto' ? 40 : Number.parseInt(height, 10) || 40));
    node.style.height = '200px';
    autoGrow(node);
    expect(node.style.height).toBe('40px');
  });
});
