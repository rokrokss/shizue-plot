import {
  coerceGroupSettings,
  coerceTalkativeness,
  groupOrder,
  type GroupMember,
  type GroupSettings,
} from '@shizue/core/group';
import type { ChatMessage, PublicMember } from './types';

/**
 * Group turns, as the reader's browser drives them: in a work of two or more
 * members a turn is answered one reply per speaker, each its own message, and
 * the browser picks the round's speakers (`groupOrder`) and asks for them one
 * at a time — the next speaker's start triggers have to run after the last
 * reply was finished.
 *
 * Everything here is pure. The page holds a `Round` while one runs, asks
 * `roundRequest` who goes next, and steps it with what became of each request.
 */

/**
 * Whether a work answers one reply per speaker: a roster of two or more,
 * counted whole — a member sent off the stage still counts, as the API counts.
 */
export const isGroupWork = (roster: readonly unknown[]): boolean => roster.length >= 2;

/** The stage as `groupOrder` reads it: every name a member's lines go by, and its 대화량. */
export function groupMembers(stage: readonly PublicMember[]): GroupMember[] {
  return stage.map((member) => {
    const nickname = member.nickname?.trim();
    return {
      id: member.id,
      names: [member.name, ...(nickname ? [nickname] : []), ...(member.aliases ?? [])],
      talkativeness: coerceTalkativeness(member.talkativeness),
    };
  });
}

/**
 * Where the round the branch ends on starts — the API's `roundStart`: the first
 * of the contiguous replies at its end that share the last one's round. The
 * last index for a reply in no round (an old scene reply, a greeting), and the
 * branch's length where it ends on the reader's turn or on nothing.
 */
export function roundStart(path: readonly Pick<ChatMessage, 'role' | 'groupTurnId'>[]): number {
  const last = path.at(-1);
  if (!last || last.role !== 'assistant') return path.length;
  let start = path.length - 1;
  const round = last.groupTurnId ?? null;
  if (round === null) return start;
  while (start > 0 && path[start - 1]!.role === 'assistant' && path[start - 1]!.groupTurnId === round) start -= 1;
  return start;
}

/**
 * What a round answers: the stored text it reads its speakers off — the reader's
 * turn after its input scripts, a reply, a narration — and, for a round that
 * does not answer the reader, who spoke last.
 */
export interface RoundCue {
  text: string;
  lastSpeakerId: string | null;
}

/**
 * The cue of a round that follows `message`. One hidden from the AI names no one
 * — SillyTavern reads no activation text off a hidden last message — though who
 * said it still spoke last.
 */
export function cueOf(message: ChatMessage | undefined): RoundCue {
  if (!message) return { text: '', lastSpeakerId: null };
  return {
    text: message.hiddenFromPrompt ? '' : message.content,
    lastSpeakerId: message.role === 'assistant' ? (message.speakerMemberId ?? null) : null,
  };
}

/** Who speaks in a round: `groupOrder` reads the cue with the work's order and cap. */
export function pickSpeakers({
  stage,
  cue,
  settings,
  random,
}: {
  /** The members on the stage, in roster order. */
  stage: readonly PublicMember[];
  cue: RoundCue;
  settings: GroupSettings | null | undefined;
  random: () => number;
}): string[] {
  const members = groupMembers(stage);
  const { order, maxSpeakers } = coerceGroupSettings(settings);
  return groupOrder({ members, text: cue.text, lastSpeakerId: cue.lastSpeakerId, order, max: maxSpeakers, random });
}

/** How the round the branch ends on is redone (재생성). */
export interface Redo {
  /** The replies at the branch's end it replaces: the whole round, none under the reader's turn. */
  replaces: number;
  /** What the new round answers: whatever the replaced one did. */
  cue: RoundCue;
}

export function redoOf(path: readonly ChatMessage[]): Redo {
  const start = roundStart(path);
  return {
    replaces: path.length - start,
    cue: cueOf(path[start - 1]),
  };
}

