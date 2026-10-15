/**
 * How often the search by words (@shizue/core `lexical.ts`, ARCHITECTURE §7.3
 * 단어 검색) finds anything, per site, said in the log every `EVERY` searches of
 * it. A keyword channel can stop finding without failing — a tokenizer that no
 * longer cuts Korean, a column left empty — and then shows only as this share
 * falling to nothing. Per process, and forgotten once said.
 */
export type LexicalSite = 'memory' | 'facts' | 'messages' | 'explore';

const EVERY = 200;
const counts = new Map<LexicalSite, { searches: number; found: number }>();

export function noteLexicalSearch(site: LexicalSite, found: boolean): void {
  const count = counts.get(site) ?? { searches: 0, found: 0 };
  count.searches += 1;
  if (found) count.found += 1;
  counts.set(site, count);
  if (count.searches < EVERY) return;
  console.log(
    `[lexical] ${site}: ${count.found} of ${count.searches} searches found words (${Math.round((100 * count.found) / count.searches)}%)`,
  );
  counts.delete(site);
}
