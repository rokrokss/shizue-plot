import { describe, expect, it } from 'vitest';
import {
  coerceGroupSettings,
  coerceTalkativeness,
  DEFAULT_GROUP_SETTINGS,
  explicitCalls,
  groupOrder,
  mentionedMembers,
  mentionIndex,
  NARRATOR_SPEAKER,
  stripCallMarker,
  stripSpeakerPrefix,
  type GroupMember,
  type GroupOrderInput,
} from '../src/group.js';
import { NARRATION_HEADER } from '../src/prompt.js';
import { transcriptLine } from '../src/transcript.js';

/** mulberry32: a seeded stand-in for Math.random. */
const seeded = (seed: number) => (): number => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** Every roll passes: anyone who speaks unprompted joins. */
const always = (): number => 0;
/** Every roll fails short of 100: nobody joins on their own. */
const never = (): number => 0.9999;

const seiya: GroupMember = { id: 'seiya', names: ['세이야', '세이'], talkativeness: 50 };
const kai: GroupMember = { id: 'kai', names: ['카이'], talkativeness: 50 };
const mio: GroupMember = { id: 'mio', names: ['미오'], talkativeness: 50 };

const order = (input: Partial<GroupOrderInput>): string[] =>
  groupOrder({
    members: [seiya, kai, mio],
    text: '',
    lastSpeakerId: null,
    order: 'natural',
    max: 3,
    random: never,
    ...input,
  });

describe('groupOrder - natural', () => {
  it('puts the mentioned members first, in order of first mention, once each', () => {
    expect(order({ text: '카이야, 세이는 어디 갔어? 카이!' })).toEqual(['kai', 'seiya']);
    expect(order({ text: '미오, 세이야한테 전해 줘.' })).toEqual(['mio', 'seiya']);
  });

  it('reads mentions in Japanese and English as well', () => {
    const miku: GroupMember = { id: 'miku', names: ['ミク'], talkativeness: 50 };
    const rin: GroupMember = { id: 'rin', names: ['リン'], talkativeness: 50 };
    expect(order({ members: [miku, rin], text: 'リンちゃんとミクさん、おはよう' })).toEqual(['rin', 'miku']);
    const alice: GroupMember = { id: 'alice', names: ['Alice'], talkativeness: 50 };
    const bob: GroupMember = { id: 'bob', names: ['Bob'], talkativeness: 50 };
    expect(order({ members: [alice, bob], text: 'BOB, where did alice go?' })).toEqual(['bob', 'alice']);
  });

  it('lets the rest join by roll, after the mentioned', () => {
    expect(order({ text: '미오?', random: always })).toEqual(['mio', expect.any(String), expect.any(String)]);
    const rolled = order({ text: '미오?', random: always });
    expect(rolled.slice(1).sort()).toEqual(['kai', 'seiya']);
  });

  it('joins by talkativeness over many rolls', () => {
    const random = seeded(7);
    const loud = { ...kai, talkativeness: 90 };
    const quiet = { ...mio, talkativeness: 10 };
    const counts = { seiya: 0, kai: 0, mio: 0 };
    for (let i = 0; i < 2000; i += 1) {
      for (const id of groupOrder({
        members: [seiya, loud, quiet],
        text: '',
        lastSpeakerId: null,
        order: 'natural',
        max: 3,
        random,
      })) {
        counts[id as keyof typeof counts] += 1;
      }
    }
    expect(counts.kai).toBeGreaterThan(counts.seiya);
    expect(counts.seiya).toBeGreaterThan(counts.mio);
  });

  it('is the same round for the same seed', () => {
    const a = order({ random: seeded(42), text: '안녕' });
    const b = order({ random: seeded(42), text: '안녕' });
    expect(a).toEqual(b);
  });

  it('drops whoever spoke last, even when mentioned', () => {
    expect(order({ text: '세이야, 카이', lastSpeakerId: 'seiya' })).toEqual(['kai']);
    const rolled = order({ lastSpeakerId: 'kai', random: always });
    expect(rolled).not.toContain('kai');
    expect(rolled.sort()).toEqual(['mio', 'seiya']);
  });

  it('never mentions or rolls a member who speaks only when picked', () => {
    const shy = { ...kai, talkativeness: 0 };
    expect(order({ members: [seiya, shy, mio], text: '카이야', random: always }).sort()).toEqual(['mio', 'seiya']);
  });

  it('falls back to one member so a round is never empty', () => {
    // Nobody rolled in: one of those eligible is drawn.
    expect(order({ random: never })).toHaveLength(1);
    // Draws skip the last speaker while anyone else speaks unprompted…
    expect(order({ members: [seiya, kai], lastSpeakerId: 'seiya' })).toEqual(['kai']);
    // …let the last speaker back when nobody else does…
    expect(order({ members: [seiya, { ...kai, talkativeness: 0 }], lastSpeakerId: 'seiya' })).toEqual(['seiya']);
    // …and take anyone on the stage when everybody speaks only when picked.
    const silent = [seiya, kai].map((member) => ({ ...member, talkativeness: 0 }));
    expect(order({ members: silent, random: () => 0.6 })).toEqual(['kai']);
  });

  it('caps the round, keeping the mentioned members', () => {
    const loud = [seiya, kai, mio].map((member) => ({ ...member, talkativeness: 100 }));
    const dan: GroupMember = { id: 'dan', names: ['단'], talkativeness: 100 };
    expect(order({ members: [...loud, dan], max: 2, text: '단아, 미오야', random: always })).toEqual(['dan', 'mio']);
    expect(order({ members: [...loud, dan], max: 3, text: '단아, 미오야', random: always })).toHaveLength(3);
    expect(order({ members: loud, max: 1, text: '미오, 세이야', random: always })).toEqual(['mio']);
  });
});

