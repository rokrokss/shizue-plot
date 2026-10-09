// @vitest-environment jsdom
/**
 * A turn drawn by who is speaking in it.
 *
 * A reply is one message and one string, and the speakers inside it are a content
 * convention — so everything about telling them apart happens at render time,
 * against the roster the plot read brought back. What that has to hold: the
 * narrator stands outside the dialogue with no face at all, a character's lines
 * carry theirs, the two interleave in the order they were written, and a turn of
 * the reader's own is never split by any of it.
 *
 * `createElement` rather than JSX, matching `messageRow.test.ts`.
 */
import { NextIntlClientProvider } from 'next-intl';
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageRow } from '../src/components/MessageRow';
import type { MessageRole, PublicMember } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

const messages = {
  chat: {
    edit: '수정',
    editUserHint: '힌트',
    generating: '생성 중…',
    sceneHint: '장면 힌트',
    swipePrev: '이전 응답',
    swipeNext: '다음 응답',
    copyMessage: '메시지 복사',
    copied: '복사됨',
    editMessage: '메시지 수정',
    deleteMessage: '삭제',
  },
  common: { cancel: '취소', save: '저장', saving: '저장 중…' },
};

/** One face on the roster and one without, so both halves of Avatar are covered. */
const ROSTER: PublicMember[] = [
  { id: 'c1', name: '아리아', avatarUrl: '/avatars/aria.png' },
  { id: 'c2', name: '카이', avatarUrl: null },
];

function render(element: ReactElement): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        timeZone: 'Asia/Seoul',
        messages,
        children: element,
      }),
    );
  });
}

const row = (content: string, role: MessageRole = 'assistant', extra: Record<string, unknown> = {}) =>
  createElement(MessageRow, {
    role,
    content,
    name: role === 'user' ? '나' : '겨울의 문',
    avatar: '/covers/plot.png',
    roster: ROSTER,
    assets: new Map(),
    streaming: false,
    ...extra,
  });

/** The names a message says, in the order it says them. */
const speakers = (): string[] =>
  [...host.querySelectorAll('[data-testid="speech-character"]')].map(
    (node) => node.getAttribute('data-speaker') ?? '',
  );

/** The runs the narrator has in it. */
const narrations = (): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>('[data-testid="speech-narration"]'),
];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a reply with several speakers in it', () => {
  const content = '비가 그치지 않았다.\n아리아: 아직도 안 그쳤네.\n카이: 조금만 더 기다려 보자.\n문이 닫혔다.';

  it('names each character where they speak, in order', () => {
    render(row(content));
    expect(speakers()).toEqual(['아리아', '카이']);
  });

  it('gives each character their own face, and the narrator none', () => {
    render(row(content));
    const faces = [...host.querySelectorAll('.message-body img')];
    expect(faces).toHaveLength(1);
    expect(faces[0]!.getAttribute('src')).toBe('/avatars/aria.png');
    // A member without an avatar still gets their initial rather than the cover.
    expect(host.querySelector('.message-body span[aria-hidden]')?.textContent).toBe('카');
    // Nothing of the plot's cover: the row no longer speaks for the reply.
    expect([...host.querySelectorAll('img')].map((node) => node.getAttribute('src'))).toEqual([
      '/avatars/aria.png',
    ]);
    expect(host.textContent).not.toContain('겨울의 문');
  });

  it('sets the narrator apart from the lines that are spoken', () => {
    render(row(content));
    const narration = narrations();
    expect(narration).toHaveLength(2);
    expect(narration[0]!.className).toContain('italic');
    expect(narration[0]!.className).toContain('text-muted');
    expect(narration[0]!.textContent).toContain('비가 그치지 않았다.');
    expect(narration[1]!.textContent).toContain('문이 닫혔다.');
    // Full width, so it stands outside the column the dialogue is indented into.
    expect(narration[0]!.querySelector('img')).toBeNull();
  });

  it('keeps a character\'s 상황묘사 inside their block, in the marks that dim it', () => {
    render(row('아리아: *문틈으로 밖을 살피며* 아직도 안 그쳤네.'));

    const block = host.querySelector('[data-testid="speech-character"]')!;
    expect(block.querySelector('span.text-xs')?.textContent).toBe('아리아');
    expect(block.querySelector('em')?.textContent).toBe('문틈으로 밖을 살피며');
    expect(block.textContent).toContain('아직도 안 그쳤네.');
  });
});

describe('a reply that is nothing but the scene', () => {
  it('is drawn full width, dimmed, with no face and no name', () => {
    render(row('비가 그치지 않았다.'));

    expect(speakers()).toEqual([]);
    expect(host.querySelector('img')).toBeNull();
    expect(narrations()).toHaveLength(1);
    expect(narrations()[0]!.className).toContain('italic');
  });
});

describe('a reply being written', () => {
  it('reads a half-written name as the scene, and as the speaker once it lands', () => {
    render(row('아리', 'assistant', { streaming: true }));
    expect(speakers()).toEqual([]);

    render(row('아리아: 아직', 'assistant', { streaming: true }));
    expect(speakers()).toEqual(['아리아']);
  });
});

describe('a plot whose members have not arrived yet', () => {
  it('leaves the row speaking for the reply, as it did before', () => {
    render(row('아리아: 아직도 안 그쳤네.', 'assistant', { roster: [] }));

    expect(host.textContent).toContain('겨울의 문');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/covers/plot.png');
    // Unsplit: the prefix is left in the text exactly as the model wrote it.
    expect(host.textContent).toContain('아리아: 아직도 안 그쳤네.');
  });
});

describe('a turn of the reader\'s own', () => {
  it('is one voice, never split by the roster', () => {
    render(row('아리아: 안녕 *손을 흔들며*', 'user'));

    expect(speakers()).toEqual([]);
    expect(host.querySelector('[data-testid="message-user"]')).not.toBeNull();
    // Their own bubble, and their 상황묘사 dimmed inside the line it was in.
    expect(host.querySelector('em')?.textContent).toBe('손을 흔들며');
    expect(host.textContent).toContain('아리아: 안녕');
  });

  it('is the narrator when the whole turn is prefixed, roster or not', () => {
    render(row('@: 비가 그쳤다', 'user'));

    expect(host.querySelector('[data-testid="message-narration"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="message-user"]')).toBeNull();
    expect(host.textContent).not.toContain('@:');
    expect(host.textContent).toContain('비가 그쳤다');
  });
});
