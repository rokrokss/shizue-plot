import { describe, expect, it } from 'vitest';
import { evaluateCbs, parseCbs, pickHashRand, unescapeCbs, type CbsClock, type CbsHost } from '../src/cbs.js';

/** RisuAI's functions of their arguments, with nothing of any host's. */
const run = (template: string, host: CbsHost = {}): string =>
  evaluateCbs(template, parseCbs(template), { variable: () => undefined, random: () => 0, ...host });

/** Each case is `[template, what RisuAI writes]`. */
const table = (cases: [string, string][]): void => {
  for (const [template, expected] of cases) expect(run(template), template).toBe(expected);
};

describe('RisuAI seeds', () => {
  it('hashes as RisuAI does, to the digit', () => {
    // Vectors from a re-typed pickHashRand (scratchpad vectors/hash.mjs).
    table([
      ['{{hash::hello}}', '0121468'],
      ['{{hash::}}', '0000040'],
      ['{{hash::a}}', '5250735'],
      ['{{hash::안녕}}', '2546171'],
      ['{{hash::shizue}}', '1030316'],
    ]);
    expect(pickHashRand(0, 'abc')).toBe(0.5968559260945767);
    expect(pickHashRand(5, 'abc')).toBe(0.5574021278880537);
    // With nothing to hash, upstream throws: the macro stays.
    expect(run('{{hash}}')).toBe('{{hash}}');
  });
});

describe('RisuAI comparisons and logic', () => {
  it('answers 1 or 0, a missing operand being undefined as upstream', () => {
    table([
      ['{{equal}}', '1'],
      ['{{equal::a}}', '0'],
      // The text `1` only: a JSON number 1 is not it.
      ['{{all::1::1}}{{all::1::0}}{{all::["1","1"]}}{{all::[1,1]}}', '1010'],
      ['{{any::0::1}}{{any::["0"]}}{{any::0}}', '100'],
      ['{{iserror::Error: nope}}{{iserror::fine}}', '10'],
      ['{{startswith::abc::ab}}{{endswith::abc::bc}}{{startswith::abc::c}}', '110'],
      // `includes(undefined)` looks for the word.
      ['{{contains::undefined!}}', '1'],
    ]);
    expect(run('{{all}}')).toBe('{{all}}');
    expect(run('{{contains}}')).toBe('{{contains}}');
  });
});

describe('RisuAI strings', () => {
  it('replaces, splits and joins as JavaScript does', () => {
    table([
      ['{{replace::a-b-c::-::+}}', 'a+b+c'],
      ['{{replace::abc::b::[$&]}}', 'a[b]c'],
      ['{{replace::abc::b}}', 'aundefinedc'],
      ['{{split::a,b,c::,}}', '["a","b","c"]'],
      ['{{join::["a","b"]::-}}', 'a-b'],
      ['{{join::["a","b"]}}', 'a,b'],
      ['{{join::a§b::+}}', 'a+b'],
      ['{{spread::["a","b"]}}', 'a::b'],
    ]);
  });

  it('trims, measures, cases and reverses', () => {
    table([
      ['[{{trim:: x }}]', '[x]'],
      ['{{length::안녕}}{{length::😀}}', '22'],
      ['{{lower::ÀB}}{{upper::ab}}{{capitalize::hello}}', 'àbABHello'],
      ['{{reverse::가나😀}}', '😀나가'],
      ['[{{tonumber::a1 b2.5c}}]', '[1 2.5]'],
    ]);
  });

  it('reads and writes code points and hex', () => {
    table([
      ['{{unicodeencode::A}}{{unicode_encode::AB::1}}', '6566'],
      ['{{unicodedecode::44032}}{{u::AC00}}{{ue::41}}', '가가A'],
      ['{{fromhex::ff}} {{tohex::255}} {{tohex::x}}', '255 ff NaN'],
    ]);
  });

  it('round-trips xor and crypt, and decodes base64 as Node does', () => {
    expect(run('{{xor::안녕 a}}')).toBe('E2p3FHpq354=');
    expect(run('{{xordecrypt::{{xor::안녕 a}}}}')).toBe('안녕 a');
    expect(run('{{xor}}')).toBe('');
    expect(run('{{crypt::{{crypt::비밀}}}}')).toBe('비밀');
    expect(run('{{crypt::a::1}}')).toBe('b');
    expect(run('{{decrypt::{{encrypt::x::5}}::-5}}')).toBe('x');
  });

  it('writes the markup-free helpers: tex, cbr, blank and friends', () => {
    table([
      ['{{tex::x^2}}', '$$x^2$$'],
      ['{{cbr}}|{{cnl::3}}', '\\n|\\n\\n\\n'],
      ['[{{blank}}{{none}}{{hiddenkey::키}}{{risu}}{{declare::x}}]', '[]'],
    ]);
    expect(run('{{cbr::1000}}')).toBe('{{cbr::1000}}');
  });
});

