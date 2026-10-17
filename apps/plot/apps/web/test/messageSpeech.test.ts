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
    sceneHint: '장면 힌트',
    swipePrev: '이전 응답',
    swipeNext: '다음 응답',
    copyMessage: '메시지 복사',
    copied: '복사됨',
    editMessage: '메시지 수정',
    deleteMessage: '삭제',
    thinking: '생각 중…',
    typing: '{name} 입력 중…',
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

describe('a member the card gives a nickname', () => {
  it('speaks under it with their own face and name', () => {
    const nicknamed: PublicMember[] = [{ ...ROSTER[0]!, nickname: '아리 씨' }, ROSTER[1]!];
    render(row('아리 씨: 왔어?\n카이: 응.', 'assistant', { roster: nicknamed }));

    expect(speakers()).toEqual(['아리아', '카이']);
    expect(host.querySelector('.message-body img')?.getAttribute('src')).toBe('/avatars/aria.png');
    expect(host.textContent).not.toContain('아리 씨');
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

describe('a message a card’s script wrote as its character', () => {
  it('is drawn as that character’s own, with their face and name, and no narration', () => {
    render(row('*문틈으로 밖을 살피며* 아직도 안 그쳤네.\n카이: 조금만 더.', 'assistant', { speaker: '아리아' }));

    expect(speakers()).toEqual(['아리아', '카이']);
    expect(narrations()).toHaveLength(0);
    expect(host.querySelector('.message-body img')?.getAttribute('src')).toBe('/avatars/aria.png');
    expect(host.querySelector('[data-testid="speech-character"] em')?.textContent).toBe('문틈으로 밖을 살피며');
  });
});

describe('a reply in a work of one member', () => {
  const SOLE: PublicMember[] = [ROSTER[0]!];

  it('is that character\'s whole: its unprefixed lines are their 지문, inside their block', () => {
    render(row('창밖은 아직 어둡다.\n아리아: 안녕 *웃으며* 반가워\n\n난로의 불이 낮게 탄다.', 'assistant', { roster: SOLE }));

    expect(speakers()).toEqual(['아리아']);
    expect(narrations()).toHaveLength(0);
    const block = host.querySelector('[data-testid="speech-character"]')!;
    expect(block.textContent).toContain('창밖은 아직 어둡다.');
    expect(block.textContent).toContain('난로의 불이 낮게 탄다.');
    // The *지문* inside a spoken line is still dimmed where it was written.
    expect(block.querySelector('em')?.textContent).toBe('웃으며');
    // One face, the member's — the row no longer speaks for the reply.
    expect([...host.querySelectorAll('img')].map((node) => node.getAttribute('src'))).toEqual(['/avatars/aria.png']);
  });

  it('is theirs from its first unprefixed word while it streams, not the scene\'s', () => {
    render(row('창밖은', 'assistant', { roster: SOLE, streaming: true }));
    expect(speakers()).toEqual(['아리아']);
    expect(narrations()).toHaveLength(0);
  });
});

describe('a group reply stored under its speaker', () => {
  it('is that member\'s whole, its unprefixed lines included', () => {
    render(row('*잔을 내려놓으며* 왔어?\n문 밖에서 바람이 분다.', 'assistant', { speaker: '카이' }));

    expect(speakers()).toEqual(['카이']);
    expect(narrations()).toHaveLength(0);
    expect(host.querySelector('[data-testid="speech-character"]')!.textContent).toContain('문 밖에서 바람이 분다.');
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

/**
 * Zeta's write-as (core `readerRuns`): a reader's `@이름: …` line is that member's
 * line written by the reader, and `@내레이터: …` or `@: …` is narration. Stored as
 * typed, drawn as who it is by.
 */
describe('a turn the reader wrote partly as others', () => {
  const runs = (): string[] =>
    [...host.querySelectorAll('[data-testid="reader-runs"] > div')].map(
      (node) => node.getAttribute('data-testid') ?? 'reader-user',
    );

  it('keeps the reader’s own lines in their bubble, a member’s as that member’s speech, narration as narration', () => {
    render(row('안녕 *손을 흔든다*\n@카이: 반가워.\n@카이: 오랜만이네.\n@내레이터: 바람이 분다.\n다시 나.', 'user'));

    expect(host.querySelector('[data-testid="message-user"]')).not.toBeNull();
    expect(runs()).toEqual(['reader-user', 'reader-member', 'reader-narration', 'reader-user']);
    // The member's face and name, with both lines in one block and no marker left.
    expect(speakers()).toEqual(['카이']);
    const spoken = host.querySelector('[data-testid="speech-character"]')!;
    expect(spoken.textContent).toContain('반가워.');
    expect(spoken.textContent).toContain('오랜만이네.');
    // Narration as a narration row has it: no label, the ≡ and italics, no bubble.
    const narration = host.querySelector('[data-testid="reader-narration"]')!;
    expect(narration.textContent).toBe('바람이 분다.');
    expect(narration.querySelector('.chat-narration.italic')).not.toBeNull();
    expect(narration.querySelector('.user-bubble, .chat-bubble')).toBeNull();
    expect(host.textContent).not.toContain('@');
    // The reader's own stretches keep their bubble and their 상황묘사.
    const bubbles = [...host.querySelectorAll('[data-testid="reader-runs"] .user-bubble')];
    expect(bubbles.map((node) => node.textContent)).toEqual(['안녕 손을 흔든다', '다시 나.']);
  });

  it('reads a member by its nickname and a bare `@:` line as narration, and a name nobody has as the reader’s', () => {
    const nicknamed: PublicMember[] = [{ ...ROSTER[0]!, nickname: '아리' }, ROSTER[1]!];
    render(row('@아리: 왔어\n@: 비가 그쳤다\n@유령: 누구?', 'user', { roster: nicknamed }));

    expect(speakers()).toEqual(['아리아']);
    expect(host.querySelector('.message-body img')?.getAttribute('src')).toBe('/avatars/aria.png');
    expect(host.querySelector('[data-testid="reader-narration"]')?.textContent).toContain('비가 그쳤다');
    expect(host.textContent).toContain('@유령: 누구?');
  });

  it('edits the turn as it was typed, markers and all', async () => {
    render(row('@카이: 반가워.', 'user', { onSave: async () => undefined }));
    const edit = [...host.querySelectorAll('button')].find((node) => node.textContent === '수정')!;
    await act(async () => {
      edit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.querySelector('textarea')?.value).toBe('@카이: 반가워.');
  });
});

describe('a reply a round is waiting on', () => {
  it('shows whose it will be, by face and name, before any of it arrives', () => {
    render(row('', 'assistant', { streaming: true, thinking: true, typing: { name: '아리아', avatarUrl: '/avatars/aria.png' } }));

    const typing = host.querySelector('[data-testid="typing"]')!;
    expect(typing.getAttribute('data-speaker')).toBe('아리아');
    // The face says it to the eye, the words to a screen reader.
    expect(typing.textContent).toBe('아리아 입력 중…');
    expect(typing.querySelector('.waiting-dots')).not.toBeNull();
    expect(typing.querySelector('img')?.getAttribute('src')).toBe('/avatars/aria.png');
  });

  it('holds its actions over the gap above it when it opens on a title, not in a line of their own', () => {
    render(row('# 은빛 여관\n\n눈이 내린다.', 'assistant', { roster: [ROSTER[0]!], intro: true, createdAt: new Date().toISOString() }));

    const time = host.querySelector('time')!;
    expect(time.parentElement!.className).toContain('absolute');
    expect(time.parentElement!.className).toContain('bottom-full');
    // The title is the first thing in the flow.
    expect(host.querySelector('.message-body')!.firstElementChild?.getAttribute('data-testid')).toBe('scene-heading');
  });

  it('waits under the reply a continue goes on from, with no second face', () => {
    render(row('*책을 덮는다.* 그래서', 'assistant', { roster: [ROSTER[0]!], streaming: true, thinking: true }));

    // The reply's own face once, and the dots after its bubble — the reply
    // still being written, so as written.
    expect(host.querySelectorAll('img')).toHaveLength(1);
    const bubbles = [...host.querySelectorAll('.chat-bubble')];
    expect(bubbles.map((node) => node.textContent)).toEqual(['*책을 덮는다.* 그래서', '생각 중…']);
  });

});

describe('a scene title in a greeting', () => {
  const GREETING = '# 아스텔리아 아카데미\n입학식 날 아침이었다.\n\n## 사역마와의 계약\n마법진이 빛난다.';

  /**
   * The body's own children that are its flow — titles, and speakers' blocks by
   * the name each says — past the row's actions over the gap above it.
   */
  const flow = (): string[] =>
    [...host.querySelector('.message-body')!.children].flatMap((node) =>
      node.getAttribute('data-testid') === 'scene-heading'
        ? [`title:${node.textContent}`]
        : node.getAttribute('data-testid') === 'speech-character'
          ? [`block:${node.querySelector('.chat-name')?.textContent ?? '-'}:${node.querySelector('.chat-bubble')?.textContent}`]
          : node.className.includes('bottom-full')
            ? []
            : [`other:${node.textContent}`],
    );

  it('stands above the face and the name at the column’s width, and the speaker goes on under a later one unnamed', () => {
    render(row(GREETING, 'assistant', { roster: [ROSTER[0]!], intro: true }));

    expect(flow()).toEqual([
      'title:아스텔리아 아카데미',
      'block:아리아:입학식 날 아침이었다.',
      'title:사역마와의 계약',
      'block:-:마법진이 빛난다.',
    ]);
    // One face: the second stretch keeps the column and says nothing again.
    expect([...host.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(['/avatars/aria.png']);
  });

  it('does the same under the work’s own face where no roster names the speaker', () => {
    render(row(GREETING, 'assistant', { roster: [], intro: true, footer: createElement('div', { 'data-testid': 'actions' }) }));

    expect(flow()).toEqual([
      'title:아스텔리아 아카데미',
      'block:겨울의 문:입학식 날 아침이었다.',
      'title:사역마와의 계약',
      'block:-:마법진이 빛난다.',
    ]);
    expect([...host.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(['/covers/plot.png']);
    // What hangs under the bubble stays in the bubble's column.
    expect(host.querySelector('[data-testid="actions"]')!.parentElement!.className).toBe('pl-12.5');
  });

  it('stays a bold line inside the bubble of a reply', () => {
    render(row('# 아스텔리아 아카데미\n입학식 날 아침이었다.', 'assistant', { roster: [] }));

    expect(host.querySelector('[data-testid="scene-heading"]')).toBeNull();
    expect(host.querySelector('.chat-bubble h1')?.textContent).toBe('아스텔리아 아카데미');
  });
});
