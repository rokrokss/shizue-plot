/**
 * Speech protocol — who is speaking inside one message, and which of their words
 * are dialogue as against 상황묘사.
 *
 * Like narration (`narration.ts`) this is a content convention and not a column:
 * the presets teach the model to write `이름: …` lines, the reader types the same
 * shapes, and nothing in the schema knows about either — so a turn still branches,
 * swipes and regenerates as one plain string.
 *
 * The parser is pure and cheap enough to run on every render, which is what makes
 * a streaming message parseable as it arrives: a half-written last line parses as
 * what it currently says, and says something else once the rest lands.
 *
 * The cost of a content convention is the same one narration pays — a character
 * whose dialogue happens to open with another member's name reads as that member.
 * That is the convention working as specified, not a case to detect.
 */

import { isNarration, narrationBody } from './narration.js';

export type SpeechSpeaker =
  | { kind: 'narrator' }
  | { kind: 'character'; name: string }
  | { kind: 'user' };

export interface SpeechPart {
  kind: 'dialogue' | 'description';
  text: string;
}

export interface SpeechBlock {
  speaker: SpeechSpeaker;
  parts: SpeechPart[];
}

/**
 * A speaker prefix: a name, a colon, and at most one space of separation. The
 * name is capped at 40 characters so an ordinary sentence containing a colon
 * cannot be read as a very long speaker.
 */
const SPEAKER_RE = /^([^:\n]{1,40}):\s?(.*)$/;

/**
 * A 상황묘사 span inside a spoken line. It never crosses a line break: the spans
 * are per line, and a pattern that spanned them would pair a stray `*` on one
 * line with a stray `*` on another. An unpaired `*` is therefore literal text.
 */
const DESCRIPTION_RE = /\*([^*\n]+)\*/g;

function sameSpeaker(a: SpeechSpeaker, b: SpeechSpeaker): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'character' ? a.name === (b as { name: string }).name : true;
}

/** Trims the ends of a part and drops it when nothing is left. */
function pushPart(parts: SpeechPart[], kind: SpeechPart['kind'], text: string): void {
  const trimmed = text.trim();
  if (trimmed.length > 0) parts.push({ kind, text: trimmed });
}

/** Splits a spoken line into its dialogue and the `*…*` spans between. */
function splitParts(text: string): SpeechPart[] {
  const parts: SpeechPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(DESCRIPTION_RE)) {
    pushPart(parts, 'dialogue', text.slice(cursor, match.index));
    pushPart(parts, 'description', match[1]!);
    cursor = match.index + match[0].length;
  }
  pushPart(parts, 'dialogue', text.slice(cursor));
  return parts;
}

/** The narrator never has dialogue, so its whole text is one 상황묘사. */
function narratorParts(text: string): SpeechPart[] {
  const parts: SpeechPart[] = [];
  pushPart(parts, 'description', text);
  return parts;
}

function narratorBlocks(text: string): SpeechBlock[] {
  const parts = narratorParts(text);
  return parts.length > 0 ? [{ speaker: { kind: 'narrator' }, parts }] : [];
}

/**
 * Assistant output: `이름: …` lines belong to the named roster member, every
 * other line is the narrator's 상황묘사, and consecutive lines with the same
 * speaker are one block. A prefix that names nobody on the roster is left alone —
 * the line stays narrator text, colon and all.
 *
 * A blank line is spacing: it neither starts a block nor ends one.
 */
export function parseAssistantSpeech(content: string, roster: readonly string[]): SpeechBlock[] {
  // A whole-turn `@:` is the narration convention, which says with a prefix what
  // an unprefixed line says here. Both read back as the narrator.
  if (isNarration(content)) return narratorBlocks(narrationBody(content));

  const groups: { speaker: SpeechSpeaker; lines: string[] }[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = SPEAKER_RE.exec(line);
    const name = match ? roster.find((member) => member === match[1]!.trim()) : undefined;
    const speaker: SpeechSpeaker =
      name === undefined ? { kind: 'narrator' } : { kind: 'character', name };
    const body = name === undefined ? line : match![2]!;
    const last = groups.at(-1);
    if (last && sameSpeaker(last.speaker, speaker)) last.lines.push(body);
    else groups.push({ speaker, lines: [body] });
  }

  return groups
    .map(({ speaker, lines }) => {
      const text = lines.join('\n').trim();
      return {
        speaker,
        parts: speaker.kind === 'narrator' ? narratorParts(text) : splitParts(text),
      };
    })
    .filter((block) => block.parts.length > 0);
}

/**
 * A user turn: `@:` makes the whole turn the reader writing narrator 상황묘사,
 * and anything else is the user speaking, with `*…*` spans as their own 상황묘사.
 * Unlike an assistant turn it is never split by speaker — one turn is one voice.
 */
export function parseUserSpeech(content: string): SpeechBlock[] {
  if (isNarration(content)) return narratorBlocks(narrationBody(content));
  const parts = splitParts(content.trim());
  return parts.length > 0 ? [{ speaker: { kind: 'user' }, parts }] : [];
}
