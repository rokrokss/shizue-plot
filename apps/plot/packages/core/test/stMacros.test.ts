/**
 * SillyTavern's macros in ST's own text (`MacroTavernData.sillyTavern`). Each case
 * follows ST's release macro engine — `macros/definitions/{core,env,chat,time,
 * variable}-macros.js` and `variables.js` — and, where the name is RisuAI's too,
 * shows that every other text keeps RisuAI's reading.
 */
import { describe, expect, it } from 'vitest';
import type { CbsChat } from '../src/cbs.js';
import { applyMacros, expandTavernStored, type MacroContext } from '../src/macro.js';
import { emptyVariables, type Variables } from '../src/variables.js';

const vars = (entries: Record<string, string> = {}): Variables => Object.assign(emptyVariables(), entries);

const chat = (overrides: Partial<CbsChat> = {}): CbsChat => ({
  messages: [
    { role: 'user', data: '안녕' },
    { role: 'char', data: '어서 와' },
    { role: 'user', data: '날씨가 좋네' },
  ],
  offset: 0,
  length: 3,
  index: -1,
  greeting: { text: '첫 인사', index: -1 },
  ...overrides,
});

const risu: MacroContext = {
  char: '엘라라',
  user: '민준',
  variables: vars(),
  data: { chat: () => chat(), character: { description: '숲의 궁수', exampleDialogue: '<START>\n예시' } },
  tavern: { group: ['엘라라'], charJailbreak: '탈옥' },
};
const st: MacroContext = {
  ...risu,
  runVariableMacros: true,
  tavern: {
    ...risu.tavern,
    sillyTavern: true,
    charVersion: '1.2',
    creatorNotes: '만든 이의 말',
    depthPrompt: '{{char}}는 숲을 떠나지 않는다.',
    firstMessage: '거기 멈춰.',
    alternateGreetings: ['또 왔네.', '누구냐.'],
    maxContext: 8000,
    maxResponse: 1000,
    swipes: { count: 3, current: 1 },
    firstIncludedMessageId: 2,
    generationType: 'swipe',
  },
};

describe('SillyTavern macros — chat-macros.js', () => {
  it('counts the greeting as message 0 for {{lastMessageId}}, where RisuAI counts from the reply after it', () => {
    expect(applyMacros('{{lastMessageId}}', st)).toBe('3');
    expect(applyMacros('{{lastMessageId}}', risu)).toBe('2');
    expect(applyMacros('{{allChatRange}}', st)).toBe('0-3');
  });

  it('reads the last message and the last character message, the greeting among them', () => {
    expect(applyMacros('{{lastMessage}}|{{lastCharMessage}}', st)).toBe('날씨가 좋네|어서 와');
    const greetingOnly: MacroContext = { ...st, data: { ...st.data, chat: () => chat({ messages: [], length: 0 }) } };
    expect(applyMacros('{{lastMessage}}|{{lastCharMessage}}|{{lastMessageId}}', greetingOnly)).toBe('첫 인사|첫 인사|0');
  });

  it('answers the swipe ids and the first included message', () => {
    expect(applyMacros('{{currentSwipeId}}/{{lastSwipeId}} {{firstIncludedMessageId}}', st)).toBe('2/3 2');
    expect(applyMacros('{{currentSwipeId}}', risu)).toBe('{{currentSwipeId}}');
  });
});

describe('SillyTavern macros — env-macros.js', () => {
  it("answers the card's fields ST names, and leaves them alone in RisuAI's text", () => {
    expect(applyMacros('{{charVersion}} {{char_version}} {{charCreatorNotes}}', st)).toBe('1.2 1.2 만든 이의 말');
    expect(applyMacros('{{charDepthPrompt}}', st)).toBe('엘라라는 숲을 떠나지 않는다.');
    expect(applyMacros('{{charInstruction}} {{charDescription}}', st)).toBe('탈옥 숲의 궁수');
    expect(applyMacros('{{mesExamplesRaw}}', st)).toBe('<START>\n예시');
    expect(applyMacros('{{charVersion}}', risu)).toBe('{{charVersion}}');
  });

  it('reads {{charFirstMessage::N}} and {{greeting}}: 0 the first message, N its N-th alternate', () => {
    expect(applyMacros('{{greeting}}|{{charFirstMessage::2}}|{{charFirstMessage::9}}', st)).toBe('거기 멈춰.|누구냐.|');
  });

  it('names the others for {{notChar}} — the reader where there is no group', () => {
    expect(applyMacros('{{notChar}}', st)).toBe('민준');
    const group: MacroContext = { ...st, tavern: { ...st.tavern, group: ['엘라라', '카일', '미라'] } };
    expect(applyMacros('{{notChar}} / {{groupNotMuted}}', group)).toBe('카일, 미라 / 엘라라, 카일, 미라');
  });
});

