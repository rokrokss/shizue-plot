'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The backlog the pacing aims to keep in hand, in characters. Small enough that
 * the reader is never watching text that arrived a moment ago, large enough to
 * cover the gap when the next chunk is late.
 */
const TARGET_LAG = 12;
/**
 * Floor on the drain rate, in characters per second. Only in force before there
 * is enough arrival history to estimate one — a stream's first frames.
 */
const MIN_RATE = 24;
/** How far a deep backlog may push the rate above the arrival estimate. */
const MAX_BOOST = 6;
/** How far back the arrival estimate looks. */
const WINDOW_MS = 2000;
/** Below this much history the estimate is noise, so the backlog leads instead. */
const MIN_SPAN_MS = 120;
/** A frame that took longer than this was a stall; it does not buy a dump. */
const MAX_FRAME_MS = 100;

interface Arrival {
  at: number;
  chars: number;
}

export interface SmoothStream {
  /** What the reader sees. Advances at most once per frame. */
  visibleText: string;
  /** Hands the pacing a delta as it arrives off the wire. */
  append: (text: string) => void;
  /** done/error/abort: everything still held back goes on screen at once. */
  finish: () => void;
  /** Empties both the buffer and the screen, for the next turn. */
  reset: () => void;
  /** Whether anything is still held back. */
  isDraining: boolean;
}

const now = (): number => performance.now();

/**
 * Characters per second over the arrival window, or 0 while it is too short to
 * say. The oldest arrival's own characters are left out: the window is measured
 * from the moment it landed, so counting it would read a single fat chunk as an
 * arbitrarily fast stream and dump the whole thing on the first frame.
 */
function arrivalRate(arrivals: readonly Arrival[], at: number): number {
  const first = arrivals[0];
  if (!first) return 0;
  const span = at - first.at;
  if (span < MIN_SPAN_MS) return 0;
  let chars = 0;
  for (let i = 1; i < arrivals.length; i += 1) chars += arrivals[i]!.chars;
  return (chars / span) * 1000;
}

/**
 * Paces streamed text onto the screen.
 *
 * Tokens arrive in the rhythm of whatever produced them: six words at once, half
 * a second of nothing, then four more. Painting each delta the moment it lands
 * puts that rhythm on the page, and the page reads as stutter. So the text is
 * held in a buffer and let out on a frame loop at roughly the speed it is
 * arriving — with a small backlog kept back to cover the next stall, and a
 * proportional boost when the backlog runs deeper than that.
 *
 * The delay is only ever a delay, never a loss: `finish` puts everything held
 * back on screen at once, so a stream that ends — done, error or abort — ends
 * whole. The whole thing costs one React state update per frame at most, and
 * none at all while the buffer is empty.
 */
export function useSmoothStream(): SmoothStream {
  const [visible, setVisible] = useState('');
  /** Everything that has arrived. The screen is a prefix of this. */
  const bufferRef = useRef('');
  const shownRef = useRef(0);
  /** Fractional characters carried between frames, so slow rates still move. */
  const carryRef = useRef(0);
  const lastTickRef = useRef(0);
  const arrivalsRef = useRef<Arrival[]>([]);
  const frameRef = useRef<number | null>(null);

  const stop = useCallback((): void => {
    if (frameRef.current === null) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  /** The one path that skips the pacing: everything, now. */
  const flush = useCallback((): void => {
    if (shownRef.current === bufferRef.current.length) return;
    shownRef.current = bufferRef.current.length;
    setVisible(bufferRef.current);
  }, []);

  const start = useCallback((): void => {
    if (frameRef.current !== null) return;
    lastTickRef.current = now();

    const tick = (): void => {
      frameRef.current = requestAnimationFrame(tick);

      const at = now();
      const elapsed = Math.min(at - lastTickRef.current, MAX_FRAME_MS);
      lastTickRef.current = at;

      const remaining = bufferRef.current.length - shownRef.current;
      if (remaining === 0) {
        // Caught up: hold here rather than banking speed for the next arrival.
        carryRef.current = 0;
        return;
      }
      // A window the reader is not looking at gets no pacing at all — by the
      // time they come back, the rhythm they would have watched is history.
      if (!document.hasFocus()) {
        flush();
        return;
      }

      const rate =
        Math.max(arrivalRate(arrivalsRef.current, at), MIN_RATE) *
        Math.min(remaining / TARGET_LAG, MAX_BOOST);
      carryRef.current += (rate * elapsed) / 1000;
      const step = Math.floor(carryRef.current);
      if (step <= 0) return;

      carryRef.current -= step;
      shownRef.current = Math.min(bufferRef.current.length, shownRef.current + step);
      setVisible(bufferRef.current.slice(0, shownRef.current));
    };

    frameRef.current = requestAnimationFrame(tick);
  }, [flush]);

  const append = useCallback(
    (text: string): void => {
      if (!text) return;
      const at = now();
      bufferRef.current += text;
      const arrivals = arrivalsRef.current;
      arrivals.push({ at, chars: text.length });
      while (arrivals.length > 0 && at - arrivals[0]!.at > WINDOW_MS) arrivals.shift();
      // A hidden document gets no animation frames, so the loop's own focus
      // check never runs there; without this the whole stream would sit in the
      // buffer until the tab came back and then crawl out at the paced rate.
      if (document.visibilityState === 'hidden') {
        flush();
        return;
      }
      start();
    },
    [start, flush],
  );

  const finish = useCallback((): void => {
    stop();
    flush();
  }, [stop, flush]);

  const reset = useCallback((): void => {
    stop();
    bufferRef.current = '';
    shownRef.current = 0;
    carryRef.current = 0;
    arrivalsRef.current = [];
    setVisible('');
  }, [stop]);

  // Whatever backed up while the document was hidden goes on screen the moment
  // it is visible again — the reader was not watching, so there is no rhythm to
  // keep, only a transcript to be current with.
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') flush();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [flush]);

  useEffect(() => stop, [stop]);

  return {
    visibleText: visible,
    append,
    finish,
    reset,
    isDraining: visible.length < bufferRef.current.length,
  };
}
