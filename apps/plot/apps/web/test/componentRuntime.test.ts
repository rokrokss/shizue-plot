// @vitest-environment jsdom
/**
 * The Layer 2 runtime, driven with the exact sources that ship.
 *
 * The worker source is evaluated with a stand-in scope — that is what
 * `componentWorkerSource('scope')` is for — so the compiler, the hooks and the
 * tree it produces are exercised directly. The frame source is evaluated inside a
 * child frame's realm, with a stand-in `Worker` that runs the same worker source,
 * a controllable clock so the budgets can be advanced rather than waited for, and
 * a `MessageChannel` pair, none of which jsdom gives an iframe.
 *
 * What jsdom cannot show, and E2E does instead (apps/e2e/tests/customUi.spec.ts):
 * the sandbox, the CSP and the real worker realm — that a component there sees no
 * `RTCPeerConnection`, no `document` and no navigable `location` — and that an
 * endless render leaves the page usable. jsdom also delivers `postMessage` with
 * `event.source === null`, so the handshake is presented here through events
 * constructed inside the child realm.
 */
import { MAX_COMPONENT_TURN_LENGTH, MAX_DIRECTIONS_LENGTH } from '@shizue/core/component';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  componentFrameCsp,
  componentFrameSrcdoc,
  componentRuntimeSource,
  componentWorkerSource,
} from '../src/lib/componentRuntime';

const ORIGIN = 'https://plot.example';

const PLATFORM = {
  variables: { gold: '7' },
  relationship: { affection: 55 },
  turn: 3,
  char: '루미',
  user: '나',
  assets: { door: '/api/assets/door.png' },
};

const STATUS = `
function StatusWindow({ hp = 0, name = '이름 없음', platform }) {
  const [open, setOpen] = useState(false);
  const half = useMemo(() => hp / 2, [hp]);
  return (
    <div id="panel" style={{ padding: 8, color: '#eee' }}>
      <b>{name}</b>
      <span> HP {hp} · 절반 {half} · 금화 {platform.variables.gold} · 호감 {platform.relationship.affection}</span>
      {hp < 60 && <em> 위험</em>}
      <button onClick={() => setOpen(!open)}>토글</button>
      {open ? <div id="detail">턴 {platform.turn}</div> : null}
    </div>
  );
}
`;

/**
 * A component that takes a click and does nothing a turn depends on: the click is
 * only there to open the frame's gesture window, so the turn can be put on the
 * worker channel directly, the way a component past its own caps would.
 */
const PLAIN_CLICK = `function Plain({ platform }) {
  return <button onClick={() => platform.suggestInput('열림')}>가만히</button>;
}`;

/* -------------------------------------------------------------- the worker */

interface WorkerApi {
  compile: (source: string) => string;
  violations: (source: string) => string[];
  names: (source: string) => string[];
}

interface WorkerScope extends Record<string, unknown> {
  onmessage?: ((event: { data: unknown }) => void) | undefined;
}

interface WorkerHarness {
  scope: WorkerScope;
  /** Everything the worker posted out, in order. */
  sent: Record<string, unknown>[];
  send: (message: unknown) => void;
  /** The last tree it produced. */
  tree: () => unknown;
  api: WorkerApi;
}

/** Runs the shipped worker source against a stand-in global. */
function bootWorker(): WorkerHarness {
  const sent: Record<string, unknown>[] = [];
  const scope: WorkerScope = {
    postMessage: (data: unknown) => sent.push(data as Record<string, unknown>),
  };
  // The very string the frame puts in the blob, with `scope` named as its global.
  new Function('scope', componentWorkerSource('scope'))(scope);
  return {
    scope,
    sent,
    send: (message) => scope.onmessage?.({ data: message }),
    tree: () => {
      const trees = sent.filter((message) => message['type'] === 'tree');
      return trees[trees.length - 1]?.['tree'];
    },
    api: scope['__shizueComponentWorker'] as WorkerApi,
  };
}

const render = (
  harness: WorkerHarness,
  code: string,
  name: string,
  props: Record<string, unknown> = {},
): void => harness.send({ type: 'render', code, name, props, platform: PLATFORM });

/** Flattens a tree to its text, the way the DOM would read it. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const children = ((node as Record<string, unknown>)['children'] ?? []) as unknown[];
  return children.map(textOf).join('');
}

/** The first node carrying the given `id` attribute. */
function nodeById(node: unknown, id: string): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;
  const attrs = (record['attrs'] ?? {}) as Record<string, unknown>;
  if (attrs['id'] === id) return record;
  for (const child of (record['children'] ?? []) as unknown[]) {
    const found = nodeById(child, id);
    if (found) return found;
  }
  return null;
}

