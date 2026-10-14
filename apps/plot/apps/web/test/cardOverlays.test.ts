// @vitest-environment jsdom
/**
 * The way out of a card's floating screen (`lib/useCardOverlays`): which of a
 * card's elements count as an open overlay, and how "close card screen" closes
 * them — the card's own toggle where it has one, hiding where it has not. jsdom
 * lays nothing out, so an element's box is stood in for: a size unless it is
 * not displayed. The real layout is the e2e suite's (customUi.spec.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeCardOverlays, forgetCardMarkup, openCardOverlays, reopenCardOverlays } from '../src/lib/useCardOverlays';

let stage: HTMLElement;
let sheet: HTMLStyleElement;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const size = getComputedStyle(this).display === 'none' ? 0 : 10;
    return { x: 0, y: 0, top: 0, left: 0, right: size, bottom: size, width: size, height: size, toJSON: () => ({}) } as DOMRect;
  });
  sheet = document.createElement('style');
  sheet.textContent =
    '.panel{display:none;position:fixed}.t:checked ~ .panel{display:block}.badge{position:fixed}.tab:checked ~ .tint{color:red}';
  document.head.appendChild(sheet);
  stage = document.createElement('div');
  document.body.appendChild(stage);
});

afterEach(() => {
  stage.remove();
  sheet.remove();
  vi.restoreAllMocks();
});

/** A message's card markup, as the chat page draws it. */
const card = (markup: string): HTMLElement => {
  stage.insertAdjacentHTML('beforeend', `<div class="message-body"><div class="shizue-msg">${markup}</div></div>`);
  return stage.lastElementChild!.firstElementChild as HTMLElement;
};

describe('a card overlay', () => {
  it('is a shown `fixed` element of a message’s card markup, and nothing else', () => {
    card('<input type="checkbox" class="t"><div class="panel">패널</div><div class="badge">HP</div>');
    // Elsewhere on the stage — the chat background — is not a message's.
    stage.insertAdjacentHTML('beforeend', '<div class="shizue-msg"><div class="badge">배경</div></div>');
    expect(openCardOverlays(stage).map((element) => element.textContent)).toEqual(['HP']);
  });

  it('closes by undoing the card’s own toggle, and leaves its other state alone', () => {
    const block = card(
      '<input type="radio" class="tab" checked><span class="tint">탭</span>' +
        '<input type="checkbox" class="t" checked><div class="panel">패널</div><div class="badge">HP</div>',
    );
    const [tab, toggle] = block.querySelectorAll('input');
    const changed = vi.fn();
    block.addEventListener('change', changed);
    expect(openCardOverlays(stage).map((element) => element.textContent)).toEqual(['패널', 'HP']);

    const closed = new Map();
    expect(closeCardOverlays(stage, closed)).toBe(true);
    expect(toggle!.checked).toBe(false);
    expect(tab!.checked).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    // Nothing was hidden behind the card's back: its toggle opens the panel again,
    // and what the card keeps floating stays for a second press.
    expect(block.querySelector<HTMLElement>('.panel')!.style.display).toBe('');
    expect(openCardOverlays(stage).map((element) => element.textContent)).toEqual(['HP']);
    expect(closeCardOverlays(stage, closed)).toBe(true);
    expect(openCardOverlays(stage)).toEqual([]);
  });

  it('hides what no toggle closes until the card moves again, and puts back what it had', () => {
    const block = card('<div class="badge" style="display:flex">HP</div>');
    const badge = block.querySelector<HTMLElement>('.badge')!;
    const closed = new Map();
    expect(closeCardOverlays(stage, closed)).toBe(true);
    expect(openCardOverlays(stage)).toEqual([]);
    expect(badge.style.getPropertyPriority('display')).toBe('important');

    reopenCardOverlays(closed);
    expect(badge.style.display).toBe('flex');
    expect(openCardOverlays(stage)).toEqual([badge]);
  });

  it('reads a block’s styles again only once its markup is reported changed', () => {
    const block = card('<div>상자</div>');
    expect(openCardOverlays(stage)).toEqual([]);
    block.innerHTML = '<div class="badge">HP</div>';
    // What a look costs is kept per block: unseen until the stage's observer reports the change.
    expect(openCardOverlays(stage)).toEqual([]);
    forgetCardMarkup([{ target: block, addedNodes: block.childNodes, removedNodes: [] } as unknown as MutationRecord]);
    expect(openCardOverlays(stage).map((element) => element.textContent)).toEqual(['HP']);
  });

  it('closes nothing, and says so, where nothing is open', () => {
    card('<div class="panel">닫힌 패널</div>');
    expect(closeCardOverlays(stage, new Map())).toBe(false);
  });
});
