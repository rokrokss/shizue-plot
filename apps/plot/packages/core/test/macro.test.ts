import { describe, expect, it } from 'vitest';
import { applyMacros, imageMacroRefs, stripImageMacros } from '../src/macro.js';

const ctx = { char: '아리아', user: '민준' };

describe('applyMacros', () => {
  it('substitutes char and user, case-insensitively', () => {
    expect(applyMacros('{{char}}와 {{USER}}, {{ Char }}', ctx)).toBe('아리아와 민준, 아리아');
  });

  it('removes comments', () => {
    expect(applyMacros('앞{{// 숨은 메모}}뒤', ctx)).toBe('앞뒤');
  });

  it('picks one of the random options', () => {
    expect(applyMacros('{{random:빨강,파랑,초록}}', { ...ctx, random: () => 0 })).toBe('빨강');
    expect(applyMacros('{{random:빨강,파랑,초록}}', { ...ctx, random: () => 0.99 })).toBe('초록');
    expect(['빨강', '파랑', '초록']).toContain(applyMacros('{{random:빨강, 파랑, 초록}}', ctx));
  });

  it('rolls dice in 1..N', () => {
    expect(applyMacros('{{roll:d20}}', { ...ctx, random: () => 0 })).toBe('1');
    expect(applyMacros('{{roll:d20}}', { ...ctx, random: () => 0.999 })).toBe('20');
    expect(applyMacros('{{roll:6}}', { ...ctx, random: () => 0.5 })).toBe('4');
  });

  it('substitutes original only when a value is supplied', () => {
    expect(applyMacros('시작 {{original}} 끝', ctx)).toBe('시작 {{original}} 끝');
    expect(applyMacros('시작 {{original}} 끝', { ...ctx, original: '프리셋' })).toBe('시작 프리셋 끝');
  });

  it('leaves unsupported macros untouched', () => {
    expect(applyMacros('{{unknown}} {{setvar::a::1}}', ctx)).toBe('{{unknown}} {{setvar::a::1}}');
  });

  it('leaves image references in place — stripping them is the prompt assembler job', () => {
    expect(applyMacros('웃는다 {{img::smile}}', ctx)).toBe('웃는다 {{img::smile}}');
  });
});

describe('applyMacros - clock', () => {
  // 2026-01-02T23:30Z is already Saturday morning in Seoul.
  const now = new Date('2026-01-02T23:30:00Z');
  const clock = { now, timeZone: 'Asia/Seoul', locale: 'ko' as const };
  const format = (options: Intl.DateTimeFormatOptions, locale = 'ko') =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: 'Asia/Seoul' }).format(now);

  it('formats date, time and weekday in the reader zone and the plot language', () => {
    expect(applyMacros('{{date}} {{TIME}} {{ weekday }}', { ...ctx, clock })).toBe(
      `${format({ dateStyle: 'long' })} ${format({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} ${format({ weekday: 'long' })}`,
    );
    expect(applyMacros('{{weekday}}', { ...ctx, clock })).toBe('토요일');
    expect(applyMacros('{{date}}', { ...ctx, clock: { ...clock, locale: 'en' } })).toBe('January 3, 2026');
  });

  it('leaves the clock macros alone without a clock', () => {
    expect(applyMacros('{{date}} {{time}} {{weekday}} {{idle_duration}}', ctx)).toBe(
      '{{date}} {{time}} {{weekday}} {{idle_duration}}',
    );
  });

  it('writes the idle time as its largest whole unit', () => {
    const idle = (idleMs: number | undefined, locale: 'ko' | 'en' | 'ja' = 'ko') =>
      applyMacros('{{idle_duration}}', {
        ...ctx,
        clock: { ...clock, locale, ...(idleMs === undefined ? {} : { idleMs }) },
      });
    expect(idle(undefined)).toBe('방금');
    expect(idle(59_000, 'en')).toBe('just now');
    expect(idle(10_000, 'ja')).toBe('たった今');
    expect(idle(5 * 60_000)).toBe('5분');
    expect(idle(90 * 60_000, 'en')).toBe('1 hour');
    expect(idle(3 * 86_400_000 + 5 * 3_600_000)).toBe('3일');
    expect(idle(3 * 86_400_000, 'en')).toBe('3 days');
    expect(idle(3 * 86_400_000, 'ja')).toBe(
      new Intl.NumberFormat('ja', { style: 'unit', unit: 'day', unitDisplay: 'long' }).format(3),
    );
  });
});

describe('applyMacros - pick', () => {
  const options = ['빨강', '파랑', '초록', '노랑', '보라'];
  const text = `{{pick::${options.join(',')}}} 그리고 {{pick:${options.join(', ')}}}`;

  it('picks the same options for the same seed, text and position', () => {
    const first = applyMacros(text, { ...ctx, seed: 'chat-1' });
    expect(applyMacros(text, { ...ctx, seed: 'chat-1', random: () => 0.99 })).toBe(first);
    const [a, b] = first.split(' 그리고 ');
    expect(options).toContain(a);
    expect(options).toContain(b);
    // Another chat is another draw; over a few seeds at least one differs.
    const others = ['chat-2', 'chat-3', 'chat-4', 'chat-5'].map((seed) => applyMacros(text, { ...ctx, seed }));
    expect(others.some((other) => other !== first)).toBe(true);
  });

  it('behaves like random without a seed', () => {
    expect(applyMacros('{{pick::가,나,다}}', { ...ctx, random: () => 0 })).toBe('가');
    expect(applyMacros('{{PICK:가,나,다}}', { ...ctx, random: () => 0.99 })).toBe('다');
  });
});

