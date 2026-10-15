/**
 * The chat's facts (ARCHITECTURE §7.3 사실): a few durable ones — names,
 * promises, preferences, relationships, important objects — that a separate
 * call of the auxiliary model takes from the messages a HypaV3 summary covers,
 * and that each request carries the most relevant of in a small `[기억]` block
 * after the summaries. The same call is shown the facts already kept that are
 * closest to those messages and says which of them the messages changed
 * (updates) or ended (invalidated) — mem0's update step, folded into the
 * extraction rather than a call of its own. In a work of several members the
 * same call marks which new facts everyone knows; the rest are known to the
 * members on the stage of their stretch alone (`factVisibleTo`). The pure half:
 * the call, reading its answer, the block and who may be told. Storage,
 * embedding and selection are the API's (`facts.ts`).
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
/** Facts already kept that one extraction is shown, to update or end. */
export const MAX_KNOWN_FACTS = 10;

/** The answer's shape, and a group work's: each new sentence says whether everyone knows it. */
const FACT_SCHEMA = '{"facts": string[], "updates": {"id": number, "fact": string}[], "invalidated": number[]}';
const SCENE_FACT_SCHEMA =
  '{"facts": {"fact": string, "public": boolean}[], "updates": {"id": number, "fact": string, "public": boolean}[], "invalidated": number[]}';
/** What marks a shown fact only some members knew: `[아는 인물: …]` after it. */
const KNOWN_TO_LABEL = '[아는 인물: …]';

/**
 * What a group work's extraction is told besides (`factExtractionRequest` with a
 * scene): who was on the stage, that the others do not know what went on there,
 * and to mark what they would know anyway — the world, an announcement, what
 * everyone came to see or hear — as public. In doubt, not public. A fact it is
 * shown that only others knew (`KnownFact` with `knownTo`) is said again when
 * this stage learns it, so its members get a copy of their own.
 */
const sceneRules = (names: readonly string[]): string => `여러 인물이 나오는 작품:
- 이 구간의 장면에 있던 등장인물은 ${names.join(', ')}입니다. 장면에 없던 인물은 여기서 오간 말과 일을 모릅니다.
- 사실마다 public을 정합니다. 장면에 없던 인물도 알 만한 사실 — 세계와 장소의 설정, 모두에게 알린 소식, 누구나 보고 듣게 된 일 — 이면 true, 그 장면에 있던 인물만 아는 사실(그 자리에서 나눈 이야기, 비밀, 둘만의 약속)이면 false입니다. 애매하면 false로 둡니다.
- [기록된 사실]에서 끝에 ${KNOWN_TO_LABEL}이 붙은 사실은 그 인물들만 알던 사실입니다. 이 장면의 인물이 그것을 알게 되었다면 그 문장을 괄호 부분 없이 facts에 다시 씁니다.`;

/**
 * A fact shown to the extraction: its words — and, in a group work, when the
 * members on this stage did not all know it, the names of those who did.
 */
export type KnownFact = string | { fact: string; knownTo: readonly string[] };

const knownText = (fact: KnownFact): string => (typeof fact === 'string' ? fact : fact.fact);

/**
 * The extraction instruction: the rules of the facts the rolling-summary memory
 * once extracted alongside its summary (one sentence each, names rather than
 * pronouns, nothing scene-bound), now a call of its own over the messages one
 * summary covers — and the facts kept from earlier in the story that are
 * closest to them, numbered, which the answer may update or end by number.
 * Only a change the messages show plainly counts: a fact not mentioned, or
 * mentioned vaguely, stays as it is. `{{language}}` is the language rule
 * (`factLanguageLine`). `scene` is a group work's (`sceneRules`).
 */
