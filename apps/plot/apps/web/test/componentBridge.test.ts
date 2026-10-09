// @vitest-environment jsdom
/**
 * The parent half of the bridge, which is where the frame's messages are decided
 * on.
 *
 * The case that matters: a component can navigate its own frame (`allow-scripts`
 * permits it, and `Function('return location')()` gets past the runtime's
 * shadowing), and the WindowProxy identity survives that — so `event.source ===
 * iframe.contentWindow` is true for whatever loaded next. Every assertion below
 * is about the window channel being closed to it, and about the port not being
 * something it can obtain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrameBridge, type FrameBridge } from '../src/lib/componentBridge';

/**
 * The barrier message. Unknown to the bridge, so posting one changes nothing —
 * see `delivered`.
 */
const SETTLE = '__settle__';

interface Harness {
  bridge: FrameBridge;
  /** Stands in for `iframe.contentWindow`: the identity the guard compares. */
  frameWindow: Window;
  /** The frame's end of the port, once the handshake completed. */
  framePort: MessagePort;
  /**
   * The bridge's own end, captured as it was created. A test needs it to observe
   * that a message it posted has landed; the bridge itself never hands it out.
   */
  bridgePort: MessagePort;
  fromFrame: Record<string, unknown>[];
  handlers: {
    onReady: ReturnType<typeof vi.fn>;
    onResize: ReturnType<typeof vi.fn>;
    onSuggestInput: ReturnType<typeof vi.fn>;
    onSendTurn?: ReturnType<typeof vi.fn>;
    onLost: ReturnType<typeof vi.fn>;
  };
}

/** Delivers a window `message` event with a chosen source, as the browser would. */
function windowMessage(harness: Harness, data: unknown, source: unknown): void {
  const event = new MessageEvent('message', { data });
  // `source` is read-only on the constructed event, and jsdom's constructor only
  // takes a Window; the identity is all the guard reads.
  Object.defineProperty(event, 'source', { value: source });
  harness.bridge.onWindowMessage(event, harness.frameWindow);
}

/** `granted` decides whether the card declared the sendTurn capability. */
function setup(granted = true): Harness {
  const handlers = {
    onReady: vi.fn(),
    onResize: vi.fn(),
    onSuggestInput: vi.fn(),
    ...(granted ? { onSendTurn: vi.fn() } : {}),
    onLost: vi.fn(),
  };
  const frameWindow = { postMessage: vi.fn() } as unknown as Window;
  const harness: Harness = {
    bridge: createFrameBridge(handlers),
    frameWindow,
    framePort: null as unknown as MessagePort,
    bridgePort: null as unknown as MessagePort,
    fromFrame: [],
    handlers,
  };
  return harness;
}

/** Runs the handshake the way the frame does, and keeps both ends of the channel. */
function handshake(harness: Harness): void {
  harness.bridge.onLoad();

  // The bridge builds the channel itself and only ever transfers one end away.
  // Standing in for the constructor for the length of the handshake is the only
  // way a test can hold the other end, and holding it is what `delivered` needs.
  const real = globalThis.MessageChannel;
  const created: MessageChannel[] = [];
  globalThis.MessageChannel = class extends real {
    constructor() {
      super();
      created.push(this);
    }
  } as typeof MessageChannel;
  try {
    windowMessage(harness, { type: 'ready' }, harness.frameWindow);
  } finally {
    globalThis.MessageChannel = real;
  }

  const post = (harness.frameWindow as unknown as { postMessage: ReturnType<typeof vi.fn> })
    .postMessage;
  expect(post).toHaveBeenCalledTimes(1);
  const [message, target, transfer] = post.mock.calls[0] as [unknown, string, MessagePort[]];
  expect(message).toEqual({ type: 'port' });
  // The frame's origin is opaque, so '*' is the only reachable target; what makes
  // it safe is that the payload is a port rather than state.
  expect(target).toBe('*');
  harness.framePort = transfer[0]!;
  harness.bridgePort = created[0]!.port1;
  harness.framePort.onmessage = (event) => {
    const data = event.data as Record<string, unknown>;
    if (data['type'] !== SETTLE) harness.fromFrame.push(data);
  };
}

