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
 *
 * The reader's own turn has a convention of its own, Zeta's: a `@이름: …` line is
 * the reader writing that member's line, and `@내레이터: …` or `@: …` narration
 * (`readerRuns`). It is stored as typed, like everything here.
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
 * One member of the roster the parser reads prefixes against: the roster name,
 * or the name with the other names a line may give it. A RisuAI card's
 * `{{char}}` is its nickname, so the model reads about the member under that
 * name and writes its lines under it too; the line is still the member's, and
 * reads back under the roster name.
 */
export type SpeechRosterMember = string | { readonly name: string; readonly aliases?: readonly string[] };

/**
 * The roster name a prefix names. Roster names are asked first, all of them, so
 * a nickname that happens to be another member's name reads as that member;
 * among aliases the first member in roster order wins.
 */
function rosterName(prefix: string, roster: readonly SpeechRosterMember[]): string | undefined {
  for (const member of roster) {
    const name = typeof member === 'string' ? member : member.name;
    if (name === prefix) return name;
  }
  for (const member of roster) {
    if (typeof member !== 'string' && member.aliases?.some((alias) => alias.trim() === prefix)) return member.name;
  }
  return undefined;
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
 * Assistant output: `이름: …` lines belong to the named roster member — by its
 * roster name or one of its aliases, and read back under the roster name either
 * way — every other line is the narrator's 상황묘사, and consecutive lines with
 * the same speaker are one block. A prefix that names nobody on the roster is
 * left alone — the line stays narrator text, colon and all.
 *
 * A blank line is spacing: it neither starts a block nor ends one.
 */
export function parseAssistantSpeech(content: string, roster: readonly SpeechRosterMember[]): SpeechBlock[] {
  // A whole-turn `@:` is the narration convention, which says with a prefix what
  // an unprefixed line says here. Both read back as the narrator.
  if (isNarration(content)) return narratorBlocks(narrationBody(content));

  const groups: { speaker: SpeechSpeaker; lines: string[] }[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = SPEAKER_RE.exec(line);
    const name = match ? rosterName(match[1]!.trim(), roster) : undefined;
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
 * What a reader writes the narrator as, at a line's start (`@내레이터: …`), in the
 * three catalog languages, both Korean spellings included. A bare `@: …` is the
 * same thing.
 */
export const NARRATOR_NAMES: readonly string[] = ['내레이터', '나레이터', 'narrator', 'ナレーター'];

/**
 * A member a reader may write a line as: its id, and every name a `@이름:` line
 * may give it — the roster name first, then its nickname and aliases.
 */
export interface ReaderMember {
  readonly id: string;
  readonly names: readonly string[];
}

/**
 * One stretch of a user turn, by who the reader wrote it as: themselves, a
 * member (`@이름: …`), or the narrator (`@내레이터: …`, `@: …`).
 */
export type ReaderRun =
  | { kind: 'user'; text: string }
  | { kind: 'member'; memberId: string; text: string }
  | { kind: 'narration'; text: string };

/**
 * A line the reader wrote as someone: `@`, a name or nothing, a colon (half or
 * full width), at most one space — and a line split off CRLF text keeps no `\r`.
 */
const WRITTEN_AS_RE = /^\s*@([^:：\n]{0,40})[:：]\s?(.*?)\r?$/;

/** What marker names are compared as: composed, trimmed, and without case. */
const foldName = (name: string): string => name.normalize('NFC').trim().toLowerCase();

/**
 * Who a line of a user turn is written as, and its text without the marker; null
 * for a line that is the reader's own. `@이름:` names a member by any of its
 * names — members are asked before the narrator's names — and `@내레이터:` or a
 * bare `@:` is narration. A marker naming nobody leaves the line the reader's,
 * marker and all.
 */
export function readerLine(
  line: string,
  members: readonly ReaderMember[],
  narratorNames: readonly string[] = NARRATOR_NAMES,
): { kind: 'member'; member: ReaderMember; text: string } | { kind: 'narration'; text: string } | null {
  const match = WRITTEN_AS_RE.exec(line);
  if (!match) return null;
  const name = foldName(match[1]!);
  const text = match[2]!;
  if (!name) return { kind: 'narration', text };
  const member = members.find((candidate) => candidate.names.some((other) => foldName(other) === name));
  if (member) return { kind: 'member', member, text };
  return narratorNames.some((other) => foldName(other) === name) ? { kind: 'narration', text } : null;
}

/**
 * A user turn cut into who the reader wrote each stretch as, as Zeta reads a
 * reader's `@이름:` line: the reader writing that member's line themselves — not
 * asking the member to speak.
 *
 * A turn that opens with `@:` is narration whole, as it has always been, every
 * line of it. Any other turn is read line by line: `@이름: …` (name, nickname or
 * alias) is that member's, `@내레이터: …` and `@: …` are narration, and every other
 * line is the reader's own. Consecutive lines written as the same one are one
 * run; a blank line is spacing and neither starts a run nor ends one. The text
 * is the run's lines without their markers, trimmed, and a run left with none is
 * dropped. A turn with no marker is one `user` run of the whole turn, trimmed.
 */
export function readerRuns(
  content: string,
  members: readonly ReaderMember[],
  narratorNames: readonly string[] = NARRATOR_NAMES,
): ReaderRun[] {
  if (isNarration(content)) {
    const text = narrationBody(content);
    return text ? [{ kind: 'narration', text }] : [];
  }
  const groups: { run: ReaderRun; lines: string[] }[] = [];
  let pending: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      pending.push(line);
      continue;
    }
    const written = readerLine(line, members, narratorNames);
    const run: ReaderRun =
      written === null
        ? { kind: 'user', text: '' }
        : written.kind === 'member'
          ? { kind: 'member', memberId: written.member.id, text: '' }
          : { kind: 'narration', text: '' };
    const body = written === null ? line : written.text;
    const last = groups.at(-1);
    if (last && last.run.kind === run.kind && (run.kind !== 'member' || (last.run as { memberId: string }).memberId === run.memberId)) {
      last.lines.push(...pending, body);
    } else {
      groups.push({ run, lines: [body] });
    }
    pending = [];
  }
  return groups
    .map(({ run, lines }) => ({ ...run, text: lines.join('\n').trim() }))
    .filter((run) => run.text.length > 0);
}

/**
 * A user turn: `@:` makes the whole turn the reader writing narrator 상황묘사,
 * and anything else is the user speaking, with `*…*` spans as their own 상황묘사.
 *
 * Given the members, lines the reader wrote as someone else are theirs
 * (`readerRuns`): a `@이름:` line is that member's block, under its roster name
 * (`names[0]`), and a `@내레이터:` line is the narrator's. Without them, or in a
 * turn with no such line, the turn is one voice, as it has always been.
 */
export function parseUserSpeech(content: string, members?: readonly ReaderMember[]): SpeechBlock[] {
  if (isNarration(content)) return narratorBlocks(narrationBody(content));
  if (!members) {
    const parts = splitParts(content.trim());
    return parts.length > 0 ? [{ speaker: { kind: 'user' }, parts }] : [];
  }
  return readerRuns(content, members).flatMap((run): SpeechBlock[] => {
    if (run.kind === 'narration') return narratorBlocks(run.text);
    const name = run.kind === 'member' ? members.find((member) => member.id === run.memberId)?.names[0] : undefined;
    const parts = splitParts(run.text);
    if (parts.length === 0) return [];
    return [{ speaker: name !== undefined ? { kind: 'character', name } : { kind: 'user' }, parts }];
  });
}

/**
 * The roster name a line's speaker prefix names, read the way
 * `parseAssistantSpeech` reads it; undefined when the line is the narrator's.
 */
export function lineSpeaker(line: string, roster: readonly SpeechRosterMember[]): string | undefined {
  const match = SPEAKER_RE.exec(line);
  return match ? rosterName(match[1]!.trim(), roster) : undefined;
}

/**
 * Text written into the protocol as `name`'s: every line with text gets the
 * `name: ` prefix, except a line the parser already reads as someone on
 * `roster` (by default `name` alone). Blank lines stay, as spacing. The
 * importers turn a character's prose into speech-protocol lines with it.
 */
export function spokenBy(text: string, name: string, roster: readonly SpeechRosterMember[] = [name]): string {
  return text
    .split('\n')
    .map((line) => (!line.trim() || lineSpeaker(line, roster) !== undefined ? line : `${name}: ${line}`))
    .join('\n');
}
