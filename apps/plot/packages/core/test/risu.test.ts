import { describe, expect, it } from 'vitest';
import { exportCardV3 } from '../src/card/export.js';
import { normalizeCard } from '../src/card/normalize.js';
import { cardLicense, creatorCssFromExtensions, MAX_CREATOR_CSS_LENGTH } from '../src/card/risu.js';
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
      // The `g` is RisuAI's to take back: a moved script lifts its first match only.
      flags: 'i',
      // Its place in the run, not RisuAI's number: alone, it runs first.
      order: 0,
      action: 'move_top',
      enabled: true,
    });
  });

  it('ignores a directive it does not know rather than reading it as flags', () => {
    const card = normalizeCard(risuCard([editdisplay({ ableFlag: true, flag: 'g<cbs><repeat_back>' })]));
    // `cbs` contributes no flag letters — `c`, `b` and `s` are not flags here.
    expect(card.displayScripts?.[0]).toMatchObject({ flags: 'g', action: 'repeat_back' });
  });

  it('reads several directives in one pair of brackets, as RisuAI splits them', () => {
    // Read as one unknown directive, `<move_top, order 3>` leaked its letters into
    // the flags — `m`, `v` and `d` — and the script rendered in place.
    const card = normalizeCard(
      risuCard([editdisplay({ ableFlag: true, flag: 'gi<move_top, order 3>' })]),
    );
    expect(card.displayScripts?.[0]).toMatchObject({ flags: 'i', action: 'move_top' });
  });

  it('reads a directive exactly as written, as RisuAI does', () => {
    const card = normalizeCard(risuCard([editdisplay({ ableFlag: true, flag: 'g<Move_Top>' })]));
    expect(card.displayScripts?.[0]?.action).toBeUndefined();
    expect(card.displayScripts?.[0]?.flags).toBe('g');
  });

  it('keeps the move when a script names a move and repeat_back, top before bottom', () => {
    const card = normalizeCard(
      risuCard([editdisplay({ ableFlag: true, flag: '<repeat_back, move_bottom><move_top>' })]),
    );
    expect(card.displayScripts?.[0]?.action).toBe('move_top');
  });

  it('honours ableFlag: without it nothing in the flag field is read', () => {
    const card = normalizeCard(risuCard([editdisplay({ ableFlag: false, flag: 'gi<move_top>' })]));
    expect(card.displayScripts?.[0]?.flags).toBeUndefined();
    // RisuAI parses the directives only when ableFlag is on, so this script
    // rendered in place for the creator who wrote it.
    expect(card.displayScripts?.[0]?.action).toBeUndefined();
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
      // ableFlag is off, but the move still takes the `g` away, and nothing left is `u`.
      flags: 'u',
      order: 0,
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

describe('RisuAI flags', () => {
  /** The flags a script is stored with: what RisuAI compiles its pattern with. */
  const flagsOf = (overrides: Record<string, unknown>) =>
    normalizeCard(risuCard([editdisplay(overrides)])).displayScripts?.[0]?.flags;

  it('stores nothing for the plain g RisuAI falls back to, which is ours too', () => {
    expect(flagsOf({ ableFlag: false, flag: 'i' })).toBeUndefined();
    expect(flagsOf({ ableFlag: true, flag: '' })).toBeUndefined();
    expect(flagsOf({ ableFlag: true, flag: '<order 2>' })).toBeUndefined();
    expect(flagsOf({ ableFlag: true, flag: '<repeat_back>' })).toBeUndefined();
  });

  it('keeps a field as written, so one without g rewrites its first match only', () => {
    expect(flagsOf({ ableFlag: true, flag: 'i' })).toBe('i');
    expect(flagsOf({ ableFlag: true, flag: 'gi' })).toBe('gi');
    expect(flagsOf({ ableFlag: true, flag: 'ggi' })).toBe('gi');
  });

  it('takes the g off a move, with ableFlag on or off', () => {
    expect(flagsOf({ ableFlag: true, flag: 'gi<move_top>' })).toBe('i');
    expect(flagsOf({ ableFlag: true, flag: 'g<move_bottom>' })).toBe('u');
    expect(flagsOf({ ableFlag: true, flag: '<move_bottom>' })).toBe('u');
    expect(flagsOf({ ableFlag: false, flag: 'g', out: '@@move_bottom <b>$1</b>' })).toBe('u');
  });

  it('compiles a field with no flag letters left in it under u, as RisuAI does', () => {
    expect(flagsOf({ ableFlag: true, flag: 'x' })).toBe('u');
    expect(flagsOf({ ableFlag: true, flag: ' <cbs>' })).toBe('u');
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
      flag: 'i<move_top>',
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

describe('RisuAI script order', () => {
  /** A script whose pattern is its name, so a sequence reads as a list of names. */
  const named = (name: string, flag = '', ableFlag = true) =>
    editdisplay({ in: name, out: `<b>${name}</b>`, ableFlag, flag });
  const placed = (scripts: DisplayScript[] | undefined) =>
    scripts?.map(({ in: source, order }) => [source, order]);

  it('keeps a list without order directives as it stands', () => {
    const card = normalizeCard(risuCard([named('a'), named('b', 'g'), named('c')]));
    expect(placed(card.displayScripts)).toEqual([['a', 0], ['b', 1], ['c', 2]]);
  });

  it('runs the highest order first once any script has one, the rest counting as 0', () => {
    // RisuAI sorts `b.order - a.order`, stably: the two 2s keep their places, and
    // so do the two scripts without a number. Ours runs the lowest first, so the
    // scripts are numbered down RisuAI's sequence rather than given its numbers.
    const card = normalizeCard(
      risuCard([
        named('a'),
        named('b', '<order 2>'),
        named('c', 'g<order -1>'),
        named('d', '<order 2>'),
        named('e'),
      ]),
    );
    expect(placed(card.displayScripts)).toEqual([['b', 0], ['d', 1], ['a', 2], ['e', 3], ['c', 4]]);
    expect(card.displayScripts?.[4]?.flags).toBe('g');
  });

  it('reads an order written beside an action in one pair of brackets', () => {
    const card = normalizeCard(risuCard([named('a'), named('b', 'g<move_top, order 3>')]));
    expect(placed(card.displayScripts)).toEqual([['b', 0], ['a', 1]]);
    expect(card.displayScripts?.[0]).toMatchObject({ action: 'move_top', flags: 'u' });
  });

  it('lets the last order a script names win, as RisuAI does', () => {
    const card = normalizeCard(
      risuCard([named('a', '<order 1>'), named('b', '<order 9, order 0>'), named('c', '<order 0><order 5>')]),
    );
    expect(placed(card.displayScripts)).toEqual([['c', 0], ['a', 1], ['b', 2]]);
  });

  it('reads no order RisuAI would not: with ableFlag off, or written into out', () => {
    const card = normalizeCard(
      risuCard([
        named('a', '<order 5>', false),
        editdisplay({ in: 'b', out: '<order 9>\n<b>b</b>' }),
        named('c', '<order 1>'),
      ]),
    );
    expect(placed(card.displayScripts)).toEqual([['c', 0], ['a', 1], ['b', 2]]);
    expect(card.displayScripts?.[2]?.out).toBe('<b>b</b>');
  });

  it('exports the scripts in the sequence they run here, without an order directive', () => {
    const scripts: DisplayScript[] = [
      { in: 'x', out: 'X', order: 5, enabled: true },
      { in: 'y', out: 'Y', order: 2, enabled: true },
      // A tie with `x` runs after it, here and in the export.
      { in: 'z', out: 'Z', order: 5, enabled: true },
    ];
    const exported = exportCardV3({ ...normalizeCard(risuCard([])), displayScripts: scripts });
    const written = (
      exported.data.extensions as { risuai: { customScripts: Record<string, unknown>[] } }
    ).risuai.customScripts;

    // With no directive on the list RisuAI runs it as it stands: y, x, z.
    expect(written.map((script) => [script['in'], script['flag']])).toEqual([
      ['y', ''],
      ['x', ''],
      ['z', ''],
    ]);
    expect(placed(normalizeCard(exported).displayScripts)).toEqual([['y', 0], ['x', 1], ['z', 2]]);
  });

  it('round-trips an ordered RisuAI card in the sequence RisuAI runs it', () => {
    const card = normalizeCard(
      risuCard([named('a'), named('b', '<order 2>'), named('c', 'g<order -1>')]),
    );
    expect(placed(card.displayScripts)).toEqual([['b', 0], ['a', 1], ['c', 2]]);
    const reimported = normalizeCard(exportCardV3(card));
    expect(reimported.displayScripts).toEqual(card.displayScripts);
    expect(normalizeCard(exportCardV3(reimported)).displayScripts).toEqual(card.displayScripts);
  });
});

describe('card license', () => {
  const licensed = (license: unknown) => {
    const card = risuCard([]);
    (card.data.extensions.risuai as Record<string, unknown>)['license'] = license;
    return normalizeCard(card);
  };

  it('reads the license RisuRealm writes, through normalization', () => {
    expect(cardLicense(licensed('CC BY-NC-ND 4.0').extensions)).toBe('CC BY-NC-ND 4.0');
    expect(cardLicense(licensed(' private ').extensions)).toBe('private');
  });

  it('says nothing for an empty license, a missing one, or a card without a risuai block', () => {
    expect(cardLicense(licensed('').extensions)).toBeUndefined();
    expect(cardLicense(licensed(3).extensions)).toBeUndefined();
    expect(cardLicense(normalizeCard(risuCard([])).extensions)).toBeUndefined();
    expect(cardLicense({})).toBeUndefined();
    expect(cardLicense({ risuai: null })).toBeUndefined();
  });
});

describe('creator stylesheet', () => {
  const css = (backgroundHTML: unknown) => creatorCssFromExtensions({ risuai: { backgroundHTML } });

  it('takes the <style> bodies out of backgroundHTML, in order, and nothing else', () => {
    expect(
      css('<div class="bg"><img src="x"></div>\n<style type="text/css">\n.a { color: red; }\n</STYLE>\n<style>.b{}</style>'),
    ).toBe('.a { color: red; }\n\n.b{}');
  });

  it('says nothing when there is no stylesheet, or one past the cap', () => {
    expect(css('<div>only a background</div>')).toBeUndefined();
    expect(css('<style>   </style>')).toBeUndefined();
    expect(css(3)).toBeUndefined();
    expect(creatorCssFromExtensions({})).toBeUndefined();
    expect(creatorCssFromExtensions({ risuai: null })).toBeUndefined();
    expect(css(`<style>${'a'.repeat(MAX_CREATOR_CSS_LENGTH + 1)}</style>`)).toBeUndefined();
  });
});
