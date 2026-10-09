// @vitest-environment jsdom
/**
 * The message body, mounted.
 *
 * This is where the two halves of the display transform meet: the plan arrives
 * from somewhere else and asynchronously, and the bindings are applied here on
 * every render. Both of the ways that can go wrong are about *time* — a plan that
 * belongs to text the message no longer has, and a message that is still being
 * written — so they are only visible with the component actually mounted and the
 * planner actually answering late.
 *
 * `createElement` rather than JSX, so this file needs nothing of the build that
 * the rest of the suite does not already have.
 */
import { NextIntlClientProvider } from 'next-intl';
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisplayContext } from '../src/lib/displayScripts';
import type { DisplayScript } from '../src/lib/types';

/** The planner is a module singleton and there is no `Worker` here, so it is replaced. */
const answers: ((plan: unknown) => void)[] = [];
const asked: { content: string; previousSameRole: string }[] = [];

vi.mock('@/lib/displayPlanner', () => ({
  displayPlanner: {
    plan: (request: { content: string; previousSameRole: string }) => {
      asked.push({ content: request.content, previousSameRole: request.previousSameRole });
      return new Promise((resolve) => answers.push(resolve));
    },
    stop: () => undefined,
  },
}));

const { MessageBody } = await import('../src/components/MessageBody');
const { planDisplayScripts, PLAN_LIMITS } = await import('../src/lib/displayScripts');

const script: DisplayScript = {
  in: '\\[status\\] hp=(\\d+)',
  out: '<div class="hp">HP $1 · 금화 {{getvar::gold}}</div>',
  order: 0,
  enabled: true,
};

/** One array, held: the chat memoizes its scripts and this hook relies on that. */
const SCRIPTS = [script];

const display = (overrides: Partial<DisplayContext> = {}): DisplayContext => ({
  scripts: SCRIPTS,
  variables: { gold: '12' },
  assets: new Map(),
  relationship: null,
  turn: 1,
  char: '아리아',
  user: '민준',
  ...overrides,
});

/** The plan the real worker would have sent back for this text. */
const planFor = (content: string): unknown =>
  planDisplayScripts(content, SCRIPTS, '', PLAN_LIMITS, Date.now);

// React refuses to believe `act` outside a test environment that says so.
(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

function render(element: ReactElement): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages: {
          chat: { componentError: '오류', componentNavigated: '이동', componentTimeout: '무응답' },
          common: { retry: '다시 시도' },
        },
        children: element,
      }),
    );
  });
}

/** Lets the planner's promise resolve and React commit what it caused. */
async function land(plan: unknown): Promise<void> {
  const answer = answers.shift();
  await act(async () => {
    answer?.(plan);
    await Promise.resolve();
  });
}

