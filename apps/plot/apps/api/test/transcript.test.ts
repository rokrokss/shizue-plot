import { describe, expect, it } from 'vitest';
import { NARRATION_HEADER } from '@shizue/core';
import { transcriptLine } from '../src/transcript.js';

describe('transcriptLine', () => {
  it('names the reader and leaves an assistant turn to name itself', () => {
    expect(transcriptLine({ role: 'user', content: '누구세요?' }, '민준')).toBe('민준: 누구세요?');
    // The script protocol already wrote the speaker into the line, and one turn
    // may hold several of them, so nothing is prefixed here.
    expect(
      transcriptLine({ role: 'assistant', content: '아리아: 나야.\n세라: *문을 닫는다*' }, '민준'),
    ).toBe('아리아: 나야.\n세라: *문을 닫는다*');
  });

  it('carries a narrating turn speaker-less under the narration header', () => {
    expect(transcriptLine({ role: 'user', content: '@: 문이 열리고 바람이 들이쳤다.' }, '민준')).toBe(
      `${NARRATION_HEADER} 문이 열리고 바람이 들이쳤다.`,
    );
  });

  it('reads the role off the content, so a generated narration is speaker-less too', () => {
    expect(transcriptLine({ role: 'assistant', content: '@: 눈이 그쳤다.' }, '민준')).toBe(
      `${NARRATION_HEADER} 눈이 그쳤다.`,
    );
  });

  it('still strips image macros from narration bodies', () => {
    expect(transcriptLine({ role: 'user', content: '@: {{img::map}} 지도가 펼쳐진다.' }, '민준')).toBe(
      `${NARRATION_HEADER} 지도가 펼쳐진다.`,
    );
  });
});