/**
 * Waits until a message posted *now* on `port` has been delivered to `peer` — a
 * barrier, not a wait.
 *
 * `postMessage` queues a task on the receiving port's message queue, and nothing
 * orders that queue against a timer's. On this runtime the port's messages are
 * drained in libuv's poll phase while a `setTimeout(0)` fires in the timers phase
 * that precedes it, so the timer usually loses the race — but only usually: let
 * more than the timer's 1ms clamp pass between scheduling it and the loop
 * reaching the timers phase, and the timer is already due and runs first, with
 * the port's messages still queued behind it. That race fails a timer-based wait
 * about once every few hundred runs, always on the first port delivery of the
 * process, where a cold event loop makes that millisecond easiest to lose.
 *
 * A port's own queue *is* ordered: FIFO, per direction. So the barrier is a
 * message of our own posted behind the ones under test, on the same port, and
 * awaited on the far end. When it arrives, everything posted before it already
 * has — on any runtime, by the spec rather than by the phase order.
 */
function delivered(port: MessagePort, peer: MessagePort): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      if ((event.data as Record<string, unknown>)?.['type'] !== SETTLE) return;
      peer.removeEventListener('message', onMessage);
      resolve();
    };
    // `addEventListener`, not `onmessage`: the bridge owns that slot on its end,
    // and the harness owns it on the frame's. Only the `onmessage` setter starts
    // a port, so a port that has never had one needs telling.
    peer.addEventListener('message', onMessage);
    peer.start();
    port.postMessage({ type: SETTLE });
  });
}

/** Everything the frame posted has reached the bridge. */
const settle = (harness: Harness): Promise<void> =>
  delivered(harness.framePort, harness.bridgePort);

/** Everything the bridge posted has reached the frame. */
const settleToFrame = (harness: Harness): Promise<void> =>
  delivered(harness.bridgePort, harness.framePort);

/**
 * One turn of the port message queue, for the cases where there is nothing to
 * wait for: once the bridge has closed its end, a message posted at the frame's
 * end has no landing point by construction. A round trip on a channel of our own
 * shows the runtime drained port messages after ours was posted, which is as much
 * as a message with no receiver allows anyone to prove.
 */
async function portQueueTurned(): Promise<void> {
  const spare = new MessageChannel();
  await delivered(spare.port2, spare.port1);
  spare.port1.close();
  spare.port2.close();
}

describe('the handshake', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setup();
  });

  it('transfers one port to the frame and reports itself connected', () => {
    handshake(harness);
    expect(harness.handlers.onReady).toHaveBeenCalledTimes(1);
    expect(harness.bridge.connected).toBe(true);
  });

  it('ignores a ready that did not come from this frame', () => {
    windowMessage(harness, { type: 'ready' }, {} as Window);
    expect(
      (harness.frameWindow as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage,
    ).not.toHaveBeenCalled();
    expect(harness.bridge.connected).toBe(false);
  });

  it('hands out a port once, so a document that replaced the first gets none', () => {
    handshake(harness);
    // Same source identity — a navigation does not change it — and still refused.
    windowMessage(harness, { type: 'ready' }, harness.frameWindow);
    expect(
      (harness.frameWindow as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage,
    ).toHaveBeenCalledTimes(1);
  });
});