describe('SillyTavern macros — core-macros.js', () => {
  it('sizes the prompt from the context and the response', () => {
    expect(applyMacros('{{maxPrompt}} {{maxContext}} {{maxResponseTokens}}', st)).toBe('7000 8000 1000');
  });

  it('rolls droll formulas, a bare number being one die of that many sides', () => {
    expect(applyMacros('{{roll::3d6+4}}', { ...st, random: () => 0 })).toBe('7');
    expect(applyMacros('{{roll::2d10-1}}', { ...st, random: () => 0.999 })).toBe('19');
    expect(applyMacros('{{roll:20}}', { ...st, random: () => 0 })).toBe('1');
    expect(applyMacros('{{roll::nonsense}}', st)).toBe('');
    // RisuAI's roll reads no modifier.
    expect(applyMacros('{{roll::3d6+4}}', { ...risu, random: () => 0 })).toBe('NaN');
  });

  it('bans a word to nothing, and says what the environment is', () => {
    expect(applyMacros('a{{banned::"word"}}b {{isMobile}} {{hasExtension::x}} {{lastGenerationType}}', st)).toBe(
      'ab false false swipe',
    );
  });

  it('reverses text, and picks one random option from a list with an escaped comma', () => {
    expect(applyMacros('{{reverse::가나다}}', st)).toBe('다나가');
    expect(applyMacros('{{random::a\\,b,c}}', { ...st, random: () => 0 })).toBe('a,b');
  });

  it('keeps one {{pick}} per chat and place, where RisuAI draws again each turn', () => {
    const at = (seedLength: number, context: MacroContext) =>
      applyMacros('{{pick::a::b::c::d::e::f::g::h}}', { ...context, seed: 'chat-1', seedLength });
    const tavern = new Set(Array.from({ length: 6 }, (_, turn) => at(turn, st)));
    expect(tavern.size).toBe(1);
  });
});

describe('SillyTavern macros — time-macros.js', () => {
  const clock = { now: new Date('2026-10-15T00:30:00Z'), timeZone: 'Asia/Seoul', locale: 'en' as const };

  it('reads {{time::UTC+N}} as {{time_UTC+N}}: moment().utc().utcOffset(N).format("LT")', () => {
    expect(applyMacros('{{time::UTC+9}} {{time_UTC-5}}', { ...st, clock })).toBe('9:30 AM 7:30 PM');
  });

  it("writes the clock as moment's English formats do, in the reader's zone (date LL, time LT, weekday dddd, isotime, isodate)", () => {
    expect(applyMacros('{{date}} | {{time}} | {{weekday}} | {{isotime}} | {{isodate}}', { ...st, clock })).toBe(
      'October 15, 2026 | 9:30 AM | Thursday | 09:30 | 2026-10-15',
    );
    // RisuAI's reading of the same names stays: 24-hour time, UTC iso fields unpadded.
    expect(applyMacros('{{time}} | {{isotime}}', { ...risu, clock })).toBe('09:30 | 0:30:0');
  });

  it('formats {{datetimeformat}} with moment tokens — escapes, ordinals, weeks, zones and long formats', () => {
    const format = (spec: string) => applyMacros(`{{datetimeformat::${spec}}}`, { ...st, clock });
    expect(format('dddd, MMMM Do YYYY, h:mm:ss a')).toBe('Thursday, October 15th 2026, 9:30:00 am');
    expect(format('[Week] w, [ISO] W, Q[Q] DDD')).toBe('Week 42, ISO 42, 4Q 288');
    expect(format('Z ZZ [at] HH:mm SSS')).toBe('+09:00 +0900 at 09:30 000');
    expect(format('LLLL')).toBe('Thursday, October 15, 2026 9:30 AM');
    expect(format('l LT')).toBe('10/15/2026 9:30 AM');
    // RisuAI's tokens read A after MMMM: "October" becomes "OctoPMer" there, not here.
    expect(applyMacros('{{datetimeformat::MMMM A}}', { ...st, clock })).toBe('October AM');
  });

  it("says how long the reader was away as moment's humanize does, and just now with nothing to measure", () => {
    expect(applyMacros('{{idle_duration}}', { ...st, clock: { ...clock, idleMs: 30_000 } })).toBe('a few seconds');
    expect(applyMacros('{{idle_duration}}', { ...st, clock: { ...clock, idleMs: 3 * 3_600_000 } })).toBe('3 hours');
    expect(applyMacros('{{idle_duration}}', { ...st, clock })).toBe('just now');
  });

  it("says how far apart two times are, in moment's words", () => {
    expect(applyMacros('{{timeDiff::2023-01-01 15:00:00::2023-01-01 12:00:00}}', st)).toBe('in 3 hours');
    expect(applyMacros('{{timeDiff::2023-01-01::2023-03-01}}', st)).toBe('2 months ago');
  });
});

