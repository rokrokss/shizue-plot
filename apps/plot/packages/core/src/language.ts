import type { MacroLocale } from './macro.js';

/**
 * How many Latin letters one Hangul syllable, kana or Han character is weighed
 * against: each of those is a syllable, where a Latin word spends a few letters
 * on one.
 */
const SYLLABLE_WEIGHT = 2;

/**
 * The share of the weighed letters Latin needs for `en`. Set high on purpose:
 * Korean and Japanese writing carries Latin names and terms all the time, while
 * English writing almost never carries Hangul or kana — so a little Hangul says
 * more than a lot of Latin does.
 */
const ENGLISH_SHARE = 0.8;

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

/**
 * What a card's text is written in, from the letters it is made of: `en` when
 * Latin carries it by a wide margin, else `ko` or `ja` by whichever of Hangul and
 * kana there is more of. Undefined when it cannot tell — no letters at all, Han
 * alone (Chinese is not a content language), or as much Hangul as kana.
 *
 * Macros, tags and style sheets are taken out first: a card's opening is often
 * wrapped in `<div style=…>` and `{{#when::…}}`, and every letter of those is
 * Latin whatever the prose is written in.
 */
export function detectContentLanguage(text: string): MacroLocale | undefined {
  let prose = text.replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ');
  // Innermost first, so a macro nested in another one's arguments goes too.
  for (let previous = ''; previous !== prose; ) {
    previous = prose;
    prose = prose.replace(/\{\{[^{}]*\}\}/g, ' ');
  }

  const latin = count(prose, /\p{Script=Latin}/gu);
  const hangul = count(prose, /\p{Script=Hangul}/gu);
  const kana = count(prose, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const han = count(prose, /\p{Script=Han}/gu);

  const weighed = latin + SYLLABLE_WEIGHT * (hangul + kana + han);
  if (weighed === 0) return undefined;
  if (latin >= ENGLISH_SHARE * weighed) return 'en';
  if (hangul > kana) return 'ko';
  if (kana > hangul) return 'ja';
  return undefined;
}