describe('the worker realm', () => {
  it('takes the forbidden globals off its own scope', () => {
    const harness = bootWorker();
    for (const name of [
      'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'location', 'setTimeout',
      // `postMessage` is on the list because the runtime captured it at boot: the
      // channel out is the runtime's own, so a component cannot forge a bridge
      // message — `sendTurn` above all — through `Function('return postMessage')()`.
      'postMessage',
    ]) {
      // Own properties shadowing the prototype's: this is what survives
      // `Function('return fetch')()`, which the parameter list alone does not.
      expect(Object.prototype.hasOwnProperty.call(harness.scope, name), name).toBe(true);
      expect(harness.scope[name], name).toBeUndefined();
    }
  });

  it('keeps its own channel out, so trees and pongs still land', () => {
    const harness = bootWorker();
    // Everything below this line runs after the blanking above, and all of it
    // goes through the captured reference.
    render(harness, STATUS, 'StatusWindow', { hp: 50 });
    expect(textOf(nodeById(harness.tree(), 'panel'))).toContain('HP 50');

    harness.send({ type: 'ping', nonce: 'p1' });
    expect(harness.sent.find((message) => message['type'] === 'pong')?.['nonce']).toBe('p1');

    // A component reaching for the name through a fresh scope finds nothing, so
    // it cannot post one of these itself.
    expect(new Function('scope', 'with (scope) { return typeof postMessage; }')(harness.scope)).toBe(
      'undefined',
    );
  });

  it('renders a tree rather than a DOM', () => {
    const harness = bootWorker();
    render(harness, STATUS, 'StatusWindow', { hp: 50, name: '루미' });

    const panel = nodeById(harness.tree(), 'panel')!;
    expect(panel['tag']).toBe('div');
    // Numbers become pixels here, so the frame only ever sets a string it was given.
    expect(panel['style']).toEqual({ padding: '8px', color: '#eee' });
    expect(textOf(panel)).toContain('HP 50');
    expect(textOf(panel)).toContain('절반 25');
    // Platform state the call code never mentioned.
    expect(textOf(panel)).toContain('금화 7');
    expect(textOf(panel)).toContain('호감 55');
    expect(textOf(panel)).toContain('위험');
  });

  it('names the events it wants and answers them with a new tree', () => {
    const harness = bootWorker();
    render(harness, STATUS, 'StatusWindow', { hp: 50 });

    const panel = nodeById(harness.tree(), 'panel')!;
    const button = (panel['children'] as Record<string, unknown>[]).find(
      (child) => child['tag'] === 'button',
    )!;
    expect(button['on']).toEqual(['click']);
    expect(nodeById(harness.tree(), 'detail')).toBeNull();

    harness.send({ type: 'event', path: button['path'], event: 'click', payload: {} });
    expect(textOf(nodeById(harness.tree(), 'detail'))).toBe('턴 3');

    // Hook state survives the round trip, because it is keyed by the path.
    harness.send({ type: 'event', path: button['path'], event: 'click', payload: {} });
    expect(nodeById(harness.tree(), 'detail')).toBeNull();
  });

  it('passes a plain object where a DOM event would be', () => {
    const harness = bootWorker();
    render(
      harness,
      `function Field() {
         const [text, setText] = useState('');
         return (
           <div>
             <input id="in" value={text} onChange={(e) => { e.preventDefault(); setText(e.target.value); }} />
             <b id="out">{text}</b>
           </div>
         );
       }`,
      'Field',
    );
    const input = nodeById(harness.tree(), 'in')!;
    harness.send({ type: 'event', path: input['path'], event: 'change', payload: { value: '안녕' } });
    expect(textOf(nodeById(harness.tree(), 'out'))).toBe('안녕');
  });

  it('reports an error instead of a tree', () => {
    const cases: [string, string, string][] = [
      ['function Bad() { return <div className="x" />; }', 'Bad', 'class_name'],
      ['function Bad() { return <div>oops; }', 'Bad', 'JSX syntax'],
      ['function Bad() { return <div>{missing.value}</div>; }', 'Bad', 'missing'],
      [STATUS, 'Nope', 'Nope'],
      ['function Bad() { return <iframe />; }', 'Bad', 'iframe'],
    ];
    for (const [code, name, expected] of cases) {
      const harness = bootWorker();
      render(harness, code, name);
      const error = harness.sent.find((message) => message['type'] === 'error');
      expect(error?.['message'], code).toContain(expected);
      expect(
        harness.sent.some((message) => message['type'] === 'tree'),
        code,
      ).toBe(false);
    }
  });

  it('runs effects after the tree and cleans them up on the next render', () => {
    const harness = bootWorker();
    const code = `
      function Effectful({ platform }) {
        const [seen, setSeen] = useState('');
        useEffect(() => {
          setSeen('mounted:' + platform.char);
          return () => platform.suggestInput('cleaned');
        }, []);
        return <p id="p">{seen}</p>;
      }
    `;
    render(harness, code, 'Effectful');
    expect(textOf(nodeById(harness.tree(), 'p'))).toBe('mounted:루미');

    render(harness, code, 'Effectful');
    expect(harness.sent.some((message) => message['text'] === 'cleaned')).toBe(true);
  });

  it('sends a suggestion, and a turn only through the one named message', () => {
    const harness = bootWorker();
    render(
      harness,
      `function Choice({ platform }) {
         return (
           <div>
             <button id="b" onClick={() => platform.suggestInput('좀 쉬어야겠다')}>쉰다</button>
             <button id="t" onClick={() => platform.sendTurn('문을 연다', { directions: '주사위 3, 실패' })}>연다</button>
           </div>
         );
       }`,
      'Choice',
    );
    const click = (id: string): void =>
      harness.send({ type: 'event', path: nodeById(harness.tree(), id)!['path'], event: 'click', payload: {} });
    click('b');
    click('t');

    expect(harness.sent.find((message) => message['type'] === 'suggestInput')?.['text']).toBe(
      '좀 쉬어야겠다',
    );
    expect(harness.sent.find((message) => message['type'] === 'sendTurn')).toEqual({
      type: 'sendTurn',
      text: '문을 연다',
      directions: '주사위 3, 실패',
    });
    for (const message of harness.sent) {
      expect(['tree', 'error', 'suggestInput', 'sendTurn']).toContain(message['type']);
    }
  });

  it('truncates a turn and its ruling, and omits a ruling it was not given', () => {
    const harness = bootWorker();
    render(
      harness,
      `function Choice({ platform }) {
         return (
           <div>
             <button id="long" onClick={() => platform.sendTurn('가'.repeat(5000), { directions: '나'.repeat(5000) })}>길게</button>
             <button id="bare" onClick={() => platform.sendTurn('문을 연다')}>맨손</button>
           </div>
         );
       }`,
      'Choice',
    );
    const click = (id: string): void =>
      harness.send({ type: 'event', path: nodeById(harness.tree(), id)!['path'], event: 'click', payload: {} });
    click('long');
    click('bare');

    const turns = harness.sent.filter((message) => message['type'] === 'sendTurn');
    expect(turns[0]!['text']).toHaveLength(MAX_COMPONENT_TURN_LENGTH);
    expect(turns[0]!['directions']).toHaveLength(MAX_DIRECTIONS_LENGTH);
    expect(turns[1]).toEqual({ type: 'sendTurn', text: '문을 연다' });
  });

  /**
   * A component that replaces the two functions every `x.call(y)` in the process
   * goes through, and parks what they caught on the global so the test can read
   * it. The module body runs before the runtime has posted anything, which is the
   * whole point: `channel.call(scope, message)` would have handed this trap the
   * native `postMessage` as `this` and the worker global as an argument — the
   * channel and the scope, to a stranger's function, on the first tree.
   */
  const TRAP = `
    const box = Function('return this')();
    box.__shizueTrapCaught = [];
    Function.prototype.call = function () {
      box.__shizueTrapCaught.push(this);
      return undefined;
    };
    Function.prototype.apply = function () {
      box.__shizueTrapCaught.push(this);
      return undefined;
    };
    function Trap() {
      return <div id="trap">덫</div>;
    }
  `;

  /** Different source, so the next render has to compile rather than reuse. */
  const AFTER_TRAP = `function After() { return <div id="after">이후</div>; }`;

  it('never routes its own channel through a function a component can replace', () => {
    const harness = bootWorker();
    // The stand-in shares this realm, so the traps are put back the moment the
    // worker is done with them — everything between is our own synchronous code.
    const nativeCall = Function.prototype.call;
    const nativeApply = Function.prototype.apply;
    let caught: unknown[] = [];
    try {
      render(harness, TRAP, 'Trap');
      // A second compile, while `Function.prototype.apply` is trapped: the module
      // factory is built through a bound `Function` for the same reason.
      render(harness, AFTER_TRAP, 'After');
      harness.send({ type: 'ping', nonce: 'p1' });
    } finally {
      Function.prototype.call = nativeCall;
      Function.prototype.apply = nativeApply;
      const box = globalThis as unknown as Record<string, unknown>;
      caught = (box['__shizueTrapCaught'] as unknown[]) ?? [];
      delete box['__shizueTrapCaught'];
    }

    // The traps were never consulted at all: they saw no receiver, so they never
    // saw the native postMessage and never saw the worker scope.
    expect(caught).toEqual([]);
    // …and the runtime went on working through the bound references it kept.
    expect(textOf(nodeById(harness.tree(), 'after'))).toBe('이후');
    expect(harness.sent.some((message) => textOf(message['tree']).includes('덫'))).toBe(true);
    expect(harness.sent.find((message) => message['type'] === 'pong')?.['nonce']).toBe('p1');
  });

  it('ignores an event for a handler it did not register', () => {
    const harness = bootWorker();
    render(harness, STATUS, 'StatusWindow', { hp: 50 });
    const before = harness.sent.length;
    harness.send({ type: 'event', path: 'r.9.9', event: 'click', payload: {} });
    expect(harness.sent.length).toBe(before);
  });
});