describe('applyMacros - RisuAI CBS', () => {
  const variables = { mood: '7', outfit: 'casual', hp: '40' };
  const vars = { ...ctx, variables };

  it('evaluates nested conditions the way imported lorebooks write them', () => {
    const entry = '{{#if {{? ($mood>5)&($mood<10)}}}}\n  {{char}}는 기분이 좋다.\n{{/if}}';
    expect(applyMacros(entry, vars)).toBe('아리아는 기분이 좋다.');
    expect(applyMacros(entry, { ...vars, variables: { mood: '2' } })).toBe('');
    expect(applyMacros('{{#if {{equal::{{getvar::outfit}}::casual}}}}평상복{{:else}}정장{{/if}}', vars)).toBe(
      '평상복',
    );
  });

  it('leaves an unknown macro as written, its nested arguments unevaluated', () => {
    // The history fold replays `{{setvar}}` from the stored text, so the model
    // must keep seeing exactly what it wrote.
    expect(applyMacros('{{setvar::hp::{{calc::{{getvar::hp}}-5}}}} 앞', vars)).toBe(
      '{{setvar::hp::{{calc::{{getvar::hp}}-5}}}} 앞',
    );
  });

  it('treats anything that reads a variable as unsupported where there are none', () => {
    expect(applyMacros('{{getvar::hp}} {{? $hp+1}} {{calc::2*3}}', ctx)).toBe(
      '{{getvar::hp}} {{? $hp+1}} {{calc::2*3}}',
    );
    expect(applyMacros('{{? $hp+1}}', vars)).toBe('41');
  });

  it('keeps a condition on a variable whole where there are none, for the prompt to decide', () => {
    // A greeting is expanded before the chat holds any variable. Read as false,
    // the body would be gone from the stored text for good.
    const greeting = '{{#if {{? $hp=0}}}}쓰러졌다{{:else}}서 있다{{/if}} {{char}}';
    expect(applyMacros(greeting, ctx)).toBe('{{#if {{? $hp=0}}}}쓰러졌다{{:else}}서 있다{{/if}} 아리아');
    expect(applyMacros(greeting, { ...vars, variables: { hp: '0' } })).toBe('쓰러졌다 아리아');
    expect(applyMacros('{{#when::{{getvar::outfit}}::is::casual}}평상복{{/when}}', ctx)).toBe(
      '{{#when::{{getvar::outfit}}::is::casual}}평상복{{/when}}',
    );
    expect(applyMacros('{{#when::outfit::vis::casual}}평상복{{/when}}', ctx)).toBe(
      '{{#when::outfit::vis::casual}}평상복{{/when}}',
    );
    // A function of one is written as itself too, not as its answer about nothing.
    expect(applyMacros('{{equal::{{getvar::outfit}}::casual}} {{random::{{getvar::outfit}}::정장}}', ctx)).toBe(
      '{{equal::{{getvar::outfit}}::casual}} {{random::{{getvar::outfit}}::정장}}',
    );
    // A condition that needs no variable is still decided at once.
    expect(applyMacros('{{#if {{equal::{{char}}::아리아}}}}본인{{/if}}', ctx)).toBe('본인');
  });

  it('repairs a malformed template rather than refusing the whole text', () => {
    expect(applyMacros('{{#if 1}}열림 {{char}}', ctx)).toBe('{{#if 1}}열림 아리아');
    expect(applyMacros('{{char}} {{/if}} {{ 미완', ctx)).toBe('아리아 {{/if}} {{ 미완');
  });

  it('accepts names the RisuAI way — case, spaces, underscores and dashes aside', () => {
    expect(applyMacros('{{greater_equal::3::3}}{{GreaterEqual::2::3}}{{not_equal::a::b}}', ctx)).toBe('101');
  });
});

describe('stripImageMacros', () => {
  it('removes every reference, however it is written', () => {
    expect(stripImageMacros('웃는다 {{img::smile}} 그리고 {{ IMG :: bg-2 }} 끝')).toBe(
      '웃는다  그리고  끝',
    );
  });

  it('keeps other macros and unknown slugs are not its problem', () => {
    expect(stripImageMacros('{{char}}가 {{img::존재하지-않음}} 웃는다')).toBe('{{char}}가  웃는다');
  });

  it('removes every RisuAI asset macro, composed ones and those inside blocks too', () => {
    expect(
      stripImageMacros(
        '{{image::smile}}{{asset::a}}{{emotion::b}}{{raw::c}}{{path::d}}{{bg::e}}{{bgm::f}}{{audio::g}}' +
          '{{video::h}}{{video-img::i}}{{inlay::j}}{{source::char}}끝',
      ),
    ).toBe('끝');
    expect(stripImageMacros('앞 {{img::{{getvar::outfit}}_웃음.png}} 뒤')).toBe('앞  뒤');
    expect(stripImageMacros('{{#if {{getvar::x}}}}{{img::a}}보임{{/if}}')).toBe('{{#if {{getvar::x}}}}보임{{/if}}');
  });
});

describe('imageMacroRefs', () => {
  it('lists the images a text names, slugs and card names alike, and skips composed ones', () => {
    expect(
      imageMacroRefs('{{img::smile}} {{ Image :: 프로필.png }} {{raw::bg}} {{img::{{getvar::x}}.png}} {{emotion::울음}}'),
    ).toEqual(['smile', '프로필.png', '울음']);
  });
});
