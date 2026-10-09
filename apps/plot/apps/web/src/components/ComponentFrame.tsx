'use client';

import { useEffect, useRef, useState } from 'react';
import { createFrameBridge, MIN_FRAME_HEIGHT, type FrameBridge } from '@/lib/componentBridge';
import { componentFrameSrcdoc, type PlatformContext } from '@/lib/componentRuntime';

/**
 * One frame document serves every component on the page, so it is built once and
 * the browser reuses the parse. It carries no creator code — that arrives over the
 * bridge — which is the reason it can be shared at all.
 */
let cachedSrcdoc = '';
function srcdocFor(origin: string): string {
  if (!cachedSrcdoc) cachedSrcdoc = componentFrameSrcdoc(origin);
  return cachedSrcdoc;
}

/**
 * How long the frame gets to say `ready`. It is a srcdoc with no network to
 * wait on, so the handshake is a few milliseconds' work; this is long enough
 * that a busy tab is never mistaken for a broken one, and short enough that a
 * reader is not left watching an empty box for the rest of the conversation.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * A creator component, mounted in a sandboxed iframe.
 *
 * The sandbox is `allow-scripts` and nothing else. Without `allow-same-origin` the
 * document has an opaque origin: no cookies, no storage, no access to our API, no
 * access to this DOM. That is the security model, and the rest follows from it —
 * the code and the props go in over the bridge, because there is no shared scope
 * to hand them over in, and nothing on this side ever evaluates them.
 *
 * The bridge itself is a `MessagePort`, obtained through a one-shot handshake
 * before any creator code runs; `lib/componentBridge` explains why the window
 * channel is not good enough (a component can navigate its own frame, and window
 * messages would follow it there). Three messages come back: a height, clamped; a
 * suggested composer text, truncated; and a turn the component asks to send, which
 * only arrives here at all when the card declared the capability — without the
 * `onSendTurn` prop the message is dropped and nothing on this side hears it.
 *
 * The handshake is also the frame's only chance to show it is alive. It gets
 * `HANDSHAKE_TIMEOUT_MS`, and a frame that misses them is taken off the page in
 * favour of a card that says so and offers a fresh one.
 */