describe('groupOrder - the narrator', () => {
  it('never takes a turn on its own: no roll, no mention, no fallback', () => {
    const random = seeded(3);
    for (let i = 0; i < 500; i += 1) {
      expect(order({ text: '내레이터, narrator, 나레이터', random })).not.toContain(NARRATOR_SPEAKER);
    }
    expect(order({ members: [] })).toEqual([]);
  });

  it('opens the round when called, ahead of members called before it', () => {
    expect(order({ calls: ['kai', NARRATOR_SPEAKER], text: '미오야' })).toEqual([NARRATOR_SPEAKER, 'kai', 'mio']);
    // Called alone, it may answer alone, and does on an empty stage too.
    expect(order({ calls: [NARRATOR_SPEAKER] })).toEqual([NARRATOR_SPEAKER]);
    expect(order({ members: [], calls: [NARRATOR_SPEAKER] })).toEqual([NARRATOR_SPEAKER]);
  });
});

describe('groupOrder - list', () => {
  it('takes every member who speaks unprompted, in roster order, the narrator only when called', () => {
    const shy = { ...kai, talkativeness: 0 };
    expect(order({ order: 'list', members: [mio, shy, seiya], text: '세이야!' })).toEqual(['mio', 'seiya']);
    expect(order({ order: 'list', members: [mio, seiya], calls: [NARRATOR_SPEAKER] })).toEqual([
      NARRATOR_SPEAKER,
      'mio',
      'seiya',
    ]);
    // The last speaker is not dropped: the order is the order.
    expect(order({ order: 'list', members: [mio, seiya], lastSpeakerId: 'mio' })).toEqual(['mio', 'seiya']);
  });

  it('caps in roster order and falls back like the natural order', () => {
    expect(order({ order: 'list', max: 2 })).toEqual(['seiya', 'kai']);
    const silent = [seiya, kai].map((member) => ({ ...member, talkativeness: 0 }));
    expect(order({ order: 'list', members: silent, random: () => 0 })).toEqual(['seiya']);
  });
});

describe('groupOrder - explicit calls', () => {
  it('puts the called first, in typed order, whatever their talkativeness and the cap', () => {
    const shy = { ...mio, talkativeness: 0 };
    expect(order({ members: [seiya, kai, shy], calls: ['mio', 'seiya'], max: 1, random: always })).toEqual([
      'mio',
      'seiya',
    ]);
    // Seats the calls leave are filled as usual.
    expect(order({ calls: ['mio'], max: 2, text: '카이야' })).toEqual(['mio', 'kai']);
  });

  it('calls back the last speaker, and the narrator ahead of everyone', () => {
    expect(order({ calls: ['kai'], lastSpeakerId: 'kai' })).toEqual(['kai']);
    expect(order({ calls: ['kai', NARRATOR_SPEAKER], max: 1 })).toEqual([NARRATOR_SPEAKER, 'kai']);
  });

  it('takes what explicitCalls reads off the text', () => {
    const text = '@카이: 한 잔 더\n@내레이터: 밤이 깊어진다';
    expect(order({ text, calls: explicitCalls(text, [seiya, kai, mio]), max: 1 })).toEqual([
      NARRATOR_SPEAKER,
      'kai',
    ]);
  });

  it('ignores a call to anyone not on the stage', () => {
    expect(order({ calls: ['ghost'], text: '미오' })).toEqual(['mio']);
  });

  it('works on the list order too', () => {
    expect(order({ order: 'list', calls: ['mio'], max: 2 })).toEqual(['mio', 'seiya']);
  });
});

