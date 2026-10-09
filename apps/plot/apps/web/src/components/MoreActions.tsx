'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, cx } from './ui';

export interface MoreAction {
  key: string;
  label: string;
  onSelect: () => void;
}

/**
 * The actions a row has no width for, behind one button. Used only where the
 * caller has already decided the row is too narrow — the same actions stay in
 * the row itself wherever it fits, so this never becomes the only way to reach
 * them.
 *
 * It opens upward: the action row it belongs to sits at the bottom of the
 * conversation, right above the composer.
 *
 * It says `role="menu"`, so it behaves like one: opening lands on the first
 * item, the arrows walk the rest, and Escape or a choice puts the reader back on
 * the button they came from.
 */
export function MoreActions({
  label,
  actions,
  className,
}: {
  label: string;
  actions: MoreAction[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  /** Shuts the menu and leaves the reader on the button they opened it from. */
  const close = useCallback((): void => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  // The items are reachable by the arrow keys and nothing else — a roving
  // tabIndex takes them out of the Tab order — so on open the first one has to
  // be handed the focus, or the keyboard has opened a menu it cannot walk.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      // The pointer has already chosen where to stand; only the keyboard's exits
      // put the focus back on the trigger.
      if (target instanceof Node && !wrapper.current?.contains(target)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        close();
        return;
      }
      // Tab walks on past the menu rather than cycling inside it: this is a
      // menu, not a dialog, and nothing in it is only reachable here. The focus
      // goes back to the trigger first, so the walk continues from the button
      // rather than from wherever the closing menu left it.
      if (event.key === 'Tab') {
        close();
        return;
      }
      const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      if (items.length === 0) return;
      const last = items.length - 1;
      const at = items.indexOf(document.activeElement as HTMLElement);
      // Both ends wrap, so a list this short is walked in one direction if that
      // is what the hand reaches for.
      const to: Record<string, number> = {
        ArrowDown: at >= last ? 0 : at + 1,
        ArrowUp: at <= 0 ? last : at - 1,
        Home: 0,
        End: last,
      };
      const next = to[event.key];
      if (next === undefined) return;
      event.preventDefault();
      items[next]!.focus();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  return (
    <div ref={wrapper} className={cx('relative', className)}>
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">⋯</span>
      </Button>
      {open ? (
        <div
          ref={menu}
          role="menu"
          className="absolute right-0 bottom-full z-20 mb-1 min-w-32 rounded-lg border border-line bg-raised p-1 shadow-lg"
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close();
                action.onSelect();
              }}
              className="block w-full rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap text-muted transition-colors hover:bg-surface hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
