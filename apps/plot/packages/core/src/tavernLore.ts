/**
 * SillyTavern's `WORLD_INFO` regex placement over an assembled prompt.
 *
 * ST runs its prompt-only regex scripts placed on World Info over each entry
 * it inserts, after the entry's macros are substituted and its budget is spent
 * (`getRegexedString(entry.content, WORLD_INFO, { depth, isPrompt })` in
 * `world-info.js`), and leaves out an entry the scripts empty. Here the
 * assembler is synchronous and the creator's regex runs only in the API's
 * bounded threads, so the two meet across a mark: the assembler, asked to
 * (`AssemblePromptInput.markTavernLore`), wraps each ST entry's text where it
 * inserts it (`markTavernSegment`) and says where each one is
 * (`AssembledPrompt.tavernLore`); the caller runs the scripts over the marked
 * texts and puts what they leave in their place (`withTavernLore`).
 *
 * A mark is three Unicode noncharacters, which no text interchanges: an entry
 * that holds one has it taken out first, and none is ever left in what is sent.
 * Where a prompt template wraps an entry in a format of its own (an item's
 * `innerFormat`), two more frame the wrapped text (`frameTavernSegment`), so
 * that an entry the scripts empty takes its wrapper with it.
 * One entry's text can hold another's — an outlet an entry writes — so the
 * innermost go first, round by round.
 */
import type { AssembledPrompt, PromptMessage } from './prompt.js';

/** Where ST's `WORLD_INFO` regex is asked a marked text: an entry at a depth, with it. */
export interface TavernLoreSegment {
  /** The entry's depth, for a depth entry — ST's `regexDepth`; absent otherwise, and then no depth bound applies. */
  depth?: number;
}

const OPEN = '\uFDD0';
const SPLIT = '\uFDD1';
const CLOSE = '\uFDD2';
const FRAME_OPEN = '\uFDD3';
const FRAME_CLOSE = '\uFDD4';
const MARKS = /[\uFDD0-\uFDD4]/g;
/** A segment whose text holds no other: the innermost. */
const INNERMOST = /\uFDD0(\d+)\uFDD1([^\uFDD0\uFDD2]*)\uFDD2/g;
/** A segment rewritten to nothing — the assembler marks no empty text — and the separators beside it. */
const EMPTIED = /(\n\n|\n)?\uFDD0\d+\uFDD1\uFDD2(\n\n|\n)?/g;
/** A frame around nothing but one emptied segment and its wrapper, and the separators beside it. */
const EMPTIED_FRAME = /(\n\n|\n)?\uFDD3[^\uFDD0-\uFDD4]*\uFDD0\d+\uFDD1\uFDD2[^\uFDD0-\uFDD4]*\uFDD4(\n\n|\n)?/g;

/** `text` marked as segment `index`, with any mark it held of its own taken out. */
export function markTavernSegment(text: string, index: number): string {
  return `${OPEN}${index}${SPLIT}${text.replace(MARKS, '')}${CLOSE}`;
}

/** Whether `text` is one marked segment, whole — what an ST entry is where it is inserted. */
export const isTavernSegment = (text: string): boolean => /^\uFDD0\d+\uFDD1[\s\S]*\uFDD2$/.test(text);

/** `wrapped`, a wrapper around one marked segment, framed so that it goes when the segment is emptied. */
export function frameTavernSegment(wrapped: string): string {
  return `${FRAME_OPEN}${wrapped}${FRAME_CLOSE}`;
}

/** Every string of a prompt that goes out: the system, the turns, and what the report and the request editors read. */
function mapTexts(prompt: AssembledPrompt, map: (text: string) => string): AssembledPrompt {
  const content = (value: PromptMessage['content']): PromptMessage['content'] =>
    typeof value === 'string'
      ? map(value)
      : value.map((part) => (part.type === 'text' ? { ...part, text: map(part.text) } : part));
  return {
    ...prompt,
    system: map(prompt.system),
    messages: prompt.messages.map((message) => ({ ...message, content: content(message.content) })),
    ...(prompt.risu
      ? {
          risu: { ...prompt.risu, system: prompt.risu.system.map((turn) => ({ ...turn, text: map(turn.text) })) },
        }
      : {}),
    ...(prompt.systemSections
      ? { systemSections: prompt.systemSections.map((section) => ({ ...section, text: map(section.text) })) }
      : {}),
    ...(prompt.report
      ? { report: { ...prompt.report, blocks: prompt.report.blocks.map((block) => ({ ...block, text: map(block.text) })) } }
      : {}),
  };
}

