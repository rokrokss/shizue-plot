// @vitest-environment jsdom
/**
 * A narrating turn, mounted.
 *
 * `@:` is a convention over the content of an ordinary message and the role does
 * not decide, so the row is the only thing that knows a narration from a line of
 * dialogue. What that has to hold: the prefix is never on screen, the speaker and
 * the bubble are gone, and editing still hands back the raw text — the reader
 * wrote the prefix and it is theirs to keep.
 *
 * `createElement` rather than JSX, matching `messageBody.test.ts`.
 */
import { NextIntlClientProvider } from 'next-intl';
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageRow } from '../src/components/MessageRow';
import type { MessageRole } from '../src/lib/types';

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

/** Fixed, so a formatted time means the same thing wherever the suite runs. */
const timeZone = 'Asia/Seoul';

function render(element: ReactElement): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, { locale: 'ko', timeZone, messages, children: element }),
    );
  });
}

const row = (content: string, role: MessageRole = 'user', extra: Record<string, unknown> = {}) =>
  createElement(MessageRow, {
    role,
    content,
    name: '나',
    avatar: null,
    assets: new Map(),
    streaming: false,
    ...extra,
  });

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a narrating user turn', () => {
  it('is drawn without the prefix, the speaker, or a bubble', () => {
    render(row('@: 문이 열리고 바람이 들이쳤다'));

    const narration = host.querySelector('[data-testid="message-narration"]');
    expect(narration).not.toBeNull();
    expect(host.querySelector('[data-testid="message-user"]')).toBeNull();
    expect(host.textContent).toContain('문이 열리고 바람이 들이쳤다');
    expect(host.textContent).not.toContain('@:');
    // No speaker, and none of the bubble the reader's own lines get.
    expect(host.textContent).not.toContain('나');
    expect(host.querySelector('.bg-surface')).toBeNull();
    expect(narration!.querySelector('.italic')).not.toBeNull();
  });

  it('still renders the markdown of its body', () => {
    render(row('@: *문이 열렸다*'));
    expect(host.querySelector('em')?.textContent).toBe('문이 열렸다');
  });

  it('opens the editor on the raw text, prefix included', async () => {
    render(row('@: 문이 열렸다', 'user', { onSave: async () => undefined }));

    const edit = [...host.querySelectorAll('button')].find((node) => node.textContent === '수정');
    expect(edit).toBeDefined();
    await act(async () => {
      edit!.click();
    });
    expect(host.querySelector('textarea')?.value).toBe('@: 문이 열렸다');
  });
});

describe('an ordinary turn', () => {
  it('keeps its bubble and its speaker', () => {
    render(row('문을 열었다'));
    expect(host.querySelector('[data-testid="message-user"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="message-narration"]')).toBeNull();
    expect(host.textContent).toContain('나');
  });

  it('keeps its bubble and its speaker as an assistant turn too', () => {
    render(row('문을 열었다', 'assistant', { name: '아리아' }));
    expect(host.querySelector('[data-testid="message-assistant"]')).not.toBeNull();
    expect(host.textContent).toContain('아리아');
  });
});