/**
 * How a round's first reply is asked for: answering a send (`/messages`), redoing
 * the round the branch ends on (`/regenerate`), or a round of its own after the
 * head (`/reply` without a round — 이어가기, 지금 말하기).
 */
export type RoundOpening = 'send' | 'regenerate' | 'reply';

/** A round in hand. */
export interface Round {
  opening: RoundOpening;
  /** Who is still to speak, in order; the first is the one asked now, or next. */
  queue: readonly string[];
  /** The round's id once its first reply is stored; every later reply joins it. */
  groupTurnId: string | null;
  /** For a redo: the replies at the branch's end its first request replaces. */
  replaces: number;
  /** Replies the card's scripts asked for in this round (`sendAIprompt`). */
  followUps: number;
  /** The request for `queue[0]` failed; the round waits on the reader's retry. */
  failed: boolean;
}

/** A round of `speakers`, or none for nobody — the stage is empty. */
export function openRound(opening: RoundOpening, speakers: readonly string[], replaces = 0): Round | null {
  if (speakers.length === 0) return null;
  return { opening, queue: [...speakers], groupTurnId: null, replaces, followUps: 0, failed: false };
}

/** One request of a round. */
export interface RoundRequest {
  /** The route: the round's opening until its first reply is stored, `reply` after. */
  mode: RoundOpening;
  speakerId: string;
  /** The round to join; null for its first reply. */
  groupTurnId: string | null;
  /** The last speaker the round knows of, who writes the status window and the choices. */
  finalSpeaker: boolean;
  /** A redo's replaced replies; 0 for every other request. */
  replaces: number;
}

/** Who goes next, and how; null once nobody is left. */
export function roundRequest(round: Round | null): RoundRequest | null {
  const speakerId = round?.queue[0];
  if (!round || speakerId === undefined) return null;
  const mode: RoundOpening = round.groupTurnId !== null ? 'reply' : round.opening;
  return {
    mode,
    speakerId,
    groupTurnId: round.groupTurnId,
    finalSpeaker: round.queue.length === 1,
    replaces: mode === 'regenerate' ? round.replaces : 0,
  };
}

/** What became of the request for `queue[0]`. */
export type RoundEvent =
  /**
   * Its reply is stored and finished, in round `groupTurnId`. `followUp`: the
   * card's output scripts asked for another (`sendAIprompt`), which the same
   * speaker gives, up to `cap` times a round.
   */
  | { type: 'landed'; groupTurnId: string | null; followUp?: { cap: number } }
  /** It failed and may be asked again: the stream broke, or the request was refused. */
  | { type: 'failed' }
  /** The reader asks the failed speaker again. */
  | { type: 'retry' }
  /** Nothing more is asked: the reader stopped it, a start trigger did, or the turn never landed. */
  | { type: 'ended' };

/** The round after `event`; null once it is over. */
export function stepRound(round: Round, event: RoundEvent): Round | null {
  switch (event.type) {
    case 'landed': {
      // A reply stored in no round answered as the scene: there is nothing to join.
      const groupTurnId = round.groupTurnId ?? event.groupTurnId;
      if (groupTurnId === null) return null;
      const [speaker, ...rest] = round.queue;
      const again = event.followUp !== undefined && speaker !== undefined && round.followUps < event.followUp.cap;
      const queue = again ? [speaker, ...rest] : rest;
      if (queue.length === 0) return null;
      return { ...round, queue, groupTurnId, followUps: round.followUps + (again ? 1 : 0), failed: false };
    }
    case 'failed':
      // A send's turn is stored either way, so its first speaker is asked again as
      // an answer to that turn — a redo of nothing, under the reader's head.
      return round.opening === 'send'
        ? { ...round, opening: 'regenerate', replaces: 0, failed: true }
        : { ...round, failed: true };
    case 'retry':
      return { ...round, failed: false };
    case 'ended':
      return null;
  }
}