describe('RisuAI numbers', () => {
  it('writes numbers as JavaScript does, NaN and Infinity included', () => {
    table([
      ['{{round::2.5}} {{floor::-1.5}} {{ceil::1.1}} {{abs::-3}}', '3 -2 2 3'],
      ['{{remaind::7::3}} {{pow::2::10}} {{round::x}}', '1 1024 NaN'],
      ['{{min::3::1::x}} {{max::[1,5,2]}} {{min::[]}}', '0 5 Infinity'],
      ['{{sum::0.1::0.2}} {{average::1::2}} {{average::[]}}', '0.30000000000000004 1.5 NaN'],
      ['{{fixnum::3.14159::2}} {{fixnumber::2}}', '3.14 2'],
    ]);
    // Past what `toFixed` takes, upstream throws.
    expect(run('{{fixnum::1::101}}')).toBe('{{fixnum::1::101}}');
  });

  it('rolls dice and integers off the random source', () => {
    const at = (r: number): CbsHost => ({ random: () => r });
    expect(run('{{randint::1::6}}', at(0.999))).toBe('6');
    expect(run('{{randint::1::6}} {{randint::a::6}}', at(0))).toBe('1 NaN');
    expect(run('{{dice::2d6}}', at(0.999))).toBe('12');
    expect(run('{{dice::3}} {{dice::d6}}', at(0))).toBe('NaN 0');
    expect(run('{{roll}} {{roll::abc}} {{roll::}} {{roll::1001d6}}', at(0))).toBe('1 NaN NaN NaN');
    expect(run('{{roll::1.5d6}}', at(0))).toBe('2');
  });
});

describe('RisuAI arrays and dictionaries', () => {
  it('reads elements, JSON or a §-list, objects written as JSON', () => {
    table([
      ['{{arraylength::[1,2,3]}} {{arraylength::a§b}} {{arraylength::abc}}', '3 2 1'],
      ['{{arrayelement::["a",{"b":1}]::1}} {{arrayelement::[1,2]::-1}} {{arrayelement::[1]::5}}', '{"b":1} 2 null'],
      ['{{dictelement::{"a":"x"}::a}} {{objectelement::{"a":[1]}::a}} {{dictelement::{}::b}}', 'x [1] null'],
      // Own keys only: a dictionary has no `constructor` of its own.
      ['{{dictelement::{}::constructor}}', 'null'],
      // A step reads the text the last one left, so a nested object has to be JSON in JSON.
      ['{{element::{"a":"{\\"b\\":2}"}::a::b}} {{element::{"a":{"b":2} }::a::b}} {{ele::[0,5]::1}}', '2 null 5'],
    ]);
    expect(run('{{dictelement::null::a}}')).toBe('{{dictelement::null::a}}');
  });

  it('edits arrays and dictionaries, writing JSON back', () => {
    table([
      ['{{arrayshift::[1,2,3]}} {{arraypop::[1,2,3]}} {{arraypush::["a"]::b}}', '[2,3] [1,2] ["a","b"]'],
      ['{{arraysplice::[1,2,3]::1::1::x}} {{arraysplice::[1,2]::0::1}}', '[1,"x",3] [null,2]'],
      ['{{arrayassert::[1]::3::x}} {{arrayassert::[1,2]::0::x}}', '[1,null,null,"x"] [1,2]'],
      ['{{objectassert::{"a":1}::b::2}} {{dictassert::{"a":1}::a::2}}', '{"a":1,"b":"2"} {"a":1}'],
      ['{{makearray::a::b}} {{a::x}} {{makedict::a=1::b=c=d::skip}} {{o}}', '["a","b"] ["x"] {"a":"1","b":"c=d"} {}'],
      ['{{makearray::a::b}}', '["a","b"]'],
    ]);
    // A value is never syntax here, so an item keeps its `::` — upstream writes `::`.
    expect(run('{{split::{{getvar::v}}::§}}', { variable: () => 'a::b§c' })).toBe('["a::b","c"]');
  });

  it('makes ranges and filters', () => {
    table([
      ['{{range::[3]}} {{range::[2,5]}} {{range::[0,10,4]}} {{range::[5,1]}}', '["0","1","2"] ["2","3","4"] ["0","4","8"] []'],
      ['{{filter::["a","","a","b"]}} {{filter::["a","","a"]::nonempty}} {{filter::["a","","a"]::unique}}', '["a","b"] ["a","a"] ["a",""]'],
    ]);
  });

  it('refuses what would be a memory bomb or a loop rather than building it', () => {
    for (const template of [
      '{{range::[0,10,0]}}',
      '{{range::[1000000]}}',
      '{{arrayassert::[]::100000000::x}}',
      '{{objectassert::[]::100000000::x}}',
      `{{replace::${'x'.repeat(1000)}::::${'y'.repeat(1000)}}}`,
      `{{replace::${'x'.repeat(2000)}::x::$\`}}`,
    ]) {
      expect(run(template), template.slice(0, 40)).toBe(template);
    }
  });
});