describe('a forked turn', () => {
  const nav = (extra: Record<string, unknown> = {}) => ({
    index: 1,
    total: 2,
    onPrev: () => undefined,
    onNext: () => undefined,
    ...extra,
  });

  const arrow = (glyph: string): HTMLButtonElement =>
    [...host.querySelectorAll('button')].find((node) => node.textContent === glyph)!;

  it('carries its own way back to the other version', () => {
    render(row('문을 열었다', 'assistant', { name: '아리아', branches: nav() }));

    expect(host.textContent).toContain('2/2');
    expect(arrow('◀')).toBeDefined();
    expect(arrow('▶')).toBeDefined();
    // The glyph is a picture of the direction, so the button says it in words.
    expect(arrow('◀').getAttribute('aria-label')).toBe('이전 응답');
    expect(arrow('▶').getAttribute('aria-label')).toBe('다음 응답');
    expect(arrow('◀').querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('moves between siblings, and stops at either end', async () => {
    const moved: string[] = [];
    render(
      row('문을 열었다', 'assistant', {
        name: '아리아',
        branches: nav({ index: 0, onPrev: null, onNext: () => moved.push('next') }),
      }),
    );

    expect(host.textContent).toContain('1/2');
    expect(arrow('◀').disabled).toBe(true);
    await act(async () => {
      arrow('▶').click();
    });
    expect(moved).toEqual(['next']);
  });

  it('offers the same way back on a narration, which has no speaker to sit beside', () => {
    render(row('@: 눈이 그쳤다', 'assistant', { name: '아리아', branches: nav() }));

    expect(host.querySelector('[data-testid="message-narration"]')).not.toBeNull();
    expect(host.textContent).toContain('2/2');
    // Hover-revealed, so a mid-path row stays quiet until it is asked for.
    expect(arrow('◀').parentElement!.className).toContain('opacity-0');
    expect(arrow('◀').parentElement!.className).toContain('group-hover:opacity-100');
  });

  it('is not drawn while the turn is still streaming', () => {
    render(row('눈이 그친', 'assistant', { name: '아리아', branches: nav(), streaming: true }));
    expect(host.textContent).not.toContain('2/2');
  });
});

describe('a generated narration', () => {
  it('is drawn the same way a reader\'s is — the role does not decide', () => {
    render(row('@: 눈이 그쳤다', 'assistant', { name: '아리아', avatar: '/avatar.png' }));

    const narration = host.querySelector('[data-testid="message-narration"]');
    expect(narration).not.toBeNull();
    expect(host.querySelector('[data-testid="message-assistant"]')).toBeNull();
    expect(host.textContent).toContain('눈이 그쳤다');
    expect(host.textContent).not.toContain('@:');
    // No speaker, and none of the character's own chrome: no name, no avatar.
    expect(host.textContent).not.toContain('아리아');
    expect(host.querySelector('img')).toBeNull();
    expect(narration!.querySelector('.italic')).not.toBeNull();
  });
});

describe('the inline editor', () => {
  const open = async (onSave: (content: string) => Promise<void>): Promise<HTMLTextAreaElement> => {
    render(row('문을 열었다', 'user', { onSave }));
    const edit = [...host.querySelectorAll('button')].find((node) => node.textContent === '수정')!;
    await act(async () => {
      edit.click();
    });
    return host.querySelector('textarea')!;
  };

  const press = async (node: HTMLElement, init: KeyboardEventInit): Promise<void> => {
    await act(async () => {
      node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    });
  };

  it('says what the field is for, which the placeholder-less box cannot', async () => {
    const area = await open(async () => undefined);
    expect(area.getAttribute('aria-label')).toBe('메시지 수정');
    // The edit is the reader's to type into the moment they ask for it.
    expect(document.activeElement).toBe(area);
  });

  it('saves on Cmd+Enter, because Enter belongs to the text', async () => {
    const saved: string[] = [];
    const area = await open(async (content) => void saved.push(content));

    await press(area, { key: 'Enter' });
    expect(saved).toEqual([]);

    await press(area, { key: 'Enter', metaKey: true });
    expect(saved).toEqual(['문을 열었다']);
    // Saved and closed: the row is back to showing what it says.
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('leaves the message as it was on Escape', async () => {
    const saved: string[] = [];
    const area = await open(async (content) => void saved.push(content));

    await press(area, { key: 'Escape' });
    expect(host.querySelector('textarea')).toBeNull();
    expect(saved).toEqual([]);
  });

  it('stays put while an IME is mid-composition, whose Escape is not ours', async () => {
    const area = await open(async () => undefined);
    await press(area, { key: 'Escape', isComposing: true });
    expect(host.querySelector('textarea')).not.toBeNull();
  });
});

describe('the furniture on a row', () => {
  const button = (label: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll('button')].find((node) => node.textContent === label);

  it('copies the message as it was written, and says so for a moment', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });

    render(row('문을 열었다'));
    await act(async () => {
      button('메시지 복사')!.click();
    });
    expect(written).toEqual(['문을 열었다']);
    expect(button('복사됨')).toBeDefined();
  });

  it('copies a narration without the prefix, which is markup and not text', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });

    render(row('@: 문이 열렸다'));
    await act(async () => {
      button('메시지 복사')!.click();
    });
    expect(written).toEqual(['문이 열렸다']);
  });

  it('offers a delete only where the page hands one down', async () => {
    render(row('문을 열었다'));
    expect(button('삭제')).toBeUndefined();

    const deleted: string[] = [];
    render(row('문을 열었다', 'user', { onDelete: () => deleted.push('gone') }));
    const remove = button('삭제')!;
    // Destructive, and quiet until the row is asked about.
    expect(remove.className).toContain('opacity-0');
    expect(remove.className).toContain('hover:text-danger');
    await act(async () => {
      remove.click();
    });
    expect(deleted).toEqual(['gone']);
  });

  it('keeps its actions to itself while the turn is streaming', () => {
    render(row('문을 여', 'assistant', { name: '아리아', streaming: true, onDelete: () => undefined }));
    expect(button('메시지 복사')).toBeUndefined();
    expect(button('삭제')).toBeUndefined();
  });

  it('carries the time it was stored, revealed on hover', () => {
    const createdAt = new Date(2026, 7, 11, 9, 5).toISOString();
    render(row('문을 열었다', 'user', { createdAt }));

    const stamp = host.querySelector('time')!;
    expect(stamp.getAttribute('datetime')).toBe(createdAt);
    expect(stamp.textContent).toBe(
      new Intl.DateTimeFormat('ko', { timeStyle: 'short', timeZone }).format(new Date(createdAt)),
    );
    expect(stamp.className).toContain('opacity-0');
    expect(stamp.className).toContain('group-hover:opacity-100');
    // Nothing to show for a turn that is not stored yet.
    render(row('문을 열었다'));
    expect(host.querySelector('time')).toBeNull();
  });

  it('says the speaker once for a run of turns', () => {
    render(row('첫 줄', 'assistant', { name: '아리아', avatar: '/avatar.png' }));
    expect(host.textContent).toContain('아리아');
    expect(host.querySelector('img')).not.toBeNull();

    render(row('이어서', 'assistant', { name: '아리아', avatar: '/avatar.png', grouped: true }));
    expect(host.textContent).not.toContain('아리아');
    expect(host.querySelector('img')).toBeNull();
    // The avatar's space is kept, so the run stays in one column.
    expect(host.querySelector('[data-testid="message-assistant"] > .size-9')).not.toBeNull();
  });
});

it('locks editing and cancellation until save settles, preserving a rejected draft', async () => {
  let fail!: (error: Error) => void;
  let calls = 0;
  render(row('보존할 메시지', 'user', { onSave: () => { calls++; return new Promise((_resolve, reject) => { fail = reject; }); } }));
  const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  await act(async () => button('수정').click());
  await act(async () => button('저장').click());
  expect(host.querySelector('textarea')!.matches(':disabled')).toBe(true);
  expect(button('취소').matches(':disabled')).toBe(true);
  await act(async () => button('저장').click());
  expect(calls).toBe(1);
  await act(async () => fail(new Error('save failed')));
  expect(host.querySelector('textarea')!.value).toBe('보존할 메시지');
  expect(host.querySelector('textarea')!.matches(':disabled')).toBe(false);
});