beforeEach(() => {
  answers.length = 0;
  asked.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('while the plan is outstanding', () => {
  it('shows the message as the model wrote it', () => {
    render(createElement(MessageBody, { content: '[status] hp=50 검을 뽑았다', display: display() }));
    expect(host.textContent).toContain('[status] hp=50 검을 뽑았다');
    expect(host.querySelector('.shizue-msg')).toBeNull();
  });

  it('draws the status window once it lands', async () => {
    const content = '[status] hp=50 검을 뽑았다';
    render(createElement(MessageBody, { content, display: display() }));
    await land(planFor(content));

    const island = host.querySelector('.shizue-msg');
    expect(island).not.toBeNull();
    expect(island!.textContent).toContain('HP 50');
    // The bindings were applied here, not in the plan.
    expect(island!.textContent).toContain('금화 12');
    expect(host.textContent).not.toContain('[status]');
  });
});

describe('a message that is still being written', () => {
  it('is not planned at all, and is planned the moment it settles', async () => {
    const content = '[status] hp=5';
    render(createElement(MessageBody, { content, display: display(), streaming: true }));
    expect(asked).toHaveLength(0);
    expect(host.textContent).toContain('[status] hp=5');

    // The stream finished; the same message, now settled.
    const whole = '[status] hp=50 검을 뽑았다';
    render(createElement(MessageBody, { content: whole, display: display(), streaming: false }));
    expect(asked.map((request) => request.content)).toEqual([whole]);
    await land(planFor(whole));
    expect(host.querySelector('.shizue-msg')?.textContent).toContain('HP 50');
  });
});

describe('when the message changes under a plan', () => {
  it('never draws the text the plan was made from', async () => {
    const first = '[status] hp=50 검을 뽑았다';
    render(createElement(MessageBody, { content: first, display: display() }));
    await land(planFor(first));
    expect(host.textContent).toContain('HP 50');

    // The reader edited it. The plan in hand describes a message that is gone, so
    // until the new one lands there is no plan — not the old one applied to new text.
    const edited = '[status] hp=9 물러섰다';
    render(createElement(MessageBody, { content: edited, display: display() }));
    expect(host.textContent).toContain('[status] hp=9 물러섰다');
    expect(host.textContent).not.toContain('HP 50');

    await land(planFor(edited));
    expect(host.querySelector('.shizue-msg')?.textContent).toContain('HP 9');
  });

  it('re-renders a landed plan against new bindings without asking again', async () => {
    const content = '[status] hp=50';
    render(createElement(MessageBody, { content, display: display() }));
    await land(planFor(content));
    expect(host.querySelector('.shizue-msg')?.textContent).toContain('금화 12');

    // A `{{setvar}}` moved the variable. This is the case the split exists to keep
    // synchronous: same plan, new bindings, no round trip.
    render(
      createElement(MessageBody, { content, display: display({ variables: { gold: '99' } }) }),
    );
    expect(host.querySelector('.shizue-msg')?.textContent).toContain('금화 99');
    expect(asked).toHaveLength(1);
  });
});

describe('when the planner gives up', () => {
  it('leaves the message as prose', async () => {
    const content = '[status] hp=50 검을 뽑았다';
    render(createElement(MessageBody, { content, display: display() }));
    // What a terminated worker looks like from here.
    await land(null);
    expect(host.querySelector('.shizue-msg')).toBeNull();
    expect(host.textContent).toContain('[status] hp=50 검을 뽑았다');
  });
});

describe('without display scripts', () => {
  it('asks for nothing and renders markdown', () => {
    render(createElement(MessageBody, { content: '*문을 열었다*' }));
    expect(asked).toHaveLength(0);
    expect(host.querySelector('em')?.textContent).toBe('문을 열었다');
  });
});

/**
 * The speaker split is the last thing the pipeline does, and it does it only to
 * what is still plain text. A status window is the creator's own markup and is
 * drawn as it was written — but the prose it was cut out of is still a reply, and
 * still says who is speaking in it.
 */
describe('with a roster', () => {
  const ROSTER = [{ id: 'c1', name: '아리아', avatarUrl: null }];

  it('tells the speakers apart in a message no script touched', () => {
    render(
      createElement(MessageBody, { content: '비가 그쳤다.\n아리아: 이제 나가자.', roster: ROSTER }),
    );

    expect(host.querySelector('[data-testid="speech-narration"]')?.textContent).toContain('비가 그쳤다.');
    const spoken = host.querySelector('[data-testid="speech-character"]')!;
    expect(spoken.getAttribute('data-speaker')).toBe('아리아');
    expect(spoken.textContent).toContain('이제 나가자.');
  });

  it('leaves an island alone and splits only the text around it', async () => {
    const content = '[status] hp=50\n아리아: 이제 나가자.';
    render(createElement(MessageBody, { content, display: display(), roster: ROSTER }));
    await land(planFor(content));

    // The island is the script's, untouched by the split.
    expect(host.querySelector('.shizue-msg')?.textContent).toContain('HP 50');
    expect(host.querySelector('.shizue-msg')?.closest('[data-testid="speech-character"]')).toBeNull();
    // …and what the script left behind is still attributed.
    expect(host.querySelector('[data-testid="speech-character"]')?.getAttribute('data-speaker')).toBe(
      '아리아',
    );
  });
});
