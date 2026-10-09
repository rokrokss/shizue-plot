/**
 * The word-reveal plugin.
 *
 * The animation is CSS; the only thing the plugin has to get right is the
 * numbering, because that is what decides whether React keeps a span or mounts a
 * new one — and a remounted span replays its fade.
 */
import { describe, expect, it } from 'vitest';
import type { HastNode } from '../src/lib/markdown/hast';
import { rehypeWordReveal } from '../src/lib/markdown/reveal';

const text = (value: string): HastNode => ({ type: 'text', value });
const el = (tagName: string, ...children: HastNode[]): HastNode => ({
  type: 'element',
  tagName,
  properties: {},
  children,
});
const root = (...children: HastNode[]): HastNode => ({ type: 'root', children });

function run(tree: HastNode): HastNode {
  rehypeWordReveal()(tree);
  return tree;
}

/** Every reveal span, as `index:word`, in document order. */
function spans(node: HastNode): string[] {
  if (node.type === 'element' && node.tagName === 'span') {
    return [`${node.properties!['dataI']}:${flatten(node)}`];
  }
  return (node.children ?? []).flatMap(spans);
}

function flatten(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(flatten).join('');
}

describe('rehypeWordReveal', () => {
  it('gives every word a span and leaves the gaps as text', () => {
    const tree = run(root(el('p', text('아리아가 천천히 돌아섰다'))));
    expect(spans(tree)).toEqual(['0:아리아가', '1:천천히', '2:돌아섰다']);
    expect(flatten(tree)).toBe('아리아가 천천히 돌아섰다');
  });

  it('numbers across elements in document order', () => {
    const tree = run(root(el('p', text('그는 '), el('em', text('낮게 웃었다')), text(' 그리고'))));
    expect(spans(tree)).toEqual(['0:그는', '1:낮게', '2:웃었다', '3:그리고']);
  });

  it('reaches into dialogue', () => {
    const tree = run(root(el('p', el('q', text('「돌아가라.」')))));
    expect(spans(tree)).toEqual(['0:「돌아가라.」']);
  });

  it('leaves code untouched', () => {
    const tree = run(
      root(el('p', text('보라 '), el('code', text('const a = 1'))), el('pre', el('code', text('x y')))),
    );
    expect(spans(tree)).toEqual(['0:보라']);
    expect(flatten(tree)).toBe('보라 const a = 1x y');
  });

  it('has nothing to do with whitespace on its own', () => {
    const tree = run(root(el('p', text('  \n '))));
    expect(spans(tree)).toEqual([]);
  });
});

describe('as the text grows', () => {
  /** What one more token of the same paragraph looks like. */
  const prefixes = ['아리아가', '아리아가 천', '아리아가 천천히', '아리아가 천천히 돌아섰다.'];

  it('never renumbers a word already on screen', () => {
    let previous: string[] = [];
    for (const prefix of prefixes) {
      const now = spans(run(root(el('p', text(prefix)))));
      // Only the word being typed may change; everything before it is fixed.
      const settled = previous.slice(0, Math.max(previous.length - 1, 0));
      expect(now.slice(0, settled.length)).toEqual(settled);
      previous = now;
    }
    expect(previous).toEqual(['0:아리아가', '1:천천히', '2:돌아섰다.']);
  });
});
