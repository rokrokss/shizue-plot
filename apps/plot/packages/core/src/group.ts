/**
 * Group turns — who answers a turn in a work of two or more members, one reply
 * per speaker, each its own message.
 *
 * The browser picks a round's speakers with `groupOrder` before it asks for the
 * first reply (the next speaker's start triggers have to see the reply before
 * it), and the server only checks that whoever it is asked for is on the
 * roster. So this is pure, and every roll goes through the `random` the caller
 * hands in — a seeded one in tests.
 *
 * The narrator never takes a turn on its own. It speaks when the reader asks
 * for it — called by name (`@내레이터:`, `explicitCalls`) or with the narration
 * button — and then it opens the round.
 */

import { lineSpeaker } from './speech.js';

/**
 * How a round's speakers are ordered. `natural`: whoever the reader called,
 * then whoever the text mentions, then the rest by roll. `list`: every member
 * who speaks unprompted, in roster order.
 */
export type GroupOrder = 'natural' | 'list';

/** Every order a work may declare; anything else falls back to the default. */
export const GROUP_ORDERS: readonly GroupOrder[] = ['natural', 'list'];

/** A work's round settings (`plots.group_settings`). */
export interface GroupSettings {
  order: GroupOrder;
  /** How many may answer one turn unless the reader called more: 1..`MAX_GROUP_SPEAKERS`. */
  maxSpeakers: number;
}

export const MIN_GROUP_SPEAKERS = 1;
export const MAX_GROUP_SPEAKERS = 10;

export const DEFAULT_GROUP_SETTINGS: GroupSettings = { order: 'natural', maxSpeakers: 3 };

/** How readily a member speaks unprompted, when nobody set it. */
export const DEFAULT_TALKATIVENESS = 50;

/** Where a member's id would be in a round, the narrator's turn. No member id (a uuid) can be this. */
export const NARRATOR_SPEAKER = 'narrator';
export type NarratorSpeaker = typeof NARRATOR_SPEAKER;

/**
 * What a reader calls the narrator by in an explicit call (`@내레이터:`), in the
 * three catalog languages, both Korean spellings included.
 */
export const NARRATOR_CALL_NAMES: readonly string[] = ['내레이터', '나레이터', 'narrator', 'ナレーター'];

/**
 * The round settings a value describes. An unknown order is the default one, a
 * cap that is not a number is the default cap, and one out of range is clamped
 * — junk is dropped rather than rejected, as `coercePlotStyle` drops it.
 */
export function coerceGroupSettings(value: unknown): GroupSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_GROUP_SETTINGS };
  const raw = value as Record<string, unknown>;
  const order = GROUP_ORDERS.includes(raw['order'] as GroupOrder)
    ? (raw['order'] as GroupOrder)
    : DEFAULT_GROUP_SETTINGS.order;
  const max = raw['maxSpeakers'];
  const maxSpeakers =
    typeof max === 'number' && Number.isFinite(max)
      ? Math.min(MAX_GROUP_SPEAKERS, Math.max(MIN_GROUP_SPEAKERS, Math.round(max)))
      : DEFAULT_GROUP_SETTINGS.maxSpeakers;
  return { order, maxSpeakers };
}

/**
 * A talkativeness, 0..100. Anything that is not a number — the null of a
 * member nobody set one for among them — is `DEFAULT_TALKATIVENESS`. 0 means
 * the member speaks only when picked.
 */
export function coerceTalkativeness(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : DEFAULT_TALKATIVENESS;
}

/** One member on the stage, as a round is picked from it. */
export interface GroupMember {
  id: string;
  /** Everything the text may call it by: the roster name, the card's nickname, the aliases. */
  names: readonly string[];
  /** 0..100 (`coerceTalkativeness`). */
  talkativeness: number;
}

