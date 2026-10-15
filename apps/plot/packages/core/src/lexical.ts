/**
 * Search by words beside search by meaning: BM25 over character bigrams, fused
 * with the embedder's ranking by reciprocal rank (ARCHITECTURE §7.3 단어 검색).
 * A dense vector blurs what a reader refers back to by its exact form — a name,
 * a number, an invented word — and BM25 finds exactly those.
 *
 * Pure: the API hands in the documents and the dense ranking it already has.
 */

/* -------------------------------------------------------------- tokenizer */

const HANGUL = /[\uAC00-\uD7A3]/;
/** Hiragana, katakana (half-width too) and CJK ideographs: written without spaces, cut into bigrams like Hangul. */
const KANA_CJK = /[\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F]/;
/** Every other letter or digit: words of Latin and the rest, numbers. */
const WORD = /[\p{L}\p{N}]/u;
/** Hangul's bare consonants and vowels — ㅋㅋ, ㅠㅠ — say nothing to search by. */
const JAMO = /[\u1100-\u11FF\u3130-\u318F]/;

type Script = 'hangul' | 'cjk' | 'word';

const scriptOf = (char: string): Script | null => {
  if (HANGUL.test(char)) return 'hangul';
  if (KANA_CJK.test(char)) return 'cjk';
  if (JAMO.test(char)) return null;
  return WORD.test(char) ? 'word' : null;
};

/**
 * What a text says in words, without what only a renderer or a macro engine
 * reads: RisuAI's and SillyTavern's `{{…}}` macros, HTML (a `<style>` or
 * `<script>` block whole), character entities, and the thousands separator in
 * a number.
 */
export function lexicalText(text: string): string {
  return text
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, ' ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1');
}

/**
 * A text's terms run by run: each run of Hangul within a word as its syllable
 * bigrams (a one-syllable word as itself), each run of kana or CJK the same
 * way, and every other run of letters and digits as one lowercase word.
 * Punctuation, symbols and bare jamo end a run and are not terms.
 */
export function lexicalRuns(text: string): string[][] {
  const runs: string[][] = [];
  let run = '';
  let script: Script | null = null;
  const flush = (): void => {
    if (script === 'word') runs.push([run]);
    else if (script) {
      const syllables = [...run];
      const terms: string[] = syllables.length === 1 ? [run] : [];
      for (let at = 0; at + 1 < syllables.length; at += 1) terms.push(syllables[at]! + syllables[at + 1]!);
      runs.push(terms);
    }
    run = '';
    script = null;
  };
  for (const char of lexicalText(text).normalize('NFKC').toLowerCase()) {
    const next = /\s/.test(char) ? null : scriptOf(char);
    if (next !== script) flush();
    if (next) {
      script = next;
      run += char;
    }
  }
  flush();
  return runs;
}

/**
 * A text's terms, in order (`lexicalRuns`). Bigrams find a Korean word under
 * its particles and endings — 리안은, 리안의 and 리안에게 all hold 리안 —
 * without a morphological analyzer.
 */
export const lexicalTerms = (text: string): string[] => lexicalRuns(text).flat();

/* --------------------------------------------------------------- evidence */

/**
 * Everyday words a turn is made of whatever it is about — conjunctions and
 * adverbs, pronouns and question words, light verbs, interjections. Their
 * stems are never a sign the turn refers to something in particular.
 */
