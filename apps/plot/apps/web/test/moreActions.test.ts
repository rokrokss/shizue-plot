// @vitest-environment jsdom
/**
 * The overflow menu the action row hands its least-used buttons to on a phone.
 * Nothing is only reachable through it, so what is tested is the menu's own
 * behaviour: it opens, it does the thing, and it closes on everything that
 * should close it.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoreActions, type MoreAction } from '../src/components/MoreActions';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;
let onSelect: () => void;

/** Three of them where the walk itself is what is being tested. */
const THREE: MoreAction[] = ['자동', '수동', '되돌리기'].map((label) => ({
  key: label,
  label,
  onSelect: () => undefined,
}));

function render(actions?: MoreAction[]): void {
  act(() => {
    root.render(
      createElement(MoreActions, {
        label: '더보기',
        actions: actions ?? [{ key: 'auto', label: '자동', onSelect }],
      }),
    );
  });
}

const trigger = (): HTMLElement => host.querySelector<HTMLElement>('[aria-label="더보기"]')!;
const menu = (): HTMLElement | null => host.querySelector<HTMLElement>('[role="menu"]');
const items = (): HTMLElement[] => [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];

function click(node: Element): void {
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

beforeEach(() => {
  onSelect = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('MoreActions', () => {
  it('opens on the button and says so', () => {
    render();
    expect(menu()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    click(trigger());
    expect(menu()!.textContent).toBe('자동');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('runs the action it was picked for, and closes', () => {
    render();
    click(trigger());
    click(menu()!.querySelector('[role="menuitem"]')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it('closes on Escape', () => {
    render();
    click(trigger());
    press('Escape');
    expect(menu()).toBeNull();
  });

  /**
   * It says `role="menu"`, so it has to behave like one: the items are off the
   * Tab order and the arrows are how they are reached.
   */
  it('opens onto the first item and walks the rest with the arrows', () => {
    render(THREE);
    click(trigger());
    expect(items().every((node) => node.tabIndex === -1)).toBe(true);
    expect(document.activeElement).toBe(items()[0]);

    press('ArrowDown');
    expect(document.activeElement).toBe(items()[1]);
    // Both ends wrap.
    press('ArrowUp');
    press('ArrowUp');
    expect(document.activeElement).toBe(items()[2]);
    press('ArrowDown');
    expect(document.activeElement).toBe(items()[0]);

    press('End');
    expect(document.activeElement).toBe(items()[2]);
    press('Home');
    expect(document.activeElement).toBe(items()[0]);
  });

  it('leaves the reader on the button they opened it from', () => {
    render();
    click(trigger());
    press('Escape');
    expect(document.activeElement).toBe(trigger());

    click(trigger());
    click(items()[0]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger());
  });

  /** Tab walks on past the menu rather than cycling inside it — this is not a dialog. */
  it('closes on Tab', () => {
    render(THREE);
    click(trigger());
    press('Tab');
    expect(menu()).toBeNull();
  });

  it('closes on a press anywhere else, and stays open on one inside it', () => {
    render();
    click(trigger());
    act(() => {
      menu()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(menu()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(menu()).toBeNull();
  });
});