describe('after the handshake', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setup();
    handshake(harness);
  });

  it('honours resize and suggestInput on the port', async () => {
    harness.framePort.postMessage({ type: 'resize', height: 120 });
    harness.framePort.postMessage({ type: 'suggestInput', text: '좀 쉬어야겠다' });
    await settle(harness);
    expect(harness.handlers.onResize).toHaveBeenCalledWith(120);
    expect(harness.handlers.onSuggestInput).toHaveBeenCalledWith('좀 쉬어야겠다');
  });

  it('clamps the height and truncates the suggestion', async () => {
    harness.framePort.postMessage({ type: 'resize', height: 99_999 });
    harness.framePort.postMessage({ type: 'resize', height: -5 });
    harness.framePort.postMessage({ type: 'suggestInput', text: 'a'.repeat(5000) });
    await settle(harness);
    expect(harness.handlers.onResize).toHaveBeenNthCalledWith(1, 2000);
    expect(harness.handlers.onResize).toHaveBeenNthCalledWith(2, 24);
    expect(harness.handlers.onSuggestInput.mock.calls[0]![0]).toHaveLength(2000);
  });

  it('ignores resize and suggestInput posted to the window', () => {
    // The whole point: this is what a navigated document can do, and it must go
    // nowhere. The source identity is the frame's, because a navigation keeps it.
    windowMessage(harness, { type: 'suggestInput', text: '악성 입력' }, harness.frameWindow);
    windowMessage(harness, { type: 'resize', height: 900 }, harness.frameWindow);
    expect(harness.handlers.onSuggestInput).not.toHaveBeenCalled();
    expect(harness.handlers.onResize).not.toHaveBeenCalled();
  });

  it('forwards a turn with its directions, both truncated', async () => {
    harness.framePort.postMessage({ type: 'sendTurn', text: '문을 연다', directions: '주사위 3, 실패' });
    harness.framePort.postMessage({
      type: 'sendTurn',
      text: 'a'.repeat(5000),
      directions: 'b'.repeat(5000),
    });
    await settle(harness);
    expect(harness.handlers.onSendTurn).toHaveBeenNthCalledWith(1, '문을 연다', '주사위 3, 실패');
    const [text, directions] = harness.handlers.onSendTurn!.mock.calls[1] as [string, string];
    expect(text).toHaveLength(2000);
    expect(directions).toHaveLength(800);
  });

  it('takes a turn without directions as a turn without a ruling', async () => {
    harness.framePort.postMessage({ type: 'sendTurn', text: '문을 연다' });
    harness.framePort.postMessage({ type: 'sendTurn', text: '뒤로 물러난다', directions: 42 });
    await settle(harness);
    expect(harness.handlers.onSendTurn).toHaveBeenNthCalledWith(1, '문을 연다', undefined);
    expect(harness.handlers.onSendTurn).toHaveBeenNthCalledWith(2, '뒤로 물러난다', undefined);
  });

  it('ignores an unknown message on the port', async () => {
    harness.framePort.postMessage({ type: 'navigate', url: 'https://evil.test' });
    harness.framePort.postMessage('nonsense');
    await settle(harness);
    expect(harness.handlers.onResize).not.toHaveBeenCalled();
    expect(harness.handlers.onSuggestInput).not.toHaveBeenCalled();
  });

  it('delivers init over the port and nowhere else', async () => {
    harness.bridge.post({ type: 'init', code: 'x' });
    await settleToFrame(harness);
    expect(harness.fromFrame).toEqual([{ type: 'init', code: 'x' }]);
    // Nothing was addressed to the window after the handshake.
    expect(
      (harness.frameWindow as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage,
    ).toHaveBeenCalledTimes(1);
  });
});

describe('a card that never declared sendTurn', () => {
  it('drops the message here, so a component cannot take a turn it was not granted', async () => {
    const harness = setup(false);
    handshake(harness);
    harness.framePort.postMessage({ type: 'sendTurn', text: '문을 연다' });
    // The rest of the bridge still works — only the ungranted message goes nowhere.
    harness.framePort.postMessage({ type: 'suggestInput', text: '문을 연다' });
    await settle(harness);
    expect(harness.handlers.onSuggestInput).toHaveBeenCalledWith('문을 연다');
  });
});

describe('when the frame navigates away', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setup();
    handshake(harness);
  });

  it('tears the bridge down on the second load', () => {
    harness.bridge.onLoad();
    expect(harness.handlers.onLost).toHaveBeenCalledTimes(1);
    expect(harness.bridge.connected).toBe(false);
  });

  it('sends no more state, so no turn reaches whatever loaded', async () => {
    harness.bridge.onLoad();
    harness.bridge.post({ type: 'init', code: 'secret', platform: { user: '페르소나' } });
    await portQueueTurned();
    expect(harness.fromFrame).toEqual([]);
  });

  it('accepts nothing back, on either channel', async () => {
    const port = harness.framePort;
    harness.bridge.onLoad();
    port.postMessage({ type: 'suggestInput', text: '악성 입력' });
    windowMessage(harness, { type: 'suggestInput', text: '악성 입력' }, harness.frameWindow);
    windowMessage(harness, { type: 'ready' }, harness.frameWindow);
    await portQueueTurned();
    expect(harness.handlers.onSuggestInput).not.toHaveBeenCalled();
    // …and it cannot start over to get a fresh port.
    expect(
      (harness.frameWindow as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage,
    ).toHaveBeenCalledTimes(1);
  });
});
