import { withNarrationPrefix } from '@shizue/core/narration';

/**
 * What the composer is writing: a line of the reader's own dialogue, their
 * 상황묘사, or the narrator's.
 *
 * The mode is a way of typing, not a column: it transforms the text on its way
 * out and nothing else — what is stored is the same `*…*` and `@:` conventions a
 * reader can type by hand, so a turn written in one mode is indistinguishable
 * from the same turn typed out in another.
 */
export type ComposerMode = 'dialogue' | 'description' | 'narration';

/** In the order the chips stand, dialogue first because it is the default. */
export const COMPOSER_MODES: readonly ComposerMode[] = ['dialogue', 'description', 'narration'];

/**
 * A line already written as someone (`@이름: …`, `@내레이터: …`, `@: …`), which the
 * reader typed themselves: Zeta's marker, read by core `readerLine`.
 */
const WRITTEN_AS_RE = /^\s*@[^:：\n]{0,40}[:：]/;

/** `*text*`, unless the reader already put the marks there. */
function described(text: string): string {
  const wrapped = text.length > 1 && text.startsWith('*') && text.endsWith('*');
  return wrapped ? text : `*${text}*`;
}

/**
 * The turn as it will be stored. Marks the reader already put there are left
 * alone: the `*` button and the 묘사 chip write the same notation, and pressing
 * both must not come out as bold.
 *
 * `as` is the member the reader writes as — Zeta's write-as, by the name a
 * `@이름:` line is read by — and every line with text then goes as that member's:
 * `@이름: …`, one marker per line, its 상황묘사 wrapped line by line, since a
 * `*…*` span never crosses a line. A line the reader already marked as someone
 * keeps its own marker, and blank lines stay as spacing. The narrator is the
 * 내레이터 chip, and it wins over `as`.
 */
export function composeTurn(text: string, mode: ComposerMode, as: string | null = null): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (mode === 'narration') return withNarrationPrefix(trimmed);
  if (as !== null) {
    return trimmed
      .split('\n')
      .map((line) => {
        const body = line.trim();
        if (!body || WRITTEN_AS_RE.test(line)) return line;
        return `@${as}: ${mode === 'description' ? described(body) : body}`;
      })
      .join('\n');
  }
  if (mode === 'description') return described(trimmed);
  return text;
}