const extractionPrompt = (scene: string, schema: string): string => `당신은 롤플레이 대화의 기록 담당자입니다. 아래 대화 구간에서, 이야기가 이어지는 동안 계속 참인 사실을 뽑습니다. 이미 기록된 사실 가운데 이 구간 때문에 더 이상 참이 아니게 된 것이 있으면 함께 고칩니다.

규칙:
- 이름과 호칭, 약속과 목표, 취향과 습관, 인물 사이의 관계, 중요한 물건과 그 행방처럼 오래 유지되는 사실만 고릅니다. 장면에 한정된 일시적 상태(지금의 자세·표정·날씨 같은 것)는 넣지 않습니다.
- 각 항목은 한 문장이며, 앞뒤 맥락 없이 그 자체로 이해되어야 합니다(대명사 대신 이름을 씁니다).
- {{language}}
- 대화에 실제로 나온 것만 적습니다. 추측하지 않습니다.
- facts는 0~${MAX_FACTS_PER_SUMMARY}개. 오래 유지될 새 사실이 없으면 빈 배열을 냅니다.

이미 기록된 사실:
- [기록된 사실]에 번호와 함께 주어진 것은 이 구간보다 앞선 이야기에서 뽑은 사실입니다. 같은 내용을 facts에 다시 쓰지 않습니다.
- 이 구간에서 기록된 사실이 분명히 바뀌었다면 updates에 그 번호와 지금 참인 새 문장을 넣습니다(예: 살아 있던 인물이 죽었다, 맡긴 물건을 돌려받았다).
- 대신할 새 사실 없이 더는 참이 아니게 되었다면 invalidated에 그 번호를 넣습니다(예: 지켜진 약속, 풀린 오해).
- 구간에 언급되지 않았거나 바뀌었는지 애매한 사실은 그대로 둡니다. 주어지지 않은 번호는 쓰지 않습니다.${scene ? `\n\n${scene}` : ''}

출력 형식: 아래 스키마를 따르는 JSON 객체 하나만 출력합니다. 코드 블록이나 다른 텍스트를 덧붙이지 않습니다.
${schema}`;

export const FACT_EXTRACTION_PROMPT = extractionPrompt('', FACT_SCHEMA);

/** Heads of the extraction's user turn when it carries facts already kept. */
export const KNOWN_FACTS_HEADING = '[기록된 사실]';
export const EXTRACTION_TRANSCRIPT_HEADING = '[대화]';

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
 * the system text, and one user turn — the covered messages' transcript, after
 * the facts already kept (`known`, closest first, at most `MAX_KNOWN_FACTS`)
 * numbered from 1 under their own heading when there are any. `scene` is the
 * names of the members on a group work's stage (`sceneMembers`): given, the
 * model is told who was there and marks each new sentence public or not, and a
 * shown fact only others knew carries their names (`[아는 인물: …]`).
 */
export function factExtractionRequest(
  transcript: string,
  language: MacroLocale | undefined,
  known: readonly KnownFact[] = [],
  scene?: readonly string[],
): {
  system: string;
  messages: { role: 'user'; content: string }[];
} {
  const listed = known.slice(0, MAX_KNOWN_FACTS);
  const numbered = listed
    .map((fact, index) =>
      typeof fact === 'string' || !scene?.length
        ? `${index + 1}. ${knownText(fact)}`
        : `${index + 1}. ${fact.fact} [아는 인물: ${fact.knownTo.join(', ')}]`,
    )
    .join('\n');
  const prompt = scene && scene.length > 0 ? extractionPrompt(sceneRules(scene), SCENE_FACT_SCHEMA) : FACT_EXTRACTION_PROMPT;
  return {
    system: prompt.replace('{{language}}', factLanguageLine(language)),
    messages: [
      {
        role: 'user',
        content:
          listed.length === 0
            ? transcript
            : `${KNOWN_FACTS_HEADING}\n${numbered}\n\n${EXTRACTION_TRANSCRIPT_HEADING}\n${transcript}`,
      },
    ],
  };
}

/** What one extraction's answer says: new facts, and what became of the facts it was shown. */
export interface FactExtraction {
  /** New facts, each once, none a fact it was shown but one only others knew, at most `MAX_FACTS_PER_SUMMARY`. */
  added: string[];
  /** A fact shown (by its 1-based number) that now reads as `content` instead. */
  updated: { id: number; content: string }[];
  /** Facts shown (by number) that no longer hold, with nothing in their place. */
  invalidated: number[];
  /** Updates and invalidations left out: a number it was not shown, or no usable one, or no usable text. */
  rejected: number;
  /** The new sentences — added, or an update's — marked `"public": true`: a group work's that everyone knows. */
  knownToAll: string[];
}

/** A fact as kept: one line, trimmed; null for the empty, the over-long and anything not text. */
function cleanFact(fact: unknown): string | null {
  if (typeof fact !== 'string') return null;
  const text = fact.replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_FACT_LENGTH || text.includes('\u0000')) return null;
  return text;
}

