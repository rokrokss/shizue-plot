import { describe, expect, it } from 'vitest';
import { detectContentLanguage } from '../src/language.js';

describe('detectContentLanguage', () => {
  it('reads clear Korean, Japanese and English text', () => {
    expect(detectContentLanguage('아직 안 가셨군요. 폐관 시간이 지났어요.')).toBe('ko');
    expect(detectContentLanguage('まだ帰っていなかったのですね。閉館時間はもう過ぎました。')).toBe('ja');
    expect(detectContentLanguage("You're still here? The library closed an hour ago.")).toBe('en');
  });

  it('keeps Korean prose Korean through English names, macros and markup', () => {
    expect(
      detectContentLanguage(
        '<div style="color: #333; font-family: serif"><img src="Greta">{{#when::fm_route::vis::6}}' +
          '{{char}}는 Library of Alexandria에서 일하는 사서다.{{/when}}</div>',
      ),
    ).toBe('ko');
    // A status block keyed in English is still a Korean opening.
    expect(detectContentLanguage('HP: 100 / MP: 50 / Location: 도서관')).toBe('ko');
  });

  it('keeps Japanese prose Japanese through kanji and English words', () => {
    expect(detectContentLanguage('東京のCafeで{{user}}を待ってる。')).toBe('ja');
  });

  it('reads English with a Korean word in it as English', () => {
    expect(detectContentLanguage('Rian meets 리안 at the library every night.')).toBe('en');
  });

  it('says nothing when there is nothing to tell by', () => {
    expect(detectContentLanguage('')).toBeUndefined();
    expect(detectContentLanguage('{{user}} <br> ... 123 !!')).toBeUndefined();
    // Han alone is Chinese as readily as Japanese, and Chinese is no content language.
    expect(detectContentLanguage('我们在东京站见面')).toBeUndefined();
    // As much Hangul as kana.
    expect(detectContentLanguage('안녕 こん')).toBeUndefined();
  });
});