describe('the JSX compiler', () => {
  let api: WorkerApi;
  beforeEach(() => {
    api = bootWorker().api;
  });

  it('compiles elements, attributes, children and fragments', () => {
    expect(api.compile('const a = <div id="x" hidden>hi</div>;')).toBe(
      'const a = h("div",{"id":"x","hidden":true},"hi");',
    );
    expect(api.compile('<><b>{x}</b></>')).toBe('h(Fragment,null,h("b",null,(x)))');
    expect(api.compile('<Card n={1 + 2} />')).toBe('h(Card,{"n":(1 + 2)})');
    expect(api.compile('<div {...rest} />')).toBe('h("div",{...(rest)})');
  });

  it('leaves JavaScript that only looks like JSX alone', () => {
    const source = 'if (a < b && c > d) { s = "<div>"; r = /a<b/g; } // <b>\n';
    expect(api.compile(source)).toBe(source);
    expect(api.compile('const t = `<div>${x}</div>`;')).toBe('const t = `<div>${x}</div>`;');
  });

  it('drops layout whitespace the way JSX does', () => {
    expect(api.compile('<div>\n  a\n  <b />\n</div>')).toBe('h("div",null,"a",h("b",null))');
    expect(api.compile('<div>{/* nothing */}</div>')).toBe('h("div",null)');
  });

  it('screens the subset the same way the editor does', () => {
    expect(api.violations('function A() { return <div/>; }')).toEqual([]);
    expect(api.violations('const x = setTimeout(f, 1)')).toEqual(['timer']);
    expect(api.violations('useLayoutEffect(() => {})')).toEqual(['unknown_hook:useLayoutEffect']);
    // A forbidden word inside a string is a label, not a call.
    expect(api.violations('const label = "fetch the sword"')).toEqual([]);
  });

  it('finds the declared component names', () => {
    expect(api.names(STATUS)).toEqual(['StatusWindow']);
    expect(api.names('const Gauge = () => null; function Panel() {}')).toEqual(['Gauge', 'Panel']);
  });
});

/* --------------------------------------------------------------- the frame */