/**
 * An extraction's answer (`FACT_EXTRACTION_PROMPT`): the first JSON object in
 * it (a code fence or a preamble around it is tolerated). `known` is the facts
 * it was shown, in their order. New facts are trimmed, the empty and the
 * over-long left out, each kept once and none that it was shown. An update or
 * an invalidation counts only for a number it was shown — the guard against a
 * model ending a fact nobody asked it about — and once per fact, the first
 * winning; an update to the same words is no change. An answer that is not
 * that object says nothing.
 *
 * A group work's answer gives each new sentence as `{"fact", "public"}`; a bare
 * string is read as one that is not public, so either shape reads anywhere. A
 * shown fact only others knew (`knownTo`) may be said again as new — this
 * stage learned it — unless the same answer changed it.
 */
export function parseFactExtraction(raw: string, known: readonly KnownFact[] = []): FactExtraction {
  const none: FactExtraction = { added: [], updated: [], invalidated: [], rejected: 0, knownToAll: [] };
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return none;
  }
  if (parsed === null || typeof parsed !== 'object') return none;
  const answer = parsed as { facts?: unknown; updates?: unknown; invalidated?: unknown };
  const shown = Math.min(known.length, MAX_KNOWN_FACTS);
  let rejected = 0;
  /** The number the answer gave, if it is one of the facts it was shown; otherwise one more rejected. */
  const numberOf = (value: unknown): number | null => {
    const id = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
    if (typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= shown) return id;
    rejected += 1;
    return null;
  };

  const touched = new Set<number>();
  const updated: FactExtraction['updated'] = [];
  const knownToAll: string[] = [];
  for (const update of Array.isArray(answer.updates) ? answer.updates : []) {
    const id = numberOf((update as { id?: unknown } | null)?.id);
    if (id === null || touched.has(id)) continue;
    const content = cleanFact((update as { fact?: unknown } | null)?.fact);
    if (content === null) {
      rejected += 1;
      continue;
    }
    touched.add(id);
    if (sameFact(content, knownText(known[id - 1]!))) continue;
    updated.push({ id, content });
    if ((update as { public?: unknown }).public === true) knownToAll.push(content);
  }
  const invalidated: number[] = [];
  for (const value of Array.isArray(answer.invalidated) ? answer.invalidated : []) {
    const id = numberOf(value);
    if (id === null || touched.has(id)) continue;
    touched.add(id);
    invalidated.push(id);
  }

  const added: string[] = [];
  for (const fact of Array.isArray(answer.facts) ? answer.facts : []) {
    const entry: { fact?: unknown; public?: unknown } = fact !== null && typeof fact === 'object' ? fact : { fact };
    const text = cleanFact(entry.fact);
    if (text === null) continue;
    const says = (other: string): boolean => sameFact(other, text);
    // A shown fact said again is no new fact — but one only others knew is this stage's to learn.
    const repeats = known.some((fact, at) => says(knownText(fact)) && (typeof fact === 'string' || touched.has(at + 1)));
    if (added.some(says) || repeats || updated.some((update) => says(update.content))) continue;
    added.push(text);
    if (entry.public === true) knownToAll.push(text);
    if (added.length === MAX_FACTS_PER_SUMMARY) break;
  }
  return { added, updated, invalidated, rejected, knownToAll };
}

/**
 * Who a fact is known to (ARCHITECTURE §7.3 장면의 멤버): the members on the stage
 * of the stretch it was taken from (`sceneMembers`), unless it is one everyone
 * knows. Null members: a fact from before scenes were kept, of a work of one, or
 * of a stretch nobody spoke in — known to everyone.
 */
export interface FactScene {
  sceneMemberIds: readonly string[] | null;
  knownToAll: boolean;
}

/** Whether a member's turn may be told a fact: one everyone knows, or one of a scene the member was in. */
export const factVisibleTo = (fact: FactScene, memberId: string): boolean =>
  fact.sceneMemberIds === null || fact.knownToAll || fact.sceneMemberIds.includes(memberId);

/**
 * Whether `kept` is known to everyone `fresh` would be: only then does a fresh
 * fact that says what `kept` says add nothing. A member who learns in its own
 * scene what another learned in private keeps its own copy.
 */
export const factCoversScene = (kept: FactScene, fresh: FactScene): boolean =>
  kept.sceneMemberIds === null ||
  kept.knownToAll ||
  (fresh.sceneMemberIds !== null && !fresh.knownToAll && fresh.sceneMemberIds.every((id) => kept.sceneMemberIds!.includes(id)));

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
 * each costs its line, and the first that does not fit ends the block. The
 * lines are as the block shows them, a time label (`labelled`) included.
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
