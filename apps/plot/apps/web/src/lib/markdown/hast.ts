/**
 * The little of hast these plugins need, declared here rather than imported.
 *
 * `@types/hast` is a transitive dependency of react-markdown and is not resolvable
 * from this package, and pulling `unist-util-visit` in for two walks that skip
 * subtrees would be a dependency for nothing.
 */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Elements whose text is not prose: never rewritten, never walked into. */
const OPAQUE_TAGS: ReadonlySet<string> = new Set(['code', 'pre']);

export const text = (value: string): HastNode => ({ type: 'text', value });

/**
 * Replaces every prose text node under `node` with whatever `rewrite` makes of
 * it; a rewrite returning null leaves that node alone. Code is neither rewritten
 * nor walked into.
 */
export function rewriteText(node: HastNode, rewrite: (value: string) => HastNode[] | null): void {
  const children = node.children;
  if (!children) return;
  const out: HastNode[] = [];
  let changed = false;
  for (const child of children) {
    if (child.type === 'text') {
      const replacement = rewrite(child.value ?? '');
      if (replacement) {
        out.push(...replacement);
        changed = true;
        continue;
      }
    } else if (child.type !== 'element' || !OPAQUE_TAGS.has(child.tagName ?? '')) {
      rewriteText(child, rewrite);
    }
    out.push(child);
  }
  if (changed) node.children = out;
}
