/**
 * Closes the markdown a half-written block has left open.
 *
 * Streaming text arrives mid-token, so a paragraph spends a moment as `그는
 * **천천히` — which markdown renders as two literal asterisks, and then as bold
 * the instant the closer lands. That flicker is the whole problem: the fix is to
 * render the block as if the writer had just stopped, not as if they had meant
 * the markers literally.
 *
 * This is only ever applied to the block still being written. A settled block is
 * rendered exactly as the model wrote it — including its unbalanced markers.
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A run of the same character starting at `i`. */
function runLength(text: string, i: number): number {
  let end = i;
  while (end < text.length && text[end] === text[i]) end += 1;
  return end - i;
}

/** The marker of the fence left open at the end of `md`, or null. */
function openFence(md: string): string | null {
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    const match = FENCE_RE.exec(line);
    if (!match) continue;
    const marker = match[1]!;
    if (fence === null) {
      fence = marker;
    } else if (marker[0] === fence[0] && marker.length >= fence.length && match[2]!.trim() === '') {
      fence = null;
    }
  }
  return fence;
}

/**
 * `[표시할 말](htt` → `표시할 말`. A destination the reader can see half of is
 * noise, and the finished link will replace this a few tokens later.
 *
 * An image is dropped instead of unwrapped: its alt text is a filename far more
 * often than something worth reading.
 */
function truncateOpenLink(md: string): string {
  const match = /(!?)\[([^\][]*)\]\([^()]*$/.exec(md);
  if (!match) return md;
  return md.slice(0, match.index) + (match[1] ? '' : match[2]!);
}

function toggle(stack: string[], marker: string): void {
  if (stack[stack.length - 1] === marker) stack.pop();
  else stack.push(marker);
}

/** Lines that are markers rather than text, and must not be counted as emphasis. */
const THEMATIC_BREAK_RE = /^ {0,3}([*_-])[ \t]*(\1[ \t]*){2,}$/;
/** `* item` / `- item`: a bullet, not the start of an emphasis run. */
const BULLET_RE = /^([ \t]*)([*+-])([ \t]+)/;

/**
 * Closes unbalanced inline markers. Emphasis is tracked as a stack so the
 * closers come out in the order that nests: `**굵게 *기울여` closes the italic
 * first.
 */
function balanceInline(md: string): string {
  const lines = md.split('\n');
  /** Open emphasis markers, innermost last. */
  const open: string[] = [];
  /** The backtick run that opened the current code span, or null. */
  let code: string | null = null;
  /** The fence marker while inside a fenced block — no inline markup in there. */
  let fence: string | null = null;

  for (const raw of lines) {
    const fenceMatch = FENCE_RE.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (THEMATIC_BREAK_RE.test(raw)) continue;

    // A bullet is skipped rather than scanned, so `* 첫째` does not open italics.
    const bullet = code === null ? BULLET_RE.exec(raw) : null;
    let i = bullet ? bullet[0].length : 0;

    while (i < raw.length) {
      const ch = raw[i]!;
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        const run = runLength(raw, i);
        const ticks = '`'.repeat(run);
        if (code === null) code = ticks;
        else if (code === ticks) code = null;
        i += run;
        continue;
      }
      if (code !== null) {
        i += 1;
        continue;
      }
      if (ch === '*') {
        let run = runLength(raw, i);
        i += run;
        while (run >= 2) {
          toggle(open, '**');
          run -= 2;
        }
        if (run === 1) toggle(open, '*');
        continue;
      }
      if (ch === '~' && raw[i + 1] === '~') {
        const run = runLength(raw, i);
        if (run >= 2) toggle(open, '~~');
        i += run;
        continue;
      }
      i += 1;
    }
  }

  let out = md;
  // A code span swallows everything, so it is closed before the emphasis around it.
  if (code !== null) out += code;
  else for (let n = open.length - 1; n >= 0; n -= 1) out += open[n];
  return out;
}

/**
 * The block as it should be drawn right now: fences and inline markers closed,
 * a half-typed link destination hidden.
 */
export function balancePartial(md: string): string {
  const fence = openFence(md);
  // Inside a fence nothing is markup, so closing the fence is the whole job.
  if (fence !== null) return md.endsWith('\n') ? md + fence : md + '\n' + fence;
  return balanceInline(truncateOpenLink(md));
}