/** The stand-in worker: the same source, driven through the same messages. */
let lastWorker: StubWorker | null = null;
/** Set before an init to get a worker that never answers, i.e. a hung render. */
let deafNext = false;

class StubWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = false;
  /** When set, the worker takes messages and never answers — a hung turn. */
  deaf = false;
  /** When set, it answers renders and events but never the liveness ping. */
  dropPings = false;
  private readonly scope: WorkerScope;

  constructor() {
    lastWorker = this;
    this.deaf = deafNext;
    this.scope = {
      postMessage: (data: unknown) => {
        if (this.terminated) return;
        queueMicrotask(() => this.onmessage?.({ data }));
      },
    };
    new Function('scope', componentWorkerSource('scope'))(this.scope);
  }

  postMessage(data: unknown): void {
    if (this.terminated || this.deaf) return;
    if (this.dropPings && (data as { type?: string })?.type === 'ping') return;
    setTimeout(() => this.scope.onmessage?.({ data }), 0);
  }

  terminate(): void {
    this.terminated = true;
    this.scope.onmessage = undefined;
  }
}

interface Frame {
  window: Window & Record<string, unknown> & { eval: (code: string) => unknown };
  root: HTMLElement;
  port: MessagePort;
  outbound: Record<string, unknown>[];
  postToWindow: (data: unknown, source: 'parent' | 'stranger', ports?: string) => void;
  /** Runs the frame's timers that come due within `ms`. */
  advance: (ms: number) => void;
  worker: () => StubWorker;
}

function boot(): Frame {
  deafNext = false;
  document.body.innerHTML = '';
  const element = document.createElement('iframe');
  document.body.appendChild(element);
  const child = element.contentWindow as unknown as Window &
    Record<string, unknown> & { eval: (code: string) => unknown };

  child.document.body.innerHTML = '<div id="shizue-root"></div>';
  // None of these exist in a jsdom iframe realm, and the frame needs all of them.
  child['MessageChannel'] = MessageChannel;
  child['MessagePort'] = MessagePort;
  child['Worker'] = StubWorker;
  child['Blob'] = Blob;
  child['URL'] = { createObjectURL: () => 'blob:stub' };

  // A clock the test drives, so a 2s budget is a line of code, not a wait.
  const timers = new Map<number, { run: () => void; at: number; every: number }>();
  let now = 0;
  let nextId = 1;
  const schedule = (run: () => void, ms: number, repeat: number): number => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { run, at: now + ms, every: repeat });
    return id;
  };
  child['setTimeout'] = (run: () => void, ms: number): number => schedule(run, ms, 0);
  child['setInterval'] = (run: () => void, ms: number): number => schedule(run, ms, ms);
  child['clearTimeout'] = (id: number): void => {
    timers.delete(id);
  };
  child['clearInterval'] = child['clearTimeout'];

  child.eval(componentRuntimeSource(window.location.origin));

  // Events are constructed *inside* the child realm: a real cross-realm
  // postMessage arrives in jsdom with `event.source === null`, which the frame is
  // right to refuse, so there is no other way to present it a genuine parent.
  const postToWindow = (data: unknown, source: 'parent' | 'stranger', ports = '[]'): void => {
    child.eval(
      `window.dispatchEvent(new MessageEvent('message', {
         data: ${JSON.stringify(data)},
         source: ${source === 'parent' ? 'window.parent' : 'window'},
         ports: ${ports},
       }));`,
    );
  };

  child.eval('window.__shizueTestChannel = new MessageChannel();');
  postToWindow({ type: 'port' }, 'parent', '[window.__shizueTestChannel.port2]');

  const port = (child['__shizueTestChannel'] as MessageChannel).port1;
  const outbound: Record<string, unknown>[] = [];
  port.onmessage = (event) => outbound.push(event.data as Record<string, unknown>);

  return {
    window: child,
    root: child.document.getElementById('shizue-root') as HTMLElement,
    port,
    outbound,
    postToWindow,
    advance: (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        // A timer one of this pass's own callbacks cancelled must not still fire:
        // clearing a deadline and starting a new one is how the frame keeps a live
        // worker alive, and a harness that ran the cleared one would hide it.
        if (!timers.has(id) || timer.at > now) continue;
        // An interval is re-armed rather than dropped; one tick per advance is
        // enough for anything asked of it here.
        if (timer.every > 0) timers.set(id, { ...timer, at: now + timer.every });
        else timers.delete(id);
        timer.run();
      }
    },
    worker: () => lastWorker!,
  };
}

