import { readVariable, type Variables } from './variables.js';

export interface MacroContext {
  char: string;
  user: string;
  /**
   * Path-derived chat variables, for {{getvar::k}}. Omitted where there is no
   * chat to derive them from (a greeting expanded at chat creation), and then
   * {{getvar}} is left alone like any other unsupported macro.
   */
  variables?: Variables;
  /**
   * Replacement for {{original}}. Only substituted when provided — {{original}}
   * is meaningful solely while injecting a preset into a card override.
   */
  original?: string;
  /** Injectable randomness for deterministic tests. Returns [0, 1). */
  random?: () => number;
}

const MACRO_RE = /\{\{([^{}]*)\}\}/g;
const IMAGE_MACRO_RE = /\{\{\s*img\s*::([^{}]*)\}\}/gi;

/**
 * Drops every `{{img::slug}}` reference. The token is client-side markup — the
 * chat renders it as the character's image — so it is noise to a model, while the
 * stored message keeps it. Prompt assembly is therefore the only caller;
 * `applyMacros` deliberately leaves the token alone, because it also runs where
 * the expanded text is what gets stored (greetings).
 */
export function stripImageMacros(text: string): string {
  return text.replace(IMAGE_MACRO_RE, '');
}

/**
 * The slugs `text` references, in order of appearance and trimmed the way the
 * chat resolves them. Whoever asks then decides what a slug with no asset behind
 * it means — the renderer drops it, the exporter leaves it out.
 */
export function imageMacroSlugs(text: string): string[] {
  return [...text.matchAll(IMAGE_MACRO_RE)].map((match) => match[1]!.trim());
}

/**
 * CBS subset: {{char}}, {{user}}, {{getvar::k}}, {{random:a,b,...}}, {{roll:dN}},
 * {{// comment}}, {{original}}. Macro names are case-insensitive; unsupported
 * macros are left as-is — which is what keeps {{setvar}}/{{addvar}} in the prompt
 * history, where the model needs to keep seeing its own protocol.
 */
export function applyMacros(text: string, ctx: MacroContext): string {
  if (!text) return text;
  const rand = ctx.random ?? Math.random;

  return text.replace(MACRO_RE, (match, body: string) => {
    const inner = body.trim();
    const lower = inner.toLowerCase();

    if (lower.startsWith('//')) return '';
    if (lower === 'char') return ctx.char;
    if (lower === 'user') return ctx.user;
    if (lower === 'original') return ctx.original ?? match;

    // `::` is the CBS argument separator; it has to be tried before the single
    // colon, or `getvar::k` would parse as the argument `:k`.
    const separator = inner.indexOf('::');
    if (separator !== -1) {
      const name = inner.slice(0, separator).trim().toLowerCase();
      if (name === 'getvar' && ctx.variables) {
        return readVariable(ctx.variables, inner.slice(separator + 2).trim()) ?? '';
      }
      return match;
    }

    const colon = inner.indexOf(':');
    if (colon !== -1) {
      const name = inner.slice(0, colon).trim().toLowerCase();
      const arg = inner.slice(colon + 1);

      if (name === 'random') {
        const options = arg.split(',').map((o) => o.trim());
        if (options.length === 0) return match;
        return options[Math.floor(rand() * options.length)] ?? match;
      }

      if (name === 'roll') {
        const sides = Number.parseInt(arg.trim().replace(/^d/i, ''), 10);
        if (!Number.isFinite(sides) || sides < 1) return match;
        return String(Math.floor(rand() * sides) + 1);
      }
    }

    return match;
  });
}
