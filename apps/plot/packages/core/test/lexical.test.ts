import { describe, expect, it } from 'vitest';
import {
  BM25,
  bm25Idf,
  bm25TermScore,
  hasLexicalEvidence,
  hybridRanking,
  lexicalRanking,
  lexicalStems,
  lexicalTerms,
  rareLimit,
  reciprocalRankFusion,
} from '../src/lexical.js';

describe('lexicalTerms', () => {
  it('cuts Hangul into syllable bigrams within each word, a one-syllable word kept whole', () => {
    expect(lexicalTerms('리안은 도서관에 꽃 한 송이')).toEqual(['리안', '안은', '도서', '서관', '관에', '꽃', '한', '송이']);
    // The name is found under every particle.
    for (const word of ['리안의', '리안에게', '리안']) expect(lexicalTerms(word)).toContain('리안');
  });

  it('keeps Latin words and numbers whole and lowercase, apart from the Hangul around them', () => {
    expect(lexicalTerms('Project ARIA, 비밀번호 4821!')).toEqual(['project', 'aria', '비밀', '밀번', '번호', '4821']);
    expect(lexicalTerms('707호에서 1,200명이')).toEqual(['707', '호에', '에서', '1200', '명이']);
    // Full-width forms are their ordinary ones.
    expect(lexicalTerms('ＡＢＣ１２')).toEqual(['abc12']);
  });

  it('cuts kana and CJK runs into bigrams', () => {
    expect(lexicalTerms('東京へ行く')).toEqual(['東京', '京へ', 'へ行', '行く']);
    expect(lexicalTerms('猫')).toEqual(['猫']);
  });

  it('reads past macros, HTML, entities, punctuation and bare jamo', () => {
    expect(lexicalTerms('{{user}}가 <b class="x">웃었다</b>&nbsp;')).toEqual(['가', '웃었', '었다']);
    expect(lexicalTerms('<style>.a { color: red }</style><div>안녕</div>')).toEqual(['안녕']);
    expect(lexicalTerms('{{getvar::hp}} ㅋㅋㅋ 진짜?! ㅠㅠ…')).toEqual(['진짜']);
    expect(lexicalTerms('『잿빛 연대기』')).toEqual(['잿빛', '연대', '대기']);
    expect(lexicalTerms('')).toEqual([]);
  });
});

describe('lexicalStems', () => {
  it('takes the first term of each word, never an ending, and no everyday word', () => {
    expect([...lexicalStems('한석 할아버지한테 다시 가 볼까?')]).toEqual(['한석', '할아', '가', '볼까']);
    expect([...lexicalStems('12월 3일에 Project ARIA')]).toEqual(['12', '월', '3', '일에', 'project', 'aria']);
    // Small talk is made of everyday words.
    expect(lexicalStems('응 좋아, 그렇게 하자')).toEqual(new Set());
    expect(lexicalStems('ㅋㅋㅋ 그래서 어떻게 됐는데?')).toEqual(new Set(['됐는']));
  });
});

describe('hasLexicalEvidence', () => {
  it('asks for a stem that few documents hold', () => {
    expect(rareLimit(10)).toBe(2);
    expect(rareLimit(100)).toBe(5);
    expect(rareLimit(1000)).toBe(50);
    const stems = new Set(['한석']);
    expect(hasLexicalEvidence([{ term: '한석', frequency: 1 }], stems, 60)).toBe(true);
    expect(hasLexicalEvidence([{ term: '한석', frequency: 4 }], stems, 60)).toBe(false);
    // A rare term that is no stem (an ending) is no evidence.
    expect(hasLexicalEvidence([{ term: '석이', frequency: 1 }], stems, 60)).toBe(false);
  });
});

describe('BM25', () => {
  it('weighs a rare term over a common one, saturates repeats and favours the shorter holder', () => {
    expect(BM25).toEqual({ k1: 1.2, b: 0.75 });
    expect(bm25Idf(100, 100)).toBeGreaterThan(0);
    expect(bm25Idf(100, 1)).toBeGreaterThan(bm25Idf(100, 10));
    expect(bm25TermScore(2, 10, 1, 10, 10)).toBeLessThan(2 * bm25TermScore(1, 10, 1, 10, 10));
    expect(bm25TermScore(1, 5, 1, 10, 10)).toBeGreaterThan(bm25TermScore(1, 20, 1, 10, 10));
  });
});

