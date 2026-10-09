/**
 * The parent half of the frame bridge.
 *
 * Split out of the React component because it is the security boundary and has to
 * be testable on its own: everything that decides whether a message is honoured
 * lives here.
 *
 * ## Why a MessageChannel and not `window.postMessage`
 *
 * A sandboxed frame may navigate *itself* — `allow-scripts` permits it, and no
 * CSP directive we can set on the frame document forbids it. Creator code can
 * reach the real `location` even though the runtime shadows it, because
 * `Function('return location')()` steps outside the shadowing scope. So a
 * component can replace our document with an attacker's page inside the same
 * `<iframe>` element, and the WindowProxy identity does not change — meaning
 * `event.source === iframe.contentWindow` still holds for the attacker's
 * document, and a window-addressed `postMessage` from us (necessarily
 * `targetOrigin: '*'`, since our own frame's origin is opaque) would be delivered
 * straight to it. That is chat state — variables, relationship, persona name,
 * asset urls — handed to a third party, once per turn.
 *
 * A `MessagePort` is not addressable that way. It is transferred once, to the
 * document that completed the handshake, and it dies with that document: after a
 * navigation the port is entangled with a discarded document, so anything we post
 * goes nowhere and nothing the new document does can get it back. The window path
 * is therefore used for exactly one message — the frame's `ready` — and that is
 * accepted once, before any creator code has run.
 *
 * The load counter on top of it is belt and braces, and the part the reader can
 * see: a second `load` on the element means the frame left our document, so the
 * frame is torn down and the message shows a fallback instead of whatever was
 * navigated to.
 */

import { MAX_COMPONENT_TURN_LENGTH, MAX_DIRECTIONS_LENGTH } from '@shizue/core/component';

/** Height a frame starts at, and the ceiling a component may grow to. */
export const MIN_FRAME_HEIGHT = 24;
const MAX_FRAME_HEIGHT = 2000;
/** Longest text a component may put in the composer, or send as a turn. */
const MAX_SUGGESTION = MAX_COMPONENT_TURN_LENGTH;
/** Longest ruling a component may attach to a turn it sends. */
const MAX_DIRECTIONS = MAX_DIRECTIONS_LENGTH;

interface FrameBridgeHandlers {
  /** The handshake completed; the caller may start sending `init`. */
  onReady: () => void;
  /** Already clamped. */
  onResize: (height: number) => void;
  /** Already truncated. */
  onSuggestInput: (text: string) => void;
  /**
   * The component asked to take the turn itself, with an optional ruling for the
   * model. Both already truncated.
   *
   * Left out when the capability was not granted, and then a `sendTurn` on the
   * port is dropped here rather than anywhere further in: the bridge is where a
   * message stops being the frame's and starts being the chat's.
   */
  onSendTurn?: (text: string, directions?: string) => void;
  /** The frame navigated away from our document and was torn down. */
  onLost: () => void;
}

export interface FrameBridge {
  /**
   * Every `message` event on the parent window. Only the frame's one-shot `ready`
   * is honoured here; everything else a frame — ours or a navigated one — posts to
   * the window is ignored, because after the handshake the port is the only way in.
   */
  onWindowMessage: (event: MessageEvent, frameWindow: Window | null) => void;
  /** The iframe element's `load`. The first is ours; a second one is a navigation. */
  onLoad: () => void;
  /** Sends over the port. A no-op before the handshake and after a navigation. */
  post: (message: unknown) => void;
  /** True once the handshake completed and the frame has not navigated. */
  readonly connected: boolean;
  close: () => void;
}

export function createFrameBridge(handlers: FrameBridgeHandlers): FrameBridge {
  let port: MessagePort | null = null;
  let loads = 0;
  let lost = false;

  function onPortMessage(event: MessageEvent): void {
    // No source check: holding the port *is* the credential, and only the
    // document we handed it to has one.
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return;

    if (data['type'] === 'resize' && typeof data['height'] === 'number') {
      const height = Math.ceil(data['height']);
      // A component cannot take the page over by asking for a screenful of it.
      handlers.onResize(
        Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Number.isFinite(height) ? height : MIN_FRAME_HEIGHT)),
      );
      return;
    }
    if (data['type'] === 'suggestInput' && typeof data['text'] === 'string') {
      handlers.onSuggestInput(data['text'].slice(0, MAX_SUGGESTION));
      return;
    }
    if (data['type'] === 'sendTurn' && typeof data['text'] === 'string') {
      // No handler means the card never declared the capability, so this is a
      // component asking for something it was not granted: it goes nowhere.
      if (!handlers.onSendTurn) return;
      const directions = data['directions'];
      handlers.onSendTurn(
        data['text'].slice(0, MAX_SUGGESTION),
        typeof directions === 'string' ? directions.slice(0, MAX_DIRECTIONS) : undefined,
      );
    }
  }

  return {
    get connected(): boolean {
      return port !== null && !lost;
    },

    onWindowMessage(event, frameWindow) {
      if (lost || port || !frameWindow || event.source !== frameWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== 'object' || data['type'] !== 'ready') return;

      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = onPortMessage;
      // '*' is the only target that can reach an opaque origin, and it is safe
      // here precisely because the payload is the port itself: whoever is in that
      // frame right now gets it, and right now that is our own document, which
      // has not yet run a character of creator code.
      (event.source as Window).postMessage({ type: 'port' }, '*', [channel.port2]);
      handlers.onReady();
    },

    onLoad() {
      loads += 1;
      if (loads < 2 || lost) return;
      // The frame left our srcdoc. There is no legitimate second load, so the
      // question of where it went does not arise.
      lost = true;
      port?.close();
      port = null;
      handlers.onLost();
    },

    post(message) {
      if (lost) return;
      port?.postMessage(message);
    },

    close() {
      port?.close();
      port = null;
    },
  };
}
