// @vitest-environment jsdom
/**
 * A card's background HTML as the chat draws it behind the conversation: CBS
 * against the chat, RisuAI's `{{bg::…}}`, and the display sanitizer — and
 * nothing at all rather than its source when it cannot be drawn.
 */
import { describe, expect, it } from 'vitest';
import { renderBackground } from '../src/components/ChatBackground';
import type { CbsContext } from '../src/lib/cbs';
import { MAX_RENDER_INPUT_CHARS } from '../src/lib/displayScripts';

const ctx: CbsContext = {
  variables: { time: '밤' },
  assets: new Map([['night', '/api/plots/p1/assets/night']]),
  relationship: null,
  turn: 2,
  char: '리안',
  user: '아린',
};

describe('the chat background', () => {
  it('reads as CBS, draws {{bg::…}} as RisuAI’s background does, and keeps to the sanitizer', () => {
    const html = renderBackground(
      '<style>.sky { color: red; position: fixed; }</style><div class="sky">{{char}}의 {{getvar::time}}</div>{{bg::night}}<script>alert(1)</script>',
      ctx,
    );
    expect(html).toContain('<style>.shizue-msg .x-shizue-sky');
    expect(html).not.toContain('fixed');
    expect(html).toContain('<div class="x-shizue-sky">리안의 밤</div>');
    expect(html).toContain('url(/api/plots/p1/assets/night)');
    expect(html).toContain('background-size: cover');
    expect(html).not.toContain('script');
    // Inside an attribute, the picture's address — and a picture this chat cannot open is nothing.
    expect(renderBackground('<div style="background-image: url({{bg::night}})"></div>{{bg::gone}}', ctx)).toBe(
      '<div style="background-image: url(/api/plots/p1/assets/night)"></div>',
    );
  });

  it('draws nothing rather than its source when it cannot be drawn', () => {
    expect(renderBackground('<div>{{#if 1}}열린 채</div>', ctx)).toBe('');
    expect(renderBackground(`<div>${'가'.repeat(MAX_RENDER_INPUT_CHARS)}</div>`, ctx)).toBe('');
    expect(renderBackground('<img src="https://tracker.example/x.png">', ctx)).toBe('');
  });
});
