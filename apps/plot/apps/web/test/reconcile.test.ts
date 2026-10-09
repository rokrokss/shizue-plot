/**
 * A rejected send only proves no stream was read — the POST may still have been
 * accepted. These cases pin down when the typed prompt may be handed back.
 */
import { describe, expect, it } from 'vitest';
import { reconcileSend } from '../src/lib/reconcile';
import type { ChatMessage, ChatState } from '../src/lib/types';

const message = (id: string, role: ChatMessage['role'], parentId: string | null): ChatMessage => ({
  id,
  parentId,
  role,
  content: `${role}:${id}`,
  source: 'user',
  directions: null,
  model: role === 'assistant' ? 'echo/echo' : null,
  promptTokens: null,
  completionTokens: null,
  attachments: [],
  createdAt: '2026-08-05T00:00:00.000Z',
});

const state = (head: string | null, path: ChatMessage[]): ChatState => ({
  chat: {
    id: 'chat-1',
    plotId: 'plot-1',
    personaId: null,
    title: '리안',
    model: 'echo/echo',
    note: '',
    preset: 'standard',
    headMessageId: head,
    memory: null,
    memorySettings: null,
    relationship: null,
    relationshipEnabled: true,
    narrator: null,
    allowComponentTurns: false,
    statusWindowEnabled: true,
    choicesEnabled: true,
    reasoningEffort: null,
    absentCharacterIds: [],
    noteIds: [],
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
  },
  path,
  siblings: Object.fromEntries(path.map((item) => [item.id, { index: 0, total: 1, ids: [item.id] }])),
});

const greeting = message('greeting', 'assistant', null);

describe('reconcileSend', () => {
  it('reports the turn as not delivered when the head did not move', () => {
    expect(reconcileSend('greeting', state('greeting', [greeting]))).toEqual({ kind: 'notDelivered' });
  });

  it('offers regenerate when the turn landed but was never answered', () => {
    const user = message('user-1', 'user', 'greeting');
    expect(reconcileSend('greeting', state('user-1', [greeting, user]))).toEqual({
      kind: 'delivered',
      retry: true,
    });
  });

  it('keeps the composer empty without offering regenerate when a reply already landed', () => {
    const user = message('user-1', 'user', 'greeting');
    const reply = message('reply-1', 'assistant', 'user-1');
    expect(reconcileSend('greeting', state('reply-1', [greeting, user, reply]))).toEqual({
      kind: 'delivered',
      retry: false,
    });
  });

  it('treats a failed reconcile refetch as unknown so the text is kept', () => {
    expect(reconcileSend('greeting', null)).toEqual({ kind: 'unknown' });
  });

  it('handles a chat that had no messages before the send', () => {
    expect(reconcileSend(null, state(null, []))).toEqual({ kind: 'notDelivered' });

    const user = message('user-1', 'user', null);
    expect(reconcileSend(null, state('user-1', [user]))).toEqual({ kind: 'delivered', retry: true });
  });
});