/** The marked segments that hold no other, by index, with their text. */
export function innermostTavernLore(prompt: AssembledPrompt): Map<number, string> {
  const found = new Map<number, string>();
  mapTexts(prompt, (text) => {
    for (const [, index, body] of text.matchAll(INNERMOST)) {
      if (!found.has(Number(index))) found.set(Number(index), body!);
    }
    return text;
  });
  return found;
}

/** What an emptied segment leaves: one of the separators beside it — the one before, else the one after. */
const dropWithSeparator = (_whole: string, before: string | undefined, after: string | undefined): string =>
  before !== undefined ? (after ?? '') : '';

/**
 * The prompt with each rewritten segment in its place. One the scripts emptied
 * goes as ST leaves it out, with the line break or blank line that set it apart
 * from what was beside it and the wrapper framed around it; a turn left with
 * nothing goes too, with its entry in `sources`. A segment not rewritten keeps
 * its text.
 */
export function withTavernLore(prompt: AssembledPrompt, rewritten: ReadonlyMap<number, string>): AssembledPrompt {
  const replace = (text: string): string => {
    if (!text.includes(OPEN)) return text;
    return (
      text
        .replace(INNERMOST, (whole, index: string) => {
          const next = rewritten.get(Number(index));
          return next === undefined ? whole : markTavernSegment(next, Number(index));
        })
        .replace(EMPTIED_FRAME, dropWithSeparator)
        .replace(EMPTIED, dropWithSeparator)
    );
  };
  const next = mapTexts(prompt, replace);
  const empty = next.messages.map(
    (message, at) =>
      prompt.messages[at]!.content !== message.content &&
      (typeof message.content === 'string' ? message.content.trim() === '' : message.content.length === 0),
  );
  if (!empty.some(Boolean)) return next;
  return {
    ...next,
    messages: next.messages.filter((_, at) => !empty[at]),
    ...(next.sources ? { sources: next.sources.filter((_, at) => !empty[at]) } : {}),
  };
}

/** `text` with every mark gone, what they held left as it is. */
export const unmarkedText = (text: string): string =>
  text.includes(OPEN) || text.includes(CLOSE) || text.includes(FRAME_OPEN)
    ? text.replace(/\uFDD0\d+\uFDD1/g, '').replace(MARKS, '')
    : text;

/** The prompt with every mark gone, the texts they held left as they are. */
export function withoutTavernMarks(prompt: AssembledPrompt): AssembledPrompt {
  if (!prompt.tavernLore) return prompt;
  const { tavernLore: _segments, ...rest } = prompt;
  return mapTexts(rest, unmarkedText);
}

/** Rounds of rewriting at most: an outlet written inside an entry nests one mark in another. */
const MAX_ROUNDS = 4;

/**
 * The prompt as ST's `WORLD_INFO` scripts leave its World Info: `run` rewrites
 * the innermost marked texts, a round at a time, each with the segment's depth
 * (`TavernLoreSegment`), answering in the order it was handed them; then no
 * mark is left. Without marks, the prompt as it is.
 */
export async function rewriteTavernLore(
  prompt: AssembledPrompt,
  run: (segments: { index: number; text: string; depth?: number }[]) => Promise<string[]>,
): Promise<AssembledPrompt> {
  const placed = prompt.tavernLore;
  if (!placed) return prompt;
  let current = prompt;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const found = innermostTavernLore(current);
    // The ones a round already rewrote stay marked for the round that reads their outer text; not again.
    if (found.size === 0) break;
    const segments = [...found].map(([index, text]) => ({
      index,
      text,
      ...(placed[index]?.depth !== undefined ? { depth: placed[index]!.depth! } : {}),
    }));
    const texts = await run(segments);
    const rewritten = new Map(segments.map((segment, at) => [segment.index, texts[at] ?? segment.text]));
    // Rewritten, a segment is unmarked, so the next round finds the one around it.
    current = unmark(withTavernLore(current, rewritten), rewritten);
  }
  return withoutTavernMarks(current);
}

/** The prompt with the marks of `done` taken off, their text kept. */
function unmark(prompt: AssembledPrompt, done: ReadonlyMap<number, string>): AssembledPrompt {
  return mapTexts(prompt, (text) =>
    text.includes(OPEN)
      ? text.replace(INNERMOST, (whole, index: string, body: string) => (done.has(Number(index)) ? body : whole))
      : text,
  );
}
