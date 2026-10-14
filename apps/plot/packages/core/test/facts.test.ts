import { describe, expect, it } from 'vitest';
import {
  FACT_EXTRACTION_PROMPT,
  FACTS_HEADING,
  FACTS_TOKEN_CAP,
  factCoveredByText,
  factExtractionRequest,
  factLanguageLine,
  factsBlock,
  fitFacts,
  MAX_FACT_LENGTH,
  MAX_FACTS_PER_SUMMARY,
  parseFacts,
  sameFact,
} from '../src/facts.js';
import { countTokens } from '../src/tokens.js';

describe('facts', () => {
  it('asks for the facts of the messages, as JSON, in the conversation’s language', () => {
    const request = factExtractionRequest('유저: 안녕\n리안: 반가워', 'ko');
    expect(request.system).toBe(FACT_EXTRACTION_PROMPT.replace('{{language}}', factLanguageLine('ko')));
    expect(request.system).toContain('{"facts": string[]}');
    expect(request.system).toContain('사실은 한국어로 씁니다.');
    expect(request.messages).toEqual([{ role: 'user', content: '유저: 안녕\n리안: 반가워' }]);
    expect(factExtractionRequest('A: hi', 'en').system).toContain('사실은 영어로 씁니다.');
    expect(factExtractionRequest('A: hi', 'ja').system).toContain('사실은 일본어로 씁니다.');
    expect(factExtractionRequest('…', undefined).system).toContain('- 사실은 대화에 쓰인 언어로 씁니다.');
  });

  it('reads the facts out of the answer, at most eight, each once', () => {
    expect(parseFacts('{"facts": ["리안은 고양이를 무서워한다.", " 유저는 도서관 열쇠를 맡았다. "]}')).toEqual([
      '리안은 고양이를 무서워한다.',
      '유저는 도서관 열쇠를 맡았다.',
    ]);
    // A fence and a preamble around it; anything but text left out; the same fact once.
    expect(parseFacts('네.\n```json\n{"facts": ["가.", 3, null, "", "가 .", "나\\n  다."]}\n```')).toEqual(['가.', '나 다.']);
    const many = Array.from({ length: 12 }, (_, index) => `사실 ${index}.`);
    expect(parseFacts(JSON.stringify({ facts: many }))).toEqual(many.slice(0, MAX_FACTS_PER_SUMMARY));
    expect(parseFacts(JSON.stringify({ facts: ['ㄱ'.repeat(MAX_FACT_LENGTH + 1), '짧다.'] }))).toEqual(['짧다.']);
    // Not the object asked for: nothing.
    expect(parseFacts('리안은 고양이를 무서워한다.')).toEqual([]);
    expect(parseFacts('{"summary": "요약"}')).toEqual([]);
    expect(parseFacts('{"facts": "하나"}')).toEqual([]);
    expect(parseFacts('{facts: [}')).toEqual([]);
  });

  it('tells a fact a summary already states, and two facts that say one thing', () => {
    expect(factCoveredByText('리안은 열쇠를 맡았다', ['그날 밤, 리안은 열쇠를 맡았다. 비가 왔다.'])).toBe(true);
    expect(factCoveredByText('리안은  열쇠를 맡았다!', ['리안은 열쇠를 맡았다.'])).toBe(true);
    expect(factCoveredByText('리안은 열쇠를 잃었다.', ['리안은 열쇠를 맡았다.'])).toBe(false);
    expect(factCoveredByText('...', ['...'])).toBe(false);
    expect(sameFact('Lian fears cats.', 'lian fears cats')).toBe(true);
    expect(sameFact('Lian fears cats.', 'Lian fears dogs.')).toBe(false);
  });

  it('keeps the block within its cap, the most relevant first', () => {
    const long = '리안은 오래된 도서관의 열람실 열쇠를 맡아 매일 밤 문을 잠근다. '.repeat(8).trim();
    const kept = fitFacts([long, long + '1', long + '2', '짧은 사실.']);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).not.toContain('짧은 사실.');
    expect(countTokens(factsBlock(kept))).toBeLessThanOrEqual(FACTS_TOKEN_CAP);
    expect(fitFacts(['짧은 사실.'], 1)).toEqual([]);
    expect(factsBlock(['가.', '나.'])).toBe(`${FACTS_HEADING}\n- 가.\n- 나.`);
    expect(factsBlock([])).toBe('');
  });
});