describe('mentionIndex', () => {
  it('finds a Hangul name at the start of an eojeol, with any suffix', () => {
    expect(mentionIndex('세이야, 왔어?', '세이야')).toBe(0);
    expect(mentionIndex('그래서 세이는 갔어', '세이')).toBe(4);
    expect(mentionIndex('"세이야!"', '세이야')).toBe(1);
    expect(mentionIndex('아세이야', '세이야')).toBe(-1);
    expect(mentionIndex('아리아 블랑은 어디?', '아리아 블랑')).toBe(0);
  });

  it('finds a Latin name as a whole word, a particle or a possessive behind it', () => {
    expect(mentionIndex('Alice는 어디 있어?', 'alice')).toBe(0);
    expect(mentionIndex("Where is ALICE's sword?", 'Alice')).toBe(9);
    expect(mentionIndex('Alicent arrived', 'Alice')).toBe(-1);
    expect(mentionIndex('Hi AL!', 'Al')).toBe(3);
    expect(mentionIndex('Alice', 'Al')).toBe(-1);
    expect(mentionIndex('R2D2, R2!', 'R2')).toBe(6);
  });

  it('finds kana and kanji of two characters or more anywhere', () => {
    expect(mentionIndex('あのミクさん', 'ミク')).toBe(2);
    expect(mentionIndex('今日は凛子と会う', '凛子')).toBe(3);
    // One character is a whole word: 凛 is not in 凛子, but is in 凛ちゃん.
    expect(mentionIndex('凛子と会う', '凛')).toBe(-1);
    expect(mentionIndex('凛ちゃん', '凛')).toBe(0);
  });

  it('accepts an @ right before the name', () => {
    expect(mentionIndex('@세이야 안녕', '세이야')).toBe(1);
    expect(mentionIndex('hey @alice', 'Alice')).toBe(5);
  });

  it('compares composed text without case, and finds nothing for a blank name', () => {
    expect(mentionIndex('세이야'.normalize('NFD'), '세이야')).toBe(0);
    expect(mentionIndex('세이야', '세이야'.normalize('NFD'))).toBe(0);
    expect(mentionIndex('ÉLODIE!', 'élodie')).toBe(0);
    expect(mentionIndex('anything', '  ')).toBe(-1);
  });
});

describe('mentionedMembers', () => {
  it('gives the longer name a place where two names start', () => {
    const sei: GroupMember = { id: 'sei', names: ['세이'], talkativeness: 50 };
    expect(mentionedMembers('세이야 왔어', [sei, seiya])).toEqual(['seiya']);
    expect(mentionedMembers('세이야 왔어, 세이도', [sei, seiya])).toEqual(['seiya', 'sei']);
  });

  it('reads a member by every name it goes by, in roster order on a tie', () => {
    expect(mentionedMembers('세이, 왔어?', [kai, seiya])).toEqual(['seiya']);
    const twin = { ...kai, id: 'twin' };
    expect(mentionedMembers('카이', [kai, twin])).toEqual(['kai', 'twin']);
  });
});

describe('explicitCalls', () => {
  const members = [seiya, kai, mio];

  it('reads @name at the start of the text or a line, colon optional, in typed order once each', () => {
    expect(explicitCalls('@카이: 술 한 잔\n@세이 너도\n@카이: 또', members)).toEqual(['kai', 'seiya']);
    expect(explicitCalls('  @미오', members)).toEqual(['mio']);
    expect(explicitCalls('@미오：うん', members)).toEqual(['mio']);
  });

  it('calls the narrator by any of its names, without case', () => {
    expect(explicitCalls('@내레이터: 밤이 깊어진다', members)).toEqual([NARRATOR_SPEAKER]);
    expect(explicitCalls('@나레이터 계속', members)).toEqual([NARRATOR_SPEAKER]);
    expect(explicitCalls('@Narrator: go on', members)).toEqual([NARRATOR_SPEAKER]);
    expect(explicitCalls('@ナレーター：続けて', members)).toEqual([NARRATOR_SPEAKER]);
    expect(explicitCalls('@내레이터', members, [])).toEqual([]);
  });

  it('is not a bare @:, a name with a suffix, or a call in the middle of a line', () => {
    expect(explicitCalls('@: 문이 열린다', members)).toEqual([]);
    expect(explicitCalls('@ 카이', members)).toEqual([]);
    expect(explicitCalls('@세이야는 어디 있어?', members)).toEqual([]);
    expect(explicitCalls('안녕 @카이', members)).toEqual([]);
    expect(explicitCalls('', members)).toEqual([]);
  });

  it('calls the longest name that fits', () => {
    const aria: GroupMember = { id: 'aria', names: ['아리아'], talkativeness: 50 };
    const blanc: GroupMember = { id: 'blanc', names: ['아리아 블랑'], talkativeness: 50 };
    expect(explicitCalls('@아리아 블랑: 안녕', [aria, blanc])).toEqual(['blanc']);
    expect(explicitCalls('@아리아 안녕', [aria, blanc])).toEqual(['aria']);
  });

  it('reads composed text', () => {
    expect(explicitCalls('@카이: 응'.normalize('NFD'), members)).toEqual(['kai']);
  });
});

