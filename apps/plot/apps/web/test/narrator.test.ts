/**
 * The two narrator decisions the chat surfaces make on their own: what an editor
 * hands back when a field is cleared, and whether the turn now streaming is going
 * to be a narration.
 */
import { describe, expect, it } from 'vitest';
import { streamsNarration, withNarratorField } from '../src/lib/narrator';
import type { ChatMessage, MessageRole } from '../src/lib/types';

const message = (role: MessageRole, content: string): ChatMessage => ({
  id: 'm1',
  parentId: null,
  role,
  content,
  source: 'user',
  directions: null,
  model: null,
  promptTokens: null,
  completionTokens: null,
  attachments: [],
  createdAt: '2026-08-11T00:00:00.000Z',
});

describe('withNarratorField', () => {
  it('drops a field the reader cleared, and the narrator once nothing is left', () => {
    expect(withNarratorField({ voice: '건조하게.', pov: 'third' }, { pov: undefined })).toEqual({
      voice: '건조하게.',
    });
    expect(withNarratorField({ voice: '건조하게.' }, { voice: '' })).toBeNull();
    expect(withNarratorField(null, { pov: 'first' })).toEqual({ pov: 'first' });
    expect(withNarratorField(null, { voice: '' })).toBeNull();
  });

  it('keeps a blank voice, which the reader may still be typing in front of a word', () => {
    // Trimming here would eat the space as it is typed; the server drops a voice
    // that stays blank, which is where it stops mattering.
    expect(withNarratorField(null, { voice: ' ' })).toEqual({ voice: ' ' });
  });
});

describe('streamsNarration', () => {
  it('is true for the narrate action, whatever the head is', () => {
    expect(streamsNarration('narrate', message('user', '문을 열었다'))).toBe(true);
    expect(streamsNarration('narrate', message('assistant', '아직 안 가셨군요.'))).toBe(true);
    expect(streamsNarration('narrate', undefined)).toBe(true);
  });

  it('is true when a narration head is being regenerated', () => {
    // The server reads the head the same way and asks for a narration again, so
    // the streaming bubble must not be drawn as a line of dialogue in the interim.
    expect(streamsNarration('regenerate', message('assistant', '@: 눈이 그쳤다'))).toBe(true);
  });

  it('is false for an ordinary regenerate, and for every other mode', () => {
    expect(streamsNarration('regenerate', message('assistant', '아직 안 가셨군요.'))).toBe(false);
    // A user head narration is not what is being replaced — the reply to it is.
    expect(streamsNarration('regenerate', message('user', '@: 문이 열렸다'))).toBe(false);
    expect(streamsNarration('regenerate', undefined)).toBe(false);
    for (const mode of ['send', 'continue', 'auto', null] as const) {
      expect(streamsNarration(mode, message('assistant', '@: 눈이 그쳤다'))).toBe(false);
    }
  });
});