/** Lets the port hop, the worker hop and the microtasks between them all land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const init = (frame: Frame, code: string, name: string, props: Record<string, unknown> = {}): void => {
  frame.port.postMessage({
    type: 'init',
    code,
    name,
    props,
    platform: PLATFORM,
    labels: { error: '컴포넌트 오류' },
  });
};

describe('the frame document', () => {
  it('states the policy the isolation depends on', () => {
    const csp = componentFrameCsp(ORIGIN);
    expect(csp).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; " +
        `img-src ${ORIGIN} data:; connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src blob:`,
    );
    // An origin we cannot vouch for gets no image source rather than a wildcard.
    expect(componentFrameCsp('javascript:alert(1)')).toContain('img-src data:;');
  });

  it('carries the policy, the runtime and the worker, and nothing that closes the script early', () => {
    const srcdoc = componentFrameSrcdoc(ORIGIN);
    expect(srcdoc).toContain(`content="${componentFrameCsp(ORIGIN)}"`);
    expect(srcdoc).toContain('<div id="shizue-root"></div>');
    // The creator's code is not in the document: it arrives over the bridge.
    expect(srcdoc.match(/<script>/g)).toHaveLength(1);
    expect(srcdoc.slice(srcdoc.indexOf('<script>') + 8, srcdoc.lastIndexOf('</script>'))).not.toMatch(
      /<\/script/i,
    );
    // …and the worker rides inside it as a string, to be blob'd at runtime.
    expect(srcdoc).toContain('__shizueComponentWorker');
  });

  it('carries the caps from @shizue/core rather than a copy in each realm', () => {
    // Neither realm can import — both are stringified — so the caps are
    // interpolated as an argument, from the one declaration in core.
    const limits = JSON.stringify({
      turn: MAX_COMPONENT_TURN_LENGTH,
      directions: MAX_DIRECTIONS_LENGTH,
    });
    expect(componentWorkerSource('scope')).toContain(`(scope,${limits})`);
    const source = componentRuntimeSource(ORIGIN);
    expect(source).toContain(`,${limits});`);
    // The frame hands the worker the very source that already carries them.
    expect(source).toContain(JSON.stringify(componentWorkerSource()));
    // Every truncation reads the argument; none of the four keeps a literal.
    expect(componentWorkerSource()).toMatch(/slice\(0, ?limits\.turn\)/);
    expect(source).toMatch(/slice\(0, ?limits\.directions\)/);
    expect(source).not.toContain(`slice(0, ${MAX_COMPONENT_TURN_LENGTH})`);
    expect(source).not.toContain(`slice(0, ${MAX_DIRECTIONS_LENGTH})`);
  });
});

describe('the frame applying a tree', () => {
  let frame: Frame;
  beforeEach(() => {
    frame = boot();
  });

  it('draws what the worker rendered', async () => {
    init(frame, STATUS, 'StatusWindow', { hp: 50, name: '루미' });
    await settle();

    const panel = frame.root.querySelector('#panel') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('HP 50');
    expect(panel.textContent).toContain('금화 7');
    expect(panel.style.padding).toBe('8px');
    expect(panel.style.color).toBe('rgb(238, 238, 238)');
  });

  it('falls back to the component defaults for a prop the call code did not carry', async () => {
    init(frame, STATUS, 'StatusWindow', {});
    await settle();
    expect(frame.root.textContent).toContain('이름 없음');
    expect(frame.root.textContent).toContain('HP 0');
  });

  it('forwards a click and draws the answer', async () => {
    init(frame, STATUS, 'StatusWindow', { hp: 50 });
    await settle();
    expect(frame.root.querySelector('#detail')).toBeNull();

    (frame.root.querySelector('button') as HTMLElement).click();
    await settle();
    expect(frame.root.querySelector('#detail')?.textContent).toBe('턴 3');

    (frame.root.querySelector('button') as HTMLElement).click();
    await settle();
    expect(frame.root.querySelector('#detail')).toBeNull();
  });

  it('re-initializes in place when the platform state changes', async () => {
    init(frame, STATUS, 'StatusWindow', { hp: 10 });
    await settle();
    expect(frame.root.textContent).toContain('HP 10');

    init(frame, STATUS, 'StatusWindow', { hp: 90 });
    await settle();
    expect(frame.root.textContent).toContain('HP 90');
    expect(frame.root.textContent).not.toContain('HP 10');
  });

  it('reports its height and forwards a suggestion to the parent', async () => {
    init(
      frame,
      `function Choice({ platform }) {
         return <button onClick={() => platform.suggestInput('좀 쉬어야겠다')}>쉰다</button>;
       }`,
      'Choice',
    );
    await settle();
    (frame.root.querySelector('button') as HTMLElement).click();
    await settle();

    expect(frame.outbound.some((message) => message['type'] === 'resize')).toBe(true);
    expect(frame.outbound.find((message) => message['type'] === 'suggestInput')?.['text']).toBe(
      '좀 쉬어야겠다',
    );
    // Nothing else crosses the bridge: resize, suggestInput and the turn below.
    for (const message of frame.outbound) {
      expect(['resize', 'suggestInput']).toContain(message['type']);
    }
  });

  it('forwards a turn the component asked to send, truncating it again', async () => {
    init(
      frame,
      `function Choice({ platform }) {
         return <button onClick={() => platform.sendTurn('문을 연다', { directions: '주사위 3, 실패' })}>연다</button>;
       }`,
      'Choice',
    );
    await settle();
    (frame.root.querySelector('button') as HTMLElement).click();
    await settle();

    expect(frame.outbound.find((message) => message['type'] === 'sendTurn')).toEqual({
      type: 'sendTurn',
      text: '문을 연다',
      directions: '주사위 3, 실패',
    });

    // A send does not end the turn: the component is still on screen.
    expect(frame.root.querySelector('button')).not.toBeNull();
  });

  it('truncates what the worker says, because that arithmetic is a stranger\'s', async () => {
    // The button only opens the gesture window; the oversized turn is put on the
    // worker channel directly, the way a component that got past its own caps would.
    init(frame, PLAIN_CLICK, 'Plain');
    await settle();
    (frame.root.querySelector('button') as HTMLElement).click();
    await settle();

    const worker = frame.worker() as unknown as { onmessage: (event: { data: unknown }) => void };
    worker.onmessage({
      data: { type: 'sendTurn', text: 'a'.repeat(5000), directions: 'b'.repeat(5000) },
    });
    await settle();
    const forwarded = frame.outbound.find((message) => message['type'] === 'sendTurn')!;
    expect(forwarded['text']).toHaveLength(MAX_COMPONENT_TURN_LENGTH);
    expect(forwarded['directions']).toHaveLength(MAX_DIRECTIONS_LENGTH);
  });

  it('drops a turn no reader asked for, however the component gets round to it', async () => {
    // A component that sends from an effect posts one on every mount, and the
    // chat re-mounts it after every model turn: the two would talk forever.
    init(
      frame,
      `function Eager({ platform }) {
         useEffect(() => { platform.sendTurn('스스로 보낸다'); }, []);
         return <button onClick={() => platform.suggestInput('채우기')}>버튼</button>;
       }`,
      'Eager',
    );
    await settle();
    expect(frame.outbound.some((message) => message['type'] === 'sendTurn')).toBe(false);
    // Silence, not an error card: the component keeps running and drawing.
    expect(frame.root.querySelector('button')).not.toBeNull();
    expect(frame.root.querySelector('.shizue-fallback')).toBeNull();

    // An event of a different kind does not launder it either — the window it
    // opens is spent by the first send, and this component's effect already ran.
    (frame.root.querySelector('button') as HTMLElement).click();
    await settle();
    expect(frame.outbound.some((message) => message['type'] === 'sendTurn')).toBe(false);
    expect(frame.outbound.some((message) => message['type'] === 'suggestInput')).toBe(true);
  });

  it('spends the window on one turn, so a click cannot post two', async () => {
    init(
      frame,
      `function Twice({ platform }) {
         return (
           <button onClick={() => { platform.sendTurn('첫 번째'); platform.sendTurn('두 번째'); }}>
             연다
           </button>
         );
       }`,
      'Twice',
    );
    await settle();
    (frame.root.querySelector('button') as HTMLElement).click();
    await settle();

    const turns = frame.outbound.filter((message) => message['type'] === 'sendTurn');
    expect(turns).toEqual([{ type: 'sendTurn', text: '첫 번째' }]);

    // A second click is a second interaction, so it opens a window of its own.
    (frame.root.querySelector('button') as HTMLElement).click();
    await settle();
    expect(frame.outbound.filter((message) => message['type'] === 'sendTurn')).toHaveLength(2);
  });

  it('does not take a hover for a decision', async () => {
    init(
      frame,
      `function Hover({ platform }) {
         return <div onMouseEnter={() => platform.sendTurn('지나갔을 뿐')}>영역</div>;
       }`,
      'Hover',
    );
    await settle();

    // A node drawn under a resting pointer gets this for free, and a component
    // re-inits on every variable change — so it must not stand in for intent.
    const area = frame.root.querySelector('div') as HTMLElement;
    area.dispatchEvent(new (frame.window as unknown as { Event: typeof Event }).Event('mouseenter'));
    await settle();
    expect(frame.outbound.some((message) => message['type'] === 'sendTurn')).toBe(false);

    // The component still receives the event; only the window stays shut. A
    // real click through the same component does speak.
    area.dispatchEvent(new (frame.window as unknown as { Event: typeof Event }).Event('focus'));
    await settle();
    expect(frame.outbound.some((message) => message['type'] === 'sendTurn')).toBe(false);
  });

  it('closes the window on its own when nothing follows the interaction', async () => {
    init(frame, PLAIN_CLICK, 'Plain');
    await settle();
    const button = frame.root.querySelector('button') as HTMLElement;
    const worker = frame.worker() as unknown as { onmessage: (event: { data: unknown }) => void };

    // The reader's interaction goes stale rather than staying available forever.
    button.click();
    await settle();
    frame.advance(1500);
    worker.onmessage({ data: { type: 'sendTurn', text: '뒤늦게' } });
    await settle();
    expect(frame.outbound.some((message) => message['type'] === 'sendTurn')).toBe(false);

    // Control: the same injection inside the window is forwarded, so what the
    // assertion above caught is the clock and not a window that never opened.
    button.click();
    await settle();
    worker.onmessage({ data: { type: 'sendTurn', text: '제때' } });
    await settle();
    expect(frame.outbound.find((message) => message['type'] === 'sendTurn')?.['text']).toBe('제때');
  });

  it('shows the fallback card for anything the worker could not do', async () => {
    init(frame, 'function Bad() { return <div className="x" />; }', 'Bad');
    await settle();
    const card = frame.root.querySelector('.shizue-fallback');
    expect(card?.textContent).toContain('컴포넌트 오류');
    expect(card?.textContent).toContain('class_name');
  });
});

describe('the frame checking what the worker sent', () => {
  let frame: Frame;
  beforeEach(() => {
    frame = boot();
  });

  /** Applies a tree straight through the applier, as if the worker had sent it. */
  const apply = (tree: unknown): void => {
    (frame.window['__shizueComponentFrame'] as { apply: (tree: unknown) => void }).apply(tree);
  };

  const node = (over: Record<string, unknown>): Record<string, unknown> => ({
    tag: 'div',
    attrs: {},
    style: {},
    props: {},
    on: [],
    path: 'r',
    children: [],
    ...over,
  });

  it('refuses a tag the subset does not allow, however it arrives', () => {
    // The worker runs a stranger's program, so what it says is checked again here.
    expect(() => apply(node({ tag: 'script' }))).toThrow();
    expect(() => apply(node({ tag: 'iframe' }))).toThrow();
    expect(() => apply(node({ tag: 'div><script' }))).toThrow();
  });

  it('drops handler attributes, javascript urls and a style string', () => {
    apply(
      node({
        tag: 'a',
        attrs: {
          onclick: 'alert(1)',
          href: 'java\tscript:alert(1)',
          style: 'position:fixed',
          title: '안전',
        },
        children: ['링크'],
      }),
    );
    const anchor = frame.root.querySelector('a') as HTMLElement;
    expect(anchor.getAttribute('onclick')).toBeNull();
    expect(anchor.getAttribute('href')).toBeNull();
    expect(anchor.getAttribute('style')).toBeNull();
    expect(anchor.getAttribute('title')).toBe('안전');
  });

  it('keeps an ordinary url', () => {
    apply(node({ tag: 'img', attrs: { src: '/api/plots/x/assets/door' } }));
    expect((frame.root.querySelector('img') as HTMLElement).getAttribute('src')).toBe(
      '/api/plots/x/assets/door',
    );
  });

  it('binds no listener for an event outside the list', () => {
    apply(node({ on: ['load', 'error'] }));
    const drawn = frame.root.querySelector('div') as HTMLElement;
    expect(drawn).not.toBeNull();
    // Nothing was bound, so dispatching reaches no worker and nothing throws.
    drawn.dispatchEvent(new (frame.window['Event'] as typeof Event)('load'));
  });

  it('refuses a tree larger than it will draw, counting what it reuses', () => {
    const small: string[] = [];
    for (let i = 0; i < 100; i += 1) small.push('x');
    apply(node({ children: small }));
    const drawn = (frame.root.querySelector('div') as HTMLElement).childNodes.length;
    expect(drawn).toBe(100);

    // The second tree reuses every one of those and appends past the ceiling.
    const huge = small.concat(new Array(6000).fill('y'));
    expect(() => apply(node({ children: huge }))).toThrow(/5000 nodes/);
    // Counting creations alone would have let this through; the DOM is untouched.
    expect((frame.root.querySelector('div') as HTMLElement).childNodes.length).toBe(100);
  });

  it('fills in the fields a sparse node left out rather than throwing mid-patch', () => {
    // Only `tag` and `children` — everything the applier reads on the way down is
    // missing. The alternative was a TypeError halfway through the document.
    apply({ tag: 'div', children: [] });
    expect(frame.root.querySelector('div')).not.toBeNull();

    apply({ tag: 'div', children: [{ tag: 'b', children: ['안'] }, '녕'] });
    expect((frame.root.querySelector('div') as HTMLElement).textContent).toBe('안녕');

    // A patch onto the sparse node still works, and so does the way back.
    apply(node({ attrs: { id: 'full' }, children: ['다시'] }));
    expect((frame.root.querySelector('#full') as HTMLElement).textContent).toBe('다시');
    apply({ tag: 'div' });
    expect((frame.root.querySelector('div') as HTMLElement).textContent).toBe('');
  });

  it('refuses a malformed tree before it draws any of it', () => {
    apply(node({ children: ['먼저'] }));
    expect(() => apply(node({ children: ['좋음', { tag: 42 }] }))).toThrow(/Malformed/);
    expect(() => apply(node({ children: ['좋음', { tag: 'div', children: 'nope' }] }))).toThrow(/Malformed/);
    // Nothing was half-applied: the first tree is still what is on screen.
    expect((frame.root.querySelector('div') as HTMLElement).textContent).toBe('먼저');
  });

  it('never lets a component carry navigation', () => {
    apply(
      node({
        tag: 'a',
        attrs: {
          href: 'https://attacker.test/?state=hp50',
          ping: 'https://attacker.test/beacon',
          target: '_blank',
          download: 'x',
          title: '눌러도 아무 데도 안 갑니다',
        },
        children: ['링크처럼 보이는 글자'],
      }),
    );
    const anchor = frame.root.querySelector('a') as HTMLElement;
    // A composed url is not fetched, so no CSP directive has an opinion about it;
    // the only defence is that the attribute never arrives.
    for (const name of ['href', 'ping', 'target', 'download']) {
      expect(anchor.getAttribute(name), name).toBeNull();
    }
    expect(anchor.textContent).toBe('링크처럼 보이는 글자');
    expect(anchor.getAttribute('title')).toBe('눌러도 아무 데도 안 갑니다');
  });
});