export function ComponentFrame({
  code,
  name,
  props,
  platform,
  errorLabel,
  navigatedLabel,
  timeoutLabel,
  retryLabel,
  onSuggestInput,
  onSendTurn,
}: {
  /** The card's whole component module; the frame compiles it. */
  code: string;
  /** Which declared component the call code named. */
  name: string;
  /** Props parsed out of the call code — literals only, never evaluated. */
  props: Record<string, unknown>;
  /** Platform state injected as the `platform` prop. */
  platform: PlatformContext;
  /** Heading of the fallback card; the frame cannot translate. */
  errorLabel: string;
  /** Detail shown when the component navigated its own frame away. */
  navigatedLabel: string;
  /** Detail shown when the frame never completed the handshake. */
  timeoutLabel: string;
  /** Label of the button that mounts a fresh frame after a timeout. */
  retryLabel: string;
  /** Fills the composer. Omitted in the preview, where there is none. */
  onSuggestInput?: (text: string) => void;
  /**
   * Takes the turn. Omitted unless the card declares the `sendTurn` capability —
   * that omission is the first of the three gates, and the only one the frame
   * knows about.
   */
  onSendTurn?: (text: string, directions?: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const suggestRef = useRef(onSuggestInput);
  suggestRef.current = onSuggestInput;
  const sendTurnRef = useRef(onSendTurn);
  sendTurnRef.current = onSendTurn;
  // Read once: the bridge is built on the first render and kept, so a component
  // cannot gain the capability by the prop appearing later.
  const [granted] = useState(Boolean(onSendTurn));

  const [srcdoc, setSrcdoc] = useState('');
  const [phase, setPhase] = useState<'loading' | 'connected' | 'lost' | 'timeout'>('loading');
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT);
  /** Bumped by the retry button; a new number is a new frame and a new bridge. */
  const [attempt, setAttempt] = useState(0);

  // One bridge per mounted frame, kept across a Strict Mode effect replay. A
  // retry is the one thing that replaces it: the old bridge has already counted
  // its frame's load, and a second load on the same bridge means the frame
  // navigated away.
  const bridgeRef = useRef<{ attempt: number; bridge: FrameBridge } | null>(null);
  if (bridgeRef.current?.attempt !== attempt) {
    bridgeRef.current = {
      attempt,
      bridge: createFrameBridge({
        onReady: () => setPhase('connected'),
        onResize: setHeight,
        onSuggestInput: (text) => suggestRef.current?.(text),
        ...(granted
          ? { onSendTurn: (text: string, directions?: string) => sendTurnRef.current?.(text, directions) }
          : {}),
        onLost: () => setPhase('lost'),
      }),
    };
  }
  const bridge = bridgeRef.current.bridge;

  // The origin is only knowable in the browser, and the frame is only useful there.
  useEffect(() => setSrcdoc(srcdocFor(window.location.origin)), []);

  // One listener for the life of the component, dispatching to whichever bridge
  // is current when a message lands. Keyed on `bridge` instead, a retry would
  // leave the old listener attached until the effect ran — and the new frame's
  // handshake is a single message that can arrive inside that gap, where the
  // bridge it was closed on would take the port the new one needs and the frame
  // would stay blank with its timeout already called off.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void =>
      bridgeRef.current?.bridge.onWindowMessage(event, frameRef.current?.contentWindow ?? null);
    window.addEventListener('message', onMessage);
    // The port is deliberately not closed here: an effect replay would leave the
    // frame with nothing to talk to, and a real unmount takes the frame with it.
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // A handshake that never lands leaves an empty box that never fills, and the
  // reader has no way to tell that from a component that draws nothing.
  useEffect(() => {
    if (!srcdoc || phase !== 'loading') return;
    const timer = setTimeout(() => setPhase('timeout'), HANDSHAKE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [srcdoc, phase, attempt]);

  // Serialized, so a re-render with equal values does not re-init the component
  // and throw away its state — the chat re-derives `platform` on every token.
  const payload = JSON.stringify({
    type: 'init',
    code,
    name,
    props,
    platform,
    labels: { error: errorLabel },
  });

  useEffect(() => {
    if (phase !== 'connected') return;
    bridge.post(JSON.parse(payload) as unknown);
  }, [payload, phase, bridge]);

  if (!srcdoc) return <div style={{ height: MIN_FRAME_HEIGHT }} />;

  // The frame navigated itself elsewhere: it comes out of the document, and
  // whatever it went to is never shown.
  if (phase === 'lost') {
    return (
      <div
        data-testid="component-lost"
        // The frame was on screen and is not any more: that is news, and it
        // arrives in the middle of a message rather than where anyone is looking.
        role="alert"
        className="my-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger"
      >
        <strong>{errorLabel}</strong>
        <p className="mt-1 text-muted">{navigatedLabel}</p>
      </div>
    );
  }

  // The frame never said `ready`, so nothing was ever going to be drawn in it.
  // Same card, and a way to ask for a fresh frame — a retry costs one srcdoc.
  if (phase === 'timeout') {
    return (
      <div
        data-testid="component-timeout"
        role="alert"
        className="my-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger"
      >
        <strong>{errorLabel}</strong>
        <p className="mt-1 text-muted">{timeoutLabel}</p>
        <button
          type="button"
          className="mt-2 rounded-full border border-danger/40 px-3 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          onClick={() => {
            bridgeRef.current?.bridge.close();
            setHeight(MIN_FRAME_HEIGHT);
            setPhase('loading');
            setAttempt((count) => count + 1);
          }}
        >
          {retryLabel}
        </button>
      </div>
    );
  }

  return (
    <iframe
      key={attempt}
      ref={frameRef}
      data-testid="component-frame"
      data-component={name}
      title={name}
      // The whole security model. Nothing may be added to this list.
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      onLoad={() => bridge.onLoad()}
      scrolling="no"
      style={{ height }}
      className="my-2 block w-full border-0 bg-transparent"
    />
  );
}
