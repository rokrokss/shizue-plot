/**
 * Call-code detection and the literal-only prop parser.
 *
 * Two properties matter more than any single case here: a value that is not a
 * literal is never guessed at (nothing is evaluated, ever), and a call that has
 * not finished arriving is not a call (a reply streams in token by token, so
 * every prefix of every call code passes through this parser).
 */
import { describe, expect, it } from 'vitest';
import { findComponentCalls, splitComponentCalls } from '../src/lib/componentCalls';
import type { Segment } from '../src/lib/displayScripts';

const NAMES = ['StatusWindow', 'Gauge'];

const first = (text: string, names: readonly string[] = NAMES) => findComponentCalls(text, names)[0];

describe('finding a call', () => {
  it('finds a self-closing call and reports where it sat', () => {
    const text = '문을 열었다.\n<StatusWindow hp={50} />\n검을 뽑았다.';
    const call = first(text)!;
    expect(call.name).toBe('StatusWindow');
    expect(call.props).toEqual({ hp: 50 });
    expect(text.slice(call.start, call.end)).toBe('<StatusWindow hp={50} />');
  });

  it('only matches names the card declares', () => {
    expect(findComponentCalls('<Unknown x={1} />', NAMES)).toEqual([]);
    expect(findComponentCalls('<StatusWindow />', [])).toEqual([]);
    // Prose that happens to contain angle brackets stays prose.
    expect(findComponentCalls('a < b and c > d', NAMES)).toEqual([]);
    expect(findComponentCalls('<br /> <div>x</div>', NAMES)).toEqual([]);
  });

  it('finds several calls and never overlapping ones', () => {
    const calls = findComponentCalls('<Gauge v={1} /> 사이 <StatusWindow hp={2} />', NAMES);
    expect(calls.map((call) => call.name)).toEqual(['Gauge', 'StatusWindow']);
    expect(calls[1]!.start).toBeGreaterThan(calls[0]!.end);
  });

  it('stops at a sane number of frames per message', () => {
    expect(findComponentCalls('<Gauge />'.repeat(30), NAMES)).toHaveLength(8);
  });
});

describe('a call that has not finished arriving', () => {
  const complete = '<StatusWindow hp={50} label="상태" />';

  it('matches no prefix of itself until the last character', () => {
    for (let length = 1; length < complete.length; length += 1) {
      expect(findComponentCalls(complete.slice(0, length), NAMES), complete.slice(0, length)).toEqual(
        [],
      );
    }
    expect(findComponentCalls(complete, NAMES)).toHaveLength(1);
  });

  it('is not a call when it is not self-closing', () => {
    // Children are not part of the protocol, and an element with them cannot be
    // told from a truncated one.
    expect(findComponentCalls('<StatusWindow hp={1}>내용</StatusWindow>', NAMES)).toEqual([]);
    expect(findComponentCalls('<StatusWindow>', NAMES)).toEqual([]);
  });

  it('is not a call when an attribute is malformed', () => {
    expect(findComponentCalls('<StatusWindow hp=50 />', NAMES)).toEqual([]);
    expect(findComponentCalls('<StatusWindow hp={50 />', NAMES)).toEqual([]);
    expect(findComponentCalls('<StatusWindow "hp" />', NAMES)).toEqual([]);
    expect(findComponentCalls('<StatusWindowhp={1} />', NAMES)).toEqual([]);
  });
});

describe('the prop values', () => {
  const props = (attributes: string) => first(`<StatusWindow ${attributes} />`)?.props;

  it('reads the JSON literal subset', () => {
    expect(props('a="문자열" b={1} c={-2.5} d={true} e={false} f={null}')).toEqual({
      a: '문자열',
      b: 1,
      c: -2.5,
      d: true,
      e: false,
      f: null,
    });
    expect(props("s={'작은따옴표'}")).toEqual({ s: '작은따옴표' });
    // A bare attribute is `true`, as in JSX.
    expect(props('open')).toEqual({ open: true });
  });

  it('reads nested arrays and objects', () => {
    expect(props('items={[{ name: "검", n: 2 }, "방패"]}')).toEqual({
      items: [{ name: '검', n: 2 }, '방패'],
    });
    expect(props('map={{ "hp": 3, mp: 4, }}')).toEqual({ map: { hp: 3, mp: 4 } });
  });

  it('drops a value that is not a literal instead of evaluating it', () => {
    for (const source of [
      'x={() => 1}',
      'x={hp + 1}',
      'x={someVariable}',
      'x={fetch("/api/models")}',
      'x={`template`}',
      'x={[1, 2].map(n => n)}',
      'x={{ a: b }}',
      'x={new Date()}',
    ]) {
      const call = first(`<StatusWindow ${source} keep={1} />`)!;
      expect(call.props, source).toEqual({ keep: 1 });
      expect(call.rejected, source).toEqual(['x']);
    }
  });

  it('keeps a key called __proto__ as a key', () => {
    const call = first('<StatusWindow map={{ __proto__: "x" }} />')!;
    const map = call.props['map'] as Record<string, unknown>;
    expect(Object.getPrototypeOf(map)).toBeNull();
    expect(Object.keys(map)).toEqual(['__proto__']);
  });

  it('refuses a value nested past any sane depth', () => {
    const deep = '['.repeat(20) + ']'.repeat(20);
    expect(first(`<StatusWindow x={${deep}} />`)!.rejected).toEqual(['x']);
  });
});

describe('splitting a message', () => {
  const text = (value: string): Segment => ({ kind: 'text', text: value });

  it('replaces the call code with a component and keeps the rest as text', () => {
    const segments = splitComponentCalls([text('앞 <Gauge v={3} /> 뒤')], NAMES);
    expect(segments).toEqual([
      { kind: 'text', text: '앞 ' },
      { kind: 'component', name: 'Gauge', props: { v: 3 } },
      { kind: 'text', text: ' 뒤' },
    ]);
  });

  it('leaves a display script island alone', () => {
    const island: Segment = { kind: 'html', html: '<div>이미 그려진 것</div>' };
    expect(splitComponentCalls([island, text('<Gauge />')], NAMES)).toEqual([
      island,
      { kind: 'component', name: 'Gauge', props: {} },
    ]);
  });

  it('changes nothing when the message has no call code', () => {
    const segments = [text('평범한 답변')];
    expect(splitComponentCalls(segments, NAMES)).toEqual(segments);
  });
});
