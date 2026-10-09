/**
 * The three catalogues, held to the same key set.
 *
 * Korean is where a string is written and the other two are translations of it,
 * so the only thing that can be checked mechanically is that none of them is
 * missing a line: a key that exists in one locale and not another is a screen
 * that renders its own key path at someone.
 */
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import ja from '../messages/ja.json';
import ko from '../messages/ko.json';

/** Every leaf, by its dotted path. */
function keys(catalogue: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(catalogue).flatMap(([key, value]) =>
    value !== null && typeof value === 'object'
      ? keys(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe('the message catalogues', () => {
  it('name the same strings in every locale', () => {
    const source = keys(ko).sort();
    expect(keys(en).sort()).toEqual(source);
    expect(keys(ja).sort()).toEqual(source);
  });
});