describe('RisuAI display escapes', () => {
  it('writes Private Use Area stand-ins, and turns them back where text is shown', () => {
    const escaped = run('{{decbo}}{{bo}}{{(}}{{)}}{{<}}{{>}}{{dec}}{{;}}{{bc}}{{decbc}}');
    expect(escaped).toBe('');
    expect(unescapeCbs(escaped, 'text')).toBe('{{{()<>:;}}}');
    expect(unescapeCbs(escaped, 'html')).toBe('{{{()&lt;&gt;:;}}}');
    expect(unescapeCbs('\\{\\{char\\}\\}', 'html')).toBe('{{char}}');
    // `{{:}}` is dead upstream too: a `:` opens block syntax.
    expect(run('{{:}}')).toBe('{{:}}');
  });
});

describe('RisuAI clock', () => {
  const at = (iso: string, timeZone: string): CbsHost => ({
    data: { clock: { now: new Date(iso), timeZone, locale: 'ko' } satisfies CbsClock },
  });
  const format = 'YYYY-MM-DD HH:mm:ss hh A | YY MMMM MMM dddd ddd | DDDD | X x';

  it('formats in the reader’s zone, token after token as upstream — April becoming PMpril', () => {
    // Vectors: a re-typed RisuAI dateTimeFormat run with the device in each zone.
    expect(run(`{{date::${format}}}`, at('2026-04-07T05:04:03.250Z', 'Asia/Seoul'))).toBe(
      '2026-04-07 14:04:03 02 PM | 26 PMpril PMpr Tuesday Tue | 97 | 1775538243 1775538243250',
    );
    expect(run(`{{datetimeformat::${format}}}`, at('2026-08-15T14:30:00.000Z', 'America/New_York'))).toBe(
      '2026-08-15 10:30:00 10 AM | 26 AMugust AMug Saturday Sat | 227 | 1786804200 1786804200000',
    );
    expect(run('{{time::DDDD YYYY}}', at('2026-12-31T23:59:59.000Z', 'Asia/Seoul'))).toBe('1 2027');
  });

  it('counts the day of the year in elapsed time, as upstream does across a clock change', () => {
    // 00:30 on 9 March in New York, the day after the clocks went forward: RisuAI says 67.
    expect(run('{{date::DDDD}}', at('2026-03-09T04:30:00.000Z', 'America/New_York'))).toBe('67');
    expect(run('{{date::DDDD}}', at('2026-03-09T04:30:00.000Z', 'Asia/Seoul'))).toBe('68');
  });

  it('reads a third argument as upstream does: divided by 1000, then taken as milliseconds', () => {
    expect(run('{{date::YYYY-MM-DD HH:mm:ss::1767225600000}}', at('2026-04-07T05:04:03Z', 'Asia/Seoul'))).toBe(
      '1970-01-21 19:53:45',
    );
    expect(run('{{date::YYYY::nope}}', at('2026-04-07T05:04:03Z', 'Asia/Seoul'))).toBe('2026');
    expect(run('[{{date::}}]', at('2026-04-07T05:04:03Z', 'Asia/Seoul'))).toBe('[]');
  });

  it('writes the argument-less forms RisuAI has, and leaves date and time to the host', () => {
    const host = at('2026-04-07T05:04:03.600Z', 'Asia/Seoul');
    expect(run('{{datetimeformat}} {{isodate}} {{isotime}} {{unixtime}}', host)).toBe('2026-4-7 2026-4-7 5:4:3 1775538244');
    expect(run('{{date}} {{time}}', host)).toBe('{{date}} {{time}}');
  });

  it('stays as written without a clock — the fold has none', () => {
    const template = '{{date::YYYY}} {{unixtime}} {{isodate}}';
    expect(run(template)).toBe(template);
  });
});
