/**
 * What a narrator editor hands back when a field is cleared.
 */
import { describe, expect, it } from 'vitest';
import { withNarratorField } from '../src/lib/narrator';
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
