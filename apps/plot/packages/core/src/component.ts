/**
 * Authoring-time screening of a Layer 2 component.
 *
 * The component itself never runs here, and never runs on our origin at all: it
 * is compiled and executed inside a dedicated worker, started by a sandboxed
 * iframe on an opaque origin (see `apps/web/src/lib/componentRuntime.ts`). So
 * nothing in this file is a security boundary — the isolation is. What this file
 * buys is that a creator finds out *while writing* that their component leaves
 * the supported subset, instead of watching a reader's message render an error
 * card.
 *
 * The subset is Elyn's, because compatibility with the components circulating
 * there is the point: hooks limited to useState/useEffect/useMemo/useCallback/
 * useRef called bare, inline object styles only (no className, no string style),
 * no timers, no network, no storage, no imports.
 *
 * The worker applies the same rules again, on its own copy — it has to, since it
 * must be a self-contained script with no imports. This copy is the one the
 * editor and the API can see.
 *
 * Dependency-free, so the web editor can import it (`@shizue/core/component`)
 * without pulling the tokenizer and the card parser into the bundle.
 */

/** Longest component code a card may carry. Elyn's circulating status windows sit under 10KB. */
export const MAX_COMPONENT_CODE_LENGTH = 40_000;

/** Longest stage direction a component may attach to a turn. */
export const MAX_DIRECTIONS_LENGTH = 800;

/**
 * Longest turn a component may send, and the longest text it may put in the
 * composer. The contract every realm holds to: the worker and the frame truncate
 * to it, the bridge truncates again, and the API refuses a component turn past it.
 */
export const MAX_COMPONENT_TURN_LENGTH = 2000;

/** Hooks a component may call, bare. Anything else is out of the subset. */
const ALLOWED_HOOKS = [
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'useRef',
] as const;

/** Why a component left the subset. Stable codes — the UI maps them to a message. */
export type SubsetViolation =
  | 'too_long'
  | 'import'
  | 'timer'
  | 'network'
  | 'storage'
  | 'eval'
  | 'class_name'
  | 'string_style'
  | 'unknown_hook';

/**
 * Blanks out the contents of strings, template literals and comments, keeping the
 * delimiters and the length. Every rule below is a word match, and a component
 * that merely writes "fetch" in a label is not calling it.
 */
function stripCodeLiterals(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop - 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      out += char;
      let j = i + 1;
      for (; j < source.length; j += 1) {
        if (source[j] === '\\') {
          out += '  ';
          j += 1;
          continue;
        }
        if (source[j] === char) break;
        out += ' ';
      }
      // The closing quote, or the end of a string the author has not finished.
      out += j < source.length ? char : '';
      i = j;
      continue;
    }
    out += char;
  }
  return out;
}

interface Rule {
  code: SubsetViolation;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { code: 'import', pattern: /\bimport\b|\brequire\s*\(/ },
  { code: 'timer', pattern: /\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\b/ },
  { code: 'network', pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator)\b/ },
  { code: 'storage', pattern: /\b(?:localStorage|sessionStorage|indexedDB|cookie)\b/ },
  { code: 'eval', pattern: /\beval\s*\(|\bnew\s+Function\b/ },
  { code: 'class_name', pattern: /\bclassName\b|\bclass\s*=\s*["']/ },
  // `style="…"` and `style={'…'}`: the subset takes an object, so a string is
  // never merely a different spelling — it would silently render nothing.
  { code: 'string_style', pattern: /\bstyle\s*=\s*(?:["']|\{\s*["'])/ },
];

/** Every `useX(` call in the source, whatever it resolves to. */
const HOOK_CALL = /\buse[A-Z][A-Za-z0-9_]*\s*\(/g;

/**
 * Screens component code. Returns the violations in a stable order; an empty
 * array means it is inside the subset.
 *
 * Being a syntactic screen, it is neither sound nor complete: `window['fe' + 'tch']`
 * passes it, and a component that only mentions a forbidden name in a computed
 * position is flagged. Neither matters much — the iframe is what stops the first
 * one, and the second is a warning the creator can read.
 */
export function componentSubsetViolations(source: string): SubsetViolation[] {
  const violations: SubsetViolation[] = [];
  if (source.length > MAX_COMPONENT_CODE_LENGTH) violations.push('too_long');

  const code = stripCodeLiterals(source);
  for (const rule of RULES) if (rule.pattern.test(code)) violations.push(rule.code);

  HOOK_CALL.lastIndex = 0;
  for (let match = HOOK_CALL.exec(code); match; match = HOOK_CALL.exec(code)) {
    const name = match[0].slice(0, match[0].search(/\s*\(/));
    if (!(ALLOWED_HOOKS as readonly string[]).includes(name)) {
      violations.push('unknown_hook');
      break;
    }
  }
  return violations;
}

/** `function Name(` and `const Name =` — the two ways a component gets declared. */
const DECLARATION = /(?:\bfunction\s+([A-Z][A-Za-z0-9_]*)\s*\()|(?:\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=)/g;

/** Most component names one card may declare; a call code only ever names one. */
const MAX_COMPONENT_NAMES = 32;

/**
 * The component names a card's code declares, in declaration order.
 *
 * The chat needs them before anything is compiled: a message is only searched for
 * the call codes of components that actually exist, so a card without them never
 * mounts an iframe and prose that happens to contain `<Something />` stays prose.
 * The runtime resolves the name for real, against what the compiled code exported.
 */
export function componentNames(source: string): string[] {
  const names: string[] = [];
  const code = stripCodeLiterals(source);
  DECLARATION.lastIndex = 0;
  for (let match = DECLARATION.exec(code); match; match = DECLARATION.exec(code)) {
    const name = match[1] ?? match[2]!;
    if (!names.includes(name)) names.push(name);
    if (names.length >= MAX_COMPONENT_NAMES) break;
  }
  return names;
}
