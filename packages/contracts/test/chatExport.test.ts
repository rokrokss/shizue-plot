import { describe, expect, it } from 'vitest';
import { ChatExportSchema } from '../src/chatExport.js';
import type { ChatExport } from '../src/chatExport.js';

const bundle: ChatExport = {
  version: 1,
  chat: {
    id: 'cht_01HZX',
    plotId: 'sty_9f2',
    plotName: '서리 골짜기의 밤',
    exportedAt: '2026-08-06T12:00:00.000Z',
  },
  messages: [
    { id: 'msg_1', role: 'user', text: '문을 연다', createdAt: '2026-08-06T11:58:00.000Z' },
    {
      id: 'msg_2',
      role: 'assistant',
      text: '문이 삐걱이며 열린다.',
      createdAt: '2026-08-06T11:58:04.000Z',
    },
    {
      id: 'msg_3',
      role: 'user',
      text: '주사위: 17',
      createdAt: '2026-08-06T11:59:00.000Z',
      source: 'component',
    },
  ],
  assets: [{ slug: 'door', url: '/api/assets/sty_9f2/door.png', mime: 'image/png' }],
  characters: [
    { id: 'chr_1', name: '세라', avatarUrl: '/api/assets/chr_1/avatar.png' },
    { id: 'chr_2', name: '민수', avatarUrl: null },
  ],
  coverUrl: '/api/plots/sty_9f2/cover.png',
  variableTimeline: [{ messageId: 'msg_2', variables: { hp: '40', gold: '12' } }],
};

describe('ChatExportSchema', () => {
  it('parses a realistic export bundle', () => {
    const parsed = ChatExportSchema.parse(bundle);
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[2]?.source).toBe('component');
    expect(parsed.variableTimeline[0]?.variables.hp).toBe('40');
    expect(parsed.chat.plotName).toBe('서리 골짜기의 밤');
    expect(parsed.characters.map((character) => character.name)).toEqual(['세라', '민수']);
  });

  it('accepts a null cover and an empty timeline', () => {
    expect(
      ChatExportSchema.parse({ ...bundle, coverUrl: null, variableTimeline: [] }).coverUrl,
    ).toBeNull();
  });

  // Revocation: the creator's contributions drop, the conversation still exports.
  it('accepts a withdrawn plot — no roster, no assets, the messages intact', () => {
    const withdrawn = ChatExportSchema.parse({
      ...bundle,
      characters: [],
      assets: [],
      coverUrl: null,
    });
    expect(withdrawn.characters).toEqual([]);
    expect(withdrawn.messages).toHaveLength(3);
  });

  it('rejects a message role outside user/assistant', () => {
    expect(
      ChatExportSchema.safeParse({
        ...bundle,
        messages: [{ id: 'msg_1', role: 'system', text: '...', createdAt: '2026-08-06T11:58:00.000Z' }],
      }).success,
    ).toBe(false);
  });

  it('rejects another format version and a missing coverUrl', () => {
    expect(ChatExportSchema.safeParse({ ...bundle, version: 2 }).success).toBe(false);
    const { coverUrl: _coverUrl, ...withoutCover } = bundle;
    expect(ChatExportSchema.safeParse(withoutCover).success).toBe(false);
  });
});