describe('stripCallMarker', () => {
  const members = [seiya, kai];

  it('takes the opening call and the space after it off', () => {
    expect(stripCallMarker('@세이야: 안녕', members)).toBe('안녕');
    expect(stripCallMarker('  @카이 술 줘', members)).toBe('술 줘');
    expect(stripCallMarker('@내레이터: 밤이 깊다', members)).toBe('밤이 깊다');
  });

  it('leaves everything else as it is', () => {
    expect(stripCallMarker('@:  문이 열린다', members)).toBe('@:  문이 열린다');
    expect(stripCallMarker('안녕 @세이야', members)).toBe('안녕 @세이야');
    expect(stripCallMarker('@세이야는?', members)).toBe('@세이야는?');
    // Only the first line's.
    expect(stripCallMarker('@세이야: 안녕\n@카이: 너도', members)).toBe('안녕\n@카이: 너도');
  });
});

describe('stripSpeakerPrefix', () => {
  it("takes the speaker's own prefixes off every line, by name or nickname", () => {
    expect(stripSpeakerPrefix('세이야: 안녕.\n\n세이야:*웃는다*\n세이: 응', ['세이야', '세이'])).toBe(
      '안녕.\n\n*웃는다*\n응',
    );
  });

  it("leaves another member's line, a line with no prefix, and a colon that is not a name", () => {
    const text = '*문을 연다*\n카이: 왔어?\n시간: 자정';
    expect(stripSpeakerPrefix(text, ['세이야'])).toBe(text);
    expect(stripSpeakerPrefix(text, [])).toBe(text);
  });
});

describe('coerceGroupSettings', () => {
  it('defaults what is missing or junk, and clamps the cap', () => {
    expect(coerceGroupSettings(null)).toEqual(DEFAULT_GROUP_SETTINGS);
    expect(coerceGroupSettings('list')).toEqual({ order: 'natural', maxSpeakers: 3 });
    expect(coerceGroupSettings({ order: 'list', maxSpeakers: 5 })).toEqual({ order: 'list', maxSpeakers: 5 });
    expect(coerceGroupSettings({ order: 'random', maxSpeakers: '5' })).toEqual({ order: 'natural', maxSpeakers: 3 });
    expect(coerceGroupSettings({ maxSpeakers: 0 }).maxSpeakers).toBe(1);
    expect(coerceGroupSettings({ maxSpeakers: 99 }).maxSpeakers).toBe(10);
    expect(coerceGroupSettings({ maxSpeakers: 2.6 }).maxSpeakers).toBe(3);
    expect(coerceGroupSettings({ maxSpeakers: Number.NaN }).maxSpeakers).toBe(3);
    // A fresh object each time: the default is not shared.
    expect(coerceGroupSettings(undefined)).not.toBe(DEFAULT_GROUP_SETTINGS);
  });
});

describe('coerceTalkativeness', () => {
  it('is 0..100, and 50 for anything that is not a number', () => {
    expect(coerceTalkativeness(null)).toBe(50);
    expect(coerceTalkativeness(undefined)).toBe(50);
    expect(coerceTalkativeness('80')).toBe(50);
    expect(coerceTalkativeness(Number.POSITIVE_INFINITY)).toBe(50);
    expect(coerceTalkativeness(0)).toBe(0);
    expect(coerceTalkativeness(73.4)).toBe(73);
    expect(coerceTalkativeness(-5)).toBe(0);
    expect(coerceTalkativeness(250)).toBe(100);
  });
});

describe('transcriptLine', () => {
  it("puts a group reply's lines under its speaker, and leaves everything else as before", () => {
    expect(transcriptLine({ role: 'assistant', content: '*잔을 든다* 건배.\n\n좋아.' }, '민준', '카이')).toBe(
      '카이: *잔을 든다* 건배.\n\n카이: 좋아.',
    );
    expect(transcriptLine({ role: 'assistant', content: '세이야: 응.\n카이: 그래.' }, '민준')).toBe(
      '세이야: 응.\n카이: 그래.',
    );
    expect(transcriptLine({ role: 'assistant', content: '@: 눈이 그쳤다.' }, '민준', '카이')).toBe(
      `${NARRATION_HEADER} 눈이 그쳤다.`,
    );
    expect(transcriptLine({ role: 'user', content: '{{img::x}}안녕' }, '민준', '카이')).toBe('민준: 안녕');
  });
});
