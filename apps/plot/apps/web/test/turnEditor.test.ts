// @vitest-environment jsdom
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../messages/ko.json';
import { TurnEditor } from '../src/components/TurnEditor';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** The panel, recording what it was asked to do. */
function open(initial: string, onSave: (text: string) => Promise<void> = async () => undefined, disabled = false) {
  const done: string[] = [];
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(TurnEditor, {
          initial,
          label: '메시지 수정',
          disabled,
          onCancel: () => done.push('cancel'),
          onSave: async (text: string) => {
            done.push(`save:${text}`);
            await onSave(text);
          },
        }) as ReactElement,
      }),
    );
  });
  const area = host.querySelector('textarea')!;
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  return { done, area, button };
}

const press = async (node: HTMLElement, init: KeyboardEventInit): Promise<void> => {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
};

const type = async (area: HTMLTextAreaElement, value: string): Promise<void> => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    set.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('the editor in the composer’s place', () => {
  it('says what the field is for, holds the text whole, and puts the caret at its end', () => {
    const { area } = open('@헤이즈: *이를 악문다.*\n\n…씨발.');
    expect(area.getAttribute('aria-label')).toBe('메시지 수정');
    expect(area.value).toBe('@헤이즈: *이를 악문다.*\n\n…씨발.');
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe(area.value.length);
  });

  it('saves with ✓ or Cmd+Enter, Enter being the text’s own', async () => {
    const { done, area, button } = open('문을 열었다');
    await type(area, '문을 닫았다');
    await press(area, { key: 'Enter' });
    expect(done).toEqual([]);
    await press(area, { key: 'Enter', metaKey: true });
    expect(done).toEqual(['save:문을 닫았다']);
    await act(async () => button('저장').click());
    expect(done).toEqual(['save:문을 닫았다', 'save:문을 닫았다']);
  });

  it('closes without a request when nothing changed, and on ✕ or Escape', async () => {
    const { done, area, button } = open('문을 열었다');
    await act(async () => button('저장').click());
    await act(async () => button('취소').click());
    await press(area, { key: 'Escape' });
    expect(done).toEqual(['cancel', 'cancel', 'cancel']);
  });

  it('leaves Escape to an IME mid-composition', async () => {
    const { done, area } = open('문을 열었다');
    await press(area, { key: 'Escape', isComposing: true });
    expect(done).toEqual([]);
  });

  it('wraps a direction in stars as the composer’s * does', async () => {
    const { area, button } = open('');
    await act(async () => button('지문').click());
    expect(area.value).toBe('**');
  });

  it('holds still while a save is out, and keeps the text when it fails', async () => {
    let fail!: (error: Error) => void;
    const { done, area, button } = open('보존할 메시지', () => new Promise((_resolve, reject) => void (fail = reject)));
    await type(area, '고친 메시지');
    await act(async () => button('저장').click());
    expect(area.matches(':disabled')).toBe(true);
    await act(async () => button('저장').click());
    expect(done).toEqual(['save:고친 메시지']);
    await act(async () => fail(new Error('save failed')));
    expect(area.value).toBe('고친 메시지');
    expect(area.matches(':disabled')).toBe(false);
  });

  it('will not save an empty text, or anything while a reply streams', () => {
    expect(open('   ').button('저장').disabled).toBe(true);
    expect(open('문을 열었다', undefined, true).button('저장').disabled).toBe(true);
  });
});
