/**
 * A round of a work of several members, as the browser drives it: who is picked,
 * who is asked next and how, and what a landed, failed, retried or stopped
 * request leaves of the round. Pure, so the whole loop is checked here without a
 * page; the page's own wiring is in groupTurns.test.ts.
 */
import { NARRATOR_SPEAKER } from '@shizue/core/group';
import { describe, expect, it } from 'vitest';
import {
  cueOf,
  groupMembers,
  isGroupWork,
  openRound,
  pickSpeakers,
  redoOf,
  roundRequest,
  roundStart,
  stepRound,
  type Round,
} from '../src/lib/groupRound';
import type { ChatMessage, PublicMember } from '../src/lib/types';

const STAGE: PublicMember[] = [
  { id: 'seiya', name: '세이야', avatarUrl: null, nickname: '세이', talkativeness: 50 },
  { id: 'kai', name: '카이', avatarUrl: null, talkativeness: 100 },
  { id: 'mio', name: '미오', avatarUrl: null, talkativeness: 0 },
];

/** A roll that always lands: every member joins, and a shuffle keeps its order reversed. */
const always = (): number => 0;

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    parentId: null,
    role,
    content,
    source: 'user',
    directions: null,
    model: null,
    promptTokens: null,
    completionTokens: null,
    attachments: [],
    createdAt: '2026-10-14T00:00:00.000Z',
    ...extra,
  };
}

describe('which works answer in rounds', () => {
  it('counts the whole roster: two members or more, on the stage or not', () => {
    expect(isGroupWork([])).toBe(false);
    expect(isGroupWork([STAGE[0]])).toBe(false);
    expect(isGroupWork(STAGE.slice(0, 2))).toBe(true);
  });

  it('reads a member by every name its lines go by, and its 대화량 with the default filled in', () => {
    expect(groupMembers([{ id: 'a', name: '아리아', avatarUrl: null, nickname: ' 아리 ', aliases: ['리아'] }])).toEqual([
      { id: 'a', names: ['아리아', '아리', '리아'], talkativeness: 50 },
    ]);
  });
});

describe('picking a round', () => {
  it('takes the reader’s picks exactly — in roster order, past 대화량 and the cap, on the stage only', () => {
    const speakers = pickSpeakers({
      stage: STAGE,
      picks: ['mio', 'seiya', 'gone'],
      cue: { text: '카이야', lastSpeakerId: null },
      settings: { order: 'natural', maxSpeakers: 1 },
      random: always,
    });
    expect(speakers).toEqual(['seiya', 'mio']);
  });

  it('rolls with the work’s order and cap where nobody was picked', () => {
    const settings = { order: 'list' as const, maxSpeakers: 3 };
    // 미오 speaks only when picked.
    expect(pickSpeakers({ stage: STAGE, picks: [], cue: { text: '안녕', lastSpeakerId: null }, settings, random: always })).toEqual([
      'seiya',
      'kai',
    ]);
    expect(
      pickSpeakers({ stage: STAGE, picks: [], cue: { text: '안녕', lastSpeakerId: null }, settings: { ...settings, maxSpeakers: 1 }, random: always }),
    ).toEqual(['seiya']);
  });

  it('reads the defaults where the work set none: natural order, three at most', () => {
    // Natural: the one named comes first, and whoever just spoke sits it out.
    const speakers = pickSpeakers({
      stage: STAGE,
      picks: [],
      cue: { text: '세이 어디 갔어?', lastSpeakerId: 'kai' },
      settings: null,
      random: always,
    });
    expect(speakers).toEqual(['seiya']);
  });

  it('leaves out a member the reader wrote a line as', () => {
    const speakers = pickSpeakers({
      stage: STAGE,
      picks: [],
      cue: { text: '@카이: 내가 대신 말할게', lastSpeakerId: null },
      settings: { order: 'list', maxSpeakers: 3 },
      random: always,
    });
    expect(speakers).toEqual(['seiya']);
  });
});

