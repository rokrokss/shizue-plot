import { describe, expect, it } from 'vitest';
import { exportCardV3 } from '../src/card/export.js';
import { normalizeCard } from '../src/card/normalize.js';
import type { DisplayScript } from '../src/types.js';

/** A V2 card the way RisuAI exports one, with a status-window display script. */
const risuCard = (customScripts: unknown[], defaultVariables?: unknown) => ({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '루미',
    description: '상태창을 쓰는 캐릭터.',
    personality: '',
    scenario: '',
    first_mes: '[status] hp=100',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '1.0',
    extensions: {
      risuai: {
        emotions: [],
        customScripts,
        ...(defaultVariables === undefined ? {} : { defaultVariables }),
      },
    },
  },
});

const editdisplay = (overrides: Record<string, unknown> = {}) => ({
  comment: '상태창',
  in: '\\[status\\] hp=(\\d+)',
  out: '<div class="hp">HP $1</div>',
  type: 'editdisplay',
  ableFlag: false,
  flag: '',
  ...overrides,
});

/** How a real RisuAI export writes a status-window script: flags and directives together. */
const realWorldScript = {
  comment: '상태창',
  in: '\\[status\\] hp=(\\d+)',
  out: '<div class="hp">HP $1</div>',
  type: 'editdisplay',
  ableFlag: true,
  flag: 'gi<move_top><order 3>',
};

describe('RisuAI customScripts import', () => {
  it('maps editdisplay entries onto display scripts', () => {
    const card = normalizeCard(risuCard([editdisplay()]));
    expect(card.displayScripts).toEqual([
      { in: '\\[status\\] hp=(\\d+)', out: '<div class="hp">HP $1</div>', order: 0, enabled: true },
    ]);
  });

  it('ignores every other script type but keeps it in extensions', () => {
    const other = { comment: '', in: 'a', out: 'b', type: 'editinput' };
    const card = normalizeCard(risuCard([other, editdisplay()]));
    expect(card.displayScripts).toHaveLength(1);
    expect(
      (card.extensions['risuai'] as { customScripts: unknown[] }).customScripts,
    ).toEqual([other, editdisplay()]);
  });

  it('reads flags and directives out of one combined flag field', () => {
    // The shape a real card carries. Requiring the whole field to be flag letters
    // dropped both the `i` and the action, so imported scripts silently became
    // case-sensitive and rendered in place.
    const card = normalizeCard(risuCard([realWorldScript]));
    expect(card.displayScripts?.[0]).toEqual({
      in: '\\[status\\] hp=(\\d+)',
      out: '<div class="hp">HP $1</div>',
      flags: 'gi',
      order: 3,
      action: 'move_top',
      enabled: true,
    });
  });

  it('ignores a directive it does not know rather than reading it as flags', () => {
    const card = normalizeCard(risuCard([editdisplay({ ableFlag: true, flag: 'g<cbs><repeat_back>' })]));
    // `cbs` contributes no flag letters — `c`, `b` and `s` are not flags here.
    expect(card.displayScripts?.[0]).toMatchObject({ flags: 'g', action: 'repeat_back' });
  });

  it('honours ableFlag: without it the letters are not flags', () => {
    const card = normalizeCard(risuCard([editdisplay({ ableFlag: false, flag: 'gi<move_top>' })]));
    expect(card.displayScripts?.[0]?.flags).toBeUndefined();
    // The directive is read either way — it is not a flag.
    expect(card.displayScripts?.[0]?.action).toBe('move_top');
  });

  it('imports a pattern that could hang a reader switched off rather than armed', () => {
    const card = normalizeCard(risuCard([editdisplay({ in: '^(a+)+$' })]));
    expect(card.displayScripts?.[0]).toMatchObject({ in: '^(a+)+$', enabled: false });
  });

  it('still reads the @@ directives older cards put in out', () => {
    const card = normalizeCard(
      risuCard([editdisplay({ out: '@@move_top\n<order 3>\n<div>HP $1</div>' })]),
    );
    expect(card.displayScripts?.[0]).toEqual({
      in: '\\[status\\] hp=(\\d+)',
      out: '<div>HP $1</div>',
      order: 3,
      action: 'move_top',
      enabled: true,
    });
  });



  it('unescapes the newlines RisuAI stores in a template', () => {
    const card = normalizeCard(risuCard([editdisplay({ out: '<div>\\n$1\\n</div>' })]));
    expect(card.displayScripts?.[0]?.out).toBe('<div>\n$1\n</div>');
  });

  it('leaves the field absent when the card has no display scripts', () => {
    const card = normalizeCard(risuCard([]));
    expect(card.displayScripts).toBeUndefined();
    expect(card.defaultVariables).toBeUndefined();
  });

  it('imports defaultVariables from the key=value block', () => {
    const card = normalizeCard(risuCard([], 'hp=100\nmood=평온'));
    expect(card.defaultVariables).toEqual({ hp: '100', mood: '평온' });
  });
});

describe('card export', () => {
  it('writes RisuAI schema back: bare source, bare template, flags and directives in flag', () => {
    const other = { comment: '', in: 'a', out: 'b', type: 'edittrigger' };
    const card = normalizeCard(risuCard([other, realWorldScript]));
    const scripts = (
      exportCardV3(card).data.extensions as { risuai: { customScripts: Record<string, unknown>[] } }
    ).risuai.customScripts;

    expect(scripts[0]).toEqual(other);
    expect(scripts[1]).toEqual({
      comment: '',
      type: 'editdisplay',
      in: '\\[status\\] hp=(\\d+)',
      out: '<div class="hp">HP $1</div>',
      ableFlag: true,
      flag: 'gi<move_top><order 3>',
    });
  });

  it('round-trips a real-world script through export and import unchanged', () => {
    const card = normalizeCard(risuCard([realWorldScript], 'hp=100'));
    const exported = exportCardV3(card);
    const reimported = normalizeCard(exported);

    expect(reimported.displayScripts).toEqual(card.displayScripts);
    expect(reimported.defaultVariables).toEqual({ hp: '100' });
    // And again, so a card that has been through the editor twice still matches.
    expect(normalizeCard(exportCardV3(reimported)).displayScripts).toEqual(card.displayScripts);
  });

  it('round-trips a script written the older @@ way into the newer flag form', () => {
    const card = normalizeCard(risuCard([editdisplay({ out: '@@repeat_back\n<order 2>\n<b>$1</b>' })]));
    expect(normalizeCard(exportCardV3(card)).displayScripts).toEqual(card.displayScripts);
  });

  it('drops disabled scripts, which render nothing anyway', () => {
    const card = normalizeCard(risuCard([editdisplay()]));
    const disabled: DisplayScript[] = (card.displayScripts ?? []).map((script) => ({
      ...script,
      enabled: false,
    }));
    const extensions = exportCardV3({ ...card, displayScripts: disabled }).data.extensions as {
      risuai: Record<string, unknown>;
    };
    expect(extensions.risuai['customScripts']).toBeUndefined();
  });

  it('leaves a card that never used the feature without a risuai block', () => {
    const card = normalizeCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '무',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {},
      },
    });
    expect(exportCardV3(card).data.extensions).toEqual({});
  });
});
