/**
 * The dialogue-quote plugin, run over hast directly.
 *
 * The interesting cases are the ones a chat log actually produces: a line of
 * speech inside a stage direction, a quote mark inside a code sample, and — on
 * every single token of every single reply — a quote that has only opened.
 */
import { describe, expect, it } from 'vitest';
import type { HastNode } from '../src/lib/markdown/hast';
import { rehypeDialogueQuotes } from '../src/lib/markdown/quotes';

const text = (value: string): HastNode => ({ type: 'text', value });
const el = (tagName: string, ...children: HastNode[]): HastNode => ({
  type: 'element',
  tagName,
  properties: {},
  children,
});
const root = (...children: HastNode[]): HastNode => ({ type: 'root', children });

function run(tree: HastNode): HastNode {
  rehypeDialogueQuotes()(tree);
  return tree;
}

/** Every `<q>` in the tree, as the text it holds, outermost first. */
function quotes(node: HastNode): string[] {
  const own = node.type === 'element' && node.tagName === 'q' ? [flatten(node)] : [];
  return [...own, ...(node.children ?? []).flatMap(quotes)];
}

function flatten(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(flatten).join('');
}

describe('rehypeDialogueQuotes', () => {
  it('wraps a closed pair and keeps the marks that were written', () => {
    const tree = run(root(el('p', text('그가 말했다. 「돌아가라.」'))));
    expect(quotes(tree)).toEqual(['「돌아가라.」']);
    expect(flatten(tree)).toBe('그가 말했다. 「돌아가라.」');
  });

  it('handles every pair it knows', () => {
    for (const line of ['"안녕"', '“안녕”', '「안녕」', '『안녕』', '«안녕»']) {
      expect(quotes(run(root(el('p', text(line)))))).toEqual([line]);
    }
  });

  it('leaves a pair that has only opened alone', () => {
    const tree = run(root(el('p', text('그가 말했다. 「돌아가'))));
    expect(quotes(tree)).toEqual([]);
    expect(flatten(tree)).toBe('그가 말했다. 「돌아가');
  });

  it('wraps the pair that closed and not the one still open', () => {
    const tree = run(root(el('p', text('「끝났다.」 그리고 「아직'))));
    expect(quotes(tree)).toEqual(['「끝났다.」']);
    expect(flatten(tree)).toBe('「끝났다.」 그리고 「아직');
  });

  it('nests, innermost included', () => {
    const tree = run(root(el('p', text('「그가 "안녕" 이라 했다.」'))));
    expect(quotes(tree)).toEqual(['「그가 "안녕" 이라 했다.」', '"안녕"']);
  });

  it('reaches into emphasis but not into code', () => {
    const tree = run(
      root(
        el('p', el('em', text('「낮게」')), text(' 그리고 '), el('code', text('"literal"'))),
        el('pre', el('code', text('const s = "x";'))),
      ),
    );
    expect(quotes(tree)).toEqual(['「낮게」']);
  });

  it('does not wrap a quote that spans two elements', () => {
    // The opener and the closer are in different text nodes, so neither is a pair.
    const tree = run(root(el('p', text('「앞'), el('strong', text('굵게')), text('뒤」'))));
    expect(quotes(tree)).toEqual([]);
  });

  it('marks the element for the stylesheet', () => {
    const tree = run(root(el('p', text('"말"'))));
    const q = (tree.children![0]!.children ?? [])[0]!;
    expect(q.tagName).toBe('q');
    expect(q.properties).toEqual({ dataDialogue: '' });
  });
});
