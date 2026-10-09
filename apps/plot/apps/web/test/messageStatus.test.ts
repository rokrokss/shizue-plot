// @vitest-environment jsdom
/**
 * The two conventions a turn may end with, mounted: the 상태창 block and the
 * choice lines.
 *
 * Both are stripped from the message before it is read as prose, so what has to
 * hold is that nothing is lost by it — the block becomes the card, the lines
 * become the offer — and that neither parser takes something that is not one: a
 * fence with prose after it is a code block the reader wrote about, and a choice
 * from a turn that is no longer the last one was an offer that has expired.
 *
 * `createElement` rather than JSX, matching `messageRow.test.ts`.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../messages/ko.json';
import { MessageRow } from '../src/components/MessageRow';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

const timeZone = 'Asia/Seoul';

function render(element: ReactElement): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, { locale: 'ko', timeZone, messages, children: element }),
    );
  });
}

const row = (content: string, extra: Record<string, unknown> = {}) =>
  createElement(MessageRow, {
    role: 'assistant',
    content,
    name: '아리아',
    avatar: null,
    assets: new Map(),
    streaming: false,
    ...extra,
  });

/** A reply that ends the way the two directives teach it to. */
const reply = [
  '문이 닫히자 빗소리만 남았다.',
  '',
  '```status',
  '위치: 여관 로비',
  '시간: 자정',
  '```',
  '',
  '>> 방을 둘러본다',
  '>> 문을 다시 연다',
].join('\n');

const card = (): HTMLElement | null => host.querySelector('[data-testid="status-card"]');
const rows = (): string[] =>
  [...(card()?.querySelectorAll('dt, dd') ?? [])].map((node) => node.textContent ?? '');
const choices = (): HTMLButtonElement[] => [
  ...host.querySelectorAll<HTMLButtonElement>('[data-testid="message-choices"] button'),
];

async function press(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a turn that ends with a status block', () => {
  it('draws it as a card instead of a code block, and keeps the prose', () => {
    render(row(reply));

    expect(host.textContent).toContain('문이 닫히자 빗소리만 남았다.');
    expect(rows()).toEqual(['위치', '여관 로비', '시간', '자정']);
    // The fence is the card now: nothing of it is left in the message.
    expect(host.querySelector('.code-block')).toBeNull();
    expect(host.textContent).not.toContain('```');
  });

  it('folds away and back, for the reader who has read it once', async () => {
    render(row(reply));
    const toggle = card()!.querySelector('button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await press(toggle);
    expect(card()!.querySelector('dl')).toBeNull();
    expect(card()!.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
  });

  it("takes the chat's answer where there is one, and hands the press back", async () => {
    const toggled: string[] = [];
    render(row(reply, { statusCollapsed: true, onToggleStatus: () => toggled.push('toggled') }));

    expect(card()!.querySelector('dl')).toBeNull();
    await press(card()!.querySelector('button')!);
    expect(toggled).toEqual(['toggled']);
  });

  /** The same fence in an opening, which is how the first scene gets a card. */
  it('draws one an opening carried, exactly the same way', () => {
    render(row(['비가 그치지 않는 밤이었다.', '```status', '위치: 서점 앞', '```'].join('\n')));
    expect(rows()).toEqual(['위치', '서점 앞']);
  });

  it('leaves a fence the turn did not end on as the code block it is', () => {
    render(row(['```status', '위치: 여관 로비', '```', '', '그리고 문이 열렸다.'].join('\n')));

    expect(card()).toBeNull();
    expect(host.querySelector('.code-block')).not.toBeNull();
    expect(host.textContent).toContain('그리고 문이 열렸다.');
  });

  it('leaves a fence still being written as the text it currently is', () => {
    render(row(['문이 닫혔다.', '```status', '위치: 여관 로'].join('\n'), { streaming: true }));
    expect(card()).toBeNull();
    expect(host.textContent).toContain('위치: 여관 로');
  });
});

describe('the choices a turn offers', () => {
  it('are buttons under the turn that made the offer', async () => {
    const filled: string[] = [];
    render(row(reply, { onChoice: (choice: string) => filled.push(choice) }));

    expect(choices().map((button) => button.textContent)).toEqual([
      '방을 둘러본다',
      '문을 다시 연다',
    ]);
    // Clicking fills the composer; sending is still the reader's own move.
    await press(choices()[0]!);
    expect(filled).toEqual(['방을 둘러본다']);
  });

  it('are drawn nowhere else, and their lines are not left as prose either', () => {
    render(row(reply));
    expect(host.querySelector('[data-testid="message-choices"]')).toBeNull();
    expect(host.textContent).not.toContain('방을 둘러본다');
  });

  it('stay away while the turn is still being written', () => {
    render(row(reply, { streaming: true, onChoice: () => undefined }));
    expect(choices()).toHaveLength(0);
  });

  it('leave a `>>` in the middle of a turn alone, because that is prose', () => {
    render(row(['>> 방을 둘러본다', '', '문이 열렸다.'].join('\n'), { onChoice: () => undefined }));
    expect(choices()).toHaveLength(0);
    expect(host.textContent).toContain('방을 둘러본다');
  });
});
