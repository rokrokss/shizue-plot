/**
 * The three catalogues, held to the same key set.
 *
 * Korean is where a string is written and the other two are translations of it,
 * so the only thing that can be checked mechanically is that none of them is
 * missing a line: a key that exists in one locale and not another is a screen
 * that renders its own key path at someone.
 */
import { MIGRATION_WARNING_CODES, SITE_SCHEMAS } from '@shizue/core/migrate';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import ja from '../messages/ja.json';
import ko from '../messages/ko.json';
import { COMMON_CONFIRMATIONS, MIGRATION_PLATFORMS, SPEAKER_MODES } from '../src/lib/migrate/wizard';

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

/**
 * The paste migration names its copy by data the core owns — the sites'
 * confirmation ids, the warning codes its mappers emit, the field visibilities —
 * so a code added there without a sentence here would reach the creator as a
 * bare identifier. Every one is formatted, with every detail a warning can
 * carry, so a sentence that names a value the core never sends fails too.
 */
describe('the paste migration copy', () => {
  const schemas = Object.values(SITE_SCHEMAS);
  const confirmations = [
    ...COMMON_CONFIRMATIONS.map((item) => item.id),
    ...schemas.flatMap((schema) => schema!.confirmations.map((item) => item.id)),
  ];
  const visibilities = [
    ...new Set(schemas.flatMap((schema) => schema!.sections.flatMap((s) => s.fields.map((f) => f.visibility)))),
  ];
  const detail = { limit: 500, length: 900, count: 3, name: 'Guest', violation: 'timer' };

  for (const [locale, messages] of Object.entries({ ko, en, ja })) {
    it(`has a sentence for every code and id in ${locale}`, () => {
      // Keys built from core data, so the catalogue's own key types cannot vouch for them.
      const t = createTranslator({
        locale,
        messages,
        namespace: 'migrate',
        onError: (error) => {
          throw error;
        },
      }) as unknown as (key: string, values?: Record<string, string | number>) => string;
      for (const id of confirmations) expect(t(`confirm.${id}`)).not.toMatch(/[{}]|^migrate\./);
      for (const code of MIGRATION_WARNING_CODES) {
        expect(t(`warnings.${code}`, detail), code).not.toMatch(/^migrate\./);
      }
      for (const platform of MIGRATION_PLATFORMS) {
        t(`platforms.${platform}`);
        t(`platformHints.${platform}`);
        t(`confirmStep.sourceUrlPlaceholder.${platform}`);
      }
      for (const visibility of visibilities) t(`form.visibility.${visibility}`);
      for (const mode of SPEAKER_MODES) t(`preview.speakerModes.${mode}`);
    });
  }
});