describe('lexicalRanking', () => {
  const summaries = [
    ['key', '리안은 지하 7번 서고의 흑요석 열쇠를 하준에게 맡겼다.'],
    ['afternoon', '리안과 하준은 도서관에서 오후를 보냈다.'],
    ['tea', '리안은 하준에게 차를 끓여 주었다.'],
    ['birthday', '하준은 리안의 생일이 12월 3일이라는 것을 알았다.'],
    ['ring', '하준은 2012년에 은반지를 샀다. 꽃을 든 리안이 웃었다.'],
  ] as const;

  it('finds what a turn names, and nothing for small talk', () => {
    expect(lexicalRanking(summaries, '그 흑요석 열쇠 아직 갖고 있어?')).toEqual(['key']);
    expect(lexicalRanking(summaries, '12월 3일에 뭐 하고 싶어?')).toEqual(['birthday']);
    expect(lexicalRanking(summaries, '응 좋아, 그렇게 하자')).toEqual([]);
    expect(lexicalRanking(summaries, '배고프다 뭐 먹을까?')).toEqual([]);
    // A name every summary holds is no evidence.
    expect(lexicalRanking(summaries, '리안')).toEqual([]);
    expect(lexicalRanking([], '흑요석')).toEqual([]);
  });

  it('matches a number or a one-syllable word only whole', () => {
    // 12 is not in 2012, nor 꽃 in 꽃을.
    expect(lexicalRanking(summaries, '12')).toEqual(['birthday']);
    expect(lexicalRanking(summaries, '꽃')).toEqual([]);
    expect(lexicalRanking([...summaries, ['flower', '꽃 한 송이']], '꽃')).toEqual(['flower']);
  });

  it('scores as BM25 over the terms the tokenizer cuts', () => {
    // A reference over `lexicalTerms`: every query term the evidence limit allows, length in characters.
    const texts = [
      ['a', '하하하 웃는 리안. 리안은 리안의 고양이를 안았다'],
      ['b', '고양이 보리와 리안, 그리고 Project ARIA'],
      ['c', '<b>보리</b>가 {{user}}의 무릎에서 잠들었다 ARIAS'],
      ['d', '오래된 등대'],
      ['e', '등대지기 한석'],
      ['f', '바다와 등대'],
    ] as const;
    const query = '보리 고양이 aria 하하 등대';
    const limit = rareLimit(texts.length);
    const terms = [...new Set(lexicalTerms(query))];
    const counts = texts.map(([, text]) => lexicalTerms(text));
    const held = terms
      .map((term) => ({ term, holders: counts.flatMap((list, at) => (list.includes(term) ? [at] : [])) }))
      .filter(({ holders }) => holders.length > 0 && holders.length <= limit);
    const stems = lexicalStems(query);
    const lengths = texts.map(([, text]) => text.replace(/<[^>]*>|\{\{[^}]*\}\}/g, ' ').length);
    const average = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
    const candidates = [...new Set(held.filter(({ term }) => stems.has(term)).flatMap(({ holders }) => holders))];
    const expected = candidates
      .map((at) => ({
        at,
        score: held.reduce(
          (sum, { term, holders }) =>
            holders.includes(at)
              ? sum + bm25TermScore(counts[at]!.filter((t) => t === term).length, lengths[at]!, holders.length, texts.length, average)
              : sum,
          0,
        ),
      }))
      .sort((x, y) => y.score - x.score || x.at - y.at)
      .map(({ at }) => texts[at]![0]);
    expect(lexicalRanking(texts, query)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });
});

describe('fusion', () => {
  it('raises what both rankings hold over what one ranks alone', () => {
    expect(reciprocalRankFusion([['a', 'b', 'c'], ['c', 'd']])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('breaks a tie for the earlier ranking, then by rank', () => {
    // a and x are both first of one list: the first list's wins.
    expect(reciprocalRankFusion([['a', 'b'], ['x', 'y']])).toEqual(['a', 'x', 'b', 'y']);
    expect(reciprocalRankFusion([[], ['x']])).toEqual(['x']);
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it('leaves the dense ranking as it is when words found nothing', () => {
    expect(hybridRanking(['a', 'b'], [])).toEqual(['a', 'b']);
    expect(hybridRanking(['a', 'b', 'c'], ['c'])).toEqual(['c', 'a', 'b']);
  });
});