describe('reading the branch', () => {
  const user = message('u1', 'user', '안녕');
  const first = message('r1', 'assistant', '세이야의 말', { speakerMemberId: 'seiya', groupTurnId: 'r1' });
  const second = message('r2', 'assistant', '카이의 말', { speakerMemberId: 'kai', groupTurnId: 'r1' });

  it('finds where the round the branch ends on starts', () => {
    const greeting = message('g', 'assistant', '문이 열린다.');
    expect(roundStart([greeting, user, first, second])).toBe(2);
    // A reply in no round is a round of one; a reader's turn ends nothing to replace.
    expect(roundStart([greeting])).toBe(0);
    expect(roundStart([greeting, user])).toBe(2);
    expect(roundStart([])).toBe(0);
  });

  it('answers the reader with no last speaker, and a reply with its own', () => {
    expect(cueOf(user)).toEqual({ text: '안녕', lastSpeakerId: null });
    expect(cueOf(second)).toEqual({ text: '카이의 말', lastSpeakerId: 'kai' });
    expect(cueOf(undefined)).toEqual({ text: '', lastSpeakerId: null });
  });

  it('reads no names off a message hidden from the AI, as ST reads no activation text off one', () => {
    expect(cueOf({ ...second, hiddenFromPrompt: true })).toEqual({ text: '', lastSpeakerId: 'kai' });
  });

  it('redoes the whole round, answering what it answered', () => {
    expect(redoOf([user, first, second])).toEqual({ replaces: 2, cue: { text: '안녕', lastSpeakerId: null }, narrator: false });
    // Under the reader's own turn there is nothing to replace: the turn is answered.
    expect(redoOf([first, user])).toEqual({ replaces: 0, cue: { text: '안녕', lastSpeakerId: null }, narrator: false });
    // A round after a reply: whoever just spoke is the last speaker.
    const auto = message('r3', 'assistant', '미오의 말', { speakerMemberId: 'mio', groupTurnId: 'r3' });
    expect(redoOf([user, first, second, auto]).cue).toEqual({ text: '카이의 말', lastSpeakerId: 'kai' });
  });

  it('gives a round the narration button opened back to the narrator', () => {
    const narration = message('n1', 'assistant', '@: 바람이 분다.', { speakerMemberId: null, groupTurnId: 'n1' });
    expect(redoOf([user, narration]).narrator).toBe(true);
    // A narration that only ended a members' round is not what the round is.
    const ended = message('n2', 'assistant', '@: 바람이 분다.', { speakerMemberId: null, groupTurnId: 'r1' });
    expect(redoOf([user, first, ended])).toMatchObject({ replaces: 2, narrator: false });
  });
});