export interface GroupOrderInput {
  /** The members on the stage, in roster order. */
  members: readonly GroupMember[];
  /** The stored text being answered — what the reader sent, after the input scripts. */
  text: string;
  /**
   * Whom the reader called by name (`explicitCalls`), in typed order: member ids
   * and `NARRATOR_SPEAKER`. They speak whatever their talkativeness, whether or
   * not they spoke last, and beyond the cap. This is the only way into a round
   * for the narrator.
   */
  calls?: readonly string[];
  /** The member who spoke last, for a round the reader did not start; else null. */
  lastSpeakerId: string | null;
  order: GroupOrder;
  /** `GroupSettings.maxSpeakers`. */
  max: number;
  /** [0, 1), like `Math.random`. */
  random: () => number;
}

/**
 * Who answers the turn, in the order they speak: member ids, and
 * `NARRATOR_SPEAKER` first when the narrator is among them.
 *
 * Natural order:
 * 1. The reader's explicit calls, in typed order — they always speak, the
 *    narrator first among them.
 * 2. Of the other members who speak unprompted (talkativeness above 0) and did
 *    not speak last: those the text mentions, in order of first mention.
 * 3. The rest of them, shuffled, each joining when `talkativeness / 100` is at
 *    least a roll.
 * 4. A round nobody was called to is never empty: when steps 2–3 found nobody,
 *    one member is drawn from those who speak unprompted and did not speak last,
 *    else from those who speak unprompted, else from the whole stage.
 * 5. The cap: the seats the calls leave go to the mentioned members first, then
 *    to the rest.
 *
 * List order is the same without mentions, rolls or the last speaker's rest:
 * every member who speaks unprompted, in roster order.
 *
 * The result is empty only when nobody can speak: no member on the stage and no
 * call.
 */
export function groupOrder(input: GroupOrderInput): string[] {
  const { members, text, calls = [], lastSpeakerId, order, random } = input;
  const cap = Math.max(MIN_GROUP_SPEAKERS, input.max);
  const onStage = new Set(members.map((member) => member.id));
  const called = [...new Set(calls)].filter((id) => id === NARRATOR_SPEAKER || onStage.has(id));
  const pool = members.filter((member) => !called.includes(member.id));
  const speaks = (member: GroupMember): boolean => member.talkativeness > 0;

  let mentioned: string[] = [];
  let others: string[];
  let eligible: GroupMember[];
  if (order === 'list') {
    eligible = pool.filter(speaks);
    others = eligible.map((member) => member.id);
  } else {
    eligible = pool.filter((member) => speaks(member) && member.id !== lastSpeakerId);
    mentioned = mentionedMembers(text, eligible);
    others = shuffle(
      eligible.filter((member) => !mentioned.includes(member.id)),
      random,
    )
      .filter((member) => member.talkativeness / 100 >= random())
      .map((member) => member.id);
  }

  if (called.length === 0 && mentioned.length === 0 && others.length === 0) {
    const tier = [eligible, pool.filter(speaks), pool].find((candidates) => candidates.length > 0);
    if (tier) others = [tier[Math.floor(random() * tier.length)]!.id];
  }

  const seats = [...mentioned, ...others].slice(0, Math.max(0, cap - called.length));
  return [
    ...(called.includes(NARRATOR_SPEAKER) ? [NARRATOR_SPEAKER] : []),
    ...called.filter((id) => id !== NARRATOR_SPEAKER),
    ...seats,
  ];
}

/** Fisher–Yates over a copy, drawing from `random`. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** What names and texts are compared as: composed, and without case. */
const fold = (text: string): string => text.normalize('NFC').toLowerCase();

/** Scripts written without spaces between words, where a name is found anywhere. */
const UNSPACED_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL_RE = /\p{Script=Hangul}/u;
/** What a word is made of, in any script. */
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u;
const SCRIPTS = [
  /\p{Script=Latin}/u,
  /\p{Script=Hangul}/u,
  /\p{Script=Han}/u,
  /\p{Script=Hiragana}/u,
  /\p{Script=Katakana}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
];
const scriptOf = (char: string): number => SCRIPTS.findIndex((script) => script.test(char));