describe('the budget', () => {
  it('terminates a worker that does not answer a render, and says so', async () => {
    const frame = boot();
    // A worker that never answers is what an endless first render looks like from
    // the frame; the real `while (true) {}` is in the E2E suite.
    deafNext = true;
    init(frame, STATUS, 'StatusWindow', { hp: 1 });
    await settle();

    frame.advance(2000);
    expect(frame.worker().terminated).toBe(true);
    const card = frame.root.querySelector('.shizue-fallback');
    expect(card?.textContent).toContain('컴포넌트 오류');
    expect(card?.textContent).toContain('2000ms');
  });

  it('terminates a worker that does not answer an event', async () => {
    const frame = boot();
    init(frame, STATUS, 'StatusWindow', { hp: 50 });
    await settle();

    frame.worker().deaf = true;
    (frame.root.querySelector('button') as HTMLElement).click();
    frame.advance(500);

    expect(frame.worker().terminated).toBe(true);
    expect(frame.root.querySelector('.shizue-fallback')?.textContent).toContain('500ms');
  });

  it('is not cleared by a tree, only by an answered ping', async () => {
    const frame = boot();
    init(frame, STATUS, 'StatusWindow', { hp: 50 });
    await settle();

    // From here the worker draws but stops answering — which is exactly the shape
    // of `postMessage({type:'tree'}); while (true) {}`, and of an honest render
    // that hangs after posting its tree.
    frame.worker().dropPings = true;
    init(frame, STATUS, 'StatusWindow', { hp: 77 });
    await settle();
    // The tree it posted was drawn…
    expect(frame.root.textContent).toContain('HP 77');
    expect(frame.worker().terminated).toBe(false);

    // …and bought it nothing: the deadline was still running.
    frame.advance(500);
    expect(frame.worker().terminated).toBe(true);
    expect(frame.root.querySelector('.shizue-fallback')?.textContent).toContain('500ms');
  });

  it('stops a worker that floods the frame with trees', async () => {
    const frame = boot();
    init(frame, STATUS, 'StatusWindow', { hp: 50 });
    await settle();

    const worker = frame.worker();
    for (let i = 0; i < 40; i += 1) {
      (worker as unknown as { onmessage: (event: { data: unknown }) => void }).onmessage({
        data: { type: 'tree', tree: 'x' + i },
      });
    }
    await settle();
    expect(worker.terminated).toBe(true);
    expect(frame.root.querySelector('.shizue-fallback')?.textContent).toContain('re-rendering');
  });

  it('does not fire once the turn came back', async () => {
    const frame = boot();
    init(frame, STATUS, 'StatusWindow', { hp: 50 });
    await settle();
    frame.advance(10_000);
    expect(frame.worker().terminated).toBe(false);
    expect(frame.root.querySelector('#panel')).not.toBeNull();
  });

  it('keeps asking a quiet component whether it is still there', async () => {
    const frame = boot();
    init(frame, STATUS, 'StatusWindow', { hp: 50 });
    await settle();

    // Nobody touches anything for a minute. A live component answers every time
    // and nothing happens to it.
    for (let i = 0; i < 12; i += 1) {
      frame.advance(5000);
      await settle();
    }
    expect(frame.worker().terminated).toBe(false);
    expect(frame.root.querySelector('#panel')).not.toBeNull();
  });

  it('reclaims a worker that answered once and then span', async () => {
    const frame = boot();
    init(frame, STATUS, 'StatusWindow', { hp: 50 });
    await settle();
    expect(frame.root.textContent).toContain('HP 50');

    // The component drew, answered the ping that ended its turn, and then went
    // into a loop. Nothing else is going to happen in this chat until the reader
    // does something, and until now that meant it kept a thread forever.
    frame.worker().dropPings = true;
    frame.advance(5000);
    expect(frame.worker().terminated).toBe(false);
    frame.advance(499);
    expect(frame.worker().terminated).toBe(false);
    frame.advance(2);

    expect(frame.worker().terminated).toBe(true);
    expect(frame.root.querySelector('.shizue-fallback')?.textContent).toContain('컴포넌트 오류');
  });

  it('does not let a tick reset a deadline that is already running', async () => {
    const frame = boot();
    init(frame, STATUS, 'StatusWindow', { hp: 50 });
    await settle();
    frame.worker().dropPings = true;

    frame.advance(5000);
    expect(frame.worker().terminated).toBe(false);
    // The next tick arrives with the previous question still unanswered. Asking
    // again here would start a fresh deadline every five seconds and the worker
    // would never be stopped at all.
    frame.advance(5000);
    expect(frame.worker().terminated).toBe(true);
  });

  it('stops asking once there is nothing to ask', async () => {
    const frame = boot();
    deafNext = true;
    init(frame, STATUS, 'StatusWindow', { hp: 1 });
    await settle();
    frame.advance(2000);
    expect(frame.worker().terminated).toBe(true);

    frame.advance(60_000);
    // The fallback card stands; a heartbeat with no worker draws nothing new.
    expect(frame.root.querySelectorAll('.shizue-fallback')).toHaveLength(1);
  });

  it('starts a fresh worker on the next init', async () => {
    const frame = boot();
    deafNext = true;
    init(frame, STATUS, 'StatusWindow', { hp: 1 });
    await settle();
    frame.advance(2000);
    const killed = frame.worker();

    deafNext = false;
    init(frame, STATUS, 'StatusWindow', { hp: 42 });
    await settle();
    expect(frame.worker()).not.toBe(killed);
    expect(frame.root.textContent).toContain('HP 42');
  });
});

