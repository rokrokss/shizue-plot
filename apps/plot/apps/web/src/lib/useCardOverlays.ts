'use client';

/**
 * The way out of a card's floating screen.
 *
 * A RisuAI card may draw a menu, a panel or a shade with `position: fixed`, and
 * in the chat that floats over the whole conversation (`.chat-stage`,
 * globals.css) — never over the header or the composer, but over every message
 * and every control among them. A card that opens one and offers no way to close
 * it, or whose way to close it is broken, would leave the reader stuck behind it.
 * So while one is open the chat header offers "close card screen" (and Esc does
 * the same): the card's own toggle undone where it has one, its overlays hidden
 * where it has not, until the card moves again.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** A message's card markup: the blocks a card's `fixed` reaches the stage from. */
const CARD_MARKUP = '.message-body .shizue-msg';

/** Whether an element is on screen: shown, with a size. */
function shown(element: HTMLElement): boolean {
  if (getComputedStyle(element).visibility === 'hidden') return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

/**
 * Each block's `fixed` elements, shown or not, and the stylesheets they were read
 * under (`sheets`). Reading every element's style is the costly part of a look —
 * a reply being written changes the stage on every token, and a long chat holds
 * thousands of elements of card markup — so it is done once per block and again
 * only when that block's markup changes (`forgetCardMarkup`), or any sheet does.
 */
const fixedOf = new WeakMap<Element, { sheets: number; elements: HTMLElement[] }>();
let sheets = 0;

function fixedIn(block: HTMLElement): HTMLElement[] {
  const kept = fixedOf.get(block);
  if (kept && kept.sheets === sheets) return kept.elements;
  const elements: HTMLElement[] = [];
  for (const element of block.querySelectorAll<HTMLElement>('*')) {
    if (getComputedStyle(element).position === 'fixed') elements.push(element);
  }
  fixedOf.set(block, { sheets, elements });
  return elements;
}

const holdsSheet = (node: Node): boolean =>
  node.nodeName === 'STYLE' || (node instanceof Element && node.querySelector('style') !== null);

/**
 * Forgets what changes of markup made stale: the block a change was in, and —
 * where a stylesheet came or went, since a sheet in one block dresses them all —
 * every block.
 */
export function forgetCardMarkup(records: readonly MutationRecord[]): void {
  for (const record of records) {
    if ([...record.addedNodes, ...record.removedNodes].some(holdsSheet)) sheets += 1;
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    const block = target?.closest(CARD_MARKUP);
    if (block) fixedOf.delete(block);
  }
}

/**
 * The card overlays open under `stage`: elements of a message's card markup with
 * `position: fixed` that are shown and have a size.
 */
export function openCardOverlays(stage: ParentNode): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const block of stage.querySelectorAll<HTMLElement>(CARD_MARKUP)) {
    for (const element of fixedIn(block)) if (element.isConnected && shown(element)) found.push(element);
  }
  return found;
}

/** An element's own `display`, as it was before it was closed. */
interface Closed {
  value: string;
  priority: string;
}

/**
 * Closes the card overlays open under `stage`, and answers whether any was.
 *
 * The card's own toggle first: a checked box or radio in the markup an overlay
 * is drawn in is unchecked, and kept unchecked where that hid an overlay — that
 * is how the card itself would close it, so the card's state and its screen
 * agree. If that closed anything, that is the press: what the card keeps
 * floating whatever the reader does (a menu button, a gauge) stays, and a second
 * press takes it down. Otherwise every open overlay is hidden (`closed`), its own
 * inline `display` kept to put back: until the reader next touches the card's
 * markup, or the card draws it again (a new element, which nothing hid).
 */
export function closeCardOverlays(stage: ParentNode, closed: Map<HTMLElement, Closed>): boolean {
  let open = openCardOverlays(stage);
  if (open.length === 0) return false;
  const before = open.length;
  const blocks = new Set(open.map((element) => element.closest<HTMLElement>(CARD_MARKUP)));
  for (const block of blocks) {
    if (!block) continue;
    // Only checkboxes and radios survive the sanitizer.
    for (const input of block.querySelectorAll<HTMLInputElement>('input:checked')) {
      // The markup's own `checked` too, so the markup says what the box does.
      const written = input.hasAttribute('checked');
      input.checked = false;
      input.removeAttribute('checked');
      const still = open.filter(shown);
      if (still.length < open.length) {
        open = still;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        if (written) input.setAttribute('checked', '');
        input.checked = true;
      }
    }
  }
  // What the reader opened is closed; what the card keeps floating — a menu
  // button, a gauge — stays, and the next press takes it down too.
  if (open.length < before) return true;
  for (const element of openCardOverlays(stage)) {
    if (!closed.has(element)) {
      closed.set(element, {
        value: element.style.getPropertyValue('display'),
        priority: element.style.getPropertyPriority('display'),
      });
    }
    element.style.setProperty('display', 'none', 'important');
  }
  return true;
}

/** Puts back what `closeCardOverlays` hid, where it is still on the page. */
export function reopenCardOverlays(closed: Map<HTMLElement, Closed>): void {
  for (const [element, was] of closed) {
    if (!element.isConnected) continue;
    if (was.value) element.style.setProperty('display', was.value, was.priority);
    else element.style.removeProperty('display');
  }
  closed.clear();
}

/**
 * Whether a card overlay is open under `stage`, and the way to close it.
 *
 * Looked for again whenever the reader touches the stage (a CSS-only toggle
 * changes what is shown without changing the markup) or the window resizes —
 * once a frame at most — and when the stage's markup changes, at most every
 * `MARKUP_LOOK_MS`: a reply being written changes it on every token, and a look
 * reads the style of every element of every card on the stage.
 */
/** How often a change of the stage's markup alone looks again. */
const MARKUP_LOOK_MS = 250;

export function useCardOverlays(
  stage: HTMLElement | null,
  enabled: boolean,
): { open: boolean; close: () => void } {
  const [open, setOpen] = useState(false);
  const closed = useRef(new Map<HTMLElement, Closed>());
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const root = stage;
    if (!enabled || !root) {
      setOpen(false);
      return;
    }
    let looked = 0;
    let later: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        looked = performance.now();
        setOpen(openCardOverlays(root).length > 0);
      });
    };
    const scheduleSoon = (): void => {
      if (later !== null || frame.current !== null) return;
      later = setTimeout(() => {
        later = null;
        schedule();
      }, Math.max(0, looked + MARKUP_LOOK_MS - performance.now()));
    };
    // The reader touching the card's markup is the card moving again.
    const touched = (event: Event): void => {
      if ((event.target as Element | null)?.closest?.(CARD_MARKUP)) reopenCardOverlays(closed.current);
    };
    const observer = new MutationObserver((records) => {
      forgetCardMarkup(records);
      scheduleSoon();
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'open'] });
    const events = ['click', 'change', 'input', 'transitionend', 'animationend'] as const;
    for (const name of events) root.addEventListener(name, schedule, true);
    root.addEventListener('pointerdown', touched, true);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      observer.disconnect();
      for (const name of events) root.removeEventListener(name, schedule, true);
      root.removeEventListener('pointerdown', touched, true);
      window.removeEventListener('resize', schedule);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      if (later !== null) clearTimeout(later);
    };
  }, [enabled, stage]);

  const close = useCallback(() => {
    if (stage) closeCardOverlays(stage, closed.current);
    setOpen(false);
  }, [stage]);

  return { open, close };
}