/**
 * Whether `next` carries on the word `last` ends — a digit, a mark, or a letter
 * of the same script. A letter of another script does not: `Alice는` is Alice
 * and a particle, `凛ちゃん` is 凛 and an honorific.
 */
function continuesWord(last: string, next: string): boolean {
  if (/[\p{N}\p{M}_]/u.test(next)) return true;
  if (!/\p{L}/u.test(next)) return false;
  const script = scriptOf(next);
  const lastScript = scriptOf(last);
  return script === -1 || lastScript === -1 || script === lastScript;
}

/** A name, folded, with how it may sit in a text. */
interface FoldedName {
  text: string;
  /** `unspaced`: anywhere. `eojeol`: at a word's start, any suffix. `word`: a whole word. */
  rule: 'unspaced' | 'eojeol' | 'word';
}

function foldName(name: string): FoldedName | undefined {
  const text = fold(name.trim());
  if (!text) return undefined;
  if (UNSPACED_RE.test(text) && [...text].length >= 2) return { text, rule: 'unspaced' };
  return { text, rule: HANGUL_RE.test(text) ? 'eojeol' : 'word' };
}

/** Every index at which a folded name is mentioned in a folded text, first to last. */
function mentionsIn(text: string, name: FoldedName): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(name.text); at !== -1; at = text.indexOf(name.text, at + 1)) {
    if (name.rule !== 'unspaced') {
      // An `@` before the name is a word start like any other non-letter.
      if (at > 0 && WORD_CHAR_RE.test(text[at - 1]!)) continue;
      const end = at + name.text.length;
      if (name.rule === 'word' && end < text.length && continuesWord(text[end - 1]!, text[end]!)) continue;
    }
    found.push(at);
  }
  return found;
}

/**
 * Where `text` first mentions `name`, or -1. Compared composed (NFC) and without
 * case, by the name's script:
 * - Hangul: at the start of an eojeol, with any suffix — 세이 in 세이야 and 세이는,
 *   not in 아세이.
 * - Kana and kanji/hanzi, two characters or more: anywhere, as those scripts put
 *   no spaces between words.
 * - Anything else, one-character kana and kanji included: a whole word. A letter
 *   of another script may follow, as a Korean particle or a Japanese honorific does.
 *
 * An `@` right before the name is fine: `@세이야` mentions 세이야.
 */
export function mentionIndex(text: string, name: string): number {
  const folded = foldName(name);
  return folded ? (mentionsIn(fold(text), folded)[0] ?? -1) : -1;
}

/**
 * The ids of the members `text` mentions by any of their names, in order of
 * first mention (`mentionIndex`). Where two members' names start at the same
 * place, the longer name has it: 세이야 is not also a mention of a 세이.
 */
export function mentionedMembers(text: string, members: readonly Pick<GroupMember, 'id' | 'names'>[]): string[] {
  const folded = fold(text);
  const hits = members.flatMap((member, rank) =>
    member.names.flatMap((name) => {
      const foldedName = foldName(name);
      return foldedName
        ? mentionsIn(folded, foldedName).map((at) => ({ id: member.id, rank, at, length: foldedName.text.length }))
        : [];
    }),
  );
  const first = new Map<string, { at: number; rank: number }>();
  for (const hit of hits) {
    if (hits.some((other) => other.id !== hit.id && other.at === hit.at && other.length > hit.length)) continue;
    const seen = first.get(hit.id);
    if (!seen || hit.at < seen.at) first.set(hit.id, { at: hit.at, rank: hit.rank });
  }
  return [...first.entries()]
    .sort(([, a], [, b]) => a.at - b.at || a.rank - b.rank)
    .map(([id]) => id);
}

/** An explicit call at a line's start: who, and where its marker ends. */
interface Call {
  speaker: string;
  /** Index in the composed text just past the marker and its `:`. */
  end: number;
}