describe('the handshake', () => {
  const initMessage = {
    type: 'init',
    code: STATUS,
    name: 'StatusWindow',
    props: { hp: 5 },
    platform: PLATFORM,
    labels: { error: '컴포넌트 오류' },
  };

  it('mounts what arrives over the port', async () => {
    const frame = boot();
    frame.port.postMessage(initMessage);
    await settle();
    expect(frame.root.textContent).toContain('HP 5');
  });

  it('refuses an init on the window, even from the parent', async () => {
    const frame = boot();
    // The window channel carries the handshake and nothing else, so a component
    // that recovered `parent` cannot feed itself state, and neither can anything
    // that replaced this document.
    frame.postToWindow(initMessage, 'parent');
    await settle();
    expect(frame.root.textContent).toBe('');
  });

  it('ignores a port offered by anyone but the embedder', async () => {
    const frame = boot();
    frame.window.postMessage({ type: 'port' }, '*');
    frame.postToWindow({ type: 'port' }, 'stranger');
    await settle();
    expect(frame.root.textContent).toBe('');
  });

  it('takes a port once, so a later document cannot get one', async () => {
    const frame = boot();
    frame.window.eval('window.__second = new MessageChannel();');
    frame.postToWindow({ type: 'port' }, 'parent', '[window.__second.port2]');

    const second = (frame.window['__second'] as MessageChannel).port1;
    const seen: unknown[] = [];
    second.onmessage = (event) => seen.push(event.data);

    // The frame kept the first port: the second one hears nothing…
    frame.port.postMessage(initMessage);
    await settle();
    expect(frame.root.textContent).toContain('HP 5');
    expect(seen).toEqual([]);

    // …and cannot drive it either.
    second.postMessage({ ...initMessage, props: { hp: 999 } });
    await settle();
    expect(frame.root.textContent).not.toContain('999');
  });
});