const EVERYDAY_WORDS = [
  '그래서', '그리고', '그런데', '근데', '하지만', '그러나', '그럼', '그러면', '그냥', '진짜', '정말', '너무', '아주', '매우',
  '조금', '좀', '많이', '다시', '또', '아직', '이제', '지금', '오늘', '내일', '어제', '요즘', '방금', '항상', '계속', '벌써',
  '이미', '빨리', '같이', '함께', '혼자', '다', '모두', '전부', '제일', '가장', '더', '꼭', '혹시', '아마', '별로', '대체',
  '도대체', '일단', '먼저', '나중', '잠깐', '잠시', '한', '두', '많다', '많은', '많아', '아무', '모든', '어떤', '다른',
  '나', '너', '저', '우리', '저희', '너희', '그', '이', '그녀', '그것', '이것', '저것', '그거', '이거', '저거', '여기', '거기',
  '저기', '이런', '그런', '저런', '이렇게', '그렇게', '저렇게', '어떻게', '왜', '뭐', '무엇', '무슨', '어디', '언제', '누구',
  '어느', '얼마', '몇',
  '하다', '하고', '하는', '해서', '했어', '했다', '할까', '할래', '할게', '해요', '해줘', '하자', '하지', '한다', '하세요',
  '있다', '있어', '있는', '없다', '없어', '없는', '같다', '같아', '같은', '되다', '됐어', '되는', '싶다', '싶어', '좋다', '좋아',
  '좋은', '알다', '알아', '몰라', '보다', '봐', '가자', '줘', '줄래', '주세요', '생각',
  '응', '네', '예', '아니', '그래', '그렇지', '맞아', '음', '아', '오', '와', '헐', '제발', '고마워', '감사', '미안', '죄송', '안녕',
];
let everydayStems: Set<string> | undefined;

/**
 * What a query may show evidence by: the first term of each run of each of
 * its words — a Korean word's stem, since its particles and endings come
 * after (한석 of 한석이, not 석이) — but not an everyday word's.
 */
export function lexicalStems(query: string): Set<string> {
  everydayStems ??= new Set(EVERYDAY_WORDS.map((word) => lexicalRuns(word)[0]![0]!));
  const stems = new Set<string>();
  for (const run of lexicalRuns(query)) if (!everydayStems.has(run[0]!)) stems.add(run[0]!);
  return stems;
}

/**
 * When a lexical hit shows real evidence (ARCHITECTURE §7.3 단어 검색): it
 * holds one of the query's stems (`lexicalStems`) that at most `share` of the
 * documents hold — or `floor` of them, in a small set. Measured on the Korean
 * eval: a stem gate keeps endings and particles (는데, 하고) and the everyday
 * words out, so small talk changes the dense picks of the memory not at all,
 * while names, numbers and invented words still count.
 */
export const LEXICAL_EVIDENCE = { share: 0.05, floor: 2 } as const;

/** At most how many of `documents` may hold a term for it to count as evidence. */
export const rareLimit = (documents: number): number =>
  Math.max(LEXICAL_EVIDENCE.floor, Math.ceil(LEXICAL_EVIDENCE.share * documents));

export function hasLexicalEvidence(
  matched: readonly { term: string; frequency: number }[],
  stems: ReadonlySet<string>,
  documents: number,
): boolean {
  const limit = rareLimit(documents);
  return matched.some((match) => stems.has(match.term) && match.frequency <= limit);
}

/* ------------------------------------------------------------------- BM25 */

/**
 * BM25's two knobs at Lucene's defaults (and Robertson's usual range): `k1`
 * 1.2, so a term said twice counts more than once but a name repeated ten
 * times does not drown the rest; `b` 0.75, so a long chunk is not favoured for
 * holding more bigrams by length alone.
 */
export const BM25 = { k1: 1.2, b: 0.75 } as const;

/** Lucene's BM25 idf: never negative, however common the term. */
export const bm25Idf = (documents: number, frequency: number): number =>
  Math.log(1 + (documents - frequency + 0.5) / (frequency + 0.5));

/**
 * One term's share of a document's BM25 score: `tf` occurrences in a document
 * of `length`, among `documents` of mean length `averageLength`, `frequency`
 * of which hold it.
 */
export function bm25TermScore(
  tf: number,
  length: number,
  frequency: number,
  documents: number,
  averageLength: number,
  { k1, b }: { k1: number; b: number } = BM25,
): number {
  const norm = k1 * (1 - b + (b * length) / (averageLength || 1));
  return (bm25Idf(documents, frequency) * tf * (k1 + 1)) / (tf + norm);
}

/** A text as the terms are cut from it (`lexicalRuns`), before the cutting. */
const searchText = (text: string): string => lexicalText(text).normalize('NFKC').toLowerCase();

/**
 * How often `term` (one of `lexicalTerms`) is a term of `text` (a
 * `searchText`), without cutting the text: a two-syllable term wherever it
 * stands, since two adjacent syllables are always one run's; a one-syllable
 * term or a word only where it is the whole run.
 */