describe('SillyTavern macros — variable-macros.js', () => {
  const run = (text: string, local: Record<string, string> = {}, global?: Record<string, string>) => {
    const context: MacroContext = {
      ...st,
      variables: vars(local),
      ...(global ? { globalVariables: vars(global) } : {}),
    };
    const out = applyMacros(text, context);
    return { out, local: { ...context.variables }, global: { ...context.globalVariables } };
  };

  it('writes the new value in place of {{incvar}} and {{decvar}}', () => {
    expect(run('{{incvar::hp}}/{{decvar::hp}}/{{decvar::hp}}', { hp: '10' }).out).toBe('11/10/9');
  });

  it('adds numbers, appends text, and pushes onto a JSON array (addLocalVariable)', () => {
    expect(run('{{addvar::n::5}}{{getvar::n}}', { n: '2' }).out).toBe('7');
    expect(run('{{addvar::s::!}}{{getvar::s}}', { s: 'hi' }).out).toBe('hi!');
    expect(run('{{addvar::list::c}}{{getvar::list}}', { list: '["a","b"]' }).out).toBe('["a","b","c"]');
    expect(run('{{addvar::fresh::5}}{{getvar::fresh}}').out).toBe('5');
  });

  it('answers {{hasvar}}, deletes, and reads an unset or number-like value as ST does', () => {
    const result = run('{{hasvar::a}} {{varexists::b}} {{deletevar::a}}{{hasvar::a}} [{{getvar::none}}] {{getvar::n}}', {
      a: '1',
      n: '5.0',
    });
    expect(result.out).toBe('true false false [] 5');
    expect('a' in result.local).toBe(false);
  });

  it('sets and reads a JSON key or index (setvarkey / getvarkey)', () => {
    const result = run('{{setvarkey::inv::sword::2}}{{setvarindex::list::1::b}}{{getvarkey::inv::sword}} {{getvarindex::list::1}}');
    expect(result.out).toBe('2 b');
    expect(result.local).toEqual({ inv: '{"sword":"2"}', list: '[null,"b"]' });
  });

  it('runs the global set on the global variables', () => {
    const result = run('{{setglobalvar::g::1}}{{incglobalvar::g}} {{hasglobalvar::g}} {{getglobalvar::g}}', {}, {});
    expect(result.out).toBe('2 true 2');
    expect(result.global).toEqual({ g: '2' });
  });

  it("leaves RisuAI's fold as it is outside ST's text", () => {
    const context: MacroContext = { ...risu, runVariableMacros: true, variables: vars({ hp: '10' }) };
    expect(applyMacros('{{incvar::hp}}', context)).toBe('');
    expect(context.variables!['hp']).toBe('11');
  });
});

describe('SillyTavern macros — core-macros.js {{if}} shorthands', () => {
  it('reads {{if $name}} as the global variable and {{if .name}} as the chat one, where RisuAI text reads both locally', () => {
    const context = (base: MacroContext): MacroContext => ({
      ...base,
      variables: vars({ flag: '0' }),
      globalVariables: vars({ flag: '1' }),
    });
    const text = '{{if $flag}}global{{else}}none{{/if}} {{if .flag}}local{{else}}none{{/if}}';
    expect(applyMacros(text, context(st))).toBe('global none');
    expect(applyMacros(text, context(risu))).toBe('none none');
    // An unset global is empty, so false.
    expect(applyMacros('{{if $missing}}a{{else}}b{{/if}}', context(st))).toBe('b');
  });
});

describe('a text SillyTavern stores (substituteParams on send, /sys and edit)', () => {
  it('expands its macros as ST reads them and hands back what its variable macros wrote, leaving the maps given alone', () => {
    const variables = vars({ hp: '3' });
    const globals = vars({ seen: '0' });
    const stored = expandTavernStored(
      '{{setvar::mood::좋음}}{{char}}에게 {{user}}가 {{getvar::mood}} {{incvar::hp}} {{setglobalvar::seen::1}}{{getvar::none}}|{{img::우산}}|{{comment::메모}}',
      { char: '엘라라', user: '민준', variables, globalVariables: globals },
    );
    // ST's incvar writes the new value in its place; an unset var is empty; what it cannot answer stays.
    expect(stored.text).toBe('엘라라에게 민준가 좋음 4 |{{img::우산}}|{{comment::메모}}');
    expect(stored.variableWrites).toEqual({ mood: '좋음', hp: '4' });
    expect(stored.globalVariableWrites).toEqual({ seen: '1' });
    expect(variables).toEqual(vars({ hp: '3' }));
    expect(globals).toEqual(vars({ seen: '0' }));
  });

  it('writes nothing for a text that sets nothing', () => {
    const stored = expandTavernStored('그냥 말', { char: 'c', user: 'u', variables: vars(), globalVariables: vars() });
    expect(stored).toEqual({ text: '그냥 말', variableWrites: null, globalVariableWrites: null });
  });
});
