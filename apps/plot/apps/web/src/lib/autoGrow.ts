/**
 * Fits a composer to what is written in it.
 *
 * The reset to `auto` is what lets it shrink again: the scroll height of a field
 * that is already tall enough only ever says how tall it is. Both writes happen
 * inside one layout pass, so nothing is ever painted at the intermediate height.
 * The ceiling is the field's own `max-height` — past it the height is clamped by
 * CSS and the text scrolls, which is why nothing here reads a limit.
 */
export function autoGrow(field: HTMLTextAreaElement): void {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}