function occurrences(text: string, term: string): number {
  const first = scriptOf(term[0]!);
  const pair = first !== 'word' && [...term].length === 2;
  let count = 0;
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    if (pair || (scriptOf(text[at - 1] ?? ' ') !== first && scriptOf(text[at + term.length] ?? ' ') !== first)) count += 1;
  }
  return count;
}

/**
 * The lexical ranking of `texts` (id → text) for `query`, best first, with
 * evidence only (`hasLexicalEvidence`); empty when nothing shows any. BM25
 * over the query's distinct terms that few enough documents hold to be
 * evidence (`rareLimit`) — a commoner one is a stop word and counts for
 * nothing — with a document's length in characters. A tie keeps the order of
 * `texts`.
 *
 * It reads the texts rather than an index of them: a term is looked for as it
 * stands in each, and a common one only until it is known to be common, so a
 * search of a long chat's thousand messages costs a few milliseconds and no
 * memory beyond the texts.
 */
export function lexicalRanking<I>(texts: Iterable<readonly [I, string]>, query: string): I[] {
  const stems = lexicalStems(query);
  if (stems.size === 0) return [];
  const documents = [...texts].map(([id, text]) => ({ id, text: searchText(text) }));
  const limit = rareLimit(documents.length);
  const held = new Map<string, Map<number, number>>();
  for (const term of new Set(lexicalTerms(query))) {
    const holders = new Map<number, number>();
    for (let at = 0; at < documents.length && holders.size <= limit; at += 1) {
      const tf = occurrences(documents[at]!.text, term);
      if (tf > 0) holders.set(at, tf);
    }
    if (holders.size > 0 && holders.size <= limit) held.set(term, holders);
  }
  const candidates = new Set([...stems].flatMap((stem) => [...(held.get(stem)?.keys() ?? [])]));
  if (candidates.size === 0) return [];
  const average = documents.reduce((sum, document) => sum + document.text.length, 0) / documents.length;
  return [...candidates]
    .map((at) => {
      let score = 0;
      for (const holders of held.values()) {
        const tf = holders.get(at);
        if (tf) score += bm25TermScore(tf, documents[at]!.text.length, holders.size, documents.length, average);
      }
      return { at, score };
    })
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map(({ at }) => documents[at]!.id);
}

/* ----------------------------------------------------------------- fusion */

/** Reciprocal rank fusion's constant (Cormack et al.; HypaV3's and Elasticsearch's too). */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion of rankings, best first: each item scores
 * `Σ 1 / (k + rank)` over the lists it is in. A tie goes to the item the
 * earlier list ranks — the dense ranking is passed first, so a lexical hit
 * alone never outranks a dense hit of the same standing — and then to the
 * better rank in a later one.
 */
export function reciprocalRankFusion<T>(lists: readonly (readonly T[])[], k: number = RRF_K): T[] {
  const scores = new Map<T, number>();
  const ranks = new Map<T, number[]>();
  lists.forEach((list, which) => {
    list.forEach((item, rank) => {
      scores.set(item, (scores.get(item) ?? 0) + 1 / (k + rank + 1));
      const own = ranks.get(item) ?? lists.map(() => Infinity);
      own[which] = Math.min(own[which]!, rank);
      ranks.set(item, own);
    });
  });
  return [...scores.keys()].sort((a, b) => {
    const difference = scores.get(b)! - scores.get(a)!;
    if (Math.abs(difference) > 1e-12) return difference;
    const ra = ranks.get(a)!;
    const rb = ranks.get(b)!;
    for (let which = 0; which < lists.length; which += 1) {
      if (ra[which] !== rb[which]) return ra[which]! - rb[which]!;
    }
    return 0;
  });
}

/**
 * A search's ranking by meaning and by words together: their reciprocal rank
 * fusion, the dense ranking first (it wins a tie). Nothing found by words
 * leaves the dense ranking as it is.
 */
export const hybridRanking = <T>(dense: readonly T[], lexical: readonly T[]): T[] =>
  lexical.length === 0 ? [...dense] : reciprocalRankFusion([dense, lexical]);
