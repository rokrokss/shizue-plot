/**
 * The chat's facts (ARCHITECTURE §7.3 사실): a few durable ones — names,
 * promises, preferences, relationships, important objects — that a separate
 * call of the auxiliary model takes from the messages a HypaV3 summary covers,
 * and that each request carries the most relevant of in a small `[기억]` block
 * after the summaries. The pure half: the call, reading its answer, and the
 * block. Storage, embedding and selection are the API's (`memory.ts`).
 */
import type { MacroLocale } from './macro.js';
import { countTokens } from './tokens.js';

/** The facts block's head in the prompt; it stands after the summaries' block. */
export const FACTS_HEADING = '[기억]';
/** Facts one summary's extraction keeps at most. */
export const MAX_FACTS_PER_SUMMARY = 8;
/** Longest fact kept, from the model or the reader. */
export const MAX_FACT_LENGTH = 300;
/** Facts a request carries by default (`memorySettings.factCount`). */
export const DEFAULT_FACT_COUNT = 5;
/** Most facts a chat may ask a request to carry. */
export const MAX_FACT_COUNT = 10;
/** Tokens the facts block may take, heading included — its own cap, beside the summaries' share. */
export const FACTS_TOKEN_CAP = 400;

/**
 * The extraction instruction: the rules of the facts the rolling-summary memory
 * once extracted alongside its summary (one sentence each, names rather than
 * pronouns, nothing scene-bound), now a call of its own over the messages one
 * summary covers. `{{language}}` is the language rule (`factLanguageLine`).
 */
export const FACT_EXTRACTION_PROMPT = `당신은 롤플레이 대화의 기록 담당자입니다. 아래 대화 구간에서, 이야기가 이어지는 동안 계속 참인 사실을 뽑습니다.

규칙:
- 이름과 호칭, 약속과 목표, 취향과 습관, 인물 사이의 관계, 중요한 물건과 그 행방처럼 오래 유지되는 사실만 고릅니다. 장면에 한정된 일시적 상태(지금의 자세·표정·날씨 같은 것)는 넣지 않습니다.
- 각 항목은 한 문장이며, 앞뒤 맥락 없이 그 자체로 이해되어야 합니다(대명사 대신 이름을 씁니다).
- {{language}}
- 대화에 실제로 나온 것만 적습니다. 추측하지 않습니다.
- 0~${MAX_FACTS_PER_SUMMARY}개. 오래 유지될 사실이 없으면 빈 배열을 냅니다.

출력 형식: 아래 스키마를 따르는 JSON 객체 하나만 출력합니다. 코드 블록이나 다른 텍스트를 덧붙이지 않습니다.
{"facts": string[]}`;

const LANGUAGE_NAMES: Record<MacroLocale, string> = { ko: '한국어', en: '영어', ja: '일본어' };

/**
 * The language the facts are written in: the conversation's — the language its
 * latest turns are written in, which the caller tells — not the plot's, so a
 * Korean reader of an English card keeps Korean facts. Unknown, the rule says
 * only "the conversation's language".
 */
export function factLanguageLine(language: MacroLocale | undefined): string {
  if (!language) return '사실은 대화에 쓰인 언어로 씁니다.';
  const name = LANGUAGE_NAMES[language];
  return `대화가 ${name}로 이어지고 있으므로 사실은 ${name}로 씁니다.`;
}

/**
 * The extraction call: the instruction, with the conversation's language, as
 * the system text, the covered messages' transcript as the one user turn.
 */
export function factExtractionRequest(
  transcript: string,
  language: MacroLocale | undefined,
): {
  system: string;
  messages: { role: 'user'; content: string }[];
} {
  return {
    system: FACT_EXTRACTION_PROMPT.replace('{{language}}', factLanguageLine(language)),
    messages: [{ role: 'user', content: transcript }],
  };
}

/**
 * The facts an answer lists: the `facts` array of the first JSON object in it
 * (a code fence or a preamble around it is tolerated), each trimmed, the empty
 * and the over-long left out, the same one said twice kept once, at most
 * `MAX_FACTS_PER_SUMMARY`. An answer that is not that object lists none.
 */
export function parseFacts(raw: string): string[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const facts = (parsed as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(facts)) return [];
  const kept: string[] = [];
  for (const fact of facts) {
    if (typeof fact !== 'string') continue;
    const text = fact.replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_FACT_LENGTH || text.includes('\u0000')) continue;
    if (kept.some((other) => sameFact(other, text))) continue;
    kept.push(text);
    if (kept.length === MAX_FACTS_PER_SUMMARY) break;
  }
  return kept;
}

/** A text as the duplicate checks compare it: lowercased, without spaces, punctuation or symbols. */
export const normalizeFact = (text: string): string => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/** Whether two facts say the same thing in the same words (spacing, punctuation and case aside). */
export const sameFact = (a: string, b: string): boolean => {
  const key = normalizeFact(a);
  return key.length > 0 && key === normalizeFact(b);
};

/**
 * Whether one of `texts` — the summaries a request carries — already states the
 * fact word for word (spacing, punctuation and case aside). The vector check
 * for a fact a summary says in other words is the API's.
 */
export function factCoveredByText(fact: string, texts: readonly string[]): boolean {
  const key = normalizeFact(fact);
  return key.length > 0 && texts.some((text) => normalizeFact(text).includes(key));
}

/**
 * The facts that fit the block's cap, in the order given (most relevant first):
 * each costs its line, and the first that does not fit ends the block.
 */
export function fitFacts(facts: readonly string[], cap: number = FACTS_TOKEN_CAP): string[] {
  let left = cap - countTokens(`${FACTS_HEADING}\n`);
  const kept: string[] = [];
  for (const fact of facts) {
    const cost = countTokens(`- ${fact}\n`);
    if (cost > left) break;
    left -= cost;
    kept.push(fact);
  }
  return kept;
}

/** The facts block the prompt carries; '' for none. */
export function factsBlock(facts: readonly string[]): string {
  return facts.length > 0 ? `${FACTS_HEADING}\n${facts.map((fact) => `- ${fact}`).join('\n')}` : '';
}
