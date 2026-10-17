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
 * Nothing the reader types forces a speaker. A `@이름: …` line is the reader
 * writing that member's line themselves, as Zeta reads it (`readerRuns`), so the
 * member has just spoken and sits the round out like the last speaker does. The
 * narrator never takes a turn: its lines are only the ones the reader writes
 * (`@내레이터: …`, `@: …`).
 */

import { isNarration } from './narration.js';
import { lineSpeaker, NARRATOR_NAMES, readerRuns, type ReaderMember } from './speech.js';

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

/**
 * The narrator as `writtenAs` names it, for the lines a reader writes as the
 * narrator. No member id (a uuid) can be this.
 */
export const NARRATOR_SPEAKER = 'narrator';

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
  /**
   * The stored text being answered — what the reader sent, after the input
   * scripts. The members it writes lines as (`writtenAs`) have just spoken.
   */
  text: string;
  /** The member who spoke last, for a round the reader did not start; else null. */
  lastSpeakerId: string | null;
  order: GroupOrder;
  /** `GroupSettings.maxSpeakers`. */
  max: number;
  /** [0, 1), like `Math.random`. */
  random: () => number;
}

/**
 * The members and the narrator a reader's turn writes lines as (`readerRuns`):
 * member ids for `@이름: …` lines, `NARRATOR_SPEAKER` for `@내레이터: …` and `@: …`
 * (a whole-turn `@:` included), in the order they first appear, once each. A
 * marker naming nobody on `members` is the reader's own line and names nobody.
 */
export function writtenAs(
  text: string,
  members: readonly ReaderMember[],
  narratorNames: readonly string[] = NARRATOR_NAMES,
): string[] {
  const found: string[] = [];
  for (const run of readerRuns(text, members, narratorNames)) {
    const id = run.kind === 'member' ? run.memberId : run.kind === 'narration' ? NARRATOR_SPEAKER : undefined;
    if (id !== undefined && !found.includes(id)) found.push(id);
  }
  return found;
}

/**
 * Who answers the turn: member ids, in the order they speak. The narrator is
 * never among them.
 *
 * A member the text writes a line as (`writtenAs`) has just spoken, as the last
 * speaker has; neither is among the eligible below. Natural order:
 * 1. Of the members who speak unprompted (talkativeness above 0) and are
 *    eligible: those the text mentions, in order of first mention. A `@이름:`
 *    marker is not a mention; the words after it may be.
 * 2. The rest of them, shuffled, each joining when `talkativeness / 100` is at
 *    least a roll.
 * 3. A round is never empty: when steps 1–2 found nobody, one member is drawn
 *    from the eligible who speak unprompted, else from all who speak unprompted
 *    (whoever just spoke included), else from the whole stage.
 * 4. The cap: the mentioned members first, then the rest.
 *
 * List order is every eligible member who speaks unprompted, in roster order,
 * without mentions or rolls — and without the last speaker's rest: the order is
 * the order. Its fallback and cap are the same.
 *
 * The result is empty only when nobody is on the stage.
 */
export function groupOrder(input: GroupOrderInput): string[] {
  const { members, text, lastSpeakerId, order, random } = input;
  const cap = Math.max(MIN_GROUP_SPEAKERS, input.max);
  const runs = readerRuns(text, members);
  const written = new Set(runs.flatMap((run) => (run.kind === 'member' ? [run.memberId] : [])));
  const speaks = (member: GroupMember): boolean => member.talkativeness > 0;

  let mentioned: string[] = [];
  let others: string[];
  let eligible: GroupMember[];
  if (order === 'list') {
    eligible = members.filter((member) => speaks(member) && !written.has(member.id));
    others = eligible.map((member) => member.id);
  } else {
    eligible = members.filter((member) => speaks(member) && member.id !== lastSpeakerId && !written.has(member.id));
    // What the reader wrote, without the markers that say as whom.
    mentioned = mentionedMembers(runs.map((run) => run.text).join('\n'), eligible);
    others = shuffle(
      eligible.filter((member) => !mentioned.includes(member.id)),
      random,
    )
      .filter((member) => member.talkativeness / 100 >= random())
      .map((member) => member.id);
  }

  if (mentioned.length === 0 && others.length === 0) {
    const tier = [eligible, members.filter(speaks), members].find((candidates) => candidates.length > 0);
    if (tier) others = [tier[Math.floor(random() * tier.length)]!.id];
  }

  return [...mentioned, ...others].slice(0, cap);
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

/**
 * The members on the stage in a stretch of a group chat — whom a memory summary
 * of it, and the facts taken from it, belong to (ARCHITECTURE §7.3 장면의 멤버):
 * the members who speak in it. That is a group reply's speaker (`speakerId`), a
 * member an untagged reply writes `이름:` lines as (a scene reply, one from before
 * group turns, an import), and a member the reader writes a line as (`@이름:`,
 * `writtenAs`). Roster order, once each.
 *
 * A mention is not presence: the members of a work name each other all the time,
 * and talking about someone who is not there is the very scene they must not
 * know. A member the reader addresses speaks next (`groupOrder` picks the
 * mentioned first), so it counts by its reply.
 *
 * Null when nobody speaks — a stretch of narration and the reader's turns. A
 * boundary needs evidence of who was there, and without it the stretch is known
 * to everyone, as a summary from before scenes were kept is. The cost of the
 * rule is the member who stood by in silence for the whole stretch: the stage is
 * not kept per message, so it is left out.
 */
export function sceneMembers(
  messages: readonly { role: 'user' | 'assistant'; content: string; speakerId?: string | null }[],
  members: readonly ReaderMember[],
): string[] | null {
  const roster = members.map((member) => ({ name: member.names[0] ?? '', aliases: member.names.slice(1) }));
  const present = new Set<string>();
  for (const message of messages) {
    if (message.role === 'user') {
      for (const id of writtenAs(message.content, members)) if (id !== NARRATOR_SPEAKER) present.add(id);
    } else if (message.speakerId) {
      present.add(message.speakerId);
    } else if (!isNarration(message.content)) {
      for (const line of message.content.split('\n')) {
        const name = lineSpeaker(line, roster);
        const member = name === undefined ? undefined : members[roster.findIndex((entry) => entry.name === name)];
        if (member) present.add(member.id);
      }
    }
  }
  const found = members.filter((member) => present.has(member.id)).map((member) => member.id);
  return found.length > 0 ? found : null;
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
