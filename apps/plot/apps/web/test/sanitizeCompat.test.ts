// @vitest-environment jsdom
/**
 * The compat gate for creator assets.
 *
 * `sanitizeHtml.test.ts` is the other half of the same boundary and asks the
 * opposite question: it lists vectors that must stay dead, and a rule loosened too
 * far fails there. This file lists cards that are already in the wild — status
 * windows, gauges, themed cards, the shapes the RisuAI import produces — and fails
 * when a rule is tightened past them.
 *
 * Both halves are needed because the sanitizer is edited under pressure from one
 * side at a time: someone closing a hole reaches for a narrower allowlist and has
 * no way to see whose card they just blanked, and a creator's card breaking is
 * silent — it renders as plain text and looks like the model misbehaved.
 *
 * When a case here changes, that is the point: read the diff, decide the new
 * output is the one you meant, and only then pin it.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeCustomHtml } from '../src/lib/sanitizeHtml';
import { CORPUS, PINNED } from './sanitizeCorpus';

describe('creator cards already in the wild', () => {
  for (const entry of CORPUS) {
    it(`${entry.name} — ${entry.about}`, () => {
      expect(sanitizeCustomHtml(entry.html)).toBe(PINNED[entry.name]);
    });
  }

  it('has a pinned output for every card and no orphans', () => {
    expect(CORPUS.map((entry) => entry.name).sort()).toEqual(Object.keys(PINNED).sort());
  });
});

/**
 * What the corpus is *for*, stated so that deleting a card to make a change pass
 * fails too. Each of these is a thing a real status window stops working without.
 */
describe('the corpus keeps covering', () => {
  const all = Object.values(PINNED).join('\n');

  const features: [string, string][] = [
    ['scoped stylesheets', '.shizue-msg .x-shizue-'],
    ['namespaced classes on elements', 'class="x-shizue-'],
    ['inline styles', 'style="'],
    ['a percentage width, which is every gauge', 'width: 72%'],
    ['gradients', 'linear-gradient('],
    ['shadows', 'box-shadow'],
    ['transitions', 'transition:'],
    ['decorative ::before content', "content: ''"],
    ['media queries', '@media'],
    ['feature queries', '@supports'],
    ['grid', 'display: grid'],
    ['flex', 'display: flex'],
    ['same-origin images', '<img src="/api/plots/'],
    ['same-origin url() backgrounds', "url('/api/plots/"],
    ['table spans', 'colspan="2"'],
    ['the composer button bridge', 'data-shizue-fill='],
    ['native progress and meter', '<progress value="72" max="100">'],
    ['details and summary', '<details'],
    ['external links, opened away from us', 'rel="noopener noreferrer nofollow"'],
  ];

  for (const [what, needle] of features) {
    it(what, () => {
      expect(all).toContain(needle);
    });
  }
});
