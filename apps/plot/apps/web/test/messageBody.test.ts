// @vitest-environment jsdom
/**
 * The message body, mounted.
 *
 * This is where the two halves of the display transform meet: the plan arrives
 * from somewhere else and asynchronously, made with the bindings it was asked
 * with, and is sanitized here. Both of the ways that can go wrong are about *time* — a plan that
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
/** What the planner already holds, by message text. */
const kept = new Map<string, unknown>();
/** Whether the page has had a plan back yet. */
let warm = true;

vi.mock('@/lib/displayPlanner', () => ({
  displayPlanner: {
    plan: (request: { content: string; previousSameRole: string }) => {
      asked.push({ content: request.content, previousSameRole: request.previousSameRole });
      return new Promise((resolve) => answers.push(resolve));
    },
    cached: (request: { content: string }) => (kept.has(request.content) ? kept.get(request.content) : undefined),
    warm: () => warm,
    stop: () => undefined,
  },
}));

const { MessageBody } = await import('../src/components/MessageBody');
const { transformDisplay, PLAN_LIMITS } = await import('../src/lib/displayScripts');

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
const planFor = (content: string, context: DisplayContext = display()): unknown =>
  transformDisplay({ content, scripts: SCRIPTS, previousSameRole: '' }, context, PLAN_LIMITS, Date.now);

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
  kept.clear();
  warm = true;
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
    expect(island!.textContent).toContain('금화 12');
    expect(host.textContent).not.toContain('[status]');
  });
});

describe('a message the planner already answered', () => {
  it('draws its status window on the first render, and asks for nothing', () => {
    const content = '[status] hp=50 검을 뽑았다';
    kept.set(content, planFor(content));
    render(createElement(MessageBody, { content, display: display() }));
    // No round trip between the mount and the styled paint: no prose to flash.
    expect(host.querySelector('.shizue-msg')!.textContent).toContain('HP 50');
    expect(host.textContent).not.toContain('[status]');
    expect(asked).toEqual([]);
  });

  it('draws a message that was kept as prose as prose, and asks for nothing', () => {
    kept.set('[status] hp=50', null);
    render(createElement(MessageBody, { content: '[status] hp=50', display: display() }));
    expect(host.querySelector('.shizue-msg')).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe('a page opening cold', () => {
  it('holds a message hidden until its plan lands, rather than showing it as prose first', async () => {
    warm = false;
    const content = '[status] hp=50 검을 뽑았다';
    render(createElement(MessageBody, { content, display: display() }));
    const body = host.querySelector<HTMLElement>('.message-body')!;
    // Laid out, not seen.
    expect(body.style.visibility).toBe('hidden');
    await land(planFor(content));
    expect(body.style.visibility).toBe('');
    expect(host.querySelector('.shizue-msg')!.textContent).toContain('HP 50');
  });

  it('lets a message go as prose when its plan never lands', async () => {
    vi.useFakeTimers();
    try {
      warm = false;
      render(createElement(MessageBody, { content: '[status] hp=50', display: display() }));
      expect(host.querySelector<HTMLElement>('.message-body')!.style.visibility).toBe('hidden');
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(host.querySelector<HTMLElement>('.message-body')!.style.visibility).toBe('');
      expect(host.textContent).toContain('[status] hp=50');
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds nothing once the page is warm, nor a message with no scripts', () => {
    render(createElement(MessageBody, { content: '[status] hp=50', display: display() }));
    expect(host.querySelector<HTMLElement>('.message-body')!.style.visibility).toBe('');
    warm = false;
    // Mounted afresh, cold, but with nothing to plan.
    render(createElement(MessageBody, { key: 'plain', content: '그냥 글' }));
    expect(host.querySelector<HTMLElement>('.message-body')!.style.visibility).toBe('');
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

  it('keeps the plan it has on screen while it asks again for new bindings', async () => {
    const content = '[status] hp=50';
    render(createElement(MessageBody, { content, display: display() }));
    await land(planFor(content));
    expect(host.querySelector('.shizue-msg')?.textContent).toContain('금화 12');

    // A `{{setvar}}` moved the variable. RisuAI reads each script's output as CBS
    // before the next one matches, so the plan reads the bindings and is asked for
    // again — but the message's own plan stands meanwhile: no prose flashes.
    const moved = display({ variables: { gold: '99' } });
    render(createElement(MessageBody, { content, display: moved }));
    expect(asked).toHaveLength(2);
    expect(host.querySelector('.shizue-msg')?.textContent).toContain('금화 12');
    await land(planFor(content, moved));
    expect(host.querySelector('.shizue-msg')?.textContent).toContain('금화 99');
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

describe('a reply that is all markup', () => {
  const ROSTER = [{ id: 'c1', name: '아리아', avatarUrl: '/api/plots/p1/assets/aria' }];

  it('still says whose it is: the face and the name over the markup', async () => {
    const content = '[status] hp=50';
    render(createElement(MessageBody, { content, display: display(), roster: ROSTER, speaker: '아리아', mode: 'reply' }));
    await land(planFor(content));
    const face = host.querySelector('[data-testid="speech-character"]')!;
    expect(face.getAttribute('data-speaker')).toBe('아리아');
    expect(face.textContent).toContain('아리아');
    // The markup stands under it at its own width, not in the column beside the face.
    expect(face.querySelector('.shizue-msg')).toBeNull();
    expect(host.querySelector('.shizue-msg')!.textContent).toContain('HP 50');
  });

  it('says nothing again where the row above already said it, nor in a narration', async () => {
    const content = '[status] hp=50';
    render(
      createElement(MessageBody, { content, display: display(), roster: ROSTER, speaker: '아리아', mode: 'reply', continued: true }),
    );
    await land(planFor(content));
    expect(host.querySelector('[data-testid="speech-character"]')).toBeNull();
  });
});

describe('a {{button}} in the message’s own prose', () => {
  it('is a button that runs the trigger it names, as a template’s is', () => {
    render(
      createElement(MessageBody, {
        content: '고르세요.\n\n{{button::Start war::war}}\n{{button::Peace::peace}}',
        buttons: new Set(['war']),
      }),
    );
    const [war, peace] = Array.from(host.querySelectorAll('button'));
    expect(war!.textContent).toBe('Start war');
    expect(war!.getAttribute('data-shizue-trigger')).toBe('war');
    expect(peace!.getAttribute('data-shizue-fill')).toBe('peace');
    expect(host.textContent).not.toContain('{{button');
  });

  it('stays as written with custom UI off', () => {
    render(createElement(MessageBody, { content: '{{button::Start war::war}}' }));
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toContain('{{button::Start war::war}}');
  });
});
