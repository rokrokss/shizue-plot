import { describe, expect, it } from 'vitest';
import { hasEditScripts, renderOutTemplate, runEditScripts, type EditScript, type ScriptCbsEnv } from '../src/triggers/index.js';
import { emptyVariables, readVariable } from '../src/variables.js';

const variables = Object.assign(emptyVariables(), { hp: '7', name: '리안' });
const env: ScriptCbsEnv = { variable: (key) => readVariable(variables, key), data: { user: '아린', char: '리안' } };

const output = (input: string, out: string, extra: Partial<EditScript> = {}): EditScript => ({
  type: 'editoutput',
  in: input,
  out,
  ...extra,
});

const run = (text: string, scripts: EditScript[], options: { chatIndex?: number; previousSameRole?: string } = {}) =>
  runEditScripts(text, scripts, 'editoutput', { chatIndex: options.chatIndex ?? 3, env, ...options });

describe('runEditScripts', () => {
  it('replaces every match by default, with $n as a line break and a newline after a closing tag', () => {
    expect(run('a1 b2', [output('\\d', '<$&>')])).toBe('a<1>\n b<2>\n');
    // RisuAI's own `{{data}}` rewrite puts the macro straight back, and so it stays.
    expect(run('a1 b2', [output('[a-z]\\d', '[$&|{{data}}]$n')])).toBe('[a1|{{data}}]\n [b2|{{data}}]\n');
  });

  it('reads only the creator’s replacement as CBS, with the match bound in as values', () => {
    expect(run('HP 3', [output('HP (\\d+)', 'HP {{calc::$1+{{getvar::hp}}}} ({{user}})')])).toBe('HP 10 (아린)');
    // A macro the model wrote, captured or not, stays text.
    expect(run('say {{getvar::hp}}', [output('say (.*)', '“$1”')])).toBe('“{{getvar::hp}}”');
    expect(run('{{getvar::hp}} x', [output('x', 'y')])).toBe('{{getvar::hp}} y');
  });

  it('runs only its own mode and skips a pattern that does not compile', () => {
    const skipped: string[] = [];
    const scripts: EditScript[] = [
      { type: 'editinput', in: 'a', out: 'b' },
      output('(', 'x'),
      output('c', 'd'),
    ];
    expect(
      runEditScripts('abc', scripts, 'editoutput', { chatIndex: 1, env, onSkip: (_script, reason) => skipped.push(reason) }),
    ).toBe('abd');
    expect(skipped).toHaveLength(1);
    expect(runEditScripts('abc', scripts, 'editinput', { chatIndex: -1, env })).toBe('bbc');
    expect(hasEditScripts(scripts, 'editinput')).toBe(true);
  });

  it('honours flags only with ableFlag, and orders highest first once any script asks', () => {
    expect(run('aA', [output('a', 'x', { flag: 'i', ableFlag: true })])).toBe('xA');
    expect(run('aA', [output('a', 'x', { flag: 'gi', ableFlag: true })])).toBe('xx');
    expect(run('aA', [output('a', 'x', { flag: 'i' })])).toBe('xA'.replace('xA', 'xA'));
    const ordered = [
      output('a', 'b', { flag: 'g<order 1>', ableFlag: true }),
      output('b', 'c', { flag: 'g<order 5>', ableFlag: true }),
    ];
    // order 5 runs first: there is no b yet, then a becomes b.
    expect(run('a', ordered)).toBe('b');
    // Without an order the list runs as it stands.
    expect(run('a', [output('a', 'b'), output('b', 'c')])).toBe('c');
  });

  it('moves the first match to the top or the bottom', () => {
    expect(run('본문 [상태] 끝 [두번째]', [output('\\[[^\\]]+\\]', '@@move_top $&')])).toBe('[상태]\n본문  끝 [두번째]');
    expect(run('[상태] 본문', [output('\\[[^\\]]+\\]', '<b>$&</b>', { flag: 'g<move_bottom>', ableFlag: true })])).toBe(
      ' 본문\n<b>[상태]</b>\n',
    );
  });

  it('repeats the previous same-role match when this message has none, and cuts an injected match', () => {
    const repeat = output('<status>.*?</status>', '@@repeat_back end_nl');
    expect(run('대답', [repeat], { previousSameRole: '전 <status>HP 3</status>' })).toBe('대답\n<status>HP 3</status>');
    expect(run('대답', [repeat], { previousSameRole: '없음' })).toBe('대답');
    // Only for a stored message: what the reader sends has no previous turn of its own.
    expect(run('대답', [repeat], { chatIndex: -1, previousSameRole: '<status>x</status>' })).toBe('대답');
    expect(run('a [memo] b', [output('\\[memo\\]', '@@inject')])).toBe('a  b');
  });

  it('evaluates a <cbs> pattern before compiling it', () => {
    expect(run('리안 왔다', [output('{{getvar::name}}', '그녀', { flag: 'g<cbs>', ableFlag: true })])).toBe('그녀 왔다');
  });

  it('names each script of its mode before it runs, in the order it runs, by its place in the list', () => {
    const heard: number[] = [];
    const scripts: EditScript[] = [
      output('a', 'b', { flag: 'g<order 1>', ableFlag: true }),
      { type: 'editinput', in: 'x', out: 'y' },
      output('b', 'c', { flag: 'g<order 5>', ableFlag: true }),
    ];
    runEditScripts('a', scripts, 'editoutput', { chatIndex: 1, env, onScript: (index) => heard.push(index) });
    expect(heard).toEqual([2, 0]);
  });

  it('hands a compiled pattern out again as a fresh one, from the start of the text', () => {
    // A sticky pattern's search leaves it past its match; the next message must
    // not start there, but get what a fresh pattern makes of it, every time.
    const sticky = output('a', 'b', { flag: 'y<move_top>', ableFlag: true });
    const fresh = run('aa', [sticky]);
    expect(run('aa', [sticky])).toBe(fresh);
    expect(run('aa', [sticky])).toBe(fresh);
    // One pattern, two scripts: the first's search matched and nothing reset it
    // (`@@emo` leaves the text alone); the second must still find the match at 0.
    const emotion = output('a', '@@emo 웃음');
    const inject = output('a', '', { flag: 'g<inject>', ableFlag: true });
    expect(run('a', [emotion, inject])).toBe('');
  });
});

describe('@@emo', () => {
  it("names the emotion picture where it matches, and leaves the text as it is", () => {
    const named: string[] = [];
    const scripts = [output('웃', '@@emo happy'), output('울', '@@emo sad'), output('웃', '@@emo  joy ')];
    const text = runEditScripts('웃었다', scripts, 'editoutput', {
      chatIndex: 1,
      env,
      onEmotion: (name) => named.push(name),
    });
    expect(text).toBe('웃었다');
    expect(named).toEqual(['happy', 'joy']);
  });
});

describe('renderOutTemplate', () => {
  const match = { match: 'hp=42', groups: ['42', undefined], named: { n: '42' }, before: 'x ', after: ' y' };
  it('binds captures the way String.replace does', () => {
    expect(renderOutTemplate('$1|$2|$3|$<n>|$&|$$|$`|$\'', match, env)).toBe("42||$3|42|hp=42|$|x | y");
    expect(renderOutTemplate('$10', { ...match, groups: ['a'] }, env)).toBe('a0');
  });
});
