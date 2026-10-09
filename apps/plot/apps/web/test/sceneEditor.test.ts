// @vitest-environment jsdom
/**
 * The scene editor, mounted.
 *
 * The scene is a run of messages edited as one block of text each, and what the
 * server needs back is exact: narration without the prefix it owns, every block
 * that came from a message still carrying its id, and the order the reader left
 * them in. That mapping is the whole of this component, so it is what is tested.
 *
 * `createElement` rather than JSX, matching `messageRow.test.ts`.
 */
import { NextIntlClientProvider } from 'next-intl';
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SceneEditor, type SceneBlock } from '../src/components/SceneEditor';
import type { ChatMessage, MessageRole } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

const messages = {
  chat: {
    sceneTitle: '장면 편집',
    sceneHint: '힌트',
    sceneNarration: '나레이션',
    sceneRemove: '블록 삭제',
    sceneAddNarration: '나레이션 추가',
    sceneAddDialogue: '대사 추가',
    lockedWhileGenerating: '생성 중에는 바꿀 수 없습니다.',
  },
  common: { cancel: '취소', save: '저장', saving: '저장 중…' },
};

const message = (id: string, role: MessageRole, content: string): ChatMessage => ({
  id,
  parentId: null,
  role,
  content,
  source: 'user',
  directions: null,
  model: null,
  promptTokens: null,
  completionTokens: null,
  attachments: [],
  createdAt: '2026-01-01T00:00:00.000Z',
});

const scene = [
  message('narration-1', 'user', '@: 문이 열린다'),
  message('reply-1', 'assistant', '누구세요?'),
];

function render(element: ReactElement): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, { locale: 'ko', messages, children: element }),
    );
  });
}

function editor(onSave: (blocks: SceneBlock[]) => Promise<void>, disabled = false): ReactElement {
  return createElement(SceneEditor, {
    scene,
    characterName: '아리아',
    youName: '나',
    disabled,
    onCancel: () => undefined,
    onSave,
  });
}

/** Types into a controlled textarea the way React reads it back. */
function type(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const areas = (): HTMLTextAreaElement[] => [...host.querySelectorAll('textarea')];

const button = (label: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;

const click = async (node: HTMLElement): Promise<void> => {
  await act(async () => {
    node.click();
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the scene editor', () => {
  it('opens one block per message, narration without its prefix', () => {
    render(editor(async () => undefined));

    expect(areas().map((area) => area.value)).toEqual(['문이 열린다', '누구세요?']);
    expect(host.textContent).toContain('나레이션');
    expect(host.textContent).toContain('아리아');
    // Whose block it is, on the field as well as over it.
    expect(areas().map((area) => area.getAttribute('aria-label'))).toEqual(['나레이션', '아리아']);
  });

  it('sends every block back with the id it came from, changed or not', async () => {
    const saved: SceneBlock[][] = [];
    render(editor(async (blocks) => void saved.push(blocks)));

    type(areas()[1]!, '거기 누구야?');
    await click(button('저장'));

    expect(saved).toEqual([
      [
        { originId: 'narration-1', kind: 'narration', content: '문이 열린다' },
        { originId: 'reply-1', kind: 'dialogue', content: '거기 누구야?' },
      ],
    ]);
  });

  it('adds a block of the kind it was added as, and drops one', async () => {
    const saved: SceneBlock[][] = [];
    render(editor(async (blocks) => void saved.push(blocks)));

    await click(button('나레이션 추가'));
    type(areas()[2]!, '복도에 불이 들어온다');
    // The first block goes; the added one has no origin to carry.
    await click([...host.querySelectorAll('button')].find((node) => node.textContent === '블록 삭제')!);
    await click(button('저장'));

    expect(saved).toEqual([
      [
        { originId: 'reply-1', kind: 'dialogue', content: '누구세요?' },
        { kind: 'narration', content: '복도에 불이 들어온다' },
      ],
    ]);
  });

  it('will not save an empty block, or anything while a reply streams', async () => {
    render(editor(async () => undefined));
    type(areas()[0]!, '   ');
    expect(button('저장').disabled).toBe(true);

    type(areas()[0]!, '문이 열린다');
    expect(button('저장').disabled).toBe(false);

    render(editor(async () => undefined, true));
    expect(button('저장').disabled).toBe(true);
  });
});

it('freezes the submitted scene and keeps it after a failed save', async () => {
  let fail!: (error: Error) => void;
  render(editor(() => new Promise((_resolve, reject) => { fail = reject; })));
  type(areas()[0]!, '저장할 장면');
  await click(button('저장'));
  expect(areas().every((area) => area.matches(':disabled'))).toBe(true);
  expect(button('취소').matches(':disabled')).toBe(true);
  expect([...host.querySelectorAll('button')].every((node) => node.matches(':disabled'))).toBe(true);
  await act(async () => fail(new Error('save failed')));
  expect(areas()[0]!.value).toBe('저장할 장면');
  expect(areas()[0]!.matches(':disabled')).toBe(false);
});
