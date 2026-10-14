// @vitest-environment jsdom
/**
 * A card's background HTML as the chat draws it behind the conversation: CBS
 * against the chat, RisuAI's `{{bg::…}}`, and the display sanitizer — and
 * nothing at all rather than its source when it cannot be drawn. Then the card's
 * display scripts over it, mounted: RisuAI draws `backgroundHTML` through its
 * `editdisplay` scripts (`ParseMarkdown(…, 'back')`), so a script that rewrites a
 * token in it rewrites the background. The plan comes from the planner the
 * messages use, late, so that half is about what is on screen before and after
 * it lands.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatBackground, MAX_BACKGROUND_RENDER_CHARS, renderBackground } from '../src/components/ChatBackground';
import type { CbsContext } from '../src/lib/cbs';
import { PLAN_LIMITS, transformDisplay } from '../src/lib/displayScripts';
import type { DisplayScript } from '../src/lib/types';

/** The planner is a module singleton and there is no `Worker` here, so it is replaced. */
const answers: ((plan: unknown) => void)[] = [];
const asked: { content: string; previousSameRole: string }[] = [];
/** What the planner already holds, by text. */
const kept = new Map<string, unknown>();

vi.mock('@/lib/displayPlanner', () => ({
  displayPlanner: {
    plan: (request: { content: string; previousSameRole: string }) => {
      asked.push({ content: request.content, previousSameRole: request.previousSameRole });
      return new Promise((resolve) => answers.push(resolve));
    },
    cached: (request: { content: string }) => (kept.has(request.content) ? kept.get(request.content) : undefined),
    warm: () => true,
    stop: () => undefined,
  },
}));

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

  it('draws a background past a message’s budget, up to what a plot carries', () => {
    const long = `<div>${'가'.repeat(150_000)}</div>`;
    expect(renderBackground(long, ctx)).toBe(long);
  });

  it('draws nothing rather than its source when it cannot be drawn', () => {
    expect(renderBackground('<div>{{#if 1}}열린 채</div>', ctx)).toBe('');
    expect(renderBackground(`<div>${'가'.repeat(MAX_BACKGROUND_RENDER_CHARS)}</div>`, ctx)).toBe('');
    expect(renderBackground('<img src="https://tracker.example/x.png">', ctx)).toBe('');
  });
});

const SCRIPTS: DisplayScript[] = [
  { in: '%%HP%%', out: '<b class="hp">{{getvar::hp}}</b>', order: 0, enabled: true },
  { in: '<i>(.+?)</i>', out: '<em class="word">$1</em>', order: 1, enabled: true, action: 'move_top' },
  // RisuAI's background has no message before it, so this never fires there.
  { in: '\\[never\\]', out: '<p class="carried">$&</p>', order: 2, enabled: true, action: 'repeat_back' },
];

const context: CbsContext = {
  variables: { hp: '42' },
  assets: new Map(),
  relationship: null,
  turn: 1,
  char: '리안',
  user: '나',
};

const planFor = (content: string): unknown =>
  transformDisplay({ content, scripts: SCRIPTS, previousSameRole: '', background: true }, context, PLAN_LIMITS, Date.now);

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

function render(html: string, scripts: readonly DisplayScript[] = SCRIPTS): void {
  act(() => {
    root.render(createElement(ChatBackground, { html, context, scripts }));
  });
}

async function land(plan: unknown): Promise<void> {
  const answer = answers.shift();
  await act(async () => {
    answer?.(plan);
    await Promise.resolve();
  });
}

const drawn = (): string | null => host.querySelector('[data-testid="chat-background"] .shizue-msg')?.innerHTML ?? null;

describe('the background under the display scripts', () => {
  beforeEach(() => {
    answers.length = 0;
    asked.length = 0;
    kept.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const html = '<div class="hud">HP %%HP%% · **굵게** <i>밤</i></div>';

  it('draws what the scripts made of it — its CBS read first, as RisuAI reads it, no markdown, the moves moved', async () => {
    render(html);
    // Scenery with no prose to fall back to: nothing until the plan is in hand.
    expect(drawn()).toBeNull();
    expect(asked).toEqual([{ content: html, previousSameRole: '' }]);

    await land(planFor(html));
    expect(drawn()).toBe(
      '<em class="x-shizue-word">밤</em>\n<div class="x-shizue-hud">HP <b class="x-shizue-hp">42</b> · **굵게** </div>',
    );
  });

  it('draws a kept plan on the first render, and asks for nothing', () => {
    kept.set(html, planFor(html));
    render(html);
    expect(drawn()).toContain('<b class="x-shizue-hp">42</b>');
    expect(asked).toEqual([]);
  });

  it('keeps the last background up while the next one is planned', async () => {
    render(html);
    await land(planFor(html));
    const next = '<div class="hud">다음 %%HP%%</div>';
    render(next);
    expect(drawn()).toContain('HP <b class="x-shizue-hp">42</b>');
    await land(planFor(next));
    expect(drawn()).toBe('<div class="x-shizue-hud">다음 <b class="x-shizue-hp">42</b></div>');
  });

  it('draws the source when the planner has nothing for it, and at once without scripts', async () => {
    render(html);
    await land(null);
    expect(drawn()).toContain('HP %%HP%%');

    render('<p>밤</p>', []);
    expect(drawn()).toBe('<p>밤</p>');
    expect(asked).toHaveLength(1);
  });
});
