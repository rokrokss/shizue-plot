import { assetResolver } from '@shizue/core/cbs';
import { describe, expect, it } from 'vitest';
import { renderImageTokens } from '../src/lib/assets';
import { awaitingEmotion, emotionResolver, emotionSlots, withEmotions } from '../src/lib/emotion';
import type { ChatMessage, PublicMember } from '../src/lib/types';

const sei: PublicMember = {
  id: 'sei',
  name: '세이',
  avatarUrl: null,
  emotion: {
    mode: 'panel',
    images: [
      { name: 'neutral', slug: 'neutral' },
      { name: 'happy', slug: 'happy' },
    ],
  },
};
const kai: PublicMember = {
  id: 'kai',
  name: '카이',
  avatarUrl: null,
  emotion: {
    mode: 'panel',
    images: [
      { name: 'neutral', slug: 'neutral-2' },
      { name: 'happy', slug: 'happy-2' },
    ],
  },
};

let at = 0;
const message = (role: 'user' | 'assistant', extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${(at += 1)}`,
  parentId: null,
  role,
  content: '…',
  source: 'user',
  directions: null,
  model: null,
  promptTokens: null,
  completionTokens: null,
  attachments: [],
  createdAt: '2026-10-14T00:00:00.000Z',
  ...extra,
});

const assets = new Map([
  ['neutral', '/n.png'],
  ['happy', '/h.png'],
  ['neutral-2', '/n2.png'],
  ['happy-2', '/h2.png'],
]);

describe('emotionSlots', () => {
  it("shows RisuAI's neutral before any choice, then the newest reply's", () => {
    const greeting = message('assistant');
    expect(emotionSlots([greeting], [sei], assets)).toEqual([
      { memberId: 'sei', name: '세이', emotion: 'neutral', src: '/n.png' },
    ]);
    const path = [greeting, message('user'), message('assistant', { emotion: 'happy' }), message('user'), message('assistant')];
    // A reply still waiting for its picture leaves the last one up.
    expect(emotionSlots(path, [sei], assets)[0]!.src).toBe('/h.png');
  });

  it('shows nothing without a neutral, nor for a picture the chat has not opened', () => {
    const plain = { ...sei, emotion: { mode: 'panel' as const, images: [{ name: 'happy', slug: 'happy' }] } };
    expect(emotionSlots([], [plain], assets)[0]).toMatchObject({ emotion: null, src: null });
    const locked = new Map([['happy', '/h.png']]);
    expect(emotionSlots([message('assistant', { emotion: 'neutral' })], [sei], locked)[0]).toMatchObject({
      emotion: 'neutral',
      src: null,
    });
  });

  it("gives each member of a group its own speaker's pictures, and skips the inlay ones", () => {
    const path = [
      message('user'),
      message('assistant', { speakerMemberId: 'sei', emotion: 'happy' }),
      message('assistant', { speakerMemberId: 'kai', emotion: 'neutral' }),
    ];
    expect(emotionSlots(path, [sei, kai], assets).map((slot) => slot.src)).toEqual(['/h.png', '/n2.png']);
    const inlay = { ...kai, emotion: { ...kai.emotion!, mode: 'inlay' as const } };
    expect(emotionSlots(path, [sei, inlay], assets).map((slot) => slot.memberId)).toEqual(['sei']);
    expect(emotionSlots(path, [{ ...sei, emotion: null }], assets)).toEqual([]);
  });
});

describe('awaitingEmotion', () => {
  it('waits only on fresh, finished replies of panel members', () => {
    const done = message('assistant');
    const pending = message('assistant', { scriptState: 'pending' });
    const chosen = message('assistant', { emotion: 'happy' });
    const narration = message('assistant', { speakerMemberId: null });
    const fresh = new Set([done.id, pending.id, chosen.id, narration.id]);
    expect(awaitingEmotion([done, pending, chosen], [sei], fresh)).toEqual([done.id]);
    // In a group only a speaker's reply is anyone's.
    expect(awaitingEmotion([narration], [sei, kai], fresh)).toEqual([]);
    expect(awaitingEmotion([done], [sei], new Set())).toEqual([]);
    // Nor a narration in a work of one.
    const told = message('assistant', { content: '@: 비가 온다.' });
    expect(awaitingEmotion([told], [sei], new Set([told.id]))).toEqual([]);
  });

  it('lays the chosen pictures onto the branch', () => {
    const reply = message('assistant');
    const state = { path: [message('user'), reply] };
    expect(withEmotions(state, new Map([[reply.id, 'happy']])).path[1]!.emotion).toBe('happy');
    expect(withEmotions(state, new Map([['other', 'happy']]))).toBe(state);
  });
});

describe('emotionResolver', () => {
  it("draws a member's {{emotion::…}} from its own pictures first", () => {
    const plotAssets = [
      { slug: 'neutral', name: 'neutral' },
      { slug: 'happy', name: 'happy' },
      { slug: 'neutral-2', name: 'neutral' },
      { slug: 'happy-2', name: 'happy' },
    ];
    const resolve = emotionResolver(kai.emotion!.images, assetResolver(plotAssets));
    expect(renderImageTokens('{{emotion::Happy}}', assets, resolve)).toBe('![happy-2](/h2.png)');
    // Other macros, and names the member has no picture for, as the plot reads them.
    expect(renderImageTokens('{{img::happy}}', assets, resolve)).toBe('![happy](/h.png)');
    expect(renderImageTokens('{{emotion::neutral-2}}', assets, resolve)).toBe('![neutral-2](/n2.png)');
  });
});