/**
 * The call a line opens with, if it opens with one: `@`, a name, then a `:`
 * (half or full width), a space, punctuation or the end — not a letter, so
 * `@세이야는` is a mention and not a call. Where one name starts another, the
 * longest that fits is the one called.
 */
function callAt(
  text: string,
  at: number,
  members: readonly Pick<GroupMember, 'id' | 'names'>[],
  narratorNames: readonly string[],
): Call | undefined {
  let start = at;
  while (start < text.length && (text[start] === ' ' || text[start] === '\t')) start += 1;
  if (text[start] !== '@') return undefined;
  const candidates = [
    ...members.flatMap((member) => member.names.map((name) => ({ speaker: member.id, name }))),
    ...narratorNames.map((name) => ({ speaker: NARRATOR_SPEAKER, name })),
  ];
  let best: { speaker: string; end: number } | undefined;
  for (const { speaker, name } of candidates) {
    const folded = fold(name.trim());
    if (!folded) continue;
    const end = start + 1 + folded.length;
    if (fold(text.slice(start + 1, end)) !== folded) continue;
    if (end < text.length && WORD_CHAR_RE.test(text[end]!)) continue;
    if (!best || end > best.end) best = { speaker, end };
  }
  if (!best) return undefined;
  const colon = text[best.end] === ':' || text[best.end] === '：' ? 1 : 0;
  return { speaker: best.speaker, end: best.end + colon };
}

/**
 * Whom the reader called by name, as Zeta's multi-character chats call a member:
 * `@이름` — a member's name, nickname or alias — or `@내레이터` (`NARRATOR_CALL_NAMES`)
 * at the start of the text or of a line, optionally followed by `:`. Member ids
 * and `NARRATOR_SPEAKER`, in typed order, each once. Compared like mentions:
 * composed, and without case.
 *
 * A bare `@:` calls nobody — it is the reader writing narration (`narration.ts`).
 * A member off the stage is not among `members`, so calling one calls nobody.
 */
export function explicitCalls(
  text: string,
  members: readonly Pick<GroupMember, 'id' | 'names'>[],
  narratorNames: readonly string[] = NARRATOR_CALL_NAMES,
): string[] {
  const composed = text.normalize('NFC');
  const found: string[] = [];
  for (let at = 0; at !== -1 && at <= composed.length; ) {
    const call = callAt(composed, at, members, narratorNames);
    if (call && !found.includes(call.speaker)) found.push(call.speaker);
    const next = composed.indexOf('\n', at);
    at = next === -1 ? -1 : next + 1;
  }
  return found;
}

/**
 * The text without the call that opens it (`explicitCalls`) — the `@이름:` and the
 * space after it — for whoever decides the stored turn should not keep it. Only
 * the first line's: a call further down is left where it is. A text that opens
 * with no call comes back as it is; one that does comes back composed (NFC).
 */
export function stripCallMarker(
  text: string,
  members: readonly Pick<GroupMember, 'id' | 'names'>[],
  narratorNames: readonly string[] = NARRATOR_CALL_NAMES,
): string {
  const composed = text.normalize('NFC');
  const call = callAt(composed, 0, members, narratorNames);
  return call ? composed.slice(call.end).replace(/^[ \t]+/, '') : text;
}

/**
 * A group reply without the speaker's own `이름: ` prefixes. The reply is the
 * speaker's whole, so a model that wrote the prefix anyway — the speech protocol
 * taught it to for years of history — must not have it stored, or the line
 * would read as said twice. `speakerNames` are the speaker's: the roster name
 * first, then whatever else the protocol may read as them (the nickname). A line
 * under anyone else's name is left alone, as is every line with no prefix.
 */
export function stripSpeakerPrefix(text: string, speakerNames: readonly string[]): string {
  const [name, ...aliases] = speakerNames;
  if (name === undefined) return text;
  const roster = [{ name, aliases }];
  return text
    .split('\n')
    .map((line) => (lineSpeaker(line, roster) === undefined ? line : line.slice(line.indexOf(':') + 1).replace(/^\s/, '')))
    .join('\n');
}
