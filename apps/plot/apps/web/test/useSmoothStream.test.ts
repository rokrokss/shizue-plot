// @vitest-environment jsdom
/**
 * The pacing, driven by a fake frame loop and a fake clock.
 *
 * Every rule the hook has is a rule about time, so nothing here waits for a real
 * frame: `requestAnimationFrame` collects callbacks and `frame()` runs them with
 * the clock moved on by exactly one frame's worth. That makes the arithmetic
 * deterministic, which is what lets these assert on counts rather than on feel.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSmoothStream, type SmoothStream } from '../src/lib/useSmoothStream';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** Mirrors the hook's own target backlog; the cases are written around it. */
const TARGET_LAG = 12;

let clock = 0;
let handle = 0;
let pending = new Map<number, FrameRequestCallback>();
let focused = true;
let visibility: DocumentVisibilityState = 'visible';

/** One frame: the clock moves, then whatever was scheduled for it runs. */
function frame(ms = 16): void {
  clock += ms;
  const due = [...pending.values()];
  pending.clear();
  act(() => {
    for (const callback of due) callback(clock);
  });
}

function frames(count: number, ms = 16): void {
  for (let i = 0; i < count; i += 1) frame(ms);
}

/** Reports the hook out of a render, so a test can drive it from outside. */
function Harness({ sink }: { sink: (stream: SmoothStream) => void }): null {
  sink(useSmoothStream());
  return null;
}

interface Mounted {
  /** Always this render's value, never a captured one. */
  api: () => SmoothStream;
  unmount: () => void;
}

const mounted: Mounted[] = [];

function mount(): Mounted {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  let current: SmoothStream | null = null;
  act(() => {
    root.render(createElement(Harness, { sink: (stream) => (current = stream) }));
  });
  const instance: Mounted = {
    api: () => current!,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
  mounted.push(instance);
  return instance;
}

beforeEach(() => {
  clock = 0;
  handle = 0;
  pending = new Map();
  focused = true;
  visibility = 'visible';
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    handle += 1;
    pending.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    pending.delete(id);
  });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const text = (length: number): string => 'x'.repeat(length);

describe('the pacing', () => {
  it('holds text back rather than painting the delta that arrived', () => {
    const { api } = mount();
    api().append(text(200));
    expect(api().visibleText).toBe('');

    frames(3);
    expect(api().visibleText.length).toBeGreaterThan(0);
    expect(api().visibleText.length).toBeLessThan(200);
    expect(api().isDraining).toBe(true);
  });

  it('accelerates when the backlog runs deeper than the target, up to the cap', () => {
    const shallow = mount();
    const deep = mount();
    const capped = mount();

    // One arrival each, so all three share the same (absent) arrival estimate
    // and the only thing telling them apart is how much is waiting.
    shallow.api().append(text(TARGET_LAG));
    deep.api().append(text(TARGET_LAG * 20));
    capped.api().append(text(TARGET_LAG * 500));

    frames(10);

    expect(deep.api().visibleText.length).toBeGreaterThan(
      shallow.api().visibleText.length * 4,
    );
    // Both are past the 6x cap, so a backlog 25 times larger buys nothing more.
    expect(capped.api().visibleText.length).toBe(deep.api().visibleText.length);
  });

  it('decelerates as the backlog empties, and keeps the last of it in hand', () => {
    const { api } = mount();
    api().append(text(400));

    frames(10);
    const deep = api().visibleText.length;

    // Drain until only a shallow backlog is left, then measure the same window.
    for (let i = 0; i < 200 && 400 - api().visibleText.length > TARGET_LAG * 2; i += 1) {
      frame();
    }
    const before = api().visibleText.length;
    frames(10);
    const shallow = api().visibleText.length - before;

    expect(shallow).toBeLessThan(deep / 2);
    // Nothing new is arriving and the cushion is still there: the tail is never
    // dumped by the pacing alone.
    expect(api().visibleText.length).toBeLessThan(400);
  });

  it('follows the speed the text is arriving at', () => {
    const slow = mount();
    const fast = mount();

    // Half a second of steady arrival, one an order of magnitude quicker.
    for (let i = 0; i < 30; i += 1) {
      slow.api().append(text(2));
      fast.api().append(text(20));
      frame();
    }

    expect(fast.api().visibleText.length).toBeGreaterThan(
      slow.api().visibleText.length * 4,
    );
  });

  it('snaps the rest onto the screen when the stream finishes', () => {
    const { api } = mount();
    api().append(text(400));
    frames(3);
    expect(api().visibleText.length).toBeLessThan(400);

    act(() => api().finish());

    expect(api().visibleText).toBe(text(400));
    expect(api().isDraining).toBe(false);
    // And the loop is not left running behind the finished turn.
    expect(pending.size).toBe(0);
  });

  it('catches up without pacing while the window is not focused', () => {
    const { api } = mount();
    focused = false;
    api().append(text(400));

    frame();

    expect(api().visibleText).toBe(text(400));
  });

  it('flushes arrivals immediately while the document is hidden', () => {
    // A hidden document gets no animation frames at all, so the frame loop's own
    // focus check would never run: the append itself has to do the flushing.
    const { api } = mount();
    visibility = 'hidden';

    act(() => api().append(text(400)));

    expect(api().visibleText).toBe(text(400));
  });

  it('flushes the backlog the moment a hidden document becomes visible again', () => {
    const { api } = mount();
    api().append(text(400));
    frames(2);
    expect(api().visibleText.length).toBeLessThan(400);

    // The tab was hidden and came back: no frame has run yet, but the reader is
    // looking at a transcript that should already be current.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(api().visibleText).toBe(text(400));
  });

  it('empties both the screen and the buffer on reset', () => {
    const { api } = mount();
    api().append(text(400));
    frames(5);

    act(() => api().reset());

    expect(api().visibleText).toBe('');
    expect(api().isDraining).toBe(false);
    expect(pending.size).toBe(0);

    // …and the next turn starts from nothing, not from the last one's tail.
    api().append(text(50));
    frames(3);
    expect(api().visibleText).toBe(text(api().visibleText.length));
    expect(api().visibleText.length).toBeLessThanOrEqual(50);
  });
});
