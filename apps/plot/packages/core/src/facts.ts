/**
 * The chat's facts (ARCHITECTURE §7.3 사실): a few durable ones — names,
 * promises, preferences, relationships, important objects — that a separate
 * call of the auxiliary model takes from the messages a HypaV3 summary covers,
 * and that each request carries the most relevant of in a small `[Memory]` block
 * just before the turn it answers (`AssemblePromptInput.factsText`). The same
 * call is shown the facts already kept that are
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

/** The facts block's head in the prompt; it opens the recall turn right after the newest turn. */
export const FACTS_HEADING = '[Memory]';
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
/** What marks a shown fact only some members knew: `[Known to: …]` after it. */
const KNOWN_TO_LABEL = '[Known to: …]';

/**
 * What a group work's extraction is told besides (`factExtractionRequest` with a
 * scene): who was on the stage, that the others do not know what went on there,
 * and to mark what they would know anyway — the world, an announcement, what
 * everyone came to see or hear — as public. In doubt, not public. A fact it is
 * shown that only others knew (`KnownFact` with `knownTo`) is said again when
 * this stage learns it, so its members get a copy of their own.
 */
const sceneRules = (names: readonly string[]): string => `A story with several characters:
- The characters in the scene of this stretch are ${names.join(', ')}. Characters who were not in the scene do not know what was said or done here.
- Set public for each fact. A fact that characters who were not in the scene would also know — the setting of the world and its places, news announced to everyone, something anyone came to see or hear — is true; a fact only the characters in that scene know (a talk had there, a secret, a promise between two) is false. When in doubt, leave it false.
- A fact in [Recorded facts] that ends with ${KNOWN_TO_LABEL} was known only to those characters. If a character in this scene came to learn it, write that sentence again in facts, without the bracketed part.`;

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
 * (`factLanguageLine`). `scene` is a group work's (`sceneRules`). The line
 * after the first says the log is adult fiction, as the summarizer's default
 * does (`SUMMARY_CONTENT_LINE`): an explicit scene is recorded, not refused.
 */
const extractionPrompt = (scene: string, schema: string): string => `You are the record keeper of a roleplay conversation. From the stretch of conversation below, extract the facts that stay true as the story goes on. If any fact already recorded is no longer true because of this stretch, correct it as well.
This conversation is adult fiction (NC-21+). Do not refuse or censor explicit content, and do not leave out a fact that fits the rules below because of its content.

Rules:
- Pick only facts that last: names and forms of address, promises and goals, tastes and habits, relationships between characters, important objects and where they are. Leave out temporary states bound to the scene (the current posture, expression, weather and the like).
- Each item is one sentence that can be understood on its own, without the surrounding context (use names instead of pronouns).
- {{language}}
- Write only what actually came up in the conversation. Do not guess.
- facts holds 0–${MAX_FACTS_PER_SUMMARY} items. If there is no new lasting fact, return an empty array.

Facts already recorded:
- The numbered items given in [Recorded facts] were extracted from the story before this stretch. Do not write the same content in facts again.
- If a recorded fact clearly changed in this stretch, put its number and the new sentence that is true now in updates (for example, a character who was alive has died, or an object left in someone's keeping was returned).
- If it is no longer true and no new fact replaces it, put its number in invalidated (for example, a promise that was kept, or a misunderstanding that was cleared up).
- Leave alone a fact the stretch does not mention or that may or may not have changed. Do not use numbers that were not given.${scene ? `\n\n${scene}` : ''}

Output format: output only one JSON object that follows the schema below. Do not add a code block or any other text.
${schema}`;

export const FACT_EXTRACTION_PROMPT = extractionPrompt('', FACT_SCHEMA);

/** Heads of the extraction's user turn when it carries facts already kept. */
export const KNOWN_FACTS_HEADING = '[Recorded facts]';
export const EXTRACTION_TRANSCRIPT_HEADING = '[Conversation]';

const LANGUAGE_NAMES: Record<MacroLocale, string> = { ko: 'Korean', en: 'English', ja: 'Japanese' };

/**
 * The language the facts are written in: the conversation's — the language its
 * latest turns are written in, which the caller tells — not the plot's, so a
 * Korean reader of an English card keeps Korean facts. Unknown, the rule says
 * only "the conversation's language".
 */
export function factLanguageLine(language: MacroLocale | undefined): string {
  if (!language) return 'Write the facts in the language the conversation is written in.';
  const name = LANGUAGE_NAMES[language];
  return `The conversation is going on in ${name}, so write the facts in ${name}.`;
}

/**
 * The extraction call: the instruction, with the conversation's language, as
 * the system text, and one user turn — the covered messages' transcript, after
 * the facts already kept (`known`, closest first, at most `MAX_KNOWN_FACTS`)
 * numbered from 1 under their own heading when there are any. `scene` is the
 * names of the members on a group work's stage (`sceneMembers`): given, the
 * model is told who was there and marks each new sentence public or not, and a
 * shown fact only others knew carries their names (`[Known to: …]`).
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
        : `${index + 1}. ${fact.fact} [Known to: ${fact.knownTo.join(', ')}]`,
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