describe('a round', () => {
  const round = (opening: Round['opening'], speakers: string[], replaces = 0): Round => openRound(opening, speakers, replaces)!;

  it('is none for nobody', () => {
    expect(openRound('send', [])).toBeNull();
    expect(roundRequest(null)).toBeNull();
  });

  it('asks its first speaker as it was opened, the rest as replies in its round, the last as the final one', () => {
    let current: Round | null = round('send', ['seiya', 'kai', 'mio']);
    expect(roundRequest(current)).toEqual({ mode: 'send', speakerId: 'seiya', groupTurnId: null, finalSpeaker: false, replaces: 0 });

    current = stepRound(current, { type: 'landed', groupTurnId: 'r1' });
    expect(roundRequest(current)).toEqual({ mode: 'reply', speakerId: 'kai', groupTurnId: 'r1', finalSpeaker: false, replaces: 0 });

    current = stepRound(current!, { type: 'landed', groupTurnId: 'r1' });
    expect(roundRequest(current)).toEqual({ mode: 'reply', speakerId: 'mio', groupTurnId: 'r1', finalSpeaker: true, replaces: 0 });

    expect(stepRound(current!, { type: 'landed', groupTurnId: 'r1' })).toBeNull();
  });

  it('carries a redo’s replaced replies on its first request only', () => {
    const redo = round('regenerate', ['seiya', 'kai'], 3);
    expect(roundRequest(redo)).toMatchObject({ mode: 'regenerate', replaces: 3 });
    expect(roundRequest(stepRound(redo, { type: 'landed', groupTurnId: 'r9' }))).toMatchObject({ mode: 'reply', replaces: 0 });
    // A round of its own opens with a reply that names no round.
    expect(roundRequest(round('reply', ['kai']))).toEqual({ mode: 'reply', speakerId: 'kai', groupTurnId: null, finalSpeaker: true, replaces: 0 });
  });

  it('ends where its reply was stored in no round — there is nothing to join', () => {
    expect(stepRound(round('send', ['seiya', 'kai']), { type: 'landed', groupTurnId: null })).toBeNull();
  });

  it('puts the same speaker first again when the card’s scripts ask for another reply, a few times a round at most', () => {
    let current: Round | null = round('send', ['seiya', 'kai']);
    for (let asked = 0; asked < 2; asked += 1) {
      current = stepRound(current!, { type: 'landed', groupTurnId: 'r1', followUp: { cap: 2 } });
      expect(current?.queue).toEqual(['seiya', 'kai']);
    }
    expect(roundRequest(current)).toMatchObject({ mode: 'reply', speakerId: 'seiya', finalSpeaker: false });
    // The cap is reached: the round goes on to whoever is next.
    current = stepRound(current!, { type: 'landed', groupTurnId: 'r1', followUp: { cap: 2 } });
    expect(current?.queue).toEqual(['kai']);
    // The last speaker asked again is still the round's last.
    const last = stepRound(round('reply', ['kai']), { type: 'landed', groupTurnId: 'r2', followUp: { cap: 3 } });
    expect(roundRequest(last)).toMatchObject({ speakerId: 'kai', groupTurnId: 'r2', finalSpeaker: true });
  });

  it('keeps a failed speaker for the retry, which asks it again in the same round and goes on', () => {
    const landed = stepRound(round('regenerate', ['seiya', 'kai', 'mio'], 2), { type: 'landed', groupTurnId: 'r1' })!;
    const failed = stepRound(landed, { type: 'failed' })!;
    expect(failed.failed).toBe(true);
    const again = stepRound(failed, { type: 'retry' })!;
    expect(roundRequest(again)).toEqual({ mode: 'reply', speakerId: 'kai', groupTurnId: 'r1', finalSpeaker: false, replaces: 0 });
    expect(stepRound(again, { type: 'landed', groupTurnId: 'r1' })?.queue).toEqual(['mio']);
  });

  it('asks a send’s failed first speaker again as an answer to the stored turn, and a redo’s as the redo', () => {
    const send = stepRound(stepRound(round('send', ['seiya', 'kai']), { type: 'failed' })!, { type: 'retry' });
    expect(roundRequest(send)).toEqual({ mode: 'regenerate', speakerId: 'seiya', groupTurnId: null, finalSpeaker: false, replaces: 0 });
    const redo = stepRound(stepRound(round('regenerate', ['seiya'], 2), { type: 'failed' })!, { type: 'retry' });
    expect(roundRequest(redo)).toMatchObject({ mode: 'regenerate', replaces: 2 });
    const own = stepRound(stepRound(round('reply', ['kai']), { type: 'failed' })!, { type: 'retry' });
    expect(roundRequest(own)).toMatchObject({ mode: 'reply', groupTurnId: null });
  });

  it('is over once stopped: nobody after is asked', () => {
    expect(stepRound(round('send', ['seiya', 'kai', 'mio']), { type: 'ended' })).toBeNull();
  });

  it('lets the narrator redo a round of its own, alone', () => {
    expect(roundRequest(round('regenerate', [NARRATOR_SPEAKER], 1))).toEqual({
      mode: 'regenerate',
      speakerId: NARRATOR_SPEAKER,
      groupTurnId: null,
      finalSpeaker: true,
      replaces: 1,
    });
  });
});
