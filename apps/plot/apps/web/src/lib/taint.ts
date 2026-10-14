/**
 * Where interpolated content landed, carried in the string itself.
 *
 * A Layer 1 template is written by the creator and is visible; the values it
 * interpolates are not. `{{getvar::k}}` reads a chat variable, and chat variables
 * are set by `{{setvar}}` macros in the model's own output — so the model chooses
 * what goes in. For a status window that is the point. For an `href` it means the
 * destination of a link is chosen by the model, and the sanitizer, looking at the
 * finished string, cannot tell `https://blog.example.test/lumi` written out by the
 * creator from the same shape assembled a character at a time from model output.
 *
 * So the template engine says so. Every value that came from model-controlled
 * content is wrapped in a marker as it is substituted, and the sanitizer reads the
 * markers off the attribute *after* interpolation — which is the only place the
 * question can be answered, since the answer is about the value and not about the
 * shape of the template around it. Markers are stripped from everything before it
 * leaves; nothing downstream ever sees one.
 *
 * The marker is U+0001. It survives the HTML parser and DOMPurify inside attribute
 * values and text (verified in `sanitizeHtml.test.ts`), it is not a character any
 * template or message legitimately contains, and it is removed from untrusted
 * values on the way in — so the model cannot plant one. Planting one would only
 * ever mark *more* of the output as untrusted anyway: taint fails towards refusing
 * a link, never towards offering one.
 */

/** Wraps a stretch of interpolated content. Never appears in output. */
export const TAINT = '\u0001';

/**
 * Open and close a capture — the model's words a display script bound into its
 * template (`lib/displayScripts`). A pair rather than one mark, because a capture
 * is evaluated as CBS and its own `{{getvar}}` comes out marked inside it: with
 * one symmetric mark the inner pair would read as the outer one closing. Taint
 * all the same, to everything that asks.
 */
export const CAPTURE_OPEN = '\u0002';
export const CAPTURE_CLOSE = '\u0003';

const MARKS_RE = /[\u0001-\u0003]/;
const MARKS_GLOBAL_RE = /[\u0001-\u0003]/g;

/** Marks a value as having come from model-controlled content. */
export const taint = (value: string): string => `${TAINT}${value}${TAINT}`;

/** Marks a display script's capture (`CAPTURE_OPEN`). */
export const markCapture = (value: string): string => `${CAPTURE_OPEN}${value}${CAPTURE_CLOSE}`;

/** Whether any part of this string was interpolated. */
export const isTainted = (value: string): boolean => MARKS_RE.test(value);

/** The same string with the bookkeeping removed. */
export const stripTaint = (value: string): string =>
  MARKS_RE.test(value) ? value.replace(MARKS_GLOBAL_RE, '') : value;
