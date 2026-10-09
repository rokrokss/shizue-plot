/**
 * The composer's `*` button.
 *
 * Written against a notation for the field rather than three numbers: `[` and `]`
 * mark the selection, `|` the caret, so a case reads as what the reader sees
 * before the press and what they see after it.
 */
import { describe, expect, it } from 'vitest';
import { toggleDirectionMarkup } from '../src/lib/directionMarkup';

/** `문을 [열었다]` → the field text and the selection it carries. */
function parse(marked: string): { value: string; selStart: number; selEnd: number } {
  const caret = marked.indexOf('|');
  if (caret >= 0) {
    const value = marked.replace('|', '');
    return { value, selStart: caret, selEnd: caret };
  }
  const start = marked.indexOf('[');
  const end = marked.indexOf(']') - 1;
  return { value: marked.replace('[', '').replace(']', ''), selStart: start, selEnd: end };
}

/** The inverse, so an expectation is one string. */
function format(result: { value: string; selStart: number; selEnd: number }): string {
  const { value, selStart, selEnd } = result;
  if (selStart === selEnd) return `${value.slice(0, selStart)}|${value.slice(selStart)}`;
  return `${value.slice(0, selStart)}[${value.slice(selStart, selEnd)}]${value.slice(selEnd)}`;
}

const press = (marked: string): string => {
  const { value, selStart, selEnd } = parse(marked);
  return format(toggleDirectionMarkup(value, selStart, selEnd));
};

describe('with a selection', () => {
  it('wraps it and keeps it selected inside the marks', () => {
    expect(press('그가 [문을 열었다] 그리고')).toBe('그가 *[문을 열었다]* 그리고');
  });

  it('wraps a selection that spans lines as one direction', () => {
    expect(press('[문을 열었다\n바람이 들이쳤다]')).toBe('*[문을 열었다\n바람이 들이쳤다]*');
  });

  it('takes the marks off when they are inside the selection', () => {
    expect(press('그가 [*문을 열었다*] 그리고')).toBe('그가 [문을 열었다] 그리고');
  });

  it('takes the marks off when they sit just outside the selection', () => {
    expect(press('그가 *[문을 열었다]* 그리고')).toBe('그가 [문을 열었다] 그리고');
  });

  it('wraps a selection that only touches a mark on one side', () => {
    expect(press('*[문을 열었다] 그리고')).toBe('**[문을 열었다]* 그리고');
  });
});

describe('with no selection', () => {
  it('opens an empty pair and puts the caret between the marks', () => {
    expect(press('그가 |그리고')).toBe('그가 *|*그리고');
  });

  it('closes the pair it just opened when pressed again', () => {
    expect(press('그가 *|*그리고')).toBe('그가 |그리고');
  });

  it('opens a pair at the very start of an empty field', () => {
    expect(press('|')).toBe('*|*');
  });

  it('only closes a pair the caret is centred in, not one it is beside', () => {
    expect(press('|**')).toBe('*|***');
  });
});
