import { describe, expect, it } from 'vitest';
import {
  EXTRACTION_TRANSCRIPT_HEADING,
  FACT_EXTRACTION_PROMPT,
  FACTS_HEADING,
  FACTS_TOKEN_CAP,
  factCoveredByText,
  factExtractionRequest,
  factLanguageLine,
  factsBlock,
  fitFacts,
  KNOWN_FACTS_HEADING,
  MAX_FACT_LENGTH,
  MAX_FACTS_PER_SUMMARY,
  MAX_KNOWN_FACTS,
  parseFactExtraction,
  sameFact,
} from '../src/facts.js';
import { countTokens } from '../src/tokens.js';

/** The new facts an answer lists. */
const parseFacts = (raw: string): string[] => parseFactExtraction(raw).added;

describe('facts', () => {
  it('asks for the facts of the messages, as JSON, in the conversation’s language', () => {
    const request = factExtractionRequest('유저: 안녕\n리안: 반가워', 'ko');
    expect(request.system).toBe(FACT_EXTRACTION_PROMPT.replace('{{language}}', factLanguageLine('ko')));
    expect(request.system).toContain('{"facts": string[], "updates": {"id": number, "fact": string}[], "invalidated": number[]}');
    expect(request.system).toContain('사실은 한국어로 씁니다.');
    // Nothing kept yet: the transcript alone.
    expect(request.messages).toEqual([{ role: 'user', content: '유저: 안녕\n리안: 반가워' }]);
    expect(factExtractionRequest('A: hi', 'en').system).toContain('사실은 영어로 씁니다.');
    expect(factExtractionRequest('A: hi', 'ja').system).toContain('사실은 일본어로 씁니다.');
    expect(factExtractionRequest('…', undefined).system).toContain('- 사실은 대화에 쓰인 언어로 씁니다.');
  });

  it('shows the facts already kept, numbered, before the transcript — at most ten', () => {
    const known = Array.from({ length: 12 }, (_, index) => `사실 ${index + 1}.`);
    const [turn] = factExtractionRequest('유저: 안녕', 'ko', known).messages;
    expect(turn!.content).toBe(
      `${KNOWN_FACTS_HEADING}\n${known
        .slice(0, MAX_KNOWN_FACTS)
        .map((fact, index) => `${index + 1}. ${fact}`)
        .join('\n')}\n\n${EXTRACTION_TRANSCRIPT_HEADING}\n유저: 안녕`,
    );
    expect(turn!.content).not.toContain('사실 11.');
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
    expect(parseFactExtraction('null')).toEqual({ added: [], updated: [], invalidated: [], rejected: 0 });
  });

  it('reads updates and invalidations of the facts it was shown, and no others', () => {
    const known = ['리안은 살아 있다.', '하준은 흑요석 열쇠를 갖고 있다.', '리안은 수영을 못 한다.'];
    const answer = JSON.stringify({
      facts: ['리안은 등대지기가 되었다.', '리안은 살아 있다.', '리안은 바다에서 죽었다.'],
      updates: [
        { id: 1, fact: '리안은 바다에서 죽었다.' },
        { id: 1, fact: '리안은 사라졌다.' },
        { id: '3', fact: '리안은 수영을 배워 이제 수영할 수 있다.' },
        { id: 2, fact: ' 하준은 흑요석 열쇠를 갖고 있다 ' },
        { id: 4, fact: '없는 번호.' },
        { id: 0, fact: '없는 번호.' },
        { id: 1.5, fact: '번호가 아니다.' },
        { fact: '번호가 없다.' },
        null,
      ],
      invalidated: [2, 3, 7, -1, 'x'],
    });
    expect(parseFactExtraction(answer, known)).toEqual({
      // A shown fact said again, or an update's new words, is no new fact.
      added: ['리안은 등대지기가 되었다.'],
      // One change per fact, the first; an update to the same words is none, but still its one change.
      updated: [
        { id: 1, content: '리안은 바다에서 죽었다.' },
        { id: 3, content: '리안은 수영을 배워 이제 수영할 수 있다.' },
      ],
      invalidated: [],
      // 4, 0, 1.5, no id, null; then 7, -1 and 'x'.
      rejected: 8,
    });
    // Ended with nothing in its place.
    expect(parseFactExtraction('{"facts": [], "invalidated": [2]}', known)).toEqual({
      added: [],
      updated: [],
      invalidated: [2],
      rejected: 0,
    });
    // Shown nothing, it can change nothing.
    expect(parseFactExtraction('{"facts": [], "updates": [{"id": 1, "fact": "가."}], "invalidated": [1]}').rejected).toBe(2);
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
