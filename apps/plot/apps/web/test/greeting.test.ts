import { describe, expect, it } from 'vitest';
import { fillPreview, greetingText, isGreeting, MAX_GREETING_CHARS } from '@/lib/greeting';

const ctx = (variables: Record<string, string>) => ({
  variables,
  char: '파르마의 기사단',
  user: '사령관',
  seed: 'chat-1',
});

// The shape RisuAI cards open with: one greeting, a route per variable value.
const routes = [
  '<start>',
  '{{#when::fm_route::vis::1}}\n사령관으로 부임한 첫날.\n{{/when}}',
  '{{#when::fm_route::vis::6}}\n그레타의 서임 신고.\n<img src="Greta">\n{{/when}}',
].join('\n\n');

describe('greeting', () => {
  it('keeps only the branch the variables choose, as the prompt does', () => {
    const one = greetingText(routes, 'm1', ctx({ fm_route: '1' }));
    expect(one).toContain('사령관으로 부임한 첫날.');
    expect(one).not.toContain('그레타');
    expect(one).not.toContain('{{');

    const six = greetingText(routes, 'm1', ctx({ fm_route: '6' }));
    expect(six).toContain('그레타의 서임 신고.');
    expect(six).not.toContain('사령관으로 부임한 첫날.');
  });

  it('stays text: tags, image references and variable macros come out as written', () => {
    const shown = greetingText(
      '{{#if {{equal::{{getvar::x}}::1}}}}<img src="Greta"> {{img::face}} {{setvar::hp::10}}{{/if}}',
      'm1',
      ctx({ x: '1' }),
    );
    expect(shown).toBe('<img src="Greta"> {{img::face}} {{setvar::hp::10}}');
  });

  it('rolls the same way on every render of one message', () => {
    const roll = '{{#if {{equal::{{getvar::x}}::1}}}}{{random::a::b::c::d::e::f::g::h}}{{/if}}';
    const first = greetingText(roll, 'm1', ctx({ x: '1' }));
    for (let i = 0; i < 5; i += 1) expect(greetingText(roll, 'm1', ctx({ x: '1' }))).toBe(first);
  });

  it('shows what was stored when a variable would blow it up', () => {
    const source = '{{#if {{equal::1::1}}}}{{getvar::blob}}{{/if}}';
    expect(greetingText(source, 'm1', ctx({ blob: 'x'.repeat(MAX_GREETING_CHARS + 1) }))).toBe(source);
  });

  it('is the root of the branch, written by the character', () => {
    expect(isGreeting({ parentId: null, role: 'assistant' })).toBe(true);
    expect(isGreeting({ parentId: null, role: 'user' })).toBe(false);
    expect(isGreeting({ parentId: 'm0', role: 'assistant' })).toBe(false);
  });
});

describe('fillPreview', () => {
  it('substitutes char and user regardless of case or spacing', () => {
    expect(fillPreview('{{char}}가 {{ USER }}를 본다', '사서', '당신')).toBe('사서가 당신를 본다');
  });

  it('leaves other macros alone', () => {
    expect(fillPreview('{{roll:d6}} {{char}}', '사서', '당신')).toBe('{{roll:d6}} 사서');
  });
});
